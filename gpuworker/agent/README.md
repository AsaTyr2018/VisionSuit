# VisionSuit GPU Agent

The VisionSuit GPU Agent turns a ComfyUI render node into a managed worker that receives jobs from VisionSIOt, materialises workflow JSON payloads, synchronises models with MinIO, executes the render, and uploads completed assets back to the requested bucket. The service is designed for headless operation and runs as a systemd daemon on the GPU host.

## Features

- **Single-job enforcement** – The agent processes exactly one job at a time and immediately rejects additional submissions with HTTP 409 so VisionSIOt can preserve the queue discipline.
- **Workflow templating** – Supports inline workflows, on-disk templates, or MinIO-hosted JSON and applies node overrides or parameter bindings defined in the dispatch envelope.
- **Managed asset lifecycle** – Caches base checkpoints permanently, downloads job-scoped LoRAs or auxiliary models on demand, normalises filenames to the "pretty" names supplied in the dispatch or MinIO metadata, and removes ephemeral assets once the render completes. LoRAs now land directly inside the configured `/opt/comfyui/models/loras` directory (with deterministic symlinks when the display name differs) so ComfyUI sees fresh adapters immediately, and any legacy `cache/` staging folders are migrated in the background. When the underlying filesystem blocks symlink creation (for example SMB/CIFS mounts without UNIX extensions) the agent automatically copies the cache into place so ComfyUI still sees the refreshed weights.
- **Structured job archives** – Backs up every dispatch manifest to `<outputs>/logs/<jobId>/manifest-*.json` and appends newline-delimited status events so operators can review prompts, parameters, cancellations, and upload outcomes for each job.
- **MinIO integration** – Pulls missing models from MinIO before execution and pushes rendered files back to user-specific prefixes with prompt metadata embedded as object metadata.
- **Callback hooks** – Emits optional status, completion, and failure callbacks to VisionSIOt or VisionSuit so UIs can surface progress.
- **Strict ComfyUI validation** – Resolves every checkpoint, VAE, CLIP, and LoRA name against the ComfyUI `/object_info` registry (with a short-lived cache) before submission. Invalid names produce a validation failure and skip the `/prompt` call entirely.
- **Cooperative cancellation** – Dispatchers can call `POST /jobs/cancel` with the job's `cancelToken` to request an early exit. The poll loop terminates gracefully, frees the GPU slot, and emits a `cancelled` status/failure callback pair.

## Directory layout

```
agent/
├── README.md
├── app/
│   ├── agent.py
│   ├── comfyui.py
│   ├── config.py
│   ├── minio_client.py
│   ├── models.py
│   └── workflow.py
├── config/
│   ├── config.example.yaml
│   └── visionsuit-gpu-agent.service
├── installer/
│   └── install.sh
├── main.py
└── requirements.txt
```

- `app/` contains the FastAPI service and helpers.
- `config/` ships a sample YAML configuration and the systemd unit template.
- `installer/` holds the privileged setup script that installs dependencies, copies files into `/opt/visionsuit-gpu-agent`, and enables the daemon.

## Installation

Copy the `gpuworker/agent/` directory to the GPU host and run the installer with elevated privileges:

```bash
cd gpuworker/agent
sudo ./installer/install.sh
```

The installer performs the following steps:

1. Creates the service directories `/opt/visionsuit-gpu-agent` and `/etc/visionsuit-gpu-agent`.
2. Adds the system user `visionsuit` (override with `AGENT_USER`/`AGENT_GROUP`) if it does not yet exist.
3. Copies the agent sources, creates a Python virtual environment, and installs the required dependencies.
4. Places a default configuration at `/etc/visionsuit-gpu-agent/config.yaml` (update the MinIO credentials, endpoints, and workflow defaults before starting the service).
5. Grants ACL access for the agent user to the configured ComfyUI model, LoRA, output, workflow, and temp directories so downloads and uploads succeed without running the daemon as root.
6. Installs the `visionsuit-gpu-agent.service` unit into systemd and enables it immediately.

> **Tip:** Set the MinIO access key, secret key, bucket names, and ComfyUI API endpoint in `/etc/visionsuit-gpu-agent/config.yaml` before dispatching jobs. You can mirror the CLI workflow tester by supplying either a full `api_url` or the `scheme`/`host`/`port` trio used by `gpuworker/scripts/test-run-workflow.sh`.

If you prefer to re-use an existing service account (for example the `comfyui` user created by the worker installer), export `AGENT_USER=<existing-user>` and optionally `AGENT_GROUP=<existing-group>` before running the installer. The ACL step honours these variables and will extend permissions for that account instead of creating `visionsuit`.

## Updating the agent

