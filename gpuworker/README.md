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

### Rollback to a clean ComfyUI state

Should the GPU worker need to be reverted for testing or reprovisioning, run the companion rollback utility from the same host:

```bash
sudo ./gpuworker/rollback-comfy.sh
```

The script removes the ComfyUI checkout, virtual environment, helper binaries, `/etc/comfyui/minio.env`, and the `comfyui` systemd unit while leaving system packages untouched. Pass `--dry-run` to preview the cleanup or `--yes` to skip the confirmation prompt.

### Automatic GPU driver provisioning

- **NVIDIA** hosts receive the distribution-recommended `nvidia-driver-*` package (discovered via `ubuntu-drivers` when available) and CUDA-enabled PyTorch wheels from `https://download.pytorch.org/whl/cu121`.
- **AMD** hosts automatically receive the AMDGPU + ROCm repositories, install the HIP runtime (`hip-runtime-amd`, `rocm-hip-runtime`, `rocminfo`), and pull ROCm-enabled PyTorch wheels from `https://download.pytorch.org/whl/rocm5.6`.
- **No discrete GPU detected** falls back to CPU-only PyTorch wheels so the worker still functions for validation or CPU rendering.

Reboot the machine after driver installation if `nvidia-smi` or `rocminfo` remain unavailable.

## MinIO helper commands

The installer publishes a small toolkit into `/usr/local/bin` so the worker can stay synchronized with MinIO:

- `generate-model-manifest` – produces a JSON manifest of available base-model checkpoints from MinIO for ComfyUI's dropdowns.
- `sync-checkpoints` – downloads base-model checkpoints from MinIO into the worker's local cache.
- `sync-loras` – downloads the latest LoRA adapters from MinIO into the worker's local cache.
- `upload-outputs` – pushes freshly rendered outputs from the worker back into the configured MinIO bucket.

All synchronization helpers now target ComfyUI's native directories (`/opt/comfyui/models/checkpoints`, `/opt/comfyui/models/loras`, and `/opt/comfyui/output`) so downloaded assets are immediately visible to the running worker without additional symlinks.

All helpers rely on the values stored in `/etc/comfyui/minio.env`. Update that file or export the variables inline to override destinations or prefixes.

## GPU agent service

The ComfyUI node can now be promoted to a managed VisionSuit GPU agent by installing the service in `gpuworker/agent/`. The agent runs alongside ComfyUI, exposes an authenticated queue endpoint, and speaks the dispatch envelope defined for VisionSIOt. Installation steps:

1. Copy `gpuworker/agent/` to the GPU host.
2. Run `sudo ./agent/installer/install.sh` from the repository root to install dependencies, create `/opt/visionsuit-gpu-agent`, and enable the `visionsuit-gpu-agent` systemd unit.
3. Edit `/etc/visionsuit-gpu-agent/config.yaml` to provide MinIO credentials, ComfyUI endpoint, bucket names, and default workflow values.
4. Confirm the service is healthy via `curl http://localhost:8081/healthz` – the response reports whether the agent is idle (`{"status":"ok","busy":false}`).

Dispatch envelopes sent to `POST /jobs` must include all MinIO keys for base models, LoRAs, and the workflow template plus the desired output bucket and prefix. The agent downloads missing assets, renders via ComfyUI, uploads results back into MinIO, and deletes LoRAs or temporary models after completion while leaving persistent checkpoints intact.

When staging assets the agent now rewrites each cached LoRA or checkpoint to use the original uploaded filename (defaulting to `LoraModel.safetensors` when no metadata is available) before surfacing it to ComfyUI, keeping the `.safetensors` extension intact even if the MinIO object key is a hashed identifier.

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

Operators can run workflows without the ComfyUI web UI by calling `scripts/test-run-workflow.sh`. The helper reads `/etc/comfyui/minio.env`, posts the selected workflow JSON (exported via ComfyUI’s **Save (API Format)** action) to the configured ComfyUI API, polls the queue until completion, and prints the generated asset identifiers. Optional flags let you target remote hosts, change the polling interval, or trigger `test-export-outputs` automatically to download the results. Run `sync-checkpoints` and `sync-loras` beforehand so the referenced assets are present locally. The runner now ignores any non-JSON queue or history responses so transient HTML or numeric payloads no longer spam `jq` errors during polling. A prebuilt SDXL workflow tailored for automation ships in `workflows/validation.json` (base model: `calicomixPonyXL_v20.safetensors`, LoRA: `DoomGirl.safetensors`).

Example:

```bash
scripts/test-run-workflow.sh --workflow ~/flows/validation.json --host comfyui.local --export-dir ~/tmp/comfyui-run
```
