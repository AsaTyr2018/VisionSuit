# GPU Worker Bootstrap

The `gpuworker` directory contains a self-contained installer for preparing a dedicated ComfyUI render node on a fresh GPU host. The script configures the operating system, clones ComfyUI, and installs helper utilities that integrate the worker with MinIO-hosted models and outputs.

## Quick start

1. Copy the `gpuworker/` directory to the target GPU host.
2. Run the installer with elevated privileges:
   ```bash
   sudo ./gpuworker/install.sh
   ```
3. When prompted, supply the MinIO endpoint URL (for example `http://192.168.1.10:9000`). The installer writes the endpoint and secure-mode flag to `/etc/comfyui/minio.env`.
4. Edit `/etc/comfyui/minio.env` and provide the MinIO credentials and bucket names before starting the `comfyui` systemd service:
   ```bash
   sudo systemctl enable --now comfyui.service
   ```

### Automatic GPU driver provisioning

- **NVIDIA** hosts receive the distribution-recommended `nvidia-driver-*` package (discovered via `ubuntu-drivers` when available) and CUDA-enabled PyTorch wheels from `https://download.pytorch.org/whl/cu121`.
- **AMD** hosts automatically receive the AMDGPU + ROCm repositories, install the HIP runtime (`hip-runtime-amd`, `rocm-hip-runtime`, `rocminfo`), and pull ROCm-enabled PyTorch wheels from `https://download.pytorch.org/whl/rocm5.6`.
- **No discrete GPU detected** falls back to CPU-only PyTorch wheels so the worker still functions for validation or CPU rendering.

Reboot the machine after driver installation if `nvidia-smi` or `rocminfo` remain unavailable.

## MinIO helper commands

The installer publishes a small toolkit into `/usr/local/bin` so the worker can stay synchronized with MinIO:

- `generate-model-manifest` – produces a JSON manifest of available base-model checkpoints from MinIO for ComfyUI's dropdowns.
- `sync-loras` – downloads the latest LoRA adapters from MinIO into the worker's local cache.
- `upload-outputs` – pushes freshly rendered outputs from the worker back into the configured MinIO bucket.

All helpers rely on the values stored in `/etc/comfyui/minio.env`. Update that file or export the variables inline to override destinations or prefixes.

## Test validation scripts

When VisionSuit has not yet been wired to the worker you can still verify connectivity with the purpose-built test helpers (copied to `/usr/local/bin` alongside the other utilities):

- `test-create-buckets` – ensures the configured checkpoint, LoRA, and output buckets exist (creating them when missing).
- `test-upload-models` – uploads local checkpoint and/or LoRA files into MinIO so ComfyUI can discover them. Example:
  ```bash
  test-upload-models --models ~/Downloads/checkpoints --loras ~/Downloads/loras
  ```
- `test-export-outputs` – downloads renders from MinIO to a local folder for manual inspection. Example:
  ```bash
  test-export-outputs ~/tmp/comfyui-outputs
  ```

Each test script reads `/etc/comfyui/minio.env`, honours optional `MINIO_*_PREFIX` values, and requires the AWS CLI to be installed.

### API-driven workflow validation

Operators can run workflows without the ComfyUI web UI by calling `scripts/test-run-workflow.sh`. The helper reads `/etc/comfyui/minio.env`, posts the selected workflow JSON to the configured ComfyUI API, polls the queue until completion, and prints the generated asset identifiers. Optional flags let you target remote hosts, change the polling interval, or trigger `test-export-outputs` automatically to download the results. A prebuilt SDXL workflow tailored for automation ships in `workflows/validation.json` (base model: `calicomixPonyXL_v20.safetensors`, LoRA: `DoomGirl.safetensors`).

Example:

```bash
scripts/test-run-workflow.sh --workflow workflows/validation.json --host comfyui.local --export-dir ~/tmp/comfyui-run
```
