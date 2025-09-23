from __future__ import annotations

import asyncio
import logging
import time
from asyncio import Event
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import httpx

from .assets import normalize_name
from .config import AgentConfig

LOGGER = logging.getLogger(__name__)


class ComfyUIError(RuntimeError):
    """Base class for ComfyUI interaction failures."""


class ComfyUIJobFailed(ComfyUIError):
    def __init__(self, message: str, history: Dict[str, Any]) -> None:
        super().__init__(message)
        self.history = history


class ComfyUICancelledError(ComfyUIError):
    pass


class ComfyUIClient:
    def __init__(self, config: AgentConfig) -> None:
        self.config = config
        self._client = httpx.AsyncClient(timeout=config.comfyui.timeout_seconds)
        self._base_url = config.comfyui.api_url.rstrip("/")
        self._object_info_cache: Optional[Tuple[float, Dict[str, Set[str]]]] = None
        self._object_info_lock = asyncio.Lock()

    async def submit_workflow(self, workflow: Dict[str, Any]) -> str:
        payload = {"prompt": workflow, "client_id": self.config.comfyui.client_id}
        LOGGER.info("Submitting workflow to ComfyUI")
        response = await self._client.post(f"{self._base_url}/prompt", json=payload)
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:  # noqa: PERF203
            body = exc.response.text
            LOGGER.error(
                "ComfyUI rejected workflow submission (status %s): %s",
                exc.response.status_code,
                body,
            )
            raise ComfyUIError(
                f"ComfyUI rejected workflow submission ({exc.response.status_code}): {body}"
            ) from exc
        data = response.json()
        prompt_id = data.get("prompt_id") or data.get("id")
        if not prompt_id:
            raise ComfyUIError("ComfyUI response missing prompt_id")
        return prompt_id

    async def wait_for_completion(
        self,
        prompt_id: str,
        *,
        timeout: float,
        cancel_event: Optional[Event] = None,
    ) -> Dict[str, Any]:
        poll_interval = self.config.comfyui.poll_interval_seconds
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            if cancel_event and cancel_event.is_set():
                LOGGER.info("ComfyUI job %s cancelled before completion", prompt_id)
                raise ComfyUICancelledError(f"ComfyUI job {prompt_id} cancelled")
            if loop.time() > deadline:
                raise asyncio.TimeoutError(f"ComfyUI job {prompt_id} timed out")
            try:
                history = await self._fetch_history(prompt_id)
            except httpx.HTTPError as exc:  # noqa: PERF203
                LOGGER.warning("Failed to query ComfyUI history: %s", exc)
                await asyncio.sleep(poll_interval)
                continue

            status = (history.get("status") or {}).get("status")
            if status in {"completed", "success"}:
                LOGGER.info("ComfyUI job %s completed", prompt_id)
                return history
            if status in {"failed", "error"}:
                raise ComfyUIJobFailed(
                    f"ComfyUI job {prompt_id} failed: {history.get('status')}", history
                )
            await asyncio.sleep(poll_interval)

    async def _fetch_history(self, prompt_id: str) -> Dict[str, Any]:
        response = await self._client.get(f"{self._base_url}/history/{prompt_id}")
        response.raise_for_status()
        history = response.json()
        # Some ComfyUI builds wrap the history under the prompt ID key.
        if prompt_id in history:
            history = history[prompt_id]
        return history

    async def describe_activity(self) -> Dict[str, Any]:
        try:
            response = await self._client.get(f"{self._base_url}/queue")
            response.raise_for_status()
            data = response.json()
        except httpx.HTTPError as exc:
            LOGGER.debug("Failed to query ComfyUI queue state: %s", exc)
            return {"pending": None, "running": None, "raw": None}

        def extract(value: Any) -> Optional[int]:
            if isinstance(value, list):
                return len(value)
            if isinstance(value, dict):
                return len(value)
            if isinstance(value, int):
                return value
            return None

        pending = extract(data.get("queue_pending"))
        running = extract(data.get("queue_running"))
        return {
            "pending": pending,
            "running": running,
            "raw": data,
        }

    async def get_allowed_names(self) -> Dict[str, Set[str]]:
        ttl = self.config.comfyui.object_info_cache_seconds
        cached = self._object_info_cache
        now = time.monotonic()
        if cached and cached[0] > now:
            return cached[1]

        async with self._object_info_lock:
            cached = self._object_info_cache
            if cached and cached[0] > now:
                return cached[1]

            mapping: Dict[str, Set[str]] = {}
            try:
                response = await self._client.get(f"{self._base_url}/object_info")
                response.raise_for_status()
                payload = response.json()
                mapping = _parse_object_info(payload)
            except httpx.HTTPError as exc:
                LOGGER.warning("Falling back to filesystem scan for allowed names: %s", exc)
            except Exception as exc:  # noqa: BLE001
                LOGGER.warning("Failed to parse /object_info payload: %s", exc)

            if not mapping:
                mapping = self._scan_filesystem()

            self._object_info_cache = (now + ttl, mapping)
            return mapping

    def _scan_filesystem(self) -> Dict[str, Set[str]]:
        base_models = self.config.paths.base_models
        base_root = base_models.parent
        vae_dir = base_root / "vae"
        clip_dir = base_root / "clip"
        lora_dir = self.config.paths.loras

        def collect(directory: Path) -> Set[str]:
            if not directory.exists():
                return set()
            return {normalize_name(path.name) for path in directory.glob("*.safetensors")}

        mapping: Dict[str, Set[str]] = {
            "ckpt_name": collect(base_models),
            "refiner_ckpt_name": collect(base_models),
            "model_name": collect(base_models),
            "vae_name": collect(vae_dir),
            "clip_name": collect(clip_dir),
            "lora_name": collect(lora_dir),
        }
        # Remove empty entries to avoid accidental allow-all behaviour.
        return {key: value for key, value in mapping.items() if value}

    async def close(self) -> None:
        await self._client.aclose()

    def invalidate_object_cache(self) -> None:
        self._object_info_cache = None


