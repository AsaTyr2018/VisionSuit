from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Dict, List, Optional

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

        try:
            await asyncio.wait_for(self._lock.acquire(), timeout=0)
        except asyncio.TimeoutError:
            return False
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

    async def _execute(self, job: DispatchEnvelope) -> Dict[str, List[str]]:
        LOGGER.info("Starting job %s for user %s", job.jobId, job.user.username)
        downloaded_loras: List[Path] = []
        downloaded_models: List[Path] = []
        try:
            base_model_path, base_downloaded = self._ensure_base_model(job.baseModel)
            if base_downloaded:
                downloaded_models.append(base_model_path)
            lora_paths = self._ensure_loras(job.loras, downloaded_loras)
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

    def _ensure_loras(self, loras: List[AssetRef], tracked_downloads: List[Path]) -> List[Path]:
        resolved: List[Path] = []
        for asset in loras:
            destination = self.config.paths.loras / Path(asset.key).name
            if destination.exists():
                LOGGER.info("LoRA %s already present", destination)
            else:
                self.minio.download_to_path(asset.bucket, asset.key, destination)
                tracked_downloads.append(destination)
            resolved.append(destination)
        return resolved

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
            "base_model_path": str(base_model_path),
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

    async def _emit_status(self, job: DispatchEnvelope, status: str, extra: Optional[Dict[str, object]] = None) -> None:
        if not job.callbacks or not job.callbacks.status:
            return
        payload = {"jobId": job.jobId, "status": status, "extra": extra or {}}
        await self._post_callback(job.callbacks.status, payload)

    async def _emit_completion(self, job: DispatchEnvelope, uploaded: List[str]) -> None:
        if not job.callbacks or not job.callbacks.completion:
            return
        payload = {"jobId": job.jobId, "status": "completed", "artifacts": uploaded}
        await self._post_callback(job.callbacks.completion, payload)

    async def _emit_failure(self, job: DispatchEnvelope, reason: str) -> None:
        if not job.callbacks or not job.callbacks.failure:
            return
        payload = {"jobId": job.jobId, "status": "failed", "reason": reason}
        await self._post_callback(job.callbacks.failure, payload)

    async def _post_callback(self, url: str, payload: Dict[str, object]) -> None:
        LOGGER.debug("Sending callback to %s: %s", url, payload)
        verify = self.config.callbacks.verify_tls
        timeout = httpx.Timeout(self.config.callbacks.timeout_seconds)
        async with httpx.AsyncClient(verify=verify, timeout=timeout) as client:
            try:
                response = await client.post(url, json=payload)
                response.raise_for_status()
            except Exception as exc:  # noqa: BLE001
                LOGGER.warning("Callback to %s failed: %s", url, exc)

