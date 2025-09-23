# VisionSuit

VisionSuit is a self-hosted platform for curated AI image galleries and LoRA safetensor distribution. The project ships with a runnable Node.js API, a Prisma data model including seed data, and a React front end that demonstrates the intended upload and curation workflow.

## Core Highlights

- **Unified operations dashboard** – Persistent sidebar navigation with instant switching between Home, Models, and Images, plus glassy health cards with color-coded LED beacons for the front end, API, MinIO, and GPU worker services.
- **Role-aware access control** – JWT-based authentication with session persistence, an admin workspace for user/model/gallery management, a dialog-driven onboarding wizard with role presets, protected upload flows, and private uploads that stay exclusive to their owner for curators while administrators always see the full inventory in their workspace (with optional audit mode on curator profiles for spot checks).
- **Live environment controls** – Administration → Settings writes the site title, registration policy, maintenance mode, and service endpoints back to the backend and frontend `.env` files, surfacing restart guidance whenever connection details change so the stack stays aligned without shell access.
- **Layered moderation workflow** – Members can flag problematic models or renders, flagged assets now disappear for the community (creators receive an “In Audit” placeholder with the asset name), and admins triage them from a cozy tile-based Moderation overview with aggregated reporter/reason chips and enforced rejection notes. Linked collections are automatically hidden while a model is under review and are removed entirely when the model is revoked.
- **Adult prompt governance** – Administration → Safety now manages configurable prompt keywords that automatically mark renders as adult when detected in prompts, LoRA metadata, or preview EXIF so NSFW assets stay hidden from guests and from members who browse with the safe-mode toggle disabled.
- **Member registration & reactions** – Public self-service signup promotes visitors into the USER role, unlocks downloads, comments, and single-tap image likes, surfaces received-like totals across profiles, and keeps upload rights reserved for curators and admins.
- **Self-service account management** – Sidebar account settings let curators update their display name, bio, and password, now proxy uploaded avatars (PNG/JPG/WebP ≤ 5 MB) through the API, and automatically reroute legacy MinIO avatar links so external domains never surface `127.0.0.1` references.
- **Guided three-step upload wizard** – Collects metadata, files, and review feedback with validation, drag & drop, and live responses from the production-ready `POST /api/uploads` endpoint.
- **Data-driven explorers** – Fast filters and full-text search across LoRA assets and galleries, complete with tag badges, five-column tiles, and seamless infinite scrolling with active filter indicators.
- **On-Site Generator hub** – Role-aware wizard that mirrors the admin-curated base-model labels from Administration → Generator, exposes them in a checkbox matrix, trusts configured base models even when no catalog asset exists (pulling the checkpoint straight from the GPU node store), lets curators compose prompts, mix LoRAs, tap trigger suggestions straight into the prompt box, pick dimensions, and enqueue generation jobs while preserving per-user history—all while live queue telemetry surfaces GPU agent activity, pause/resume state, and any admin-imposed generation blocks.
- **Curator spotlight profiles** – Dedicated profile view with avatars, rank progression, bios, and live listings of every model and collection uploaded by the curator, reachable from any curator name across the interface.
- **Versioned modelcards** – Dedicated model dialogs with inline descriptions, quick switches between safetensor versions, in-place editing for curators/admins, an integrated flow for uploading new revisions including preview handling, and admin tooling to promote or retire revisions.
- **Governed storage pipeline** – Direct MinIO ingestion with automatic tagging, secure download proxying via the backend, audit trails, and guardrails for file size (≤ 2 GB) and batch limits (≤ 12 files).

## Good to Know