Run the bundled updater whenever new commits land in the repository clone on the GPU host:

```bash
cd ~/VisionSuit
sudo ./gpuworker/agent/installer/update.sh
```

The script performs a `git pull` from the directory that originally cloned VisionSuit (no `.git` data lives inside `/opt/visionsuit-gpu-agent`), synchronises the refreshed sources into `/opt/visionsuit-gpu-agent`, upgrades dependencies inside the existing virtual environment, reapplies ownership, and restarts the `visionsuit-gpu-agent` systemd service. Override the detected service account by exporting `AGENT_USER`/`AGENT_GROUP` before running the updater if you deviated from the defaults during installation.

## Configuration

`config/config.example.yaml` documents every available option:

- `minio.*` – Connection details for the MinIO/S3 endpoint that holds base models, LoRAs, and output buckets.
- `comfyui.*` – REST endpoint configuration (either a direct `api_url` or discrete `scheme`/`host`/`port` values), timeout, polling cadence, client identifier, asset refresh delay, and the per-step/img2img timeout tunables.
- `paths.*` – Local filesystem paths for ComfyUI models, outputs, workflow cache, and temporary files.
- The agent automatically creates `<outputs>/logs` to store per-job manifests and event logs for troubleshooting.
- `persistent_model_keys` – Keys that should never be deleted after download (typically base checkpoints).
- `cleanup.*` – Toggle removal of temporary LoRAs or ad-hoc models after each job.
- `callbacks.*` – Optional `base_url` override plus TLS verification, timeout, and retry policy for VisionSIOt callback URLs.
- `workflow_defaults` – Optional metadata appended to the workflow parameter context when a dispatch omits the value. Required sampling fields (`steps`, `cfg_scale`, `sampler`, `scheduler`, `width`, `height`, and `seed`) must come directly from the generator request and cannot be provided here.

Set `callbacks.base_url` when the backend publishes relative callback paths or runs behind a reverse proxy so the agent rewrites those hooks to an externally reachable host instead of the default `http://127.0.0.1`. The override now applies even when VisionSuit supplies loopback-only absolute URLs, ensuring completion and failure events land on the control plane regardless of how the backend reports its callback endpoints.

## API contract

The agent exposes lightweight HTTP endpoints:

- `GET /` – Health summary for platform probes. Returns `{ "status": "ok", "service": "VisionSuit GPU Agent", "busy": false }` when idle.
- `GET /healthz` – Returns `{ "status": "ok", "busy": false }` when idle. `busy` becomes `true` while a job is running.
- `POST /jobs` – Accepts a JSON payload that follows the dispatch envelope designed for VisionSIOt. When the agent is idle the endpoint returns HTTP 202 and starts the background job. If the agent is already running a job the endpoint returns HTTP 409.
- `POST /jobs/cancel` – Accepts `{ "token": "<cancelToken>" }` to cancel the in-flight job associated with that token. Returns HTTP 404 when no running job matches.

### Dispatch envelope example

