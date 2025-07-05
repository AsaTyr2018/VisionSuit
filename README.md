# VisionSuit

VisionSuit is a compact installer package for Vision Apps built around Generative AI content. Apps are cloned on demand from their repositories and run inside Docker containers.

## Directory Layout

- `manifests/` – manifest files describing available apps
- `temp/` – temporary workspace used during installation
- `storage/` – permanent location where installed app files are kept

## Usage

Install dependencies:

```bash
pip install -r requirements.txt
```

List available apps:

```bash
python app_manager.py list
```

The repository ships with manifests for three applications:

- **VisionVault** – lightweight image board for AI-generated artwork.
- **MyLora** – manage and browse LoRA models.
- **SDUnity** – Stable Diffusion web UI built with Gradio.

Install an app from its manifest:

```bash
python app_manager.py install <AppName>
```

The install command clones the app repository into `temp/` where the Docker image is built. After the build succeeds, the cloned files are moved to `storage/<AppName>` for persistence. If no `Dockerfile` is present, VisionSuit looks for a `docker_setup/builder.py` script and runs it to create one automatically. The container is then exposed on the port defined in the manifest.

## Web Interface

A simple Flask web server is provided for browsing and managing apps.

Start the server:

```bash
python webserver.py
```

By default the server runs on port 5000. Open `http://localhost:5000` in your
browser to view the app list. Each application shows an **Install** button when
it is not present on the system. Once installed, the Web UI displays **Open**,
**Update** and **Remove** actions allowing you to access the running app,
rebuild it from the latest sources or delete it entirely.

## Bifrost Ingress

On server start, VisionSuit launches the **Bifrost** container which acts as a
reverse proxy for all installed apps. Each application container joins the
`asgard` Docker network and is assigned a random host port. Bifrost listens on
port `80` in the `midgard` network and forwards requests from
`http://<server>/<AppName>/` to the matching host port. Routes are stored in
`bifrost_routes.json` and reloaded automatically whenever apps are installed or
removed.

## Anchor Files

Apps can define custom install steps by placing a `visionsuit-anchor.yaml` (or
`visionsuit-anchor.json`) file in the root of their repository. VisionSuit reads
this file when an app is cloned or updated.

Example `visionsuit-anchor.yaml`:

```yaml
apt_packages:
  - ffmpeg
pip_packages:
  - somepackage>=1.0
env:
  SAMPLE_VAR: "value"
```

Supported keys:

- `apt_packages` – system packages installed via `apt-get` before building the
  Docker image.
- `pip_packages` – additional Python packages installed with `pip`.
- `env` – environment variables passed to the container at runtime.

Include this file in the app repository to have VisionSuit apply these custom
steps automatically.