- Sticky shell layout with live service badges, trust metrics, and call-to-action panels for a polished product look including toast notifications for upload events.
- Guests can browse public assets, while downloads, comments, and reactions require a signed-in account (USER role or higher). Adult-tagged models and renders stay hidden from guests and from members who leave the NSFW toggle off (default) in their account settings.
- Home spotlight tiles are fully interactive—click previews to jump straight into the model or gallery explorers, and tap tag chips to filter matching content instantly.
- Gallery and model previews now ship with an intelligent two-minute cache token so browsers keep recent imagery warm while automatically reloading whenever the underlying asset changes.
- Model detail views and the gallery lightbox now include full comment threads—model dialogs keep replies inline beneath the content, while the gallery modal tucks discussions into a collapsible side rail so the enlarged image always stays visible. Signed-in members can post feedback and react to individual responses in place.
- Curators can edit and delete their own models, collections, and images directly from the explorers (each destructive action ships with a “Nicht umkehrbar ist wenn gelöscht wird. weg ist weg.” warning), while administrators continue to see controls for every entry.
- Manual collection linking lets curators attach their own galleries to models from the detail view, while administrators can pair any collection when moderation requires intervention.
- Administrators can toggle the On-Site Generator between an **Admin only** preview phase and a **Members & curators** rollout from the Administration → Generator tab, and curate the exact database-backed base-model list consumed by the wizard without touching storage manifests.
- Private uploads remain hidden from other curators; the administration workspace now surfaces every model, gallery, and image for admins by default, and the token-aware storage proxy streams private previews directly in the browser for moderation. The **Audit** toggle on curator profiles remains available for targeted spot checks.
- Signed-in users can open the **Account settings** dialog from the sidebar to adjust profile details or rotate their password in a single modal workflow.
- Administration workspace now presents models and images in lightweight thumbnail grids with one-click detail pages, inline visibility toggles, ranking controls (weights, tiers, and user resets), persistent bulk tools tuned for six-figure libraries, multi-step onboarding with permission previews, dialog-driven actions to edit assets, upload or rename model versions, remove secondary revisions, **and a dedicated Moderation tab** that lists every flagged asset for approve/remove workflows. Model and image edit dialogs now ship with tabbed flows (details, prompting, metadata, ownership) plus right-rail summaries for instant context, and ranking inputs immediately cache typed values so the tab stays responsive while backend refreshes complete. Image archive filters add a dedicated model picker with type-ahead suggestions sourced from stored metadata so curators can audit renders tied to specific checkpoints in seconds.
- Flagged models and renders are hidden from members and curators; creators get a lightweight “In Audit” placeholder while administrators continue to see clear previews and can approve or remove them while leaving the required audit note that will power the upcoming notification center.
- Gallery uploads support multi-select (up to 12 files/2 GB), role-aware gallery selection, and on-the-fly gallery creation.
- Model uploads enforce exactly one safetensor/ZIP archive plus a cover image; additional renders can be attached afterwards from the gallery explorer.
- Gallery explorer offers a five-column grid with random cover art, consistent tile sizing, and a detail dialog per collection with an EXIF lightbox for every image.
- Interface remains resilient when the backend returns incomplete gallery payloads—missing owners, metadata, or even entry arrays—and the metadata card now stretches across the dialog for easier scanning.
- Automatic extraction of EXIF, Stable Diffusion prompt data, and safetensor headers populates searchable base-model references and frequency tables for tags.
- Modelcards include a dedicated Trigger/Activator field that is required during uploads or edits and ships with a click-to-copy shortcut for quick prompting.
- Click any curator name—from home cards to explorer panels and admin lists—to jump straight into the curator’s profile with contribution stats and navigation back to their models or collections.
- Administrators can fine-tune rank weights, curate new tiers, reset individual curator ladders, or temporarily block a curator from ranking directly inside the admin **Ranking** tab or via the dedicated `/api/rankings` controls.

## Community Roadmap

VisionSuit is evolving toward a richer community layer featuring reactions, threaded discussions, collaborative collections, and creator recognition systems. The [Community Features Plan](docs/community-features-plan.md) outlines the phased rollout, technical architecture, and moderation safeguards that will guide this expansion while preserving the curated gallery experience. A complementary [feasibility analysis](docs/community-features-plan-analysis.md) captures the current engineering effort required for each capability. Severity-bucketed content programs are captured in the companion plans for [Project Silverleaf](docs/community-update-plans/project-silverleaf-low-severity.md), [Project Ironquill](docs/community-update-plans/project-ironquill-medium-severity.md), and [Project Novashield](docs/community-update-plans/project-novashield-high-severity.md).

An [On-Site Image Generator Project Plan](docs/on-site-image-generator-plan.md) details how a headless ComfyUI service, MinIO-hosted models, and curated review tooling will deliver in-platform rendering with governed moderation and retention workflows.

## Support & Credits

