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

## MinIO helper commands

The installer publishes a small toolkit into `/usr/local/bin` so the worker can stay synchronized with MinIO:

- `generate-model-manifest` – produces a JSON manifest of available base-model checkpoints from MinIO for ComfyUI's dropdowns.
- `sync-loras` – downloads the latest LoRA adapters from MinIO into the worker's local cache.
- `upload-outputs` – pushes freshly rendered outputs from the worker back into the configured MinIO bucket.

All helpers rely on the values stored in `/etc/comfyui/minio.env`. Update that file or export the variables inline to override destinations or prefixes.
