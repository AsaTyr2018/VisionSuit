import copy
import unittest
from pathlib import Path
from types import SimpleNamespace

from gpuworker.agent.app.agent import GPUAgent, ResolvedAsset
from gpuworker.agent.app.models import (
    AssetRef,
    DispatchEnvelope,
    JobParameters,
    OutputSpec,
    UserContext,
    WorkflowParameterBinding,
    WorkflowRef,
)
from gpuworker.agent.app.workflow import build_workflow_payload


class InlineWorkflowLoader:
    def load(self, job: DispatchEnvelope):  # noqa: D401 - simple stub
        return copy.deepcopy(job.workflow.inline)


class ParameterContextTests(unittest.TestCase):
    def setUp(self) -> None:
        self.agent = GPUAgent.__new__(GPUAgent)
        self.agent.config = SimpleNamespace(workflow_defaults={"sampler": "euler"})
        self.base_asset_ref = AssetRef(bucket="models", key="checkpoints/base.safetensors")
        self.base_resolved = ResolvedAsset(
            asset=self.base_asset_ref,
            cache_path=Path("/models/base.safetensors"),
            comfy_name="base.safetensors",
            symlink_path=Path("/models/base.safetensors"),
            downloaded=False,
            link_created=False,
        )
        self.lora_asset_ref = AssetRef(bucket="models", key="loras/my-lora.safetensors")
        self.lora_resolved = ResolvedAsset(
            asset=self.lora_asset_ref,
            cache_path=Path("/loras/my-lora.safetensors"),
            comfy_name="my-lora.safetensors",
            symlink_path=Path("/loras/my-lora.safetensors"),
            downloaded=False,
            link_created=False,
        )
        self.workflow_ref = WorkflowRef(
            id="inline",
            inline={
                "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ""}},
                "2": {
                    "class_type": "LoraLoader",
                    "inputs": {"lora_name": "", "strength_model": 0.0, "strength_clip": 0.0},
                },
            },
        )

    def _build_job(self, extra: dict | None = None) -> DispatchEnvelope:
        parameters = JobParameters(prompt="Test prompt", extra=extra or {})
        return DispatchEnvelope(
            jobId="job-1",
            user=UserContext(id="user-1", username="tester"),
            workflow=self.workflow_ref,
            baseModel=self.base_asset_ref,
            loras=[self.lora_asset_ref],
            parameters=parameters,
            output=OutputSpec(bucket="outputs", prefix="jobs/job-1"),
            workflowParameters=[
                WorkflowParameterBinding(parameter="primary_lora_name", node=2, path="inputs.lora_name"),
                WorkflowParameterBinding(
                    parameter="primary_lora_strength_model", node=2, path="inputs.strength_model"
                ),
                WorkflowParameterBinding(
                    parameter="primary_lora_strength_clip", node=2, path="inputs.strength_clip"
                ),
            ],
        )

    def test_primary_lora_metadata_preserved_and_bound(self) -> None:
        extra = {
            "loras": [
                {
                    "id": "lora-1",
                    "filename": "loras/My-Lora.safetensors",
                    "key": "loras/my-lora.safetensors",
                    "strength": 0.85,
                }
            ],
            "primary_lora_name": "../unsanitized-path.safetensors",
            "primary_lora_strength_model": 3,
            "misc": "value",
        }
        job = self._build_job(extra)

        renamed_lora = ResolvedAsset(
            asset=self.lora_asset_ref,
            cache_path=self.lora_resolved.cache_path,
            comfy_name="unsanitized-path.safetensors",
            symlink_path=Path("/loras/unsanitized-path.safetensors"),
            downloaded=self.lora_resolved.downloaded,
            link_created=self.lora_resolved.link_created,
        )

        context = self.agent._build_parameter_context(job, self.base_resolved, [renamed_lora])

        self.assertEqual(context["loras"], ["unsanitized-path.safetensors"])
        self.assertIn("loras_metadata", context)
        self.assertIsNot(context["loras_metadata"], job.parameters.extra["loras"])
        self.assertEqual(context["loras_metadata"], job.parameters.extra["loras"])
        self.assertEqual(context["primary_lora_name"], "unsanitized-path.safetensors")
        self.assertEqual(context["primary_lora_strength_model"], 0.85)
        self.assertEqual(context["primary_lora_strength_clip"], 0.85)
        self.assertEqual(context["misc"], "value")
        self.assertEqual(context["sampler"], "euler")

        payload = build_workflow_payload(InlineWorkflowLoader(), job, context)
        lora_inputs = payload["2"]["inputs"]
        self.assertEqual(lora_inputs["lora_name"], "unsanitized-path.safetensors")
        self.assertEqual(lora_inputs["strength_model"], 0.85)
        self.assertEqual(lora_inputs["strength_clip"], 0.85)

    def test_primary_lora_defaults_when_metadata_missing(self) -> None:
        job = self._build_job()

        context = self.agent._build_parameter_context(job, self.base_resolved, [self.lora_resolved])

        self.assertEqual(context["primary_lora_name"], "my-lora.safetensors")
        self.assertEqual(context["primary_lora_strength_model"], 1.0)
        self.assertEqual(context["primary_lora_strength_clip"], 1.0)
        self.assertNotIn("loras_metadata", context)


if __name__ == "__main__":
    unittest.main()
