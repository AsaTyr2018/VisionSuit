from __future__ import annotations

import asyncio
import json
import logging
from asyncio import Event
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple
from urllib.parse import urljoin, urlparse, urlunparse

import httpx

from .assets import build_collision_suffix, derive_pretty_name, must_be_allowed, normalize_name
from .comfyui import (
    ComfyUICancelledError,
    ComfyUIClient,
    ComfyUIError,
    ComfyUIJobFailed,
    extract_output_files,
)
from .config import AgentConfig
from .minio_client import MinioManager
from .models import AssetRef, DispatchEnvelope
from .workflow import WorkflowLoader, build_workflow_payload, find_save_image_nodes

LOGGER = logging.getLogger(__name__)


@dataclass
class ResolvedAsset:
    asset: AssetRef
    cache_path: Path
    comfy_name: str
    symlink_path: Path
    downloaded: bool
    link_created: bool


@dataclass
class UploadResult:
    uploaded: List[str]
    missing: List[Path]


@dataclass
class CancellationHandle:
    token: str
    event: Event
    job: DispatchEnvelope


class FailureCategory(str, Enum):
    VALIDATION = "validation"
    TRANSIENT = "transient"
    TIMEOUT = "timeout"
    CANCELLED = "cancelled"
    SYSTEM = "system"


class ValidationFailure(Exception):
    """Raised when the dispatch payload fails validation."""


