from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml


@dataclass
class MinioConfig:
    endpoint: str
    access_key: str
    secret_key: str
    secure: bool = False
    region: Optional[str] = None
    verify_tls: bool = True


@dataclass
class ComfyUIConfig:
    api_url: str
    timeout_seconds: int = 900
    poll_interval_seconds: float = 2.0
    client_id: str = "visionsuit-gpu-agent"


@dataclass
class PathConfig:
    base_models: Path
    loras: Path
    workflows: Path
    outputs: Path
    temp: Path


@dataclass
class CleanupConfig:
    delete_downloaded_loras: bool = True
    delete_downloaded_models: bool = True


@dataclass
class CallbackConfig:
    verify_tls: bool = True
    timeout_seconds: int = 10


@dataclass
class AgentConfig:
    minio: MinioConfig
    comfyui: ComfyUIConfig
    paths: PathConfig
    persistent_model_keys: List[str] = field(default_factory=list)
    cleanup: CleanupConfig = field(default_factory=CleanupConfig)
    callbacks: CallbackConfig = field(default_factory=CallbackConfig)
    workflow_defaults: Dict[str, Any] = field(default_factory=dict)

    def ensure_directories(self) -> None:
        for path in [
            self.paths.base_models,
            self.paths.loras,
            self.paths.workflows,
            self.paths.outputs,
            self.paths.temp,
        ]:
            path.mkdir(parents=True, exist_ok=True)


def _resolve_path(value: str) -> Path:
    expanded = os.path.expanduser(os.path.expandvars(value))
    return Path(expanded).resolve()


def load_config(path: str | os.PathLike[str]) -> AgentConfig:
    cfg_path = Path(path)
    if not cfg_path.exists():
        raise FileNotFoundError(f"Agent configuration missing: {cfg_path}")

    with cfg_path.open("r", encoding="utf-8") as handle:
        payload = yaml.safe_load(handle) or {}

    def _require(section: str, key: str) -> Any:
        if section not in payload or payload[section] is None:
            raise ValueError(f"Configuration section '{section}' missing required key '{key}'")
        if key not in payload[section]:
            raise ValueError(f"Configuration section '{section}' missing required key '{key}'")
        return payload[section][key]

    minio_cfg = MinioConfig(
        endpoint=_require("minio", "endpoint"),
        access_key=_require("minio", "access_key"),
        secret_key=_require("minio", "secret_key"),
        secure=bool(payload.get("minio", {}).get("secure", False)),
        region=payload.get("minio", {}).get("region"),
        verify_tls=bool(payload.get("minio", {}).get("verify_tls", True)),
    )

    comfy_cfg = ComfyUIConfig(
        api_url=_require("comfyui", "api_url"),
        timeout_seconds=int(payload.get("comfyui", {}).get("timeout_seconds", 900)),
        poll_interval_seconds=float(payload.get("comfyui", {}).get("poll_interval_seconds", 2.0)),
        client_id=str(payload.get("comfyui", {}).get("client_id", "visionsuit-gpu-agent")),
    )

    paths_cfg = PathConfig(
        base_models=_resolve_path(_require("paths", "base_models")),
        loras=_resolve_path(_require("paths", "loras")),
        workflows=_resolve_path(_require("paths", "workflows")),
        outputs=_resolve_path(_require("paths", "outputs")),
        temp=_resolve_path(_require("paths", "temp")),
    )

    cleanup_cfg = CleanupConfig(
        delete_downloaded_loras=bool(payload.get("cleanup", {}).get("delete_downloaded_loras", True)),
        delete_downloaded_models=bool(payload.get("cleanup", {}).get("delete_downloaded_models", True)),
    )

    callbacks_cfg = CallbackConfig(
        verify_tls=bool(payload.get("callbacks", {}).get("verify_tls", True)),
        timeout_seconds=int(payload.get("callbacks", {}).get("timeout_seconds", 10)),
    )

    persistent_model_keys = list(payload.get("persistent_model_keys", []) or [])
    workflow_defaults = dict(payload.get("workflow_defaults", {}) or {})

    config = AgentConfig(
        minio=minio_cfg,
        comfyui=comfy_cfg,
        paths=paths_cfg,
        persistent_model_keys=persistent_model_keys,
        cleanup=cleanup_cfg,
        callbacks=callbacks_cfg,
        workflow_defaults=workflow_defaults,
    )
    config.ensure_directories()
    return config

