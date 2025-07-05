# VisionSuit AGENTS instructions

This repository is a compact installer package for all Vision Apps designed around Generative AI Content. The application pulls, builds and manages Vision Apps using Docker Engine.

- **Do not** use Git submodules or `.gitmodules` files. They are not supported in
  this project and will cause issues.
- Clone external Vision app repositories manually when needed instead of relying
  on submodules.

Current available Repos:
- https://github.com/AsaTyr2018/VisionVault
- https://github.com/AsaTyr2018/MyLora
- https://github.com/AsaTyr2018/SDUnity

Workflow:
1. The user starts the app, which launches a WebUI listing all available apps similar to an Appstore.
2. Additional apps can be included by placing manifest files in the `manifests/` directory.
3. When an app is selected, the script clones the repo into `temp/`, builds the Docker image, starts it, and configures an ingress so the app is accessible via `{serverip}/{appname}` instead of a port. For example `{serverip}/VisionVault` routes to `{serverip}:3000`.

## Bifrost Ingress Blueprint
- All app containers join the `asgard` Docker network.
- **Bifrost** is the only container exposed to the outside world on the `midgard` network.
- On server start, build or start this controller automatically.
- App containers keep their internal port as defined in the manifest but are mapped to a random available host port.
- Record each `{appname}` to host port mapping in a routing table used by Bifrost.
- Bifrost listens on port `80` and proxies requests from `{serverip}/{appname}` coming from `midgard` to the matching host port in `asgard`.
- The routing table allows redirecting to namespaces so multiple apps run simultaneously without fixed host ports.
