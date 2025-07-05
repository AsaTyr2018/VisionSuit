# VisionSuit AGENTS instructions

This repository is a compact installer package for all Vision Apps designed around Generative AI Content. The application pulls, builds and manages Vision Apps using Docker Engine.

- Keep all external Vision apps as git submodules under the `apps/` directory.
- When adding new Vision apps, add them as submodules in `apps/` and commit the change.
- Update submodules regularly using standard git submodule workflow (`git submodule update --remote`).

Current available Repos:
- https://github.com/AsaTyr2018/VisionVault
- https://github.com/AsaTyr2018/MyLora
- https://github.com/AsaTyr2018/SDUnity

Workflow:
1. The user starts the app, which launches a WebUI listing all available apps similar to an Appstore.
2. Additional apps can be included by placing manifest files in the `manifests/` directory.
3. When an app is selected, the script clones the repo into `temp/`, builds the Docker image, starts it, and configures an ingress so the app is accessible via `{serverip}/{appname}` instead of a port. For example `{serverip}/VisionVault` routes to `{serverip}:3000`.
