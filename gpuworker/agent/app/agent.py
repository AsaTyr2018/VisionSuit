from __future__ import annotations

import asyncio
import contextlib
import copy
import errno
import json
import logging
import mimetypes
import re
import secrets
import shutil
import time
import uuid
from asyncio import Event
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from math import isfinite
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple
from urllib.parse import urljoin, urlparse, urlunparse

import httpx

from .assets import (
    build_collision_suffix,
    derive_pretty_name,
    ensure_extension,
    must_be_allowed,
    normalize_name,
)
from .comfyui import (
    ComfyUICancelledError,
    ComfyUIClient,
    ComfyUIError,
    ComfyUIJobFailed,
    OutputImage,
    extract_output_files,
)
from .config import AgentConfig
from .minio_client import MinioManager, compute_sha256
from .models import AssetRef, DispatchEnvelope, Resolution
from .workflow import WorkflowLoader, build_workflow_payload, find_save_image_nodes

LOGGER = logging.getLogger(__name__)


SYMLINK_ERROR_CODES: Set[int] = {
    code
    for code in (
        errno.EPERM,
        errno.EACCES,
        getattr(errno, "ENOTSUP", None),
        getattr(errno, "EOPNOTSUPP", None),
        errno.EROFS,
    )
    if code is not None
}


class SymlinkCreationUnsupported(RuntimeError):
    def __init__(self, directory: Path, cause: OSError) -> None:
        message = f"Symlinks are not supported in {directory}: {cause}"
        super().__init__(message)
        self.directory = directory
        self.cause = cause


@dataclass
class ResolvedAsset:
    asset: AssetRef
    cache_path: Path
    comfy_name: str
    symlink_path: Path
    downloaded: bool
    link_created: bool


@dataclass
class ArtifactRecord:
    node_id: str
    filename: str
    subfolder: str
    rel_path: str
    abs_path: str
    mime: str
    sha256: Optional[str]
    size_bytes: Optional[int]
    s3_bucket: str
    s3_key: str
    s3_url: Optional[str]
    kind: str = "image"

    def to_callback_payload(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "kind": self.kind,
            "node_id": self.node_id,
            "filename": self.filename,
            "subfolder": self.subfolder,
            "rel_path": self.rel_path,
            "abs_path": self.abs_path,
            "mime": self.mime,
            "s3": {
                "bucket": self.s3_bucket,
                "key": self.s3_key,
                "url": self.s3_url,
            },
        }
        if self.sha256:
            payload["sha256"] = self.sha256
        if self.size_bytes is not None:
            payload["bytes"] = self.size_bytes
        return payload


@dataclass
class UploadResult:
    uploaded: List[str]
    missing: List[Path]
    artifacts: List[ArtifactRecord]


@dataclass
class CancellationHandle:
    token: str
    event: Event
    job: DispatchEnvelope


@dataclass
class JobLogHandle:
    job_id: str
    directory: Path
    manifest_path: Path
    events_path: Path


class FailureCategory(str, Enum):
    VALIDATION = "validation"
    TRANSIENT = "transient"
    TIMEOUT = "timeout"
    CANCELLED = "cancelled"
    SYSTEM = "system"


class GeneratorState(str, Enum):
    QUEUED = "QUEUED"
    PREPARING = "PREPARING"
    MATERIALIZING = "MATERIALIZING"
    SUBMITTED = "SUBMITTED"
    RUNNING = "RUNNING"
    UPLOADING = "UPLOADING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    CANCELED = "CANCELED"


class ValidationFailure(Exception):
    """Raised when the dispatch payload fails validation."""


@dataclass
class JobRuntimeState:
    heartbeat_seq: int
    started_at: datetime
    started_monotonic: float
    prompt_id: Optional[str] = None