def _parse_object_info(payload: Dict[str, Any]) -> Dict[str, Set[str]]:
    mapping: Dict[str, Set[str]] = {}
    for node in payload.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if isinstance(inputs, dict):
            _collect_inputs(inputs, mapping)
        required = node.get("required")
        if isinstance(required, dict):
            _collect_inputs(required, mapping)
        optional = node.get("optional")
        if isinstance(optional, dict):
            _collect_inputs(optional, mapping)
    return mapping


def _collect_inputs(section: Dict[str, Any], mapping: Dict[str, Set[str]]) -> None:
    for key, value in section.items():
        if isinstance(value, dict) and not {"choices", "default"} & set(value.keys()):
            _collect_inputs(value, mapping)
            continue
        choices = _collect_choices(value)
        if choices:
            bucket = mapping.setdefault(key, set())
            bucket.update(choices)


def _collect_choices(value: Any) -> Set[str]:
    discovered: Set[str] = set()
    if isinstance(value, dict):
        if "choices" in value:
            discovered.update(_collect_choices(value["choices"]))
        if "default" in value and isinstance(value["default"], str):
            discovered.add(normalize_name(value["default"]))
        for inner in value.values():
            if isinstance(inner, (dict, list)):
                discovered.update(_collect_choices(inner))
    elif isinstance(value, list):
        for item in value:
            discovered.update(_collect_choices(item))
    elif isinstance(value, str):
        discovered.add(normalize_name(value))
    return discovered


def extract_output_files(
    history: Dict[str, Any],
    expected_node_ids: Optional[Iterable[int]] = None,
) -> List[Tuple[str, str, str]]:
    outputs = history.get("outputs", {})
    discovered: List[Tuple[str, str, str]] = []
    allowed_ids: Optional[Set[str]] = None
    if expected_node_ids:
        allowed_ids = {str(node_id) for node_id in expected_node_ids}
    if isinstance(outputs, dict):
        iterable = outputs.items()
    else:
        iterable = []
    for node_id, node in iterable:
        if allowed_ids and str(node_id) not in allowed_ids:
            continue
        if not isinstance(node, dict):
            continue
        images = node.get("images", [])
        if not isinstance(images, list):
            continue
        for image in images:
            if not isinstance(image, dict):
                continue
            filename = image.get("filename")
            subfolder = image.get("subfolder", "")
            image_type = image.get("type", "output")
            if filename:
                discovered.append((filename, subfolder or "", image_type))
    return discovered