class GPUAgent:
    def __init__(self, config: AgentConfig) -> None:
        self.config = config
        self.minio = MinioManager(config)
        self.comfyui = ComfyUIClient(config)
        self.workflow_loader = WorkflowLoader(config, self.minio)
        self._lock = asyncio.Lock()
        self._cancel_handle: Optional[CancellationHandle] = None

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
            handle.event.set()
            try:
                await self._emit_status(handle.job, "cancelling")
            except Exception:  # noqa: BLE001
                LOGGER.debug("Failed to emit cancellation status for %s", handle.job.jobId, exc_info=True)
        return True

    async def describe_activity(self) -> Dict[str, Any]:
        return await self.comfyui.describe_activity()

    async def _execute(self, job: DispatchEnvelope) -> Dict[str, List[str]]:
        LOGGER.info("Starting job %s for user %s", job.jobId, job.user.username)
        resolved_base: Optional[ResolvedAsset] = None
        resolved_loras: List[ResolvedAsset] = []
        history: Optional[Dict[str, Any]] = None
        warnings: List[str] = []
        cancel_handle: Optional[CancellationHandle] = None
        try:
            resolved_base = self._ensure_base_model(job.baseModel)
            resolved_loras = self._ensure_loras(job)
            needs_refresh = self._needs_model_refresh(resolved_base, resolved_loras)
            if needs_refresh:
                await self._refresh_model_cache()

            resolved_params = self._build_parameter_context(job, resolved_base, resolved_loras)
            workflow_payload = build_workflow_payload(self.workflow_loader, job, resolved_params)
            save_nodes = find_save_image_nodes(workflow_payload)
            await self._validate_workflow_assets(workflow_payload)

            await self._emit_status(job, "queued")
            cancel_handle = self._register_cancellation(job)
            prompt_id = await self.comfyui.submit_workflow(workflow_payload)
            await self._emit_status(job, "running", {"prompt_id": prompt_id})

            timeout = self._compute_timeout(job, workflow_payload)
            history = await self.comfyui.wait_for_completion(
                prompt_id,
                timeout=timeout,
                cancel_event=cancel_handle.event if cancel_handle else None,
            )
            await self._emit_status(job, "uploading", {"prompt_id": prompt_id})

            outputs = extract_output_files(history, save_nodes if save_nodes else None)
            if save_nodes and not outputs:
                raise ValidationFailure("Workflow completed without producing outputs from SaveImage nodes")

            upload_result = self._upload_outputs(job, outputs, resolved_base, resolved_loras)
            if upload_result.missing:
                missing_names = ", ".join(path.name for path in upload_result.missing)
                warnings.append(f"Missing outputs on disk: {missing_names}")
            await self._emit_completion(job, upload_result.uploaded, warnings or None)
            LOGGER.info("Job %s completed", job.jobId)
            return {"uploaded": upload_result.uploaded}
        except ValidationFailure as exc:
            LOGGER.exception("Job %s failed validation", job.jobId)
            await self._emit_failure(job, str(exc), FailureCategory.VALIDATION, history)
            raise
        except ComfyUICancelledError:
            LOGGER.info("Job %s cancelled by controller", job.jobId)
            await self._emit_cancellation(job)
            return {"uploaded": []}
        except asyncio.TimeoutError as exc:
            LOGGER.exception("Job %s timed out", job.jobId)
            await self._emit_failure(job, str(exc), FailureCategory.TIMEOUT, history)
            raise
        except ComfyUIJobFailed as exc:
            history = exc.history
            LOGGER.exception("ComfyUI reported failure for job %s", job.jobId)
            await self._emit_failure(job, str(exc), FailureCategory.VALIDATION, history)
            raise
        except ComfyUIError as exc:
            LOGGER.exception("ComfyUI transport error for job %s", job.jobId)
            await self._emit_failure(job, str(exc), FailureCategory.TRANSIENT, history)
            raise
        except Exception as exc:  # noqa: BLE001
            LOGGER.exception("Job %s failed unexpectedly", job.jobId)
            await self._emit_failure(job, str(exc), FailureCategory.SYSTEM, history)
            raise
        finally:
            self._cleanup(resolved_base, resolved_loras)
            self._clear_cancellation(cancel_handle)

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

    def _ensure_base_model(self, base_model: AssetRef) -> ResolvedAsset:
        base_dir = self.config.paths.base_models
        cache_dir = base_dir / "cache"
        cache_dir.mkdir(parents=True, exist_ok=True)

        source_name = Path(base_model.key).name
        display_name = self._resolve_display_name(base_model, source_name)
        pretty_path = base_dir / display_name

        cache_path = (
            pretty_path
            if pretty_path.exists() and pretty_path.is_file() and not pretty_path.is_symlink()
            else cache_dir / source_name
        )
        downloaded = False
        if not cache_path.exists():
            LOGGER.info("Downloading base model %s", base_model.key)
            self.minio.download_to_path(base_model.bucket, base_model.key, cache_path)
            downloaded = True

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

    def _ensure_loras(self, job: DispatchEnvelope) -> List[ResolvedAsset]:
        resolved: List[ResolvedAsset] = []
        if not job.loras:
            return resolved
        lookup = self._build_lora_filename_lookup(job)
        cache_dir = self.config.paths.loras / "cache"
        cache_dir.mkdir(parents=True, exist_ok=True)

        for asset in job.loras:
            source_name = Path(asset.key).name
            override = self._resolve_lora_filename(asset, lookup)
            display_name = self._resolve_display_name(asset, override)
            pretty_path = self.config.paths.loras / display_name
            cache_path = (
                pretty_path
                if pretty_path.exists() and pretty_path.is_file() and not pretty_path.is_symlink()
                else cache_dir / source_name
            )
            downloaded = False
            if not cache_path.exists():
                LOGGER.info("Downloading LoRA %s", asset.key)
                self.minio.download_to_path(asset.bucket, asset.key, cache_path)
                downloaded = True
            symlink_path, created = self._ensure_symlink(pretty_path, cache_path, asset.key)
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
        return resolved

    def _resolve_display_name(self, asset: AssetRef, fallback: str) -> str:
        candidate = asset.display_name or asset.original_name
        if not candidate:
            metadata = self.minio.get_object_metadata(asset.bucket, asset.key)
            candidate = metadata.get("original-name") or metadata.get("original_name") or metadata.get("display-name")
        return derive_pretty_name(candidate, fallback)

    def _ensure_symlink(self, desired: Path, target: Path, source_key: str) -> Tuple[Path, bool]:
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
                    pass
                new_name = f"{candidate.stem}__{suffix}{candidate.suffix or target.suffix or '.safetensors'}"
                candidate = candidate.with_name(new_name)
                continue
            candidate.symlink_to(target)
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

    def _resolve_lora_filename(self, asset: AssetRef, lookup: Dict[str, str]) -> str:
        key = asset.key
        candidates = [key, Path(key).name]
        for candidate in candidates:
            if candidate in lookup:
                return lookup[candidate]
        return Path(key).name
    def _build_parameter_context(
        self,
        job: DispatchEnvelope,
        base_model: ResolvedAsset,
        loras: List[ResolvedAsset],
    ) -> Dict[str, object]:
        context: Dict[str, object] = {
            "prompt": job.parameters.prompt,
            "negative_prompt": job.parameters.negativePrompt,
            "seed": job.parameters.seed,
            "cfg_scale": job.parameters.cfgScale,
            "steps": job.parameters.steps,
            "base_model_path": base_model.comfy_name,
            "base_model_name": base_model.comfy_name,
            "base_model_full_path": str(base_model.cache_path),
            "loras": [entry.comfy_name for entry in loras],
        }
        if job.parameters.resolution:
            context["width"] = job.parameters.resolution.width
            context["height"] = job.parameters.resolution.height
        context.update(self.config.workflow_defaults)
        context.update(job.parameters.extra or {})
        return {key: value for key, value in context.items() if value is not None}

    def _upload_outputs(
        self,
        job: DispatchEnvelope,
        outputs: List[Tuple[str, str, str]],
        base_model: ResolvedAsset,
        loras: List[ResolvedAsset],
    ) -> UploadResult:
        uploaded_keys: List[str] = []
        missing_files: List[Path] = []
        output_root = Path(self.config.paths.outputs)
        seed_value = str(job.parameters.seed or 0)
        lora_names = ",".join(entry.comfy_name for entry in loras) if loras else ""

        for index, (filename, subfolder, image_type) in enumerate(outputs, start=1):
            output_dir = output_root / subfolder if subfolder else output_root
            source = output_dir / filename
            if not source.exists():
                LOGGER.warning("Expected output missing: %s", source)
                missing_files.append(source)
                continue
            ext = Path(filename).suffix or ".png"
            destination_key = f"comfy-outputs/{job.jobId}/{index:02d}_{seed_value}{ext}"
            metadata = {
                "prompt": job.parameters.prompt or "",
                "negative_prompt": job.parameters.negativePrompt or "",
                "seed": seed_value,
                "steps": str(job.parameters.steps or ""),
                "user": job.user.username,
                "job_id": job.jobId,
                "model": base_model.comfy_name,
                "loras": lora_names,
                "image_type": image_type or "output",
            }
            self.minio.upload_file(job.output.bucket, destination_key, source, metadata)
            uploaded_keys.append(destination_key)
        return UploadResult(uploaded=uploaded_keys, missing=missing_files)

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
        status: str,
        extra: Optional[Dict[str, object]] = None,
        reason: Optional[str] = None,
    ) -> None:
        if not job.callbacks or not job.callbacks.status:
            return
        payload_extra: Dict[str, object] = {}
        if extra:
            payload_extra.update(extra)
        try:
            activity = await self.describe_activity()
        except Exception as exc:  # noqa: BLE001
            LOGGER.debug("Failed to capture ComfyUI activity snapshot: %s", exc)
            activity = None
        if activity:
            payload_extra["activity"] = activity
        payload: Dict[str, object] = {"jobId": job.jobId, "status": status}
        if reason:
            payload["reason"] = reason
        if payload_extra:
            payload["extra"] = payload_extra
        await self._post_callback(job.callbacks.status, payload)

    async def _emit_completion(
        self,
        job: DispatchEnvelope,
        uploaded: List[str],
        warnings: Optional[List[str]],
    ) -> None:
        if not job.callbacks or not job.callbacks.completion:
            return
        payload: Dict[str, Any] = {"jobId": job.jobId, "status": "completed", "artifacts": uploaded}
        if warnings:
            payload["warnings"] = warnings
        await self._post_callback(job.callbacks.completion, payload)

    async def _emit_cancellation(self, job: DispatchEnvelope) -> None:
        await self._emit_status(job, "cancelled")
        if job.callbacks and job.callbacks.failure:
            payload = {"jobId": job.jobId, "status": "cancelled", "reason": "Job cancelled"}
            await self._post_callback(job.callbacks.failure, payload)

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
            await self._emit_status(job, "error", reason=normalized_reason)
        except Exception:  # noqa: BLE001
            LOGGER.debug("Failed to emit error status callback for %s", job.jobId, exc_info=True)
        payload: Dict[str, Any] = {
            "jobId": job.jobId,
            "status": "error",
            "reason": normalized_reason,
            "errorType": category.value,
        }
        if node_errors:
            payload["nodeErrors"] = node_errors
        await self._post_callback(job.callbacks.failure, payload)

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

    async def _post_callback(self, url: str, payload: Dict[str, object]) -> None:
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
        async with httpx.AsyncClient(verify=verify, timeout=timeout) as client:
            attempt = 0
            while True:
                attempt += 1
                try:
                    response = await client.post(target, json=payload)
                    response.raise_for_status()
                    return
                except Exception as exc:  # noqa: BLE001
                    LOGGER.warning("Callback to %s failed (attempt %s/%s): %s", target, attempt, max_attempts, exc)
                    if attempt >= max_attempts:
                        return
                    await asyncio.sleep(backoff * attempt)

    def _compute_timeout(self, job: DispatchEnvelope, workflow: Dict[str, Any]) -> float:
        base_timeout = float(self.config.comfyui.timeout_seconds)
        per_step = float(self.config.comfyui.per_step_timeout_seconds)
        steps = job.parameters.steps
        if steps is None:
            extra_steps = job.parameters.extra.get("steps") if job.parameters.extra else None
            if isinstance(extra_steps, (int, float)):
                steps = int(extra_steps)
        if steps is None:
            steps = int(self.config.workflow_defaults.get("steps", 30))
        timeout = base_timeout + max(0, int(steps)) * per_step
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

    def _extract_node_errors(self, history: Optional[Dict[str, Any]]) -> Optional[str]:
        if not history:
            return None
        status = history.get("status") if isinstance(history, dict) else None
        node_errors = None
        if isinstance(status, dict):
            node_errors = status.get("node_errors") or status.get("nodeErrors")
        if not node_errors:
            return None
        try:
            serialized = json.dumps(node_errors)
        except Exception:  # noqa: BLE001
            serialized = str(node_errors)
        if len(serialized) > 4096:
            serialized = f"{serialized[:4093]}…"
        return serialized