class GPUAgent:
    _RESERVED_DEFAULT_KEYS: Set[str] = {
        "prompt",
        "negative_prompt",
        "seed",
        "steps",
        "cfg_scale",
        "width",
        "height",
        "sampler",
        "scheduler",
    }
    _RESERVED_KEYS_WITH_DEFAULTS: Set[str] = {"sampler", "scheduler"}

    def __init__(self, config: AgentConfig) -> None:
        self.config = config
        self.minio = MinioManager(config)
        self.comfyui = ComfyUIClient(config)
        self.workflow_loader = WorkflowLoader(config, self.minio)
        self._lock = asyncio.Lock()
        self._cancel_handle: Optional[CancellationHandle] = None
        self._runtime: Dict[str, JobRuntimeState] = {}
        self._symlink_support: Dict[Path, bool] = {}
        self._job_log_dir = config.paths.outputs / "logs"
        self._job_logs: Dict[str, JobLogHandle] = {}

    def is_busy(self) -> bool:
        return self._lock.locked()

    async def try_reserve_job(self) -> bool:
        """Attempt to reserve the execution lock without waiting."""

        if self._lock.locked():
            return False
        await self._lock.acquire()
        return True

    async def run_reserved_job(self, job: DispatchEnvelope) -> Dict[str, List[str]]:
        """Execute a job after :meth:`try_reserve_job` succeeds."""

        try:
            return await self._execute(job)
        finally:
            self._lock.release()

    async def handle_job(self, job: DispatchEnvelope) -> Dict[str, List[str]]:
        async with self._lock:
            return await self._execute(job)

    async def request_cancel(self, token: str) -> bool:
        handle = self._cancel_handle
        if not handle or not token or handle.token != token:
            LOGGER.debug("Cancellation token %s did not match active job", token)
            return False
        if not handle.event.is_set():
            LOGGER.info("Received cancellation request for job %s", handle.job.jobId)
            self._log_job_event(self._job_logs.get(handle.job.jobId), "cancel_requested", None)
            handle.event.set()
            try:
                await self._emit_status(
                    handle.job,
                    GeneratorState.RUNNING,
                    message="Cancellation requested",
                    progress={"phase": "cancelling"},
                )
            except Exception:  # noqa: BLE001
                LOGGER.debug("Failed to emit cancellation status for %s", handle.job.jobId, exc_info=True)
        return True

    async def describe_activity(self) -> Dict[str, Any]:
        return await self.comfyui.describe_activity()

    async def _execute(self, job: DispatchEnvelope) -> Dict[str, List[str]]:
        LOGGER.info("Starting job %s for user %s", job.jobId, job.user.username)
        self._start_runtime(job)
        resolved_base: Optional[ResolvedAsset] = None
        resolved_loras: List[ResolvedAsset] = []
        history: Optional[Dict[str, Any]] = None
        warnings: List[str] = []
        cancel_handle: Optional[CancellationHandle] = None
        job_log = self._create_job_log(job)
        self._log_job_event(
            job_log,
            "accepted",
            {
                "user": job.user.username,
                "output_bucket": job.output.bucket,
                "output_prefix": job.output.prefix,
            },
        )
        prompt_id: Optional[str] = None
        try:
            resolved_base = self._ensure_base_model(job.baseModel)
            resolved_loras = self._ensure_loras(job)
            needs_refresh = self._needs_model_refresh(resolved_base, resolved_loras)
            if needs_refresh:
                await self._refresh_model_cache()

            resolved_params = self._build_parameter_context(job, resolved_base, resolved_loras)
            workflow_payload = build_workflow_payload(self.workflow_loader, job, resolved_params)
            applied_loras = self._apply_lora_chain(workflow_payload, resolved_loras, resolved_params)
            self._synchronize_lora_context(job, resolved_params, resolved_loras, applied_loras)
            self._validate_workflow_bindings(job, workflow_payload, resolved_params)
            self._validate_prompt_connections(workflow_payload)
            save_nodes = find_save_image_nodes(workflow_payload)
            await self._ensure_lora_visibility(resolved_loras)
            await self._persist_applied_workflow(job_log, job, workflow_payload)
            await self._update_job_manifest(job_log, job, resolved_params, workflow_payload)
            await self._validate_workflow_assets(workflow_payload)

            self._log_job_event(
                job_log,
                "context_resolved",
                self._build_log_context(resolved_base, resolved_loras, job, resolved_params),
            )

            await self._emit_status(
                job,
                GeneratorState.QUEUED,
                message="Job queued",
                progress={"phase": "queued", "percent": 0},
            )
            self._log_job_event(
                job_log,
                "queued",
                {"progress": {"phase": "queued", "percent": 0}},
            )
            cancel_handle = self._register_cancellation(job)
            if cancel_handle:
                self._log_job_event(job_log, "cancellation_registered", {"token_present": True})
            prompt_id = await self.comfyui.submit_workflow(workflow_payload)
            await self._emit_status(
                job,
                GeneratorState.RUNNING,
                message="Workflow submitted to ComfyUI",
                prompt_id=prompt_id,
                progress={"phase": "running"},
            )
            self._log_job_event(
                job_log,
                "running",
                {"prompt_id": prompt_id},
            )

            timeout = self._compute_timeout(job, workflow_payload, resolved_params)
            history = await self.comfyui.wait_for_completion(
                prompt_id,
                timeout=timeout,
                cancel_event=cancel_handle.event if cancel_handle else None,
            )
            await self._emit_status(
                job,
                GeneratorState.UPLOADING,
                message="Uploading generated artifacts",
                progress={"phase": "uploading"},
            )
            self._log_job_event(job_log, "uploading", {"prompt_id": prompt_id})

            outputs = extract_output_files(history, save_nodes if save_nodes else None)
            if save_nodes and not outputs:
                raise ValidationFailure("Workflow completed without producing outputs from SaveImage nodes")

            upload_result = self._upload_outputs(job, outputs, resolved_base, resolved_loras, resolved_params)
            if upload_result.missing:
                missing_names = ", ".join(path.name for path in upload_result.missing)
                warnings.append(f"Missing outputs on disk: {missing_names}")
            await self._emit_completion(
                job,
                upload_result,
                warnings or None,
                resolved_base,
                resolved_loras,
                resolved_params,
                history,
            )
            self._log_job_event(
                job_log,
                "completed",
                self._build_completion_log(upload_result, warnings, prompt_id),
            )
            LOGGER.info("Job %s completed", job.jobId)
            return {"uploaded": upload_result.uploaded}
        except ValidationFailure as exc:
            LOGGER.exception("Job %s failed validation", job.jobId)
            self._log_job_event(
                job_log,
                "failed",
                {"reason": str(exc), "category": FailureCategory.VALIDATION.value, "prompt_id": prompt_id},
            )
            await self._emit_failure(job, str(exc), FailureCategory.VALIDATION, history)
            raise
        except ComfyUICancelledError:
            LOGGER.info("Job %s cancelled by controller", job.jobId)
            self._log_job_event(
                job_log,
                "cancelled",
                {"reason": "Cancelled by controller", "prompt_id": prompt_id},
            )
            await self._emit_cancellation(job)
            return {"uploaded": []}
        except asyncio.TimeoutError as exc:
            LOGGER.exception("Job %s timed out", job.jobId)
            self._log_job_event(
                job_log,
                "failed",
                {"reason": str(exc), "category": FailureCategory.TIMEOUT.value, "prompt_id": prompt_id},
            )
            await self._emit_failure(job, str(exc), FailureCategory.TIMEOUT, history)
            raise
        except ComfyUIJobFailed as exc:
            history = exc.history
            LOGGER.exception("ComfyUI reported failure for job %s", job.jobId)
            self._log_job_event(
                job_log,
                "failed",
                {"reason": str(exc), "category": FailureCategory.VALIDATION.value, "prompt_id": prompt_id},
            )
            await self._emit_failure(job, str(exc), FailureCategory.VALIDATION, history)
            raise
        except ComfyUIError as exc:
            LOGGER.exception("ComfyUI transport error for job %s", job.jobId)
            self._log_job_event(
                job_log,
                "failed",
                {"reason": str(exc), "category": FailureCategory.TRANSIENT.value, "prompt_id": prompt_id},
            )
            await self._emit_failure(job, str(exc), FailureCategory.TRANSIENT, history)
            raise
        except Exception as exc:  # noqa: BLE001
            LOGGER.exception("Job %s failed unexpectedly", job.jobId)
            self._log_job_event(
                job_log,
                "failed",
                {"reason": str(exc), "category": FailureCategory.SYSTEM.value, "prompt_id": prompt_id},
            )
            await self._emit_failure(job, str(exc), FailureCategory.SYSTEM, history)
            raise
        finally:
            runtime = self._get_runtime(job.jobId)
            if runtime:
                duration = time.perf_counter() - runtime.started_monotonic
                self._log_job_event(
                    job_log,
                    "finalized",
                    {"duration_seconds": round(duration, 3)},
                )
            self._cleanup(resolved_base, resolved_loras)
            self._clear_cancellation(cancel_handle)
            self._clear_runtime(job.jobId)
            self._clear_job_log(job.jobId)

    def _register_cancellation(self, job: DispatchEnvelope) -> Optional[CancellationHandle]:
        token = (job.cancelToken or "").strip()
        if not token:
            self._cancel_handle = None
            return None
        handle = CancellationHandle(token=token, event=asyncio.Event(), job=job)
        self._cancel_handle = handle
        return handle

    def _clear_cancellation(self, handle: Optional[CancellationHandle]) -> None:
        if handle and self._cancel_handle is handle:
            self._cancel_handle = None

    def _start_runtime(self, job: DispatchEnvelope) -> JobRuntimeState:
        state = JobRuntimeState(
            heartbeat_seq=0,
            started_at=datetime.now(timezone.utc),
            started_monotonic=time.perf_counter(),
        )
        self._runtime[job.jobId] = state
        return state

    def _get_runtime(self, job_id: str) -> Optional[JobRuntimeState]:
        return self._runtime.get(job_id)

    def _clear_runtime(self, job_id: str) -> None:
        self._runtime.pop(job_id, None)

    def _clear_job_log(self, job_id: str) -> None:
        self._job_logs.pop(job_id, None)

    def _now_iso(self) -> str:
        now = datetime.now(timezone.utc)
        return now.isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def _create_job_log(self, job: DispatchEnvelope) -> Optional[JobLogHandle]:
        base_dir = self._job_log_dir
        try:
            base_dir.mkdir(parents=True, exist_ok=True)
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning("Failed to prepare job log directory %s: %s", base_dir, exc)
            fallback = self.config.paths.temp / "job-logs"
            try:
                fallback.mkdir(parents=True, exist_ok=True)
            except Exception:  # noqa: BLE001
                LOGGER.exception("Failed to prepare fallback job log directory %s", fallback)
                return None
            base_dir = fallback
            self._job_log_dir = fallback

        job_dir = base_dir / job.jobId
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        manifest_path = job_dir / f"manifest-{timestamp}.json"
        manifest_payload = {
            "schemaVersion": 1,
            "capturedAt": self._now_iso(),
            "job": job.dict(by_alias=True),
        }
        try:
            job_dir.mkdir(parents=True, exist_ok=True)
            with manifest_path.open("w", encoding="utf-8") as handle:
                json.dump(manifest_payload, handle, indent=2, ensure_ascii=False)
                handle.write("\n")
            events_path = job_dir / "events.jsonl"
            events_path.touch(exist_ok=True)
        except Exception:  # noqa: BLE001
            LOGGER.exception("Failed to persist manifest for job %s", job.jobId)
            return None

        log_handle = JobLogHandle(job.jobId, job_dir, manifest_path, events_path)
        self._job_logs[job.jobId] = log_handle
        return log_handle

    def _log_job_event(
        self,
        log_handle: Optional[JobLogHandle],
        event: str,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not log_handle:
            return
        entry: Dict[str, Any] = {"timestamp": self._now_iso(), "event": event}
        if details:
            entry["details"] = details
        try:
            with log_handle.events_path.open("a", encoding="utf-8") as stream:
                json.dump(entry, stream, ensure_ascii=False)
                stream.write("\n")
        except Exception:  # noqa: BLE001
            LOGGER.warning(
                "Failed to record %s event for job %s", event, log_handle.job_id, exc_info=True
            )

    def _build_log_context(
        self,
        base_model: Optional[ResolvedAsset],
        loras: Sequence[ResolvedAsset],
        job: DispatchEnvelope,
        resolved_params: Dict[str, object],
    ) -> Dict[str, Any]:
        details: Dict[str, Any] = {
            "base_model": base_model.comfy_name if base_model else None,
            "loras": [lora.comfy_name for lora in loras] if loras else [],
            "output_bucket": job.output.bucket,
            "output_prefix": job.output.prefix,
        }
        resolution = job.parameters.resolution
        if resolution:
            details["resolution"] = {"width": resolution.width, "height": resolution.height}
        prompt_text = resolved_params.get("prompt") or job.parameters.prompt or ""
        negative_text = resolved_params.get("negative_prompt") or job.parameters.negativePrompt or ""
        details["prompt"] = prompt_text
        details["negative_prompt"] = negative_text
        seed = resolved_params.get("seed", job.parameters.seed)
        if seed is not None:
            details["seed"] = seed
        cfg_scale = resolved_params.get("cfg_scale") or resolved_params.get("cfg")
        if cfg_scale is not None:
            details["cfg_scale"] = cfg_scale
        steps = resolved_params.get("steps") or job.parameters.steps
        if steps is not None:
            details["steps"] = steps
        sampler = resolved_params.get("sampler")
        scheduler = resolved_params.get("scheduler")
        if sampler is not None:
            details["sampler"] = sampler
        if scheduler is not None:
            details["scheduler"] = scheduler
        return {key: value for key, value in details.items() if value not in (None, {})}

    def _build_completion_log(
        self,
        upload_result: UploadResult,
        warnings: Sequence[str],
        prompt_id: Optional[str],
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "prompt_id": prompt_id,
            "uploaded": upload_result.uploaded,
        }
        if upload_result.missing:
            payload["missing"] = [path.name for path in upload_result.missing]
        if warnings:
            payload["warnings"] = list(warnings)
        return payload

    def _build_activity_snapshot(self, activity: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not activity:
            return None
        snapshot: Dict[str, Any] = {}
        pending = activity.get("pending")
        running = activity.get("running")
        if pending is not None:
            snapshot["queue_size"] = pending
        if running is not None:
            snapshot["executing"] = bool(running)
        raw = activity.get("raw")
        if raw is not None:
            snapshot["raw"] = raw
        return snapshot or None

    def _build_s3_url(self, bucket: str, key: str) -> Optional[str]:
        endpoint = (self.config.minio.endpoint or "").strip()
        if not endpoint:
            return None
        base = endpoint.rstrip("/")
        return f"{base}/{bucket}/{key}"

    def _coerce_simple_value(self, value: Any) -> Optional[Any]:
        if isinstance(value, (str, int, float, bool)):
            return value
        return None

    def _build_completion_params(
        self,
        job: DispatchEnvelope,
        base_model: ResolvedAsset,
        loras: List[ResolvedAsset],
        resolved_params: Dict[str, object],
    ) -> Dict[str, Any]:
        cfg_value = self._coerce_simple_value(
            resolved_params.get("cfg") or resolved_params.get("cfg_scale")
        )
        width_value = (
            job.parameters.resolution.width
            if job.parameters.resolution
            else self._coerce_simple_value(resolved_params.get("width"))
        )
        height_value = (
            job.parameters.resolution.height
            if job.parameters.resolution
            else self._coerce_simple_value(resolved_params.get("height"))
        )
        params: Dict[str, Any] = {
            "model": base_model.comfy_name,
            "vae": self._coerce_simple_value(
                resolved_params.get("vae_name") or resolved_params.get("vae")
            ),
            "clip": self._coerce_simple_value(
                resolved_params.get("clip_name") or resolved_params.get("clip")
            ),
            "seed": job.parameters.seed,
            "steps": job.parameters.steps
            or self._coerce_simple_value(resolved_params.get("steps")),
            "cfg": job.parameters.cfgScale or cfg_value,
            "sampler": self._coerce_simple_value(resolved_params.get("sampler")),
            "scheduler": self._coerce_simple_value(resolved_params.get("scheduler")),
            "denoise": self._coerce_simple_value(resolved_params.get("denoise")),
            "width": width_value,
            "height": height_value,
        }
        lora_entries = [
            {"name": entry.comfy_name}
            for entry in loras
        ]
        if lora_entries:
            params["loras"] = lora_entries
        return {key: value for key, value in params.items() if value is not None}

    def _map_failure_reason_code(self, category: FailureCategory) -> str:
        mapping = {
            FailureCategory.VALIDATION: "VALIDATION_ERROR",
            FailureCategory.TRANSIENT: "TRANSIENT_ERROR",
            FailureCategory.TIMEOUT: "TIMEOUT",
            FailureCategory.CANCELLED: "CANCELED",
            FailureCategory.SYSTEM: "SYSTEM_ERROR",
        }
        return mapping.get(category, "SYSTEM_ERROR")

    def _needs_model_refresh(self, base: Optional[ResolvedAsset], loras: List[ResolvedAsset]) -> bool:
        candidates: Iterable[ResolvedAsset] = [asset for asset in loras]
        if base:
            candidates = list(candidates) + [base]
        return any(asset.downloaded or asset.link_created for asset in candidates)

    async def _refresh_model_cache(self) -> None:
        self.comfyui.invalidate_object_cache()
        delay = max(0.0, self.config.comfyui.model_refresh_delay_seconds)
        if delay:
            await asyncio.sleep(delay)

    def _supports_symlinks(self, directory: Path) -> bool:
        resolved = directory.resolve()
        if resolved in self._symlink_support:
            return self._symlink_support[resolved]
        directory.mkdir(parents=True, exist_ok=True)
        token = uuid.uuid4().hex
        target = directory / f".vs-symlink-probe-target-{token}"
        link = directory / f".vs-symlink-probe-link-{token}"
        try:
            target.write_text("probe", encoding="utf-8")
            link.symlink_to(target)
        except OSError as exc:  # noqa: BLE001
            winerror = getattr(exc, "winerror", None)
            if exc.errno in SYMLINK_ERROR_CODES or winerror in {1314}:  # 1314: ERROR_PRIVILEGE_NOT_HELD
                LOGGER.warning(
                    "Symlinks appear to be unsupported in %s (%s); copying assets instead.",
                    directory,
                    exc,
                )
                self._symlink_support[resolved] = False
                return False
            raise
        finally:
            with contextlib.suppress(FileNotFoundError):
                link.unlink()
            with contextlib.suppress(FileNotFoundError):
                target.unlink()
        self._symlink_support[resolved] = True
        return True

    def _materialize_without_symlink(
        self,
        pretty_path: Path,
        cache_dir: Path,
        cache_name: str,
        source_name: str,
        asset: AssetRef,
        asset_kind: str,
        replace_existing: bool = False,
    ) -> Tuple[Path, bool, bool]:
        pretty_path.parent.mkdir(parents=True, exist_ok=True)
        if pretty_path.is_symlink():
            pretty_path.unlink(missing_ok=True)
        if replace_existing and pretty_path.exists():
            try:
                pretty_path.unlink()
            except IsADirectoryError:
                shutil.rmtree(pretty_path)
        created = not pretty_path.exists()
        downloaded = False
        if created or replace_existing:
            candidates = [cache_dir / cache_name, cache_dir / source_name]
            for candidate in candidates:
                if candidate.exists():
                    if candidate == pretty_path:
                        created = False
                        break
                    try:
                        candidate.replace(pretty_path)
                        LOGGER.debug(
                            "Migrated cached %s %s into %s", asset_kind, candidate, pretty_path
                        )
                        break
                    except Exception:  # noqa: BLE001
                        LOGGER.debug(
                            "Failed to migrate cached %s %s into %s", asset_kind, candidate, pretty_path, exc_info=True
                        )
            if not pretty_path.exists():
                LOGGER.info("Downloading %s %s", asset_kind, asset.key)
                self.minio.download_to_path(asset.bucket, asset.key, pretty_path)
                downloaded = True
        return pretty_path, downloaded, created

    def _ensure_base_model(self, base_model: AssetRef) -> ResolvedAsset:
        base_dir = self.config.paths.base_models
        cache_dir = base_dir / "cache"
        cache_dir.mkdir(parents=True, exist_ok=True)

        source_name = Path(base_model.key).name
        cache_name = ensure_extension(source_name)
        display_name = self._resolve_display_name(base_model, cache_name)
        pretty_path = base_dir / display_name

        use_symlink = self._supports_symlinks(base_dir)

        cache_path = (
            pretty_path
            if not use_symlink
            and pretty_path.exists()
            and pretty_path.is_file()
            and not pretty_path.is_symlink()
            else cache_dir / cache_name
        )
        legacy_cache = cache_dir / source_name
        if not cache_path.exists() and legacy_cache.exists():
            try:
                legacy_cache.rename(cache_path)
                LOGGER.debug("Migrated legacy base model cache %s to %s", legacy_cache, cache_path)
            except Exception:  # noqa: BLE001
                LOGGER.debug("Failed to migrate legacy cache %s", legacy_cache, exc_info=True)
        downloaded = False
        if not cache_path.exists():
            LOGGER.info("Downloading base model %s", base_model.key)
            self.minio.download_to_path(base_model.bucket, base_model.key, cache_path)
            downloaded = True

        if not use_symlink:
            link_path, direct_downloaded, created = self._materialize_without_symlink(
                pretty_path,
                cache_dir,
                cache_name,
                source_name,
                base_model,
                "base model",
            )
            comfy_name = normalize_name(link_path.name)
            return ResolvedAsset(
                asset=base_model,
                cache_path=link_path,
                comfy_name=comfy_name,
                symlink_path=link_path,
                downloaded=downloaded or direct_downloaded,
                link_created=created,
            )

        try:
            symlink_path, created = self._ensure_symlink(pretty_path, cache_path, base_model.key)
            comfy_name = normalize_name(symlink_path.name)
            return ResolvedAsset(
                asset=base_model,
                cache_path=cache_path,
                comfy_name=comfy_name,
                symlink_path=symlink_path,
                downloaded=downloaded,
                link_created=created,
            )
        except SymlinkCreationUnsupported:
            link_path, direct_downloaded, created = self._materialize_without_symlink(
                pretty_path,
                cache_dir,
                cache_name,
                source_name,
                base_model,
                "base model",
            )
            comfy_name = normalize_name(link_path.name)
            return ResolvedAsset(
                asset=base_model,
                cache_path=link_path,
                comfy_name=comfy_name,
                symlink_path=link_path,
                downloaded=downloaded or direct_downloaded,
                link_created=created,
            )

    def _prepare_primary_lora_cache(
        self,
        cache_dir: Path,
        cache_path: Path,
        override_name: str,
    ) -> Path:
        desired = cache_dir / override_name
        if cache_path == desired:
            return cache_path
        desired.parent.mkdir(parents=True, exist_ok=True)
        if desired.exists() or desired.is_symlink():
            try:
                if desired.samefile(cache_path):
                    return desired
            except FileNotFoundError:
                pass
            try:
                desired.unlink()
            except IsADirectoryError:
                shutil.rmtree(desired)
            except FileNotFoundError:
                pass
        try:
            cache_path.replace(desired)
            LOGGER.debug(
                "Retitled primary LoRA cache %s to %s", cache_path, desired
            )
            return desired
        except Exception:  # noqa: BLE001
            LOGGER.debug(
                "Failed to rename primary LoRA cache %s to %s; copying instead",
                cache_path,
                desired,
                exc_info=True,
            )
            desired.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(cache_path, desired)
            cache_path.unlink(missing_ok=True)
            LOGGER.debug(
                "Copied primary LoRA cache %s into %s after rename failure",
                cache_path,
                desired,
            )
            return desired

    def _ensure_loras(self, job: DispatchEnvelope) -> List[ResolvedAsset]:
        resolved: List[ResolvedAsset] = []
        if not job.loras:
            return resolved
        lookup = self._build_lora_filename_lookup(job)
        primary_override = self._extract_primary_lora_name(job)
        cache_dir = self.config.paths.loras
        legacy_cache_dir = cache_dir / "cache"
        cache_dir.mkdir(parents=True, exist_ok=True)

        use_symlink = self._supports_symlinks(cache_dir)

        used_visible: Set[str] = set()

        for index, asset in enumerate(job.loras):
            source_name = Path(asset.key).name
            cache_name = ensure_extension(source_name)
            is_primary = index == 0 and primary_override is not None
            if is_primary:
                override = ensure_extension(primary_override)
                display_candidate = override
            else:
                override = ensure_extension(self._resolve_lora_filename(asset, lookup))
                display_candidate = self._resolve_display_name(asset, override)
            visible_name = self._build_visible_lora_name(job, asset, display_candidate, index, used_visible)
            pretty_path = cache_dir / visible_name
            cache_path = (
                pretty_path
                if not use_symlink
                and pretty_path.exists()
                and pretty_path.is_file()
                and not pretty_path.is_symlink()
                else cache_dir / cache_name
            )
            if not cache_path.exists() and legacy_cache_dir.exists():
                legacy_candidates = [legacy_cache_dir / cache_name, legacy_cache_dir / source_name]
                for legacy_cache in legacy_candidates:
                    if not legacy_cache.exists():
                        continue
                    try:
                        legacy_cache.rename(cache_path)
                        LOGGER.debug(
                            "Migrated legacy LoRA cache %s to %s",
                            legacy_cache,
                            cache_path,
                        )
                        break
                    except Exception:  # noqa: BLE001
                        LOGGER.debug(
                            "Failed to migrate legacy LoRA cache %s",
                            legacy_cache,
                            exc_info=True,
                        )
            downloaded = False
            if not cache_path.exists():
                LOGGER.info("Downloading LoRA %s", asset.key)
                self.minio.download_to_path(asset.bucket, asset.key, cache_path)
                downloaded = True

            if is_primary and cache_path.parent == cache_dir:
                cache_path = self._prepare_primary_lora_cache(cache_dir, cache_path, override)
                cache_name = cache_path.name
            elif cache_path.parent == cache_dir:
                cache_name = cache_path.name

            if not use_symlink:
                link_path, direct_downloaded, created = self._materialize_without_symlink(
                    pretty_path,
                    cache_dir,
                    cache_name,
                    source_name,
                    asset,
                    "LoRA",
                    replace_existing=is_primary,
                )
                comfy_name = normalize_name(link_path.name)
                resolved.append(
                    ResolvedAsset(
                        asset=asset,
                        cache_path=link_path,
                        comfy_name=comfy_name,
                        symlink_path=link_path,
                        downloaded=downloaded or direct_downloaded,
                        link_created=created,
                    )
                )
                continue

            try:
                symlink_path, created = self._ensure_symlink(
                    pretty_path,
                    cache_path,
                    asset.key,
                    replace_existing=is_primary,
                )
                comfy_name = normalize_name(symlink_path.name)
                resolved.append(
                    ResolvedAsset(
                        asset=asset,
                        cache_path=cache_path,
                        comfy_name=comfy_name,
                        symlink_path=symlink_path,
                        downloaded=downloaded,
                        link_created=created,
                    )
                )
            except SymlinkCreationUnsupported:
                use_symlink = False
                link_path, direct_downloaded, created = self._materialize_without_symlink(
                    pretty_path,
                    cache_dir,
                    cache_name,
                    source_name,
                    asset,
                    "LoRA",
                    replace_existing=is_primary,
                )
                comfy_name = normalize_name(link_path.name)
                resolved.append(
                    ResolvedAsset(
                        asset=asset,
                        cache_path=link_path,
                        comfy_name=comfy_name,
                        symlink_path=link_path,
                        downloaded=downloaded or direct_downloaded,
                        link_created=created,
                    )
                )
        return resolved

    def _resolve_display_name(self, asset: AssetRef, fallback: str) -> str:
        candidate = asset.display_name or asset.original_name
        if not candidate:
            metadata = self.minio.get_object_metadata(asset.bucket, asset.key)
            candidate = metadata.get("original-name") or metadata.get("original_name") or metadata.get("display-name")
        return derive_pretty_name(candidate, fallback)

    def _ensure_symlink(
        self,
        desired: Path,
        target: Path,
        source_key: str,
        replace_existing: bool = False,
    ) -> Tuple[Path, bool]:
        if desired == target:
            return desired, False
        desired.parent.mkdir(parents=True, exist_ok=True)
        suffix = build_collision_suffix(source_key)
        candidate = desired
        while True:
            if candidate.exists() or candidate.is_symlink():
                try:
                    if candidate.samefile(target):
                        return candidate, False
                except FileNotFoundError:
                    try:
                        candidate.unlink()
                    except FileNotFoundError:
                        pass
                    continue
                if replace_existing:
                    try:
                        candidate.unlink()
                    except IsADirectoryError:
                        shutil.rmtree(candidate)
                    except FileNotFoundError:
                        pass
                    continue
                new_name = f"{candidate.stem}__{suffix}{candidate.suffix or target.suffix or '.safetensors'}"
                candidate = candidate.with_name(new_name)
                continue
            try:
                candidate.symlink_to(target)
            except OSError as exc:  # noqa: BLE001
                winerror = getattr(exc, "winerror", None)
                if exc.errno in SYMLINK_ERROR_CODES or winerror in {1314}:
                    resolved_parent = candidate.parent.resolve()
                    self._symlink_support[resolved_parent] = False
                    raise SymlinkCreationUnsupported(resolved_parent, exc) from exc
                raise
            return candidate, True

    def _build_lora_filename_lookup(self, job: DispatchEnvelope) -> Dict[str, str]:
        lookup: Dict[str, str] = {}
        extra = job.parameters.extra or {}
        lora_entries = extra.get("loras")
        if not isinstance(lora_entries, list):
            return lookup
        for entry in lora_entries:
            if not isinstance(entry, dict):
                continue
            filename = entry.get("filename")
            if not isinstance(filename, str) or not filename:
                filename = entry.get("originalName")
            if not isinstance(filename, str):
                continue
            sanitized = normalize_name(filename)
            if not sanitized:
                continue
            key_value = entry.get("key")
            if isinstance(key_value, str) and key_value:
                lookup[key_value] = sanitized
                lookup[Path(key_value).name] = sanitized
            identifier = entry.get("id")
            if isinstance(identifier, str) and identifier:
                lookup[identifier] = sanitized
            slug = entry.get("slug")
            if isinstance(slug, str) and slug:
                lookup[slug] = sanitized
        return lookup

    def _extract_primary_lora_name(self, job: DispatchEnvelope) -> Optional[str]:
        extra = job.parameters.extra or {}
        primary = extra.get("primary_lora_name")
        if isinstance(primary, str):
            sanitized = normalize_name(primary)
            if sanitized:
                return sanitized
        return None

    def _resolve_lora_filename(self, asset: AssetRef, lookup: Dict[str, str]) -> str:
        if asset.original_name:
            original = normalize_name(asset.original_name)
            if original:
                return original
        if asset.display_name:
            display = normalize_name(asset.display_name)
            if display:
                return display
        key = asset.key
        candidates = [key, Path(key).name]
        for candidate in candidates:
            if candidate in lookup:
                return lookup[candidate]
        return Path(key).name

    def _sanitize_text(self, value: Optional[str]) -> str:
        if value is None:
            return ""
        return str(value).strip()

    def _coerce_positive_int(self, value: Any) -> Optional[int]:
        candidate = self._as_float(value)
        if candidate is None:
            return None
        normalized = int(round(candidate))
        if normalized > 0:
            return normalized
        return None

    def _require_positive_int(self, value: Any, field: str) -> int:
        normalized = self._coerce_positive_int(value)
        if normalized is None:
            raise ValidationFailure(f"Job parameter '{field}' must be a positive integer")
        return normalized

    def _require_cfg_scale(self, value: Any) -> float:
        candidate = self._as_float(value)
        if candidate is None or candidate <= 0:
            raise ValidationFailure("Job parameter 'cfgScale' must be a positive number")
        return round(candidate, 2)

    def _generate_seed(self) -> int:
        return secrets.randbelow(1_000_000_000)

    def _normalize_seed_value(self, value: Any) -> int:
        if isinstance(value, (int, float)) and isfinite(value):
            normalized = abs(int(value))
            return normalized % 1_000_000_000
        return self._generate_seed()

    def _require_resolution(self, resolution: Optional[Resolution]) -> Resolution:
        if resolution is None:
            raise ValidationFailure("Job parameter 'resolution' must include width and height values")
        width = self._require_positive_int(resolution.width, "resolution.width")
        height = self._require_positive_int(resolution.height, "resolution.height")
        return Resolution(width=width, height=height)

    def _slugify_component(self, value: str, fallback: str, *, length: int = 32) -> str:
        base = normalize_name(value) if value else ""
        candidate = base or fallback
        candidate = re.sub(r"[^A-Za-z0-9_-]+", "-", candidate).strip("-_.")
        if not candidate:
            candidate = fallback
        if len(candidate) > length:
            trimmed = candidate[:length].rstrip("-_.")
            candidate = trimmed or candidate[:length]
        return candidate or fallback

    def _build_visible_lora_name(
        self,
        job: DispatchEnvelope,
        asset: AssetRef,
        display_name: str,
        index: int,
        used: Set[str],
    ) -> str:
        base = self._slugify_component(Path(display_name).stem or f"lora{index + 1}", f"lora{index + 1}")
        owner_source = job.user.username or job.user.id
        owner = self._slugify_component(owner_source, "user", length=12)
        job_short = build_collision_suffix(job.jobId, length=6)
        candidate = f"{base}__{owner}__{job_short}.safetensors"
        counter = 1
        while candidate in used:
            suffix = build_collision_suffix(f"{asset.key}:{counter}", length=6)
            candidate = f"{base}__{owner}__{job_short}__{suffix}.safetensors"
            counter += 1
        used.add(candidate)
        return candidate
    def _build_parameter_context(
        self,
        job: DispatchEnvelope,
        base_model: ResolvedAsset,
        loras: List[ResolvedAsset],
    ) -> Dict[str, object]:
        prompt = self._sanitize_text(job.parameters.prompt)
        negative = self._sanitize_text(job.parameters.negativePrompt)
        steps = self._require_positive_int(job.parameters.steps, "steps")
        cfg_scale = self._require_cfg_scale(job.parameters.cfgScale)
        seed = self._normalize_seed_value(job.parameters.seed)
        resolution = self._require_resolution(job.parameters.resolution)

        job.parameters.prompt = prompt
        job.parameters.negativePrompt = negative
        job.parameters.steps = steps
        job.parameters.cfgScale = cfg_scale
        job.parameters.seed = seed
        job.parameters.resolution = resolution

        context: Dict[str, object] = {
            "prompt": prompt,
            "negative_prompt": negative,
            "seed": seed,
            "cfg_scale": cfg_scale,
            "steps": steps,
            "width": resolution.width,
            "height": resolution.height,
            "base_model_path": base_model.comfy_name,
            "base_model_name": base_model.comfy_name,
            "base_model_full_path": str(base_model.cache_path),
            "loras": [entry.comfy_name for entry in loras],
        }
        extra_payload = job.parameters.extra or {}
        lora_metadata = self._extract_lora_metadata(extra_payload)
        if lora_metadata:
            context["loras_metadata"] = lora_metadata
        primary_lora_context = self._derive_primary_lora_context(loras, lora_metadata)
        context.update(primary_lora_context)
        defaults = self.config.workflow_defaults or {}
        for key, value in defaults.items():
            if key in self._RESERVED_DEFAULT_KEYS and key not in self._RESERVED_KEYS_WITH_DEFAULTS:
                continue
            if key not in context and value is not None:
                context[key] = value
        for key, value in extra_payload.items():
            if key in {"loras", "primary_lora_name", "primary_lora_strength_model", "primary_lora_strength_clip"}:
                continue
            if key in self._RESERVED_DEFAULT_KEYS and key not in self._RESERVED_KEYS_WITH_DEFAULTS:
                continue
            context[key] = value
        self._validate_parameter_context(context)
        return {key: value for key, value in context.items() if value is not None}

    def _validate_parameter_context(self, context: Dict[str, Any]) -> None:
        errors: List[str] = []

        for key in ("steps", "width", "height"):
            normalized = self._coerce_positive_int(context.get(key))
            if normalized is None:
                errors.append(key)
            else:
                context[key] = normalized

        cfg_value = self._as_float(context.get("cfg_scale"))
        if cfg_value is None or cfg_value <= 0:
            errors.append("cfg_scale")
        else:
            context["cfg_scale"] = round(cfg_value, 2)

        for key in ("sampler", "scheduler"):
            value = context.get(key)
            if isinstance(value, str):
                trimmed = value.strip()
                if trimmed:
                    context[key] = trimmed
                    continue
            errors.append(key)

        if errors:
            missing = ", ".join(sorted(errors))
            raise ValidationFailure(
                f"Missing or invalid required workflow parameters: {missing}"
            )

    def _values_match(self, expected: Any, actual: Any) -> bool:
        if isinstance(expected, int):
            numeric = self._as_float(actual)
            if numeric is None:
                return False
            return abs(numeric - expected) < 0.5
        if isinstance(expected, float):
            numeric = self._as_float(actual)
            if numeric is None:
                return False
            return abs(numeric - expected) <= 1e-3
        if isinstance(expected, str):
            actual_str = str(actual or "").strip()
            return actual_str == expected.strip()
        return actual == expected

    def _resolve_workflow_value(
        self,
        workflow: Dict[str, Any],
        node_id: int,
        path: str,
        parameter: str,
    ) -> Any:
        node = workflow.get(str(node_id))
        if not isinstance(node, dict):
            node = workflow.get(node_id)
        if not isinstance(node, dict):
            raise ValidationFailure(f"Workflow node {node_id} missing for parameter '{parameter}'")
        target: Any = node
        for part in path.split("."):
            if isinstance(target, dict) and part in target:
                target = target[part]
            else:
                raise ValidationFailure(
                    f"Workflow node {node_id} missing path '{path}' for parameter '{parameter}'"
                )
        return target

    def _validate_workflow_bindings(
        self,
        job: DispatchEnvelope,
        workflow: Dict[str, Any],
        resolved_params: Dict[str, Any],
    ) -> None:
        if not job.workflowParameters:
            return

        mismatches: List[str] = []
        for binding in job.workflowParameters:
            parameter = binding.parameter
            if parameter not in resolved_params:
                continue
            try:
                actual = self._resolve_workflow_value(
                    workflow, binding.node, binding.path, parameter
                )
            except ValidationFailure as exc:
                mismatches.append(str(exc))
                continue
            expected = resolved_params[parameter]
            if not self._values_match(expected, actual):
                mismatches.append(
                    f"Parameter '{parameter}' resolved to {expected!r} but workflow has {actual!r} on node {binding.node} ({binding.path})"
                )

        if mismatches:
            raise ValidationFailure("; ".join(mismatches))

    def _validate_prompt_connections(self, workflow: Dict[str, Any]) -> None:
        lookup: Dict[str, Dict[str, Any]] = {
            str(node_id): node
            for node_id, node in workflow.items()
            if isinstance(node, dict)
        }
        issues: List[str] = []
        for node_id, node in lookup.items():
            class_type = str(node.get("class_type") or "").lower()
            if class_type != "ksampler":
                continue
            inputs = node.get("inputs")
            if not isinstance(inputs, dict):
                issues.append(f"KSampler node {node_id} missing inputs map")
                continue
            for key in ("positive", "negative"):
                ref = self._as_connection_ref(inputs.get(key))
                if not ref:
                    issues.append(f"KSampler node {node_id} missing '{key}' connection")
                    continue
                target_id, _ = ref
                target = lookup.get(str(target_id))
                if not isinstance(target, dict):
                    issues.append(
                        f"KSampler node {node_id} {key} input targets unknown node {target_id}"
                    )
                    continue
                target_type = str(target.get("class_type") or "").lower()
                if "cliptextencode" not in target_type:
                    issues.append(
                        f"KSampler node {node_id} {key} input targets non-CLIP node {target_id} ({target.get('class_type')})"
                    )

        if issues:
            raise ValidationFailure("; ".join(issues))

    def _extract_lora_metadata(self, extra: Dict[str, Any]) -> List[Dict[str, Any]]:
        entries = extra.get("loras") if isinstance(extra, dict) else None
        if not isinstance(entries, list):
            return []
        metadata: List[Dict[str, Any]] = []
        for entry in entries:
            if isinstance(entry, dict):
                metadata.append(dict(entry))
        return metadata

    def _derive_primary_lora_context(
        self,
        loras: Sequence[ResolvedAsset],
        metadata: Sequence[Dict[str, Any]],
    ) -> Dict[str, Any]:
        if not loras:
            return {}
        primary = loras[0]
        payload = self._match_lora_metadata(primary, metadata)
        strength = self._normalize_strength(self._extract_strength_value(payload))
        return {
            "primary_lora_name": primary.comfy_name,
            "primary_lora_strength_model": strength,
            "primary_lora_strength_clip": strength,
        }

    def _collect_lora_nodes(self, workflow: Dict[str, Any]) -> List[Tuple[str, Dict[str, Any]]]:
        nodes: List[Tuple[str, Dict[str, Any]]] = []
        for key, node in workflow.items():
            if not isinstance(node, dict):
                continue
            class_type = str(node.get("class_type") or "").lower()
            if class_type == "loraloader":
                nodes.append((str(key), node))
        nodes.sort(key=lambda item: int(item[0]) if str(item[0]).isdigit() else 0)
        return nodes

    def _as_connection_ref(self, value: Any) -> Optional[Tuple[str, int]]:
        if isinstance(value, (list, tuple)) and len(value) == 2:
            target, index = value
            if isinstance(target, (str, int)) and isinstance(index, (int, float)):
                return str(target), int(index)
        return None

    def _allocate_node_id(self, workflow: Dict[str, Any]) -> str:
        max_id = 0
        for key in workflow.keys():
            if isinstance(key, int):
                max_id = max(max_id, key)
            elif isinstance(key, str) and key.isdigit():
                max_id = max(max_id, int(key))
        return str(max_id + 1)

    def _redirect_connections(
        self,
        workflow: Dict[str, Any],
        mapping: Dict[str, Dict[int, Tuple[str, int]]],
        *,
        skip_nodes: Optional[Set[str]] = None,
    ) -> None:
        skip = {str(node) for node in skip_nodes} if skip_nodes else set()
        for node_id, node in workflow.items():
            if str(node_id) in skip or not isinstance(node, dict):
                continue
            inputs = node.get("inputs")
            if not isinstance(inputs, dict):
                continue
            for key, value in list(inputs.items()):
                ref = self._as_connection_ref(value)
                if not ref:
                    continue
                target, index = ref
                replacement = mapping.get(target, {}).get(index)
                if not replacement:
                    continue
                inputs[key] = [str(replacement[0]), replacement[1]]

    def _apply_lora_chain(
        self,
        workflow: Dict[str, Any],
        loras: Sequence[ResolvedAsset],
        resolved_params: Dict[str, Any],
    ) -> List[Tuple[str, float]]:
        lora_nodes = self._collect_lora_nodes(workflow)
        if not lora_nodes:
            return []

        template_id, template_node = lora_nodes[0]
        inputs = template_node.setdefault("inputs", {})
        upstream_model = self._as_connection_ref(inputs.get("model"))
        upstream_clip = self._as_connection_ref(inputs.get("clip"))
        if upstream_model is None or upstream_clip is None:
            return []

        metadata_entries = resolved_params.get("loras_metadata")
        metadata = metadata_entries if isinstance(metadata_entries, list) else []

        applied: List[Tuple[str, float]] = []
        redirect: Dict[str, Dict[int, Tuple[str, int]]] = {}

        for extra_id, _ in lora_nodes[1:]:
            workflow.pop(extra_id, None)
            redirect[extra_id] = {0: upstream_model, 1: upstream_clip}

        if not loras:
            workflow.pop(template_id, None)
            redirect[template_id] = {0: upstream_model, 1: upstream_clip}
            self._redirect_connections(workflow, redirect)
            return []

        prototype = copy.deepcopy(template_node)
        keep_nodes: Set[str] = {template_id}
        last_node_id = template_id

        for index, asset in enumerate(loras):
            payload = self._match_lora_metadata(asset, metadata)
            strength = self._normalize_strength(self._extract_strength_value(payload))
            if index == 0:
                inputs["model"] = [upstream_model[0], upstream_model[1]]
                inputs["clip"] = [upstream_clip[0], upstream_clip[1]]
                inputs["lora_name"] = asset.comfy_name
                inputs["strength_model"] = strength
                inputs["strength_clip"] = strength
                applied.append((asset.comfy_name, strength))
                continue

            new_id = self._allocate_node_id(workflow)
            new_node = copy.deepcopy(prototype)
            new_inputs = new_node.setdefault("inputs", {})
            new_inputs["model"] = [last_node_id, 0]
            new_inputs["clip"] = [last_node_id, 1]
            new_inputs["lora_name"] = asset.comfy_name
            new_inputs["strength_model"] = strength
            new_inputs["strength_clip"] = strength
            new_node["id"] = int(new_id) if new_id.isdigit() else new_id
            workflow[new_id] = new_node
            keep_nodes.add(new_id)
            last_node_id = new_id
            applied.append((asset.comfy_name, strength))

        if applied:
            redirect[template_id] = {0: (last_node_id, 0), 1: (last_node_id, 1)}
        self._redirect_connections(workflow, redirect, skip_nodes=keep_nodes)
        return applied

    def _synchronize_lora_context(
        self,
        job: DispatchEnvelope,
        resolved_params: Dict[str, Any],
        resolved_loras: Sequence[ResolvedAsset],
        applied_loras: Sequence[Tuple[str, float]],
    ) -> None:
        extra = job.parameters.extra or {}
        names = [name for name, _ in applied_loras]
        strengths = {name: strength for name, strength in applied_loras}
        if applied_loras:
            primary_name, primary_strength = applied_loras[0]
            resolved_params["primary_lora_name"] = primary_name
            resolved_params["primary_lora_strength_model"] = primary_strength
            resolved_params["primary_lora_strength_clip"] = primary_strength
            extra["primary_lora_name"] = primary_name
            extra["primary_lora_strength_model"] = primary_strength
            extra["primary_lora_strength_clip"] = primary_strength
        else:
            for key in ("primary_lora_name", "primary_lora_strength_model", "primary_lora_strength_clip"):
                resolved_params.pop(key, None)
                extra.pop(key, None)

        metadata_entries = extra.get("loras") if isinstance(extra, dict) else None
        if isinstance(metadata_entries, list) and resolved_loras:
            for index, entry in enumerate(metadata_entries):
                if not isinstance(entry, dict):
                    continue
                if index < len(resolved_loras):
                    entry["filename"] = resolved_loras[index].comfy_name
                    original = resolved_loras[index].asset.original_name or entry.get("originalName")
                    if isinstance(original, str) and original:
                        entry["originalName"] = normalize_name(original)
                    strength = strengths.get(resolved_loras[index].comfy_name)
                    if strength is not None:
                        entry["strength"] = strength
        elif not applied_loras and isinstance(extra, dict):
            extra.pop("loras", None)

        job.parameters.extra = extra
        resolved_params["loras"] = names

    async def _ensure_lora_visibility(self, loras: Sequence[ResolvedAsset]) -> None:
        names = [entry.comfy_name for entry in loras if entry.comfy_name]
        if not names:
            return
        try:
            await self.comfyui.ensure_allowed_names("lora_name", names)
        except Exception:  # noqa: BLE001
            LOGGER.debug("Failed to confirm LoRA visibility in object_info", exc_info=True)

    async def _persist_applied_workflow(
        self,
        log_handle: Optional[JobLogHandle],
        job: DispatchEnvelope,
        workflow: Dict[str, Any],
    ) -> None:
        directory = log_handle.directory if log_handle else self.config.paths.outputs / "logs" / job.jobId
        try:
            directory.mkdir(parents=True, exist_ok=True)
            path = directory / "applied-workflow.json"
            payload = {"prompt": workflow, "client_id": self.config.comfyui.client_id}
            with path.open("w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2, ensure_ascii=False)
                handle.write("\n")
        except Exception:  # noqa: BLE001
            LOGGER.debug("Failed to persist applied workflow for job %s", job.jobId, exc_info=True)

    async def _update_job_manifest(
        self,
        log_handle: Optional[JobLogHandle],
        job: DispatchEnvelope,
        resolved_params: Dict[str, Any],
        workflow: Dict[str, Any],
    ) -> None:
        if not log_handle:
            return
        snapshot = {
            "schemaVersion": 1,
            "capturedAt": self._now_iso(),
            "job": job.dict(by_alias=True),
            "resolvedParameters": resolved_params,
            "workflow": workflow,
        }
        try:
            with log_handle.manifest_path.open("w", encoding="utf-8") as handle:
                json.dump(snapshot, handle, indent=2, ensure_ascii=False)
                handle.write("\n")
        except Exception:  # noqa: BLE001
            LOGGER.debug("Failed to update manifest for job %s", job.jobId, exc_info=True)
    def _match_lora_metadata(
        self,
        target: ResolvedAsset,
        metadata: Sequence[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        target_name = target.comfy_name
        for entry in metadata:
            for field in ("filename", "key", "name", "title", "id", "slug"):
                value = entry.get(field)
                if isinstance(value, str) and normalize_name(value) == target_name:
                    return entry
        return metadata[0] if metadata else None

    def _extract_strength_value(self, payload: Optional[Dict[str, Any]]) -> Optional[float]:
        if not payload:
            return None
        for field in ("strength_model", "strength_clip", "strength"):
            candidate = payload.get(field)
            normalized = self._as_float(candidate)
            if normalized is not None:
                return normalized
        return None

    def _normalize_strength(self, value: Optional[float]) -> float:
        if value is None:
            return 1.0
        clamped = max(-2.0, min(2.0, value))
        return round(clamped, 2)

    def _as_float(self, value: Any) -> Optional[float]:
        if isinstance(value, (int, float)):
            numeric = float(value)
        elif isinstance(value, str):
            try:
                numeric = float(value)
            except ValueError:
                return None
        else:
            return None
        if not isfinite(numeric):
            return None
        return numeric

    def _upload_outputs(
        self,
        job: DispatchEnvelope,
        outputs: List[OutputImage],
        base_model: ResolvedAsset,
        loras: List[ResolvedAsset],
        resolved_params: Dict[str, Any],
    ) -> UploadResult:
        uploaded_keys: List[str] = []
        missing_files: List[Path] = []
        artifact_records: List[ArtifactRecord] = []
        output_root = Path(self.config.paths.outputs)
        seed_value = str(resolved_params.get("seed", job.parameters.seed or 0))
        lora_entries = resolved_params.get("loras")
        if not lora_entries:
            lora_entries = [entry.comfy_name for entry in loras]
        lora_names = ",".join(lora_entries) if lora_entries else ""
        prompt_text = resolved_params.get("prompt") or job.parameters.prompt or ""
        negative_text = resolved_params.get("negative_prompt") or job.parameters.negativePrompt or ""
        steps_value = resolved_params.get("steps", job.parameters.steps or "")

        for index, image in enumerate(outputs, start=1):
            output_dir = output_root / image.subfolder if image.subfolder else output_root
            source = output_dir / image.filename
            if not source.exists():
                LOGGER.warning("Expected output missing: %s", source)
                missing_files.append(source)
                continue
            ext = Path(image.filename).suffix or ".png"
            destination_key = f"comfy-outputs/{job.jobId}/{index:02d}_{seed_value}{ext}"
            sha_value = compute_sha256(source)
            metadata = {
                "prompt": prompt_text,
                "negative_prompt": negative_text,
                "seed": seed_value,
                "steps": str(steps_value),
                "user": job.user.username,
                "job_id": job.jobId,
                "model": base_model.comfy_name,
                "loras": lora_names,
                "image_type": image.image_type or "output",
                "sha256": sha_value,
            }
            self.minio.upload_file(job.output.bucket, destination_key, source, metadata)
            uploaded_keys.append(destination_key)

            rel_path = image.filename if not image.subfolder else f"{image.subfolder.rstrip('/')}/{image.filename}"
            abs_path = str(source.resolve())
            mime, _ = mimetypes.guess_type(image.filename)
            artifact_records.append(
                ArtifactRecord(
                    node_id=image.node_id,
                    filename=image.filename,
                    subfolder=image.subfolder,
                    rel_path=rel_path,
                    abs_path=abs_path,
                    mime=mime or "image/png",
                    sha256=sha_value,
                    size_bytes=source.stat().st_size,
                    s3_bucket=job.output.bucket,
                    s3_key=destination_key,
                    s3_url=self._build_s3_url(job.output.bucket, destination_key),
                )
            )
        return UploadResult(uploaded=uploaded_keys, missing=missing_files, artifacts=artifact_records)

    def _cleanup(self, base_model: Optional[ResolvedAsset], loras: List[ResolvedAsset]) -> None:
        if base_model and self.config.cleanup.delete_downloaded_models:
            if base_model.asset.cacheStrategy != "persistent" and base_model.downloaded:
                try:
                    LOGGER.info("Removing temporary model %s", base_model.cache_path)
                    base_model.cache_path.unlink(missing_ok=True)
                except Exception as exc:  # noqa: BLE001
                    LOGGER.warning("Failed to remove model %s: %s", base_model.cache_path, exc)
            if (
                base_model.asset.cacheStrategy != "persistent"
                and base_model.link_created
                and base_model.symlink_path.is_symlink()
            ):
                try:
                    base_model.symlink_path.unlink(missing_ok=True)
                except Exception as exc:  # noqa: BLE001
                    LOGGER.debug("Failed to remove model symlink %s: %s", base_model.symlink_path, exc)

        if self.config.cleanup.delete_downloaded_loras:
            for entry in loras:
                if entry.asset.cacheStrategy == "persistent":
                    continue
                if entry.downloaded:
                    try:
                        LOGGER.info("Removing temporary LoRA %s", entry.cache_path)
                        entry.cache_path.unlink(missing_ok=True)
                    except Exception as exc:  # noqa: BLE001
                        LOGGER.warning("Failed to remove LoRA %s: %s", entry.cache_path, exc)
                if entry.link_created and entry.symlink_path.is_symlink():
                    try:
                        entry.symlink_path.unlink(missing_ok=True)
                    except Exception as exc:  # noqa: BLE001
                        LOGGER.debug("Failed to remove LoRA symlink %s: %s", entry.symlink_path, exc)

    def _normalize_failure_reason(self, reason: Optional[str]) -> str:
        if not reason:
            return "GPU worker reported an unknown failure."
        normalized = str(reason).strip()
        if not normalized:
            return "GPU worker reported an unknown failure."
        if len(normalized) > 500:
            return f"{normalized[:497]}…"
        return normalized

    async def _emit_status(
        self,
        job: DispatchEnvelope,
        state: GeneratorState,
        *,
        message: Optional[str] = None,
        progress: Optional[Dict[str, Any]] = None,
        prompt_id: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> None:
        if not job.callbacks or not job.callbacks.status:
            return
        runtime = self._get_runtime(job.jobId)
        prompt = prompt_id or (runtime.prompt_id if runtime else None)
        if runtime:
            if prompt_id:
                runtime.prompt_id = prompt_id
            runtime.heartbeat_seq += 1
            heartbeat_seq = runtime.heartbeat_seq
        else:
            heartbeat_seq = 0
        try:
            activity = await self.describe_activity()
        except Exception as exc:  # noqa: BLE001
            LOGGER.debug("Failed to capture ComfyUI activity snapshot: %s", exc)
            activity = None
        snapshot = self._build_activity_snapshot(activity)
        payload: Dict[str, Any] = {
            "job_id": job.jobId,
            "client_id": self.config.comfyui.client_id,
            "state": state.value,
            "timestamp": self._now_iso(),
            "heartbeat_seq": heartbeat_seq,
        }
        if prompt:
            payload["prompt_id"] = prompt
        if message:
            payload["message"] = message
        if progress:
            payload["progress"] = progress
        if reason:
            payload["reason"] = reason
        if snapshot:
            payload["activity_snapshot"] = snapshot
        idempotency_key = f"{job.jobId}-{state.value}-{heartbeat_seq}"
        await self._post_callback(job.callbacks.status, payload, idempotency_key=idempotency_key)

    async def _emit_completion(
        self,
        job: DispatchEnvelope,
        upload_result: UploadResult,
        warnings: Optional[List[str]],
        base_model: ResolvedAsset,
        loras: List[ResolvedAsset],
        resolved_params: Dict[str, object],
        history: Optional[Dict[str, Any]],
    ) -> None:
        await self._emit_status(
            job,
            GeneratorState.SUCCESS,
            message="Job completed",
            progress={"phase": "complete", "percent": 100},
        )
        if not job.callbacks or not job.callbacks.completion:
            return
        runtime = self._get_runtime(job.jobId)
        started_at_iso = (
            runtime.started_at.isoformat(timespec="milliseconds").replace("+00:00", "Z")
            if runtime
            else None
        )
        finished_at_iso = self._now_iso()
        status_payload = history.get("status") if isinstance(history, dict) else None
        status_str = None
        if isinstance(status_payload, dict):
            status_str = status_payload.get("status") or status_payload.get("status_str")
        artifacts_payload = [artifact.to_callback_payload() for artifact in upload_result.artifacts]
        params_payload = self._build_completion_params(job, base_model, loras, resolved_params)
        payload: Dict[str, Any] = {
            "job_id": job.jobId,
            "client_id": self.config.comfyui.client_id,
            "state": GeneratorState.SUCCESS.value,
            "timestamp": finished_at_iso,
            "artifacts": artifacts_payload,
            "params": params_payload,
            "meta": {
                "status_str": status_str or "success",
                "completed": True,
            },
        }
        if runtime and runtime.prompt_id:
            payload["prompt_id"] = runtime.prompt_id
        if runtime:
            duration_ms = int(max(0.0, (time.perf_counter() - runtime.started_monotonic) * 1000))
            payload["timing"] = {
                "started_at": started_at_iso,
                "finished_at": finished_at_iso,
                "duration_ms": duration_ms,
            }
        if warnings:
            payload["warnings"] = warnings
        idempotency_key = f"{job.jobId}-SUCCESS"
        await self._post_callback(job.callbacks.completion, payload, idempotency_key=idempotency_key)

    async def _emit_cancellation(self, job: DispatchEnvelope) -> None:
        await self._emit_status(
            job,
            GeneratorState.CANCELED,
            message="Job cancelled",
            progress={"phase": "cancelled", "percent": 100},
        )
        if job.callbacks and job.callbacks.failure:
            runtime = self._get_runtime(job.jobId)
            finished_at_iso = self._now_iso()
            started_at_iso = (
                runtime.started_at.isoformat(timespec="milliseconds").replace("+00:00", "Z")
                if runtime
                else None
            )
            payload: Dict[str, Any] = {
                "job_id": job.jobId,
                "client_id": self.config.comfyui.client_id,
                "state": GeneratorState.CANCELED.value,
                "timestamp": finished_at_iso,
                "reason_code": "CANCELED",
                "reason": "Job cancelled",
            }
            if runtime and runtime.prompt_id:
                payload["prompt_id"] = runtime.prompt_id
            if runtime:
                duration_ms = int(max(0.0, (time.perf_counter() - runtime.started_monotonic) * 1000))
                payload["timing"] = {
                    "started_at": started_at_iso,
                    "finished_at": finished_at_iso,
                    "duration_ms": duration_ms,
                }
            idempotency_key = f"{job.jobId}-CANCELED"
            await self._post_callback(job.callbacks.failure, payload, idempotency_key=idempotency_key)

    async def _emit_failure(
        self,
        job: DispatchEnvelope,
        reason: str,
        category: FailureCategory,
        history: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not job.callbacks or not job.callbacks.failure:
            return
        normalized_reason = self._normalize_failure_reason(reason)
        node_errors = self._extract_node_errors(history)
        try:
            await self._emit_status(
                job,
                GeneratorState.FAILED,
                message="Job failed",
                reason=normalized_reason,
                progress={"phase": "failed"},
            )
        except Exception:  # noqa: BLE001
            LOGGER.debug("Failed to emit error status callback for %s", job.jobId, exc_info=True)
        runtime = self._get_runtime(job.jobId)
        finished_at_iso = self._now_iso()
        started_at_iso = (
            runtime.started_at.isoformat(timespec="milliseconds").replace("+00:00", "Z")
            if runtime
            else None
        )
        payload: Dict[str, Any] = {
            "job_id": job.jobId,
            "client_id": self.config.comfyui.client_id,
            "state": GeneratorState.FAILED.value,
            "timestamp": finished_at_iso,
            "reason_code": self._map_failure_reason_code(category),
            "reason": normalized_reason,
            "error_type": category.value,
        }
        if runtime and runtime.prompt_id:
            payload["prompt_id"] = runtime.prompt_id
        if node_errors:
            payload["node_errors"] = node_errors
        if runtime:
            duration_ms = int(max(0.0, (time.perf_counter() - runtime.started_monotonic) * 1000))
            payload["timing"] = {
                "started_at": started_at_iso,
                "finished_at": finished_at_iso,
                "duration_ms": duration_ms,
            }
        try:
            activity = await self.describe_activity()
        except Exception as exc:  # noqa: BLE001
            LOGGER.debug("Failed to capture final ComfyUI activity snapshot: %s", exc)
            activity = None
        snapshot = self._build_activity_snapshot(activity)
        if snapshot:
            payload["last_activity"] = snapshot
        idempotency_key = f"{job.jobId}-FAILED"
        await self._post_callback(job.callbacks.failure, payload, idempotency_key=idempotency_key)

    def _resolve_callback_url(self, url: str) -> str:
        candidate = str(url or "").strip()
        if not candidate:
            raise ValueError("Callback URL cannot be empty")

        base = (self.config.callbacks.base_url or "").strip()
        if candidate.startswith("http://") or candidate.startswith("https://"):
            if not base:
                return candidate
            parsed_base = urlparse(base)
            if not parsed_base.scheme or not parsed_base.netloc:
                return candidate
            parsed_candidate = urlparse(candidate)
            return urlunparse(
                (
                    parsed_base.scheme,
                    parsed_base.netloc,
                    parsed_candidate.path or "/",
                    parsed_candidate.params,
                    parsed_candidate.query,
                    parsed_candidate.fragment,
                )
            )

        if not base:
            raise ValueError("Callback URL cannot be relative when no base URL configured")

        normalized_base = f"{base.rstrip('/')}/"
        normalized_candidate = candidate.lstrip("/")
        return urljoin(normalized_base, normalized_candidate)

    async def _post_callback(
        self,
        url: str,
        payload: Dict[str, object],
        *,
        idempotency_key: Optional[str] = None,
    ) -> None:
        try:
            target = self._resolve_callback_url(url)
        except ValueError as exc:
            LOGGER.warning("Skipping callback with invalid target %s: %s", url, exc)
            return
        LOGGER.debug("Sending callback to %s: %s", target, payload)
        verify = self.config.callbacks.verify_tls
        timeout = httpx.Timeout(self.config.callbacks.timeout_seconds)
        max_attempts = max(1, int(self.config.callbacks.max_retries))
        backoff = max(0.0, float(self.config.callbacks.retry_backoff_seconds))
        headers = {"Content-Type": "application/json"}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        async with httpx.AsyncClient(verify=verify, timeout=timeout) as client:
            attempt = 0
            while True:
                attempt += 1
                try:
                    response = await client.post(target, json=payload, headers=headers)
                    response.raise_for_status()
                    return
                except Exception as exc:  # noqa: BLE001
                    LOGGER.warning("Callback to %s failed (attempt %s/%s): %s", target, attempt, max_attempts, exc)
                    if attempt >= max_attempts:
                        return
                    await asyncio.sleep(backoff * attempt)

    def _compute_timeout(
        self,
        job: DispatchEnvelope,
        workflow: Dict[str, Any],
        resolved_params: Dict[str, Any],
    ) -> float:
        base_timeout = float(self.config.comfyui.timeout_seconds)
        per_step = float(self.config.comfyui.per_step_timeout_seconds)
        steps_value = resolved_params.get("steps")
        steps = steps_value if isinstance(steps_value, int) else None
        if steps is None or steps <= 0:
            raise ValidationFailure("Resolved workflow parameters must include a positive 'steps' value")
        timeout = base_timeout + steps * per_step
        if self._workflow_has_low_denoise(workflow):
            timeout *= float(self.config.comfyui.img2img_timeout_multiplier)
        return timeout

    def _workflow_has_low_denoise(self, workflow: Dict[str, Any]) -> bool:
        for node in workflow.values():
            if not isinstance(node, dict):
                continue
            inputs = node.get("inputs")
            if not isinstance(inputs, dict):
                continue
            denoise = inputs.get("denoise")
            if isinstance(denoise, (int, float)) and float(denoise) < 1.0:
                return True
        return False

    async def _validate_workflow_assets(self, workflow: Dict[str, Any]) -> None:
        allowed = await self.comfyui.get_allowed_names()
        violations: List[str] = []
        for node_id, node in workflow.items():
            if not isinstance(node, dict):
                continue
            inputs = node.get("inputs")
            if not isinstance(inputs, dict):
                continue
            for key, value in inputs.items():
                if not isinstance(value, str):
                    continue
                normalized = normalize_name(value)
                allowed_set = allowed.get(key)
                if not allowed_set:
                    continue
                try:
                    must_be_allowed(normalized, allowed_set, key)
                except ValueError:
                    violations.append(f"{key}='{normalized}' rejected for node {node_id}")
        if violations:
            raise ValidationFailure("; ".join(violations))

    def _extract_node_errors(self, history: Optional[Dict[str, Any]]) -> Optional[Any]:
        if not history:
            return None
        status = history.get("status") if isinstance(history, dict) else None
        node_errors: Any = None
        if isinstance(status, dict):
            node_errors = status.get("node_errors") or status.get("nodeErrors")
        if node_errors is None:
            return None
        if isinstance(node_errors, (dict, list)):
            return node_errors
        text = str(node_errors)
        if len(text) > 4096:
            text = f"{text[:4093]}…"
        return {"message": text}
