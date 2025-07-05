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
