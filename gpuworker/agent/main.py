from __future__ import annotations

import logging
import os
from typing import Any, Dict

from fastapi import BackgroundTasks, FastAPI, HTTPException

from app.agent import GPUAgent
from app.config import load_config
from app.models import DispatchEnvelope

LOGGER = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(levelname)s %(name)s: %(message)s")


def create_app() -> FastAPI:
    config_path = os.environ.get("VISION_SUITE_AGENT_CONFIG", "/etc/visionsuit-gpu-agent/config.yaml")
    config = load_config(config_path)
    agent = GPUAgent(config)

    app = FastAPI(title="VisionSuit GPU Agent", version="1.0.0")
    app.state.agent = agent

    @app.get("/healthz")
    async def healthcheck() -> Dict[str, Any]:
        busy = agent.is_busy()
        activity = await agent.describe_activity()
        return {"status": "ok", "busy": busy, "activity": activity}

    @app.get("/")
    async def root() -> Dict[str, Any]:
        busy = agent.is_busy()
        return {
            "status": "ok",
            "service": "VisionSuit GPU Agent",
            "busy": busy,
            "activity": await agent.describe_activity(),
        }

    @app.post("/jobs", status_code=202)
    async def submit_job(job: DispatchEnvelope, background_tasks: BackgroundTasks) -> Dict[str, Any]:
        if not await agent.try_reserve_job():
            raise HTTPException(status_code=409, detail="Agent is currently processing a job")

        async def run_job() -> None:
            try:
                await agent.run_reserved_job(job)
            except Exception:  # noqa: BLE001
                LOGGER.exception("Job %s crashed", job.jobId)

        background_tasks.add_task(run_job)
        LOGGER.info("Accepted job %s", job.jobId)
        return {"status": "accepted", "jobId": job.jobId}

    @app.on_event("shutdown")
    async def shutdown_event() -> None:  # pragma: no cover - FastAPI event
        await agent.comfyui.close()

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8081, reload=False)

