# VisionSuit

VisionSuit is a compact installer package for Vision Apps built around Generative AI content. Apps are cloned on demand from their repositories and run inside Docker containers.

## Directory Layout

- `manifests/` – manifest files describing available apps
- `temp/` – temporary clone location when installing apps

## Usage

Install dependencies:

```bash
pip install -r requirements.txt
```

List available apps:

```bash
python app_manager.py list
```

Install an app from its manifest:

```bash
python app_manager.py install VisionVault
```

The install command clones the app repository into `temp/`, builds a Docker image and runs it. The container is exposed on the port defined in the manifest.
