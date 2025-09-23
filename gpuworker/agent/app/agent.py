from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin, urlparse, urlunparse

import httpx

from .comfyui import ComfyUIClient, extract_output_files
from .config import AgentConfig
from .minio_client import MinioManager
from .models import AssetRef, DispatchEnvelope
from .workflow import WorkflowLoader, build_workflow_payload

LOGGER = logging.getLogger(__name__)


class GPUAgent:
    def __init__(self, config: AgentConfig) -> None:
        self.config = config
        self.minio = MinioManager(config)
        self.comfyui = ComfyUIClient(config)
        self.workflow_loader = WorkflowLoader(config, self.minio)
        self._lock = asyncio.Lock()

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

    async def describe_activity(self) -> Dict[str, Any]:
        return await self.comfyui.describe_activity()

    async def _execute(self, job: DispatchEnvelope) -> Dict[str, List[str]]:
        LOGGER.info("Starting job %s for user %s", job.jobId, job.user.username)
        downloaded_loras: List[Path] = []
        downloaded_models: List[Path] = []
        try:
            base_model_path, base_downloaded = self._ensure_base_model(job.baseModel)
            if base_downloaded:
                downloaded_models.append(base_model_path)
            lora_paths = self._ensure_loras(job, downloaded_loras)
            resolved_params = self._build_parameter_context(job, base_model_path, lora_paths)
            workflow_payload = build_workflow_payload(self.workflow_loader, job, resolved_params)
            await self._emit_status(job, "queued")
            prompt_id = await self.comfyui.submit_workflow(workflow_payload)
            await self._emit_status(job, "running", {"prompt_id": prompt_id})
            history = await self.comfyui.wait_for_completion(prompt_id)
            await self._emit_status(job, "uploading", {"prompt_id": prompt_id})
            uploaded = self._upload_outputs(job, history)
            await self._emit_completion(job, uploaded)
            LOGGER.info("Job %s completed", job.jobId)
            return {"uploaded": uploaded}
        except Exception as exc:  # noqa: BLE001
            LOGGER.exception("Job %s failed", job.jobId)
            await self._emit_failure(job, str(exc))
            raise
        finally:
            self._cleanup(downloaded_loras, downloaded_models)

    def _ensure_base_model(self, base_model: AssetRef) -> tuple[Path, bool]:
        destination = self.config.paths.base_models / Path(base_model.key).name
        if destination.exists():
            LOGGER.info("Base model %s already cached", destination)
            return destination, False
        self.minio.download_to_path(base_model.bucket, base_model.key, destination)
        return destination, True

    def _ensure_loras(self, job: DispatchEnvelope, tracked_downloads: List[Path]) -> List[Path]:
        resolved: List[Path] = []
        filename_lookup = self._build_lora_filename_lookup(job)
        for asset in job.loras:
            destination = self.config.paths.loras / self._resolve_lora_filename(asset, filename_lookup)
            legacy_path = self.config.paths.loras / Path(asset.key).name
            if destination.exists():
                LOGGER.info("LoRA %s already present", destination)
            elif legacy_path.exists() and legacy_path != destination:
                LOGGER.info("Renaming cached LoRA %s -> %s", legacy_path, destination)
                legacy_path.rename(destination)
            else:
                self.minio.download_to_path(asset.bucket, asset.key, destination)
                tracked_downloads.append(destination)
                if legacy_path.exists() and legacy_path != destination:
                    LOGGER.debug("Removing stale cached LoRA %s", legacy_path)
                    legacy_path.unlink(missing_ok=True)
            resolved.append(destination)
        return resolved

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
            sanitized = Path(filename).name
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
        base_model_path: Path,
        lora_paths: List[Path],
    ) -> Dict[str, object]:
        context: Dict[str, object] = {
            "prompt": job.parameters.prompt,
            "negative_prompt": job.parameters.negativePrompt,
            "seed": job.parameters.seed,
            "cfg_scale": job.parameters.cfgScale,
            "steps": job.parameters.steps,
            "base_model_path": base_model_path.name,
            "base_model_full_path": str(base_model_path),
            "loras": [str(path) for path in lora_paths],
        }
        if job.parameters.resolution:
            context["width"] = job.parameters.resolution.width
            context["height"] = job.parameters.resolution.height
        context.update(self.config.workflow_defaults)
        context.update(job.parameters.extra or {})
        return {key: value for key, value in context.items() if value is not None}

    def _upload_outputs(self, job: DispatchEnvelope, history: Dict[str, object]) -> List[str]:
        uploaded_keys: List[str] = []
        for filename, subfolder, image_type in extract_output_files(history):
            output_dir = Path(self.config.paths.outputs)
            if subfolder:
                output_dir = output_dir / subfolder
            source = output_dir / filename
            if not source.exists():
                LOGGER.warning("Expected output missing: %s", source)
                continue
            destination_key = f"{job.output.prefix.rstrip('/')}/{filename}"
            metadata = {
                "prompt": job.parameters.prompt,
                "negative_prompt": job.parameters.negativePrompt or "",
                "seed": str(job.parameters.seed or ""),
                "user": job.user.username,
                "job_id": job.jobId,
                "image_type": image_type,
            }
            self.minio.upload_file(job.output.bucket, destination_key, source, metadata)
            uploaded_keys.append(destination_key)
        return uploaded_keys

    def _cleanup(self, downloaded_loras: List[Path], downloaded_models: List[Path]) -> None:
        if self.config.cleanup.delete_downloaded_loras:
            for path in downloaded_loras:
                try:
                    LOGGER.info("Removing temporary LoRA %s", path)
                    path.unlink(missing_ok=True)
                except Exception as exc:  # noqa: BLE001
                    LOGGER.warning("Failed to remove LoRA %s: %s", path, exc)
        if self.config.cleanup.delete_downloaded_models:
            for path in downloaded_models:
                key = next((key for key in self.config.persistent_model_keys if Path(key).name == path.name), None)
                if key:
                    LOGGER.debug("Skipping cleanup for persistent model %s", path)
                    continue
                try:
                    LOGGER.info("Removing temporary model %s", path)
                    path.unlink(missing_ok=True)
                except Exception as exc:  # noqa: BLE001
                    LOGGER.warning("Failed to remove model %s: %s", path, exc)

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

    async def _emit_completion(self, job: DispatchEnvelope, uploaded: List[str]) -> None:
        if not job.callbacks or not job.callbacks.completion:
            return
        payload = {"jobId": job.jobId, "status": "completed", "artifacts": uploaded}
        await self._post_callback(job.callbacks.completion, payload)

    async def _emit_failure(self, job: DispatchEnvelope, reason: str) -> None:
        if not job.callbacks or not job.callbacks.failure:
            return
        normalized_reason = self._normalize_failure_reason(reason)
        try:
            await self._emit_status(job, "error", reason=normalized_reason)
        except Exception:  # noqa: BLE001
            LOGGER.debug("Failed to emit error status callback for %s", job.jobId, exc_info=True)
        payload = {"jobId": job.jobId, "status": "error", "reason": normalized_reason}
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
        async with httpx.AsyncClient(verify=verify, timeout=timeout) as client:
            try:
                response = await client.post(target, json=payload)
                response.raise_for_status()
            except Exception as exc:  # noqa: BLE001
                LOGGER.warning("Callback to %s failed: %s", target, exc)

