import copy
import unittest
from pathlib import Path
from types import SimpleNamespace

from gpuworker.agent.app.agent import GPUAgent, ResolvedAsset, ValidationFailure
from gpuworker.agent.app.models import (
    AssetRef,
    DispatchEnvelope,
    JobParameters,
    OutputSpec,
    Resolution,
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
        self.agent.config = SimpleNamespace(
            workflow_defaults={}
        )
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
        self.second_lora_asset_ref = AssetRef(bucket="models", key="loras/second-lora.safetensors")
        self.second_lora_resolved = ResolvedAsset(
            asset=self.second_lora_asset_ref,
            cache_path=Path("/loras/second-lora.safetensors"),
            comfy_name="second-lora.safetensors",
            symlink_path=Path("/loras/second-lora.safetensors"),
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

    def _build_job(self, extra: dict | None = None, loras: list[AssetRef] | None = None) -> DispatchEnvelope:
        payload_extra = {"sampler": "dpmpp_2m_sde_gpu", "scheduler": "karras"}
        if extra:
            payload_extra.update(extra)
        parameters = JobParameters(
            prompt="Test prompt",
            steps=60,
            cfgScale=7.5,
            resolution=Resolution(width=1024, height=1024),
            extra=payload_extra,
        )
        return DispatchEnvelope(
            jobId="job-1",
            user=UserContext(id="user-1", username="tester"),
            workflow=self.workflow_ref,
            baseModel=self.base_asset_ref,
            loras=loras or [self.lora_asset_ref],
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
        self.assertEqual(context["sampler"], "dpmpp_2m_sde_gpu")

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

    def test_missing_sampler_raises_validation_failure(self) -> None:
        job = self._build_job()
        job.parameters.extra.pop("sampler", None)

        with self.assertRaises(ValidationFailure):
            self.agent._build_parameter_context(job, self.base_resolved, [self.lora_resolved])

    def test_missing_scheduler_raises_validation_failure(self) -> None:
        job = self._build_job()
        job.parameters.extra.pop("scheduler", None)

        with self.assertRaises(ValidationFailure):
            self.agent._build_parameter_context(job, self.base_resolved, [self.lora_resolved])

    def test_workflow_defaults_do_not_override_resolved_values(self) -> None:
        original_defaults = dict(self.agent.config.workflow_defaults)
        try:
            self.agent.config.workflow_defaults = {
                "steps": 30,
                "cfg_scale": 4.5,
                "primary_lora_name": "default-lora.safetensors",
                "primary_lora_strength_model": 0.25,
                "primary_lora_strength_clip": 0.25,
                "prompt": "Default prompt",
                "negative_prompt": "default negative",
                "sampler": "heun",
                "scheduler": "exponential",
            }

            job = self._build_job()
            job.parameters.steps = 80
            job.parameters.cfgScale = 9.5
            job.parameters.negativePrompt = "shallow depth of field"

            context = self.agent._build_parameter_context(job, self.base_resolved, [self.lora_resolved])

            self.assertEqual(context["steps"], 80)
            self.assertEqual(context["cfg_scale"], 9.5)
            self.assertEqual(context["prompt"], "Test prompt")
            self.assertEqual(context["negative_prompt"], "shallow depth of field")
            self.assertEqual(context["primary_lora_name"], "my-lora.safetensors")
            self.assertEqual(context["primary_lora_strength_model"], 1.0)
            self.assertEqual(context["primary_lora_strength_clip"], 1.0)
            self.assertEqual(context["sampler"], "dpmpp_2m_sde_gpu")
            self.assertEqual(context["scheduler"], "karras")
        finally:
            self.agent.config.workflow_defaults = original_defaults

    def test_apply_lora_chain_without_loras_removes_loader(self) -> None:
        job = self._build_job(loras=[])
        context = self.agent._build_parameter_context(job, self.base_resolved, [])
        workflow = {
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {}},
            "2": {
                "class_type": "LoraLoader",
                "inputs": {"model": ["1", 0], "clip": ["1", 1], "lora_name": "", "strength_model": 1.0, "strength_clip": 1.0},
            },
            "3": {"class_type": "CLIPTextEncodeSDXL", "inputs": {"clip": ["2", 1]}},
            "4": {"class_type": "KSampler", "inputs": {"model": ["2", 0]}},
        }

        applied = self.agent._apply_lora_chain(workflow, [], context)
        self.assertEqual(applied, [])
        self.assertNotIn("2", workflow)
        self.assertEqual(workflow["3"]["inputs"]["clip"], ["1", 1])
        self.assertEqual(workflow["4"]["inputs"]["model"], ["1", 0])

    def test_apply_lora_chain_with_multiple_loras(self) -> None:
        extra = {
            "loras": [
                {"filename": "my-lora.safetensors", "strength": 0.6},
                {"filename": "second-lora.safetensors", "strength": 0.3},
            ]
        }
        job = self._build_job(extra, loras=[self.lora_asset_ref, self.second_lora_asset_ref])
        resolved_loras = [self.lora_resolved, self.second_lora_resolved]
        context = self.agent._build_parameter_context(job, self.base_resolved, resolved_loras)
        workflow = {
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {}},
            "2": {
                "class_type": "LoraLoader",
                "inputs": {"model": ["1", 0], "clip": ["1", 1], "lora_name": "", "strength_model": 1.0, "strength_clip": 1.0},
            },
            "3": {"class_type": "CLIPTextEncodeSDXL", "inputs": {"clip": ["2", 1]}},
            "4": {"class_type": "KSampler", "inputs": {"model": ["2", 0]}},
        }

        applied = self.agent._apply_lora_chain(workflow, resolved_loras, context)
        self.agent._synchronize_lora_context(job, context, resolved_loras, applied)

        self.assertEqual(len(applied), 2)
        new_node_id = max(workflow.keys(), key=int)
        self.assertNotEqual(new_node_id, "2")
        self.assertEqual(workflow["3"]["inputs"]["clip"], [new_node_id, 1])
        self.assertEqual(workflow["4"]["inputs"]["model"], [new_node_id, 0])
        self.assertEqual(workflow["2"]["inputs"]["lora_name"], "my-lora.safetensors")
        self.assertEqual(workflow["2"]["inputs"]["strength_model"], 0.6)
        self.assertEqual(workflow[new_node_id]["inputs"]["lora_name"], "second-lora.safetensors")
        self.assertEqual(workflow[new_node_id]["inputs"]["strength_model"], 0.3)
        self.assertEqual(context["loras"], ["my-lora.safetensors", "second-lora.safetensors"])

    def test_sdxl_workflow_bindings_receive_resolved_parameters(self) -> None:
        workflow_template = {
            "1": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": "sdxl_base_1.0.safetensors", "vae_name": "None", "clip_name": "None"},
            },
            "2": {
                "class_type": "LoraLoader",
                "inputs": {
                    "model": ["1", 0],
                    "clip": ["1", 1],
                    "lora_name": "",
                    "strength_model": 0.75,
                    "strength_clip": 0.75,
                },
            },
            "3": {
                "class_type": "CLIPTextEncodeSDXL",
                "inputs": {
                    "clip": ["2", 1],
                    "width": 1024,
                    "height": 1024,
                    "crop_w": 0,
                    "crop_h": 0,
                    "target_width": 1024,
                    "target_height": 1024,
                    "text_g": "",
                    "text_l": "",
                },
            },
            "4": {
                "class_type": "CLIPTextEncodeSDXL",
                "inputs": {
                    "clip": ["2", 1],
                    "width": 1024,
                    "height": 1024,
                    "crop_w": 0,
                    "crop_h": 0,
                    "target_width": 1024,
                    "target_height": 1024,
                    "text_g": "",
                    "text_l": "",
                },
            },
            "5": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": 1024, "height": 1024, "batch_size": 1},
            },
            "6": {
                "class_type": "KSampler",
                "inputs": {
                    "model": ["2", 0],
                    "positive": ["3", 0],
                    "negative": ["4", 0],
                    "latent_image": ["5", 0],
                    "seed": 123456789,
                    "steps": 28,
                    "cfg": 7.5,
                    "sampler_name": "dpmpp_2m_sde_gpu",
                    "scheduler": "karras",
                    "denoise": 1.0,
                },
            },
            "7": {
                "class_type": "VAEDecode",
                "inputs": {"samples": ["6", 0], "vae": ["1", 2]},
            },
            "8": {
                "class_type": "SaveImage",
                "inputs": {"images": ["7", 0], "filename_prefix": "SDXL_LoRA_API_{TIMESTAMP}"},
            },
        }

        workflow_ref = WorkflowRef(id="sdxl", inline=workflow_template)
        job = DispatchEnvelope(
            jobId="job-sdxl",
            user=UserContext(id="user-1", username="tester"),
            workflow=workflow_ref,
            baseModel=self.base_asset_ref,
            loras=[self.lora_asset_ref],
            parameters=JobParameters(prompt=""),
            output=OutputSpec(bucket="outputs", prefix="jobs/job-sdxl"),
            workflowParameters=[
                WorkflowParameterBinding(parameter="base_model_path", node=1, path="inputs.ckpt_name"),
                WorkflowParameterBinding(parameter="primary_lora_name", node=2, path="inputs.lora_name"),
                WorkflowParameterBinding(parameter="primary_lora_strength_model", node=2, path="inputs.strength_model"),
                WorkflowParameterBinding(parameter="primary_lora_strength_clip", node=2, path="inputs.strength_clip"),
                WorkflowParameterBinding(parameter="prompt", node=3, path="inputs.text_g"),
                WorkflowParameterBinding(parameter="width", node=3, path="inputs.width"),
                WorkflowParameterBinding(parameter="width", node=3, path="inputs.target_width"),
                WorkflowParameterBinding(parameter="height", node=3, path="inputs.height"),
                WorkflowParameterBinding(parameter="height", node=3, path="inputs.target_height"),
                WorkflowParameterBinding(parameter="negative_prompt", node=4, path="inputs.text_l"),
                WorkflowParameterBinding(parameter="width", node=4, path="inputs.width"),
                WorkflowParameterBinding(parameter="width", node=4, path="inputs.target_width"),
                WorkflowParameterBinding(parameter="height", node=4, path="inputs.height"),
                WorkflowParameterBinding(parameter="height", node=4, path="inputs.target_height"),
                WorkflowParameterBinding(parameter="width", node=5, path="inputs.width"),
                WorkflowParameterBinding(parameter="height", node=5, path="inputs.height"),
                WorkflowParameterBinding(parameter="seed", node=6, path="inputs.seed"),
                WorkflowParameterBinding(parameter="steps", node=6, path="inputs.steps"),
                WorkflowParameterBinding(parameter="cfg_scale", node=6, path="inputs.cfg"),
                WorkflowParameterBinding(parameter="sampler", node=6, path="inputs.sampler_name"),
                WorkflowParameterBinding(parameter="scheduler", node=6, path="inputs.scheduler"),
            ],
        )

        resolved_params = {
            "prompt": "VisionSuit SDXL integration test",
            "negative_prompt": "blurry, artifacts",
            "width": 832,
            "height": 1216,
            "seed": 987654321,
            "steps": 28,
            "cfg_scale": 7.5,
            "sampler": "dpmpp_2m_sde_gpu",
            "scheduler": "karras",
            "base_model_path": "sdxl_base_1.0.safetensors",
            "primary_lora_name": "cyber_fantasy.safetensors",
            "primary_lora_strength_model": 0.75,
            "primary_lora_strength_clip": 0.75,
        }

        payload = build_workflow_payload(InlineWorkflowLoader(), job, resolved_params)

        self.assertEqual(payload["1"]["inputs"]["ckpt_name"], "sdxl_base_1.0.safetensors")
        self.assertEqual(payload["2"]["inputs"]["lora_name"], "cyber_fantasy.safetensors")
        self.assertEqual(payload["2"]["inputs"]["strength_model"], 0.75)
        self.assertEqual(payload["2"]["inputs"]["strength_clip"], 0.75)
        self.assertEqual(payload["3"]["inputs"]["text_g"], "VisionSuit SDXL integration test")
        self.assertEqual(payload["4"]["inputs"]["text_l"], "blurry, artifacts")
        self.assertEqual(payload["3"]["inputs"]["width"], 832)
        self.assertEqual(payload["3"]["inputs"]["height"], 1216)
        self.assertEqual(payload["3"]["inputs"]["target_width"], 832)
        self.assertEqual(payload["3"]["inputs"]["target_height"], 1216)
        self.assertEqual(payload["4"]["inputs"]["width"], 832)
        self.assertEqual(payload["4"]["inputs"]["height"], 1216)
        self.assertEqual(payload["4"]["inputs"]["target_width"], 832)
        self.assertEqual(payload["4"]["inputs"]["target_height"], 1216)
        self.assertEqual(payload["5"]["inputs"]["width"], 832)
        self.assertEqual(payload["5"]["inputs"]["height"], 1216)
        self.assertEqual(payload["6"]["inputs"]["seed"], 987654321)
        self.assertEqual(payload["6"]["inputs"]["steps"], 28)
        self.assertEqual(payload["6"]["inputs"]["cfg"], 7.5)
        self.assertEqual(payload["6"]["inputs"]["sampler_name"], "dpmpp_2m_sde_gpu")
        self.assertEqual(payload["6"]["inputs"]["scheduler"], "karras")


if __name__ == "__main__":
    unittest.main()
