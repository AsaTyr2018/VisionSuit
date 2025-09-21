# VisionSuit

VisionSuit is a self-hosted platform for curated AI image galleries and LoRA safetensor distribution. The project ships with a runnable Node.js API, a Prisma data model including seed data, and a React front end that demonstrates the intended upload and curation workflow.

## Core Highlights

- **Unified operations dashboard** – Persistent sidebar navigation with instant switching between Home, Models, and Images, plus glassy health cards with color-coded LED beacons for the front end, API, and MinIO services.
- **Role-aware access control** – JWT-based authentication with session persistence, an admin workspace for user/model/gallery management, a dialog-driven onboarding wizard with role presets, protected upload flows, and private uploads that stay exclusive to their owner unless an administrator explicitly enters audit mode from the curator profile.
- **Self-service account management** – Sidebar account settings let curators update their display name, bio, and password and now proxy uploaded avatars (PNG/JPG/WebP ≤ 5 MB) through the API while removing manual image URLs for safer defaults.
- **Guided three-step upload wizard** – Collects metadata, files, and review feedback with validation, drag & drop, and live responses from the production-ready `POST /api/uploads` endpoint.
- **Data-driven explorers** – Fast filters and full-text search across LoRA assets and galleries, complete with tag badges, five-column tiles, and seamless infinite scrolling with active filter indicators.
- **Curator spotlight profiles** – Dedicated profile view with avatars, rank progression, bios, and live listings of every model and collection uploaded by the curator, reachable from any curator name across the interface.
- **Versioned modelcards** – Dedicated model dialogs with inline descriptions, quick switches between safetensor versions, in-place editing for curators/admins, an integrated flow for uploading new revisions including preview handling, and admin tooling to promote or retire revisions.
- **Governed storage pipeline** – Direct MinIO ingestion with automatic tagging, secure download proxying via the backend, audit trails, and guardrails for file size (≤ 2 GB) and batch limits (≤ 12 files).

## Good to Know

- Sticky shell layout with live service badges, trust metrics, and call-to-action panels for a polished product look including toast notifications for upload events.
- Home spotlight tiles are fully interactive—click previews to jump straight into the model or gallery explorers, and tap tag chips to filter matching content instantly.
- Curators can edit their own models, collections, and images directly from the explorers, while administrators continue to see edit controls for every entry.
- Private uploads remain hidden from other curators; administrators can temporarily reveal them by clicking the new **Audit** button on curator profiles when moderation is required.
- Signed-in users can open the **Account settings** dialog from the sidebar to adjust profile details or rotate their password in a single modal workflow.
- Administration workspace now offers moderation grids for models and images, ranking controls (weights, tiers, and user resets), a streamlined model gallery that opens full management controls in the mainframe, persistent bulk tools tuned for six-figure libraries, multi-step onboarding with permission previews, and one-click actions to promote, rename, or remove secondary model versions. Ranking inputs immediately cache typed values so the tab stays responsive while backend refreshes complete.
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

After completion the stack is ready for development or evaluation. Use `./dev-start.sh` for a combined watch mode when coding locally.

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

Each importer refuses to upload a model unless a matching image folder exists. After authentication the scripts pick a random preview render, keep up to ten additional images (VisionSuit accepts a maximum of twelve files per upload, including the LoRA), and stream the batch to `POST /api/uploads` so the backend can push artifacts into MinIO.

### Linux and macOS

1. Review and adjust `server_ip`, `server_username`, and `server_port` at the top of `scripts/bulk_import_linux.sh`.
2. Ensure `curl` and `python3` are installed on the client.
3. Provide the VisionSuit password either via the `VISIONSUIT_PASSWORD` environment variable or interactively when prompted.
4. Run the script from the root of your asset stash (or pass custom directories):

   ```bash
   ./scripts/bulk_import_linux.sh ./loras ./images
   ```

The script authenticates with `POST /api/auth/login`, then uploads the LoRA and curated previews straight to the VisionSuit API. Models without imagery are skipped automatically.

### Windows (PowerShell)

1. Edit `$ServerIp`, `$ServerUsername`, and `$ServerPort` at the head of `scripts/bulk_import_windows.ps1`.
2. Launch the script from PowerShell 7+ (pwsh). Enter your VisionSuit password when prompted or expose it via `VISIONSUIT_PASSWORD`.
3. Run the importer with optional overrides for the source folders:

   ```powershell
   pwsh -File .\scripts\bulk_import_windows.ps1 -LorasDirectory .\loras -ImagesDirectory .\images
   ```

The PowerShell helper mirrors the Linux workflow: it logs in once, picks a random preview, trims excessive renders, and posts the bundle directly to the VisionSuit API for processing.

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
- `GET /api/storage/:bucket/:objectId` – Secure file proxy resolving anonymized IDs to originals.
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

