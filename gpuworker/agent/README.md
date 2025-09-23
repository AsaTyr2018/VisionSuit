# VisionSuit GPU Agent

The VisionSuit GPU Agent turns a ComfyUI render node into a managed worker that receives jobs from VisionSIOt, materialises workflow JSON payloads, synchronises models with MinIO, executes the render, and uploads completed assets back to the requested bucket. The service is designed for headless operation and runs as a systemd daemon on the GPU host.

## Features

- **Single-job enforcement** – The agent processes exactly one job at a time and immediately rejects additional submissions with HTTP 409 so VisionSIOt can preserve the queue discipline.
- **Workflow templating** – Supports inline workflows, on-disk templates, or MinIO-hosted JSON and applies node overrides or parameter bindings defined in the dispatch envelope.
- **Managed asset lifecycle** – Caches base checkpoints permanently, downloads job-scoped LoRAs or auxiliary models on demand, and removes ephemeral assets once the render completes.
- **MinIO integration** – Pulls missing models from MinIO before execution and pushes rendered files back to user-specific prefixes with prompt metadata embedded as object metadata.
- **Callback hooks** – Emits optional status, completion, and failure callbacks to VisionSIOt or VisionSuit so UIs can surface progress.

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
2. Adds the system user `visionsuit` if it does not yet exist.
3. Copies the agent sources, creates a Python virtual environment, and installs the required dependencies.
4. Places a default configuration at `/etc/visionsuit-gpu-agent/config.yaml` (update the MinIO credentials, endpoints, and workflow defaults before starting the service).
5. Installs the `visionsuit-gpu-agent.service` unit into systemd and enables it immediately.

> **Tip:** Set the MinIO access key, secret key, bucket names, and ComfyUI API URL in `/etc/visionsuit-gpu-agent/config.yaml` before dispatching jobs.

## Configuration

`config/config.example.yaml` documents every available option:

- `minio.*` – Connection details for the MinIO/S3 endpoint that holds base models, LoRAs, and output buckets.
- `comfyui.*` – REST endpoint, timeout, polling cadence, and client identifier for ComfyUI.
- `paths.*` – Local filesystem paths for ComfyUI models, outputs, workflow cache, and temporary files.
- `persistent_model_keys` – Keys that should never be deleted after download (typically base checkpoints).
- `cleanup.*` – Toggle removal of temporary LoRAs or ad-hoc models after each job.
- `callbacks.*` – TLS verification and timeout for VisionSIOt callback URLs.
- `workflow_defaults` – Additional values injected into the workflow parameter context when building prompts.

## API contract

The agent exposes two HTTP endpoints:

- `GET /healthz` – Returns `{ "status": "ok", "busy": false }` when idle. `busy` becomes `true` while a job is running.
- `POST /jobs` – Accepts a JSON payload that follows the dispatch envelope designed for VisionSIOt. When the agent is idle the endpoint returns HTTP 202 and starts the background job. If the agent is already running a job the endpoint returns HTTP 409.

### Dispatch envelope example

```json
{
  "jobId": "c7c4b87a-6c9e-4a53-9301-7a1d5f6d32b2",
  "user": { "id": "30d6", "username": "curator.one" },
  "workflow": {
    "id": "sdxl-base",
    "minioKey": "generator-workflows/sdxl-refined.json"
  },
  "baseModel": {
    "bucket": "comfyui-models",
    "key": "models/checkpoints/sdxl_base.safetensors",
    "cacheStrategy": "persistent"
  },
  "loras": [
    {
      "bucket": "comfyui-loras",
      "key": "models/loras/my-character.safetensors",
      "cacheStrategy": "ephemeral"
    }
  ],
  "parameters": {
    "prompt": "portrait of a neon samurai",
    "negativePrompt": "lowres, blurry",
    "seed": 12345,
    "cfgScale": 7,
    "steps": 30,
    "resolution": { "width": 1024, "height": 1024 },
    "extra": { "scheduler": "dpmpp_2m" }
  },
  "workflowParameters": [
    { "parameter": "prompt", "node": 23, "path": "inputs.text" },
    { "parameter": "negative_prompt", "node": 24, "path": "inputs.text" },
    { "parameter": "seed", "node": 12, "path": "inputs.seed" },
    { "parameter": "cfg_scale", "node": 12, "path": "inputs.cfg" },
    { "parameter": "steps", "node": 12, "path": "inputs.steps" },
    { "parameter": "base_model_path", "node": 3, "path": "inputs.ckpt_name" }
  ],
  "output": {
    "bucket": "generator-outputs",
    "prefix": "generated/30d6/c7c4b87a-6c9e-4a53-9301-7a1d5f6d32b2"
  },
  "callbacks": {
    "status": "https://visionsiot.local/api/queue/status",
    "completion": "https://visionsiot.local/api/queue/done",
    "failure": "https://visionsiot.local/api/queue/fail"
  }
}
```

- `workflowOverrides` can be supplied to patch nodes directly if a value is not tied to a named parameter.
- Provide `workflow.bucket` when the workflow JSON lives in a different MinIO bucket than the base model entry.
- After completion the agent uploads the generated files to `s3://generator-outputs/generated/<user>/<job>` and, if configured, sends the callback payload `{ "jobId": "...", "status": "completed", "artifacts": ["generated/..."] }`.

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

