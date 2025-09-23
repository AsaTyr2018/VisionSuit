from __future__ import annotations

import json
import logging
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, Iterable

from .config import AgentConfig
from .minio_client import MinioManager
from .models import DispatchEnvelope, WorkflowMutation

LOGGER = logging.getLogger(__name__)


class WorkflowLoader:
    def __init__(self, config: AgentConfig, minio: MinioManager):
        self.config = config
        self.minio = minio

    def load(self, job: DispatchEnvelope) -> Dict[str, Any]:
        if job.workflow.inline is not None:
            base = deepcopy(job.workflow.inline)
            LOGGER.debug("Using inline workflow payload for job %s", job.jobId)
        elif job.workflow.localPath is not None:
            path = Path(job.workflow.localPath)
            LOGGER.debug("Loading workflow from local path %s", path)
            with path.open("r", encoding="utf-8") as handle:
                base = json.load(handle)
        elif job.workflow.minioKey is not None:
            tmp_path = self.config.paths.workflows / f"{job.workflow.id}.json"
            bucket = job.workflow.bucket or job.baseModel.bucket
            LOGGER.debug("Fetching workflow from MinIO s3://%s/%s", bucket, job.workflow.minioKey)
            self.minio.download_to_path(bucket, job.workflow.minioKey, tmp_path)
            with tmp_path.open("r", encoding="utf-8") as handle:
                base = json.load(handle)
        else:
            raise ValueError("Workflow reference does not provide a valid source")

        return base


def _build_node_lookup(workflow: Dict[str, Any]) -> Dict[int, Dict[str, Any]]:
    nodes: Dict[int, Dict[str, Any]] = {}
    node_list = workflow.get("nodes") if isinstance(workflow, dict) else None
    if isinstance(node_list, list):
        for node in node_list:
            if not isinstance(node, dict):
                continue
            identifier = node.get("id")
            if isinstance(identifier, int):
                nodes[identifier] = node
            elif isinstance(identifier, str) and identifier.isdigit():
                nodes[int(identifier)] = node
    if nodes:
        return nodes
    if isinstance(workflow, dict):
        for key, value in workflow.items():
            if isinstance(key, str) and key.isdigit() and isinstance(value, dict):
                nodes[int(key)] = value
    return nodes


def apply_mutations(workflow: Dict[str, Any], mutations: Iterable[WorkflowMutation]) -> Dict[str, Any]:
    if not mutations:
        return workflow
    nodes = _build_node_lookup(workflow)
    if not nodes:
        raise KeyError("Workflow does not expose any nodes for mutation")
    for mutation in mutations:
        node = nodes.get(mutation.node)
        if node is None:
            raise KeyError(f"Workflow node {mutation.node} not found")
        _assign_path(node, mutation.path, mutation.value)
    return workflow


def _assign_path(node: Dict[str, Any], dotted_path: str, value: Any) -> None:
    parts = dotted_path.split(".")
    target = node
    for part in parts[:-1]:
        if isinstance(target, dict):
            if part not in target or target[part] is None:
                target[part] = {}
            target = target[part]
        else:
            raise KeyError(f"Cannot resolve path '{dotted_path}' on node {node.get('id')}")
    last = parts[-1]
    if isinstance(target, dict):
        target[last] = value
    else:
        raise KeyError(f"Cannot assign path '{dotted_path}' on non-dict target")


def attach_parameters(workflow: Dict[str, Any], job: DispatchEnvelope, resolved_parameters: Dict[str, Any]) -> Dict[str, Any]:
    if not job.workflowParameters:
        return workflow
    mutations: list[WorkflowMutation] = []
    for binding in job.workflowParameters:
        if binding.parameter not in resolved_parameters:
            continue
        mutations.append(WorkflowMutation(node=binding.node, path=binding.path, value=resolved_parameters[binding.parameter]))
    return apply_mutations(workflow, mutations)


def build_workflow_payload(
    loader: WorkflowLoader,
    job: DispatchEnvelope,
    resolved_parameters: Dict[str, Any],
) -> Dict[str, Any]:
    workflow = loader.load(job)
    apply_mutations(workflow, job.workflowOverrides)
    workflow = attach_parameters(workflow, job, resolved_parameters)
    return workflow

