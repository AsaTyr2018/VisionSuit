# VisionSuit

VisionSuit is a self-hosted platform for curated AI image galleries and LoRA safetensor distribution. The project ships with a runnable Node.js API, a Prisma data model including seed data, and a React front end that demonstrates the intended upload and curation workflow.

## Core Highlights

- **Unified operations dashboard** – Persistent sidebar navigation with instant switching between Home, Models, and Images, plus live health badges for the front end, API, and MinIO services.
- **Role-aware access control** – JWT-based authentication with session persistence, an admin workspace for user/model/gallery management, and protected upload flows.
- **Guided three-step upload wizard** – Collects metadata, files, and review feedback with validation, drag & drop, and live responses from the production-ready `POST /api/uploads` endpoint.
- **Data-driven explorers** – Fast filters and full-text search across LoRA assets and galleries, complete with tag badges, five-column tiles, and seamless infinite scrolling with active filter indicators.
- **Versioned modelcards** – Dedicated model dialogs with inline descriptions, quick switches between safetensor versions, and an integrated flow for uploading new revisions including preview handling.
- **Governed storage pipeline** – Direct MinIO ingestion with automatic tagging, secure download proxying via the backend, audit trails, and guardrails for file size (≤ 2 GB) and batch limits (≤ 12 files).

## Good to Know

- Sticky shell layout with live service badges, trust metrics, and call-to-action panels for a polished product look including toast notifications for upload events.
- Gallery uploads support multi-select (up to 12 files/2 GB), role-aware gallery selection, and on-the-fly gallery creation.
- Model uploads enforce exactly one safetensor/ZIP archive plus a cover image; additional renders can be attached afterwards from the gallery explorer.
- Gallery explorer offers a five-column grid with random cover art, consistent tile sizing, and a detail dialog per collection with an EXIF lightbox for every image.
- Interface remains resilient even when the backend delivers entries without populated metadata.
- Automatic extraction of EXIF, Stable Diffusion prompt data, and safetensor headers populates searchable base-model references and frequency tables for tags.

## Community Roadmap

VisionSuit is evolving toward a richer community layer featuring reactions, threaded discussions, collaborative collections, and creator recognition systems. The [Community Features Plan](docs/community-features-plan.md) outlines the phased rollout, technical architecture, and moderation safeguards that will guide this expansion while preserving the curated gallery experience.

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
- `GET /api/users` – Admin-only listing of accounts.
- `POST /api/users` – Admin-only account provisioning.
- `PUT /api/users/:id` – Admin-only account maintenance, deactivation, and password resets.
- `DELETE /api/users/:id` – Admin-only user removal (no self-delete).
- `POST /api/users/bulk-delete` – Bulk account deletion (admin only).
- `POST /api/assets/models/bulk-delete` – Bulk removal of models including storage cleanup.
- `POST /api/assets/models/:id/versions` – Adds safetensor revisions with previews to an existing modelcard.
- `POST /api/assets/images/bulk-delete` – Bulk removal of gallery images and cover cleanup.
- `PUT /api/galleries/:id` – Edit gallery metadata, visibility, and ordering.
- `DELETE /api/galleries/:id` – Delete a gallery (admin or owner permissions).

## Troubleshooting

- **`Cannot find module './types/express'` when starting the backend** – Legacy builds expected Express type definitions as `.d.ts` files. Ensure you are on the latest code, then reinstall dependencies and rebuild: `git pull`, `cd backend`, `npm install`, `npm run build` (or `npm run dev`).
- **Node 18 warnings from Vite** – A crypto polyfill is bundled for Node.js 18.19.x, but upgrading to Node.js 22 LTS removes the warning and future-proofs the toolchain (`nvm install 22 && nvm use 22`).

