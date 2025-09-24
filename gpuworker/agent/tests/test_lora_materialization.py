import tempfile
import unittest
from pathlib import Path

from gpuworker.agent.app.agent import GPUAgent
from gpuworker.agent.app.models import AssetRef


class DummyMinio:
    def download_to_path(self, *args, **kwargs) -> None:  # noqa: D401 - test stub
        raise AssertionError("download_to_path should not be invoked in tests")


class LoraMaterializationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.base_dir = Path(self.tempdir.name)
        self.agent = GPUAgent.__new__(GPUAgent)
        self.agent.minio = DummyMinio()
        self.agent._symlink_support = {}

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_prepare_primary_lora_cache_replaces_existing_file(self) -> None:
        cache_dir = self.base_dir / "cache"
        cache_dir.mkdir()
        original = cache_dir / "original.safetensors"
        original.write_text("new", encoding="utf-8")
        desired = cache_dir / "hero.safetensors"
        desired.write_text("stale", encoding="utf-8")

        staged = self.agent._prepare_primary_lora_cache(cache_dir, original, "hero.safetensors")

        self.assertEqual(staged, desired)
        self.assertEqual(desired.read_text(encoding="utf-8"), "new")
        self.assertFalse(original.exists())

    def test_ensure_symlink_replace_existing_preserves_override_name(self) -> None:
        cache_dir = self.base_dir / "cache"
        cache_dir.mkdir()
        target = cache_dir / "fresh.safetensors"
        target.write_text("fresh", encoding="utf-8")
        previous_target = cache_dir / "stale.safetensors"
        previous_target.write_text("stale", encoding="utf-8")
        desired = self.base_dir / "hero.safetensors"
        desired.symlink_to(previous_target)

        link, created = self.agent._ensure_symlink(
            desired,
            target,
            source_key="loras/hero.safetensors",
            replace_existing=True,
        )

        self.assertTrue(created)
        self.assertEqual(link, desired)
        self.assertTrue(link.is_symlink())
        self.assertTrue(link.samefile(target))

    def test_materialize_without_symlink_replaces_existing_payload(self) -> None:
        lora_dir = self.base_dir / "loras"
        cache_dir = lora_dir / "cache"
        cache_dir.mkdir(parents=True)
        pretty_path = lora_dir / "hero.safetensors"
        pretty_path.parent.mkdir(parents=True, exist_ok=True)
        pretty_path.write_text("old", encoding="utf-8")
        cached = cache_dir / "hero.safetensors"
        cached.write_text("fresh", encoding="utf-8")
        asset = AssetRef(bucket="models", key="loras/hero.safetensors")

        link_path, downloaded, created = self.agent._materialize_without_symlink(
            pretty_path,
            cache_dir,
            cached.name,
            cached.name,
            asset,
            "LoRA",
            replace_existing=True,
        )

        self.assertEqual(link_path, pretty_path)
        self.assertFalse(downloaded)
        self.assertTrue(created)
        self.assertEqual(pretty_path.read_text(encoding="utf-8"), "fresh")
        self.assertFalse(cached.exists())


if __name__ == "__main__":
    unittest.main()