```json
{
  "jobId": "c7c4b87a-6c9e-4a53-9301-7a1d5f6d32b2",
  "user": { "id": "30d6", "username": "curator.one" },
  "workflow": {
    "id": "sdxl-default",
    "minioKey": "generator-workflows/default.json"
  },
  "baseModel": {
    "bucket": "comfyui-models",
    "key": "models/checkpoints/sdxl_base_1.0.safetensors",
    "cacheStrategy": "persistent"
  },
  "loras": [
    {
      "bucket": "comfyui-loras",
      "key": "models/loras/cyber_fantasy.safetensors",
      "cacheStrategy": "ephemeral"
    }
  ],
  "parameters": {
    "prompt": "portrait of a neon samurai",
    "negativePrompt": "lowres, blurry",
    "seed": 987654321,
    "cfgScale": 7.5,
    "steps": 80,
    "resolution": { "width": 832, "height": 1216 },
    "extra": {
      "sampler": "dpmpp_2m_sde_gpu",
      "scheduler": "karras"
    }
  },
  "workflowParameters": [
    { "parameter": "base_model_path", "node": 1, "path": "inputs.ckpt_name" },
    { "parameter": "primary_lora_name", "node": 2, "path": "inputs.lora_name" },
    { "parameter": "primary_lora_strength_model", "node": 2, "path": "inputs.strength_model" },
    { "parameter": "primary_lora_strength_clip", "node": 2, "path": "inputs.strength_clip" },
    { "parameter": "prompt", "node": 3, "path": "inputs.text_g" },
    { "parameter": "negative_prompt", "node": 4, "path": "inputs.text_l" },
    { "parameter": "width", "node": 3, "path": "inputs.width" },
    { "parameter": "width", "node": 3, "path": "inputs.target_width" },
    { "parameter": "height", "node": 3, "path": "inputs.height" },
    { "parameter": "height", "node": 3, "path": "inputs.target_height" },
    { "parameter": "width", "node": 4, "path": "inputs.width" },
    { "parameter": "width", "node": 4, "path": "inputs.target_width" },
    { "parameter": "height", "node": 4, "path": "inputs.height" },
    { "parameter": "height", "node": 4, "path": "inputs.target_height" },
    { "parameter": "width", "node": 5, "path": "inputs.width" },
    { "parameter": "height", "node": 5, "path": "inputs.height" },
    { "parameter": "seed", "node": 6, "path": "inputs.seed" },
    { "parameter": "steps", "node": 6, "path": "inputs.steps" },
    { "parameter": "cfg_scale", "node": 6, "path": "inputs.cfg" },
    { "parameter": "sampler", "node": 6, "path": "inputs.sampler_name" },
    { "parameter": "scheduler", "node": 6, "path": "inputs.scheduler" }
  ],
  "output": {
    "bucket": "generator-outputs",
    "prefix": "generated/30d6/c7c4b87a-6c9e-4a53-9301-7a1d5f6d32b2"
  },
  "callbacks": {
    "status": "https://visionsuit.local/api/generator/requests/c7c4b87a-6c9e-4a53-9301-7a1d5f6d32b2/callbacks/status",
    "completion": "https://visionsuit.local/api/generator/requests/c7c4b87a-6c9e-4a53-9301-7a1d5f6d32b2/callbacks/completion",
    "failure": "https://visionsuit.local/api/generator/requests/c7c4b87a-6c9e-4a53-9301-7a1d5f6d32b2/callbacks/failure"
  }
}
```

The dispatch payload must carry the sampler, scheduler, steps, CFG scale, and dimensions shown above. The agent validates the resolved parameter context and the mutated workflow graph before submitting to ComfyUI, raising a validation error if any of those fields are missing or land on the wrong node.

- `workflowOverrides` can be supplied to patch nodes directly if a value is not tied to a named parameter.
- Provide `workflow.bucket` when the workflow JSON lives in a different MinIO bucket than the base model entry.
- After completion the agent uploads the generated files to `s3://generator-outputs/comfy-outputs/<job>/<index>_<seed>.<ext>` and, if configured, emits a `SUCCESS` callback that includes the resolved `prompt_id`, generation parameters, timing metadata, and a rich artifact list (absolute/relative paths, mime type, SHA-256, S3 location, and public URL). Missing files are logged and reported as warnings without aborting the job.

### Callback payloads

When VisionSuit provides callback URLs the agent now mirrors the control-plane schema directly:

- **Status heartbeats** – Sent to the `callbacks.status` URL with `state` drawn from `QUEUED | PREPARING | MATERIALIZING | SUBMITTED | RUNNING | UPLOADING | SUCCESS | FAILED | CANCELED`. Each heartbeat carries a monotonic `heartbeat_seq`, ISO-8601 `timestamp`, optional `prompt_id`, best-effort progress hints, and a live `activity_snapshot` harvested from the ComfyUI queue. Headers include `Idempotency-Key: <job_id>-<state>-<heartbeat_seq>` so duplicates are safe to replay.
- **Success notifications** – Delivered to `callbacks.completion` with `state: "SUCCESS"`, the artifact manifest, selected sampler parameters, and timing measurements. Idempotency keys follow `<job_id>-SUCCESS` so the backend can ignore retransmits.
- **Failure / cancellation notifications** – Posted to `callbacks.failure` with `state: "FAILED"` or `"CANCELED"`, a structured `reason_code`, normalized `reason`, optional `node_errors`, the last observed activity snapshot, and the same timing block used for success callbacks. Retries reuse `<job_id>-FAILED` or `<job_id>-CANCELED` idempotency keys.

## Running manually

The daemon binds to port `8081` by default. To run it manually inside a shell (for example during development) change into the agent directory, point the configuration variable to a local YAML file, and execute uvicorn:

```bash
VISION_SUITE_AGENT_CONFIG=./config/config.example.yaml \
  uvicorn main:app --host 0.0.0.0 --port 8081 --reload
```

## Removal

To disable and remove the service:

```bash
sudo systemctl disable --now visionsuit-gpu-agent.service
sudo rm -rf /opt/visionsuit-gpu-agent /etc/visionsuit-gpu-agent
sudo rm /etc/systemd/system/visionsuit-gpu-agent.service
sudo systemctl daemon-reload
```

Delete the `visionsuit` system user if it was created solely for the agent.

