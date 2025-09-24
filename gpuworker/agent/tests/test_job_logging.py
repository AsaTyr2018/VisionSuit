import asyncio
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

from gpuworker.agent.app.agent import CancellationHandle, GPUAgent
from gpuworker.agent.app.models import (
    AssetRef,
    DispatchEnvelope,
    JobParameters,
    OutputSpec,
    UserContext,
    WorkflowRef,
)


def _build_job(job_id: str = "job-1") -> DispatchEnvelope:
    workflow = WorkflowRef(
        id="inline",
        inline={"1": {"class_type": "TestNode", "inputs": {}}},
    )
    return DispatchEnvelope(
        jobId=job_id,
        user=UserContext(id="user-1", username="tester"),
        workflow=workflow,
        baseModel=AssetRef(bucket="models", key="base/model.safetensors"),
        loras=[],
        parameters=JobParameters(prompt="hello world"),
        output=OutputSpec(bucket="bucket", prefix="prefix"),
    )


class JobLoggingTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        outputs = root / "outputs"
        outputs.mkdir()
        temp = root / "tmp"
        temp.mkdir()

        self.agent = GPUAgent.__new__(GPUAgent)
        self.agent.config = SimpleNamespace(paths=SimpleNamespace(outputs=outputs, temp=temp))
        self.agent._job_log_dir = outputs / "logs"
        self.agent._job_logs = {}
        self.agent._runtime = {}
        self.agent._cancel_handle = None

    def test_manifest_and_events_written(self) -> None:
        job = _build_job()

        handle = self.agent._create_job_log(job)

        self.assertIsNotNone(handle)
        assert handle is not None  # for type checkers
        self.assertTrue(handle.manifest_path.exists())
        manifest = json.loads(handle.manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest["job"]["jobId"], job.jobId)
        self.assertEqual(manifest["schemaVersion"], 1)
        self.assertIn("capturedAt", manifest)

        self.agent._log_job_event(handle, "completed", {"uploaded": ["file.png"]})
        lines = [line for line in handle.events_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.assertEqual(len(lines), 1)
        entry = json.loads(lines[0])
        self.assertEqual(entry["event"], "completed")
        self.assertEqual(entry["details"]["uploaded"], ["file.png"])


class CancellationLoggingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name)
        outputs = root / "outputs"
        outputs.mkdir()
        temp = root / "tmp"
        temp.mkdir()

        self.agent = GPUAgent.__new__(GPUAgent)
        self.agent.config = SimpleNamespace(paths=SimpleNamespace(outputs=outputs, temp=temp))
        self.agent._job_log_dir = outputs / "logs"
        self.agent._job_logs = {}
        self.agent._runtime = {}
        self.agent._cancel_handle = None

        self.job = _build_job("job-cancel")
        self.log_handle = self.agent._create_job_log(self.job)
        assert self.log_handle is not None
        self.agent._cancel_handle = CancellationHandle(
            token="secret",
            event=asyncio.Event(),
            job=self.job,
        )

    async def asyncTearDown(self) -> None:
        self._tmp.cleanup()

    async def test_cancel_request_records_event(self) -> None:
        accepted = await self.agent.request_cancel("secret")
        self.assertTrue(accepted)
        assert self.log_handle is not None
        lines = [
            json.loads(line)
            for line in self.log_handle.events_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        events = [entry["event"] for entry in lines]
        self.assertIn("cancel_requested", events)


if __name__ == "__main__":
    unittest.main()