For real-time assistance, join the [VisionSuit Support Discord](https://discord.gg/UEb68YQwKR). VisionSuit is produced by [MythosMachina](https://github.com/MythosMachina) and developed by [AsaTyr](https://github.com/AsaTyr2018/).

## Architecture Overview

| Layer | Purpose & Key Technologies |
| ----- | -------------------------- |
| **Backend API** | Express 5 with TypeScript orchestrated by Prisma ORM. Exposes REST endpoints for authentication, uploads, asset management, and statistics. |
| **Database** | SQLite during development, modelled via Prisma schemas for users, LoRA assets, galleries, tags, upload drafts, and storage objects with referential constraints. |
| **Object Storage** | MinIO (S3 compatible) provides buckets for model and image artifacts. Buckets and credentials are provisioned automatically by the install script. |
| **Front End** | Vite + React (TypeScript) delivers the management console, explorers, and upload wizard with real-time data fetching. |
| **Tooling & Ops** | Shell scripts automate environment setup, dependency installation, Prisma migrations, seeding, and optional Portainer CE provisioning. |

## Installation & Setup

### Prerequisites

Ensure the following tools are available on the target host:

- Node.js 22 LTS (includes npm)
- Python 3 (utility scripts used by the installer)
- Docker Engine with a running daemon
- Docker Compose plugin or the legacy `docker-compose` binary
- Optional: Portainer CE (can be installed by the setup script)

### Guided setup script

Run the bundled installer to configure the entire stack:

```bash
./install.sh
```

The script detects the reachable server IP, replaces loopback references, and proposes sensible defaults (API `4000`, front end `5173`, MinIO `9000`). Accept the summary with `Y` or provide custom values interactively. Only the external API and front end ports are requested; all internal services use vetted defaults.

During execution the installer:

1. Verifies Docker, Docker Compose, and optionally installs Portainer CE when missing.
2. Installs npm dependencies for `backend` and `frontend`.
3. Generates missing `.env` files from templates, aligning `HOST`/`VITE_API_URL` with the detected server IP.
4. Provisions MinIO credentials, configures buckets, and launches the `visionsuit-minio` container.
5. Offers optional execution of `npm run prisma:migrate`, `npm run seed`, and `npm run create-admin` for initial data.

Base checkpoints for the On-Site Generator still live in the GPU worker bucket `comfyui-models`. When customizing bucket names, mirror the change inside `backend/.env` with `GENERATOR_BASE_MODEL_BUCKET` and inside `frontend/.env` via `VITE_GENERATOR_BASE_MODEL_BUCKET` so the GPU worker and download proxy continue to line up. After new checkpoints land in the bucket, open **Administration → Generator** and add an entry for each filename so the curated picker exposes only vetted models; the generator now hydrates that list from the corresponding database records automatically. For headless maintenance windows or CI pipelines the helper remains available to pre-seed the catalog explicitly:

```bash
cd backend
npm run generator:sync-base-models
```

The helper script cross-references the configured bucket, creates public `checkpoint` model assets for any missing entries, and refreshes ownership/metadata for existing records—useful when preparing a dataset before users sign in or when scripting migrations.

Installations where the MinIO or S3 credentials lack `ListObjects` can still power the base-model picker by exposing a manifest JSON inside the same bucket (default `minio-model-manifest.json`) that enumerates object keys. The backend reads this manifest before falling back to live bucket listing. Override the filename through `GENERATOR_BASE_MODEL_MANIFEST` whenever the manifest ships under a different key—`gpuworker/scripts/generate-model-manifest.sh` produces a compatible payload automatically.

After completion the stack is ready for development or evaluation. Use `./dev-start.sh` for a combined watch mode when coding locally.

### Serving VisionSuit through a single public domain

Expose only the frontend to the internet when publishing VisionSuit under a public hostname (for example `https://example.com`). Set `VITE_API_URL=@origin` inside `frontend/.env` so the React app talks to the backend through the same origin, and let your reverse proxy forward `/api` requests to the private backend port while keeping MinIO reachable solely via the values defined in `backend/.env`. The Vite dev server automatically proxies these relative API calls to the address stored in `DEV_API_PROXY_TARGET` (defaults to `http://127.0.0.1:4000`), so internal service-to-service communication continues to rely on the previously configured `.env` endpoints even when external clients access the platform through the frontend.

### Creating an initial admin account

The administrative surfaces require a signed-in profile. Create one via SSH on the target machine:

```bash
cd backend
npm run create-admin -- \
  --email=admin@example.com \
  --password="super-secure-password" \
  --name="VisionSuit Admin" \
  --bio="Optional profile text"
```

The script upserts an `ADMIN` role account, activates it, and stores the hashed password.

### Dedicated GPU worker provisioning

A remote ComfyUI render node can be prepared independently of the VisionSuit stack. Copy the [`gpuworker/`](gpuworker/README.md) directory to the GPU host, run `sudo ./gpuworker/install.sh`, and provide the MinIO endpoint URL when prompted so the worker targets the correct storage instance. The installer now autodetects NVIDIA and AMD GPUs, installs the matching driver stack (CUDA with the distribution-recommended NVIDIA package or ROCm + HIP for AMD), and falls back to CPU-only PyTorch wheels when no discrete GPU is found. After installation, populate `/etc/comfyui/minio.env` with MinIO credentials before enabling the `comfyui` systemd service. The helper toolkit (`generate-model-manifest`, `sync-checkpoints`, `sync-loras`, and `upload-outputs`) keeps base models, LoRAs, and rendered outputs synchronized with MinIO, landing them directly in ComfyUI’s native tree under `/opt/comfyui/models` and `/opt/comfyui/output` so no manual symlinks are required. The bundled workflow validator (`scripts/test-run-workflow.sh`) also tolerates non-JSON queue or history payloads so repeated polls never echo `jq` parse errors, and expects workflows exported via ComfyUI’s **Save (API Format)** action (the shipped `workflows/validation.json` already follows this layout). If the host repositories omit the legacy `awscli` package, the installer automatically downloads the official AWS CLI v2 bundle so the synchronization helpers remain available. When you need to return the worker to a pre-install baseline, `sudo ./gpuworker/rollback-comfy.sh` cleans up the ComfyUI checkout, MinIO environment file, helper binaries, and systemd unit while leaving the operating system packages intact.

#### GPU agent service

Alongside the ComfyUI runtime you can deploy the VisionSuit GPU agent to broker jobs from VisionSIOt. The agent lives in [`gpuworker/agent`](gpuworker/agent/README.md) and installs via `sudo ./gpuworker/agent/installer/install.sh`, which copies the FastAPI service to `/opt/visionsuit-gpu-agent`, provisions a Python virtual environment, and enables the `visionsuit-gpu-agent` systemd unit. Configure `/etc/visionsuit-gpu-agent/config.yaml` with MinIO credentials, bucket names, workflow defaults, and the ComfyUI API URL. The ComfyUI block now accepts either a ready-to-use `api_url` or the same `scheme`/`host`/`port` tuple that `gpuworker/scripts/test-run-workflow.sh` understands so both the CLI validator and the agent target identical endpoints. VisionSIOt submits dispatch envelopes to `POST /jobs`; the agent enforces single-job execution, hydrates workflows, syncs missing models from MinIO, invokes ComfyUI, uploads outputs to the requested bucket, and notifies VisionSuit through the optional status/completion/failure callbacks. When VisionSuit emits relative callback paths (for example when the backend sits behind a reverse proxy), populate `callbacks.base_url` in the agent configuration so those hooks target a reachable host instead of defaulting to `http://127.0.0.1`.

Re-running the installer now stops and disables any existing `visionsuit-gpu-agent` service, removes the previous systemd unit, and recreates `/opt/visionsuit-gpu-agent` from scratch before staging the updated release so upgrades land on a clean slate.

#### VisionSuit ↔ GPU agent handshake

VisionSuit now speaks to the GPU agent instead of probing ComfyUI directly. Point `GENERATOR_NODE_URL` in `backend/.env` at the agent root (for example `http://gpu-node:8081`)—the service advertises `GET /` and `GET /healthz` so health checks stay green. Provide the workflow location and parameter bindings via:

- `GENERATOR_WORKFLOW_ID`, `GENERATOR_WORKFLOW_BUCKET`, and `GENERATOR_WORKFLOW_MINIO_KEY` (or `GENERATOR_WORKFLOW_LOCAL_PATH` / `GENERATOR_WORKFLOW_INLINE`) to tell the agent which JSON graph to load.
- A starter SDXL workflow ships at [`backend/generator-workflows/default.json`](backend/generator-workflows/default.json); when no custom `GENERATOR_WORKFLOW_LOCAL_PATH` is provided the backend uploads this template to MinIO automatically.
- `GENERATOR_WORKFLOW_EXPOSE_LOCAL_PATH` defaults to `false` so dispatch envelopes always reference the MinIO object; set it to `true` only when the GPU agent can read the same filesystem path (for example on a co-located host).
- VisionSuit now auto-seeds the configured workflow into `GENERATOR_WORKFLOW_BUCKET` before every dispatch, so provide either a
  local template path or inline JSON when rolling out a new graph to avoid 404s on the GPU node.
- Prompt, sampler, and resolution bindings are pre-wired for the bundled workflow—only override `GENERATOR_WORKFLOW_PARAMETERS` when publishing a custom node layout.
- `GENERATOR_WORKFLOW_PARAMETERS` (JSON array) to map prompt/seed/CFG inputs onto workflow nodes and `GENERATOR_WORKFLOW_OVERRIDES` for fixed node tweaks.
- `GENERATOR_OUTPUT_BUCKET` and `GENERATOR_OUTPUT_PREFIX` to control where the agent uploads rendered files (supports `{userId}` and `{jobId}` tokens).
- `GENERATOR_CALLBACK_BASE_URL` so the backend can publish reachable callback URLs for status, completion, and failure updates (defaults to `http://127.0.0.1:4000` when unset).

Once those values are set, every `POST /api/generator/requests` submission queues a dispatch envelope with the selected base models, LoRA adapters, and prompt metadata. The GPU agent receives the full base-model roster alongside the primary checkpoint so it can stage or audit every curated option up front. If the GPU agent reports a busy state VisionSuit marks the request as `pending`; accepted jobs flip to `queued` and surface in the history list immediately. When the agent executes the job it now posts back to `/api/generator/requests/:id/callbacks/status` as phases progress, `/completion` once artifacts land in MinIO, and `/failure` if the run aborts—VisionSuit records those transitions, stores returned object keys, and surfaces finished renders directly in the On-Site Generator history.

GPU-side failures are now reported back to VisionSuit automatically. The agent emits an error status before the failure callback so jobs no longer remain stuck as `queued`, and administrators can review the full diagnostic trail inside the new **Administration → Generator → Generation failure log** panel. Members only see a generic failure notice in their history while sensitive stack traces stay scoped to the admin center.

To support operational visibility the agent samples the ComfyUI `/queue` endpoint before each status callback and includes a live activity snapshot (pending/running counts plus the raw payload) so VisionSuit can mirror GPU utilization, pause state, and administrator-imposed blocks in both the generator wizard and the Administration → Generator tab. The `/` and `/healthz` probes expose the same telemetry so external monitors can verify the worker is healthy and idle before dispatching additional jobs.

## Development Workflow

### Unified dev starter

`./dev-start.sh` launches both API and front end in watch mode, binding services to the IP supplied through the `HOST` environment variable. Pass your server IP explicitly when developing across networks to avoid `localhost` confusion:

```bash
(cd backend && npm install)
(cd frontend && npm install)
HOST=<your-server-ip> ./dev-start.sh
```

Default ports:

- Backend: `4000` (override with `BACKEND_PORT`)
- Front end: `5173` (override with `FRONTEND_PORT`)

> Tip: Always point `HOST` to a reachable address (e.g., `HOST=192.168.1.50 ./dev-start.sh`) when accessing services from other devices or containers.

## Bulk Import Utilities

Client-side helpers streamline batched LoRA transfers when curating existing libraries offline. Both scripts expect two sibling directories on the client machine:

- `loras/` – contains `.safetensors` weights.
- `images/` – contains folders named after each safetensor (without the extension) populated with preview renders.

Each importer refuses to upload a model unless a matching image folder exists. After authentication the helpers verify the signed-in account is an administrator, upload the LoRA with a randomly chosen preview image, and then cycle through the remaining renders in batches of up to twelve files so the entire gallery lands in VisionSuit without the usual per-request cap.

### Linux and macOS

1. Review and adjust `server_ip`, `server_username`, and `server_port` at the top of `scripts/bulk_import_linux.sh`.
2. Ensure `curl` and `python3` are installed on the client.
3. Provide the VisionSuit administrator password either via the `VISIONSUIT_PASSWORD` environment variable or interactively when prompted (bulk imports are restricted to admin accounts).
4. Run the script from the root of your asset stash (or pass custom directories):

   ```bash
   ./scripts/bulk_import_linux.sh ./loras ./images
   ```

The script authenticates with `POST /api/auth/login`, seeds the gallery by uploading the LoRA file together with a random preview, and then pushes every remaining render into the same collection across as many follow-up batches as necessary. Models without imagery are skipped automatically.

### Windows (PowerShell)

1. Edit `$ServerIp`, `$ServerUsername`, and `$ServerPort` at the head of `scripts/bulk_import_windows.ps1`.
2. Launch the script from PowerShell 7+ (`pwsh`) or Windows PowerShell 5.1. The helper auto-loads the required `System.Net.Http` types so legacy shells work without manual assembly tweaks. Enter your VisionSuit administrator password when prompted or expose it via `VISIONSUIT_PASSWORD`.
3. Run the importer with optional overrides for the source folders:

   ```powershell
   pwsh -File .\scripts\bulk_import_windows.ps1 -LorasDirectory .\loras -ImagesDirectory .\images
   ```

The PowerShell helper mirrors the Linux workflow: it authenticates, verifies admin privileges, stages the LoRA with a random preview, and then fans out the remaining renders in twelve-file batches until the entire collection has been imported.

> Tip: If `ImagesDirectory` is missing or omitted, the script now searches for preview folders that live next to each `.safetensors` file (for example `./loras/model-name.safetensors` with a sibling `./loras/model-name/`).

### MyLora migration

Use `scripts/migrate_mylora_to_visionsuit.py` to pull an existing MyLora library into VisionSuit without touching databases directly.

- Install the lone dependency once on the machine running the migration helper:
  ```bash
  pip install requests
  ```
- Provide the base URLs and admin credentials for both platforms:
  ```bash
  python3 scripts/migrate_mylora_to_visionsuit.py \
    --mylora-base-url http://127.0.0.1:5000 \
    --mylora-username admin \
    --mylora-password "mylora-secret" \
    --visionsuit-base-url http://127.0.0.1:4000/api \
    --visionsuit-email admin@example.com \
    --visionsuit-password "visionsuit-secret"
  ```
- Optional `--visibility public` publishes the migrated models instantly; omit it to stage imports as private drafts.

The script logs into MyLora, walks the grid API in batches, downloads each safetensor and its preview images, then creates matching VisionSuit model entries with categories and tags preserved as labels. Existing VisionSuit models are skipped automatically to avoid duplicates when a run is interrupted or repeated.

### Backend service

1. `cd backend`
2. Create `.env` from the template if it does not exist:
   ```bash
   cp .env.example .env
   ```
   The default sets `DATABASE_URL="file:./dev.db"` for both Prisma CLI and the dev server.
3. Optionally apply migrations and seed demo data:
   ```bash
   npm run prisma:migrate
   npm run seed
   ```
4. Start the development server (ideally with the server IP):
   ```bash
   HOST=<your-server-ip> PORT=4000 npm run dev
   ```

### Front-end service

1. `cd frontend`
2. Start Vite with explicit host binding:
   ```bash
   npm run dev -- --host <your-server-ip> --port 5173
   ```
3. Confirm your Node.js version:
   ```bash
   node -v
   ```
   Upgrade via `nvm` if the version is below 18.
4. Open `http://<your-server-ip>:5173` to explore live filters for LoRA models and curated galleries.

### Allowing external domains in Vite

Vite blocks unknown hosts by default when the dev server is reachable from the internet. Use the helper to register additional
domains:

```bash
node scripts/add-allowed-host.mjs example.com
```

Replace `example.com` with the domain you need to allow. The script normalizes the domain, updates `frontend/allowed-hosts.json`, and keeps the list sorted. Restart the Vite dev server after adding a new host so the updated allow list takes effect.

## Upload Pipeline

1. **Authentication** – Every upload requires a valid JWT. Missing or expired tokens respond with `401/403` immediately.
2. **Draft creation** – `POST /api/uploads` stores an `UploadDraft` with owner, visibility, tags, and expected files.
3. **Direct storage ingest** – Files stream straight to MinIO (`s3://<bucket>/<uuid>`). The backend issues random object IDs, stores metadata (name, MIME type, size) in `StorageObject`, and returns anonymized identifiers.
4. **Asset linking** – The backend creates `ModelAsset` or `ImageAsset` entries, attaches tags, provisions galleries when requested, and auto-assigns covers.
5. **Explorer refresh & auditing** – Drafts transition to `processed`, new tiles appear instantly, and storage metadata (bucket, object key, public URL) is included in the response.

Batch uploads validate up to 12 files per request and enforce the 2 GB size ceiling with descriptive error messages.

## API Snapshot

- `GET /health` – Service health probe.
- `POST /api/auth/login` – Email/password authentication returning JWT and profile data.
- `GET /api/auth/me` – Validates a JWT and returns the current account.
- `GET /api/meta/stats` – Aggregated counters for assets, galleries, and tags.
- `GET /api/assets/models` – LoRA assets including owners, tags, and metadata.
- `GET /api/assets/images` – Image assets with prompts, model info, and tags.
- `GET /api/galleries` – Curated gallery collections and associated assets.
- `POST /api/uploads` – Initiates the upload pipeline for models or galleries (JWT required).
- `GET /api/storage/:bucket/:objectId` – Secure file proxy resolving anonymized IDs to originals with role-aware gating (public assets stream for guests; private ones require owner/admin access).
- `GET /api/users/:id/avatar` – Streams curator avatars through the API without exposing MinIO endpoints.
- `GET /api/users` – Admin-only listing of accounts.
- `POST /api/users` – Admin-only account provisioning.
- `GET /api/rankings/settings` – Admin-only view of the current score weights with fallback defaults.
- `PUT /api/rankings/settings` – Admin-only update to model/gallery/image weightings.
- `GET /api/rankings/tiers` – List rank tiers (including inactive ones when present).
- `POST /api/rankings/tiers` – Add a new rank tier with label, description, and minimum score.
- `PUT /api/rankings/tiers/:id` – Adjust the label, thresholds, or ordering of an existing tier.
- `DELETE /api/rankings/tiers/:id` – Remove a tier from the ladder.
- `POST /api/rankings/users/:id/reset` – Reset a curator’s effective score back to zero without deleting uploads.
- `POST /api/rankings/users/:id/block` – Exclude a curator from ranking without altering contributions.
- `POST /api/rankings/users/:id/unblock` – Restore a curator to the public ranking ladder.
- `PUT /api/users/:id` – Admin-only account maintenance, deactivation, and role changes.
- `POST /api/users/:id/avatar` – Uploads a curator avatar (PNG/JPG/WebP up to 5 MB, GIFs rejected) and returns the refreshed profile payload.
- `PUT /api/users/:id/profile` – Update a curator’s display name or bio (self-service or admin override).
- `PUT /api/users/:id/password` – Change a password after verifying the current credential (self-service or admin override).
- `DELETE /api/users/:id` – Admin-only user removal (no self-delete).
- `POST /api/users/bulk-delete` – Bulk account deletion (admin only).
- `POST /api/assets/models/bulk-delete` – Bulk removal of models including storage cleanup.
- `POST /api/assets/models/:id/versions` – Adds safetensor revisions with previews to an existing modelcard.
- `PUT /api/assets/models/:modelId/versions/:versionId` – Renames an existing model revision.
- `POST /api/assets/models/:modelId/versions/:versionId/promote` – Promotes a revision to become the primary profile.
- `DELETE /api/assets/models/:modelId/versions/:versionId` – Removes a secondary revision and associated storage objects.
- `POST /api/assets/images/bulk-delete` – Bulk removal of gallery images and cover cleanup.
- `PUT /api/galleries/:id` – Edit gallery metadata, visibility, and ordering.
- `DELETE /api/galleries/:id` – Delete a gallery (admin or owner permissions).

## Troubleshooting

- **`Cannot find module './types/express'` when starting the backend** – Legacy builds expected Express type definitions as `.d.ts` files. Ensure you are on the latest code, then reinstall dependencies and rebuild: `git pull`, `cd backend`, `npm install`, `npm run build` (or `npm run dev`).
- **Node 18 warnings from Vite** – A crypto polyfill is bundled for Node.js 18.19.x, but upgrading to Node.js 22 LTS removes the warning and future-proofs the toolchain (`nvm install 22 && nvm use 22`).

