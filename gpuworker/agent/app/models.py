from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, validator


class UserContext(BaseModel):
    id: str
    username: str


class AssetRef(BaseModel):
    bucket: str
    key: str
    cacheStrategy: Literal["persistent", "ephemeral"] = "ephemeral"
    checksum: Optional[str] = None
    display_name: Optional[str] = Field(None, alias="displayName")
    original_name: Optional[str] = Field(None, alias="originalName")


class WorkflowRef(BaseModel):
    id: str
    version: Optional[str] = None
    minioKey: Optional[str] = None
    localPath: Optional[str] = None
    inline: Optional[Dict[str, Any]] = None
    bucket: Optional[str] = None

    @validator("inline", always=True)
    def _ensure_source(cls, v, values):
        if v is None and not any(values.get(field) for field in ("minioKey", "localPath")):
            raise ValueError("Workflow reference must provide inline payload, minioKey, or localPath")
        return v


class OutputSpec(BaseModel):
    bucket: str
    prefix: str


class WorkflowMutation(BaseModel):
    node: int = Field(..., description="Target node ID inside the ComfyUI workflow")
    path: str = Field(..., description="Dot separated path on the node to update (e.g. inputs.ckpt_name)")
    value: Any


class WorkflowParameterBinding(BaseModel):
    parameter: str
    node: int
    path: str


class CallbackConfigPayload(BaseModel):
    status: Optional[str] = Field(None, description="URL for in-flight status updates")
    completion: Optional[str] = Field(None, description="URL for job completion callbacks")
    failure: Optional[str] = Field(None, description="URL for job failure callbacks")
    cancel: Optional[str] = Field(None, description="URL for cooperative cancellation requests")


class Resolution(BaseModel):
    width: int
    height: int


class JobParameters(BaseModel):
    prompt: str
    negativePrompt: Optional[str] = None
    seed: Optional[int] = None
    cfgScale: Optional[float] = None
    steps: Optional[int] = None
    resolution: Optional[Resolution] = None
    extra: Dict[str, Any] = Field(default_factory=dict)


class DispatchEnvelope(BaseModel):
    jobId: str
    user: UserContext
    workflow: WorkflowRef
    baseModel: AssetRef
    loras: List[AssetRef] = Field(default_factory=list)
    parameters: JobParameters
    output: OutputSpec
    priority: Optional[str] = None
    requestedAt: Optional[str] = None
    cancelToken: Optional[str] = Field(None, alias="cancel_token")
    workflowOverrides: List[WorkflowMutation] = Field(default_factory=list)
    workflowParameters: List[WorkflowParameterBinding] = Field(default_factory=list)
    callbacks: Optional[CallbackConfigPayload] = None

    class Config:
        allow_population_by_field_name = True

