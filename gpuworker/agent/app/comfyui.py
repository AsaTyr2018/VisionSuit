from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional, Tuple

import httpx

from .config import AgentConfig

LOGGER = logging.getLogger(__name__)


class ComfyUIClient:
    def __init__(self, config: AgentConfig) -> None:
        self.config = config
        self._client = httpx.AsyncClient(timeout=config.comfyui.timeout_seconds)
        self._base_url = config.comfyui.api_url.rstrip("/")

    async def submit_workflow(self, workflow: Dict[str, Any]) -> str:
        payload = {"prompt": workflow, "client_id": self.config.comfyui.client_id}
        LOGGER.info("Submitting workflow to ComfyUI")
        response = await self._client.post(f"{self._base_url}/prompt", json=payload)
        response.raise_for_status()
        data = response.json()
        prompt_id = data.get("prompt_id") or data.get("id")
        if not prompt_id:
            raise RuntimeError("ComfyUI response missing prompt_id")
        return prompt_id

    async def wait_for_completion(self, prompt_id: str) -> Dict[str, Any]:
        poll_interval = self.config.comfyui.poll_interval_seconds
        deadline = asyncio.get_event_loop().time() + self.config.comfyui.timeout_seconds
        while True:
            if asyncio.get_event_loop().time() > deadline:
                raise TimeoutError(f"ComfyUI job {prompt_id} timed out")
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
                raise RuntimeError(f"ComfyUI job {prompt_id} failed: {history.get('status')}")
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

    async def close(self) -> None:
        await self._client.aclose()


def extract_output_files(history: Dict[str, Any]) -> List[Tuple[str, str, str]]:
    outputs = history.get("outputs", {})
    discovered: List[Tuple[str, str, str]] = []
    for node in outputs.values():
        images = node.get("images", [])
        for image in images:
            filename = image.get("filename")
            subfolder = image.get("subfolder", "")
            image_type = image.get("type", "output")
            if filename:
                discovered.append((filename, subfolder, image_type))
    return discovered

