# VisionSuit

VisionSuit is a self-hosted platform for curating AI image galleries, distributing LoRA adapters, and managing an on-site GPU generation workflow. It ships with a full-stack experience that keeps moderation, governance, and community tooling under your control.

## Core Features

### Operations & Governance
- Unified administrator workspace with environment alignment, `.env` synchronization for frontend and backend settings, and a dedicated service status page accessible from the footer with per-service health probes.
- Toggleable GPU generation module that lets admins disable the On-Site Generator, hides its navigation entry, and clearly marks the GPU worker as deactivated on the live status page.
- Role-aware access control backed by JWT authentication, admin onboarding flows, and guarded upload paths for curators.
- Configurable registration policies and a maintenance mode that collapses the UI to an admin-only login gate. Operators follow the documented restart checklist to bring services back online after upgrades without relying on in-app prompts.

### Moderation & Safety
- Layered moderation queues with severity filters, audit trails, and rejection requirements for administrators.
- Moderation workspace previews stay at a consistent 256 px width with one-click zooming so approve/remove actions remain aligned.
- Centralized NSFW pipeline that blends OpenCV heuristics, ONNX swimwear detection, and configurable scheduler pools stored in `config/nsfw-image-analysis.json`.
- Textual safety screening that never bypasses metadata or prompt keywords, so guests stay shielded from NSFW-tagged models and covers even when the ONNX analyzer is offline.
- Prompt governance with separate adult and illegal keyword queues—adult terms feed NSFW filters while illegal terms block uploads until review—paired with automated rescans and SmilingWolf/wd-swinv2 auto-tagging for prompt-free uploads.

### Creation & Distribution
- Guided three-step upload wizard for LoRA models and gallery renders with drag-and-drop validation, revisioned model cards, and gallery batches up to 100 files (still capped at 2 GB per request).
- On-site generator hub that dispatches SDXL workflows to GPU agents, supports multi-LoRA blends, and streams artifacts through authenticated proxies.
- MinIO-backed storage pipeline with secure download proxying, size guardrails, and curated collection linking.

### Community Experience
- Home view centered on a "What's new" highlight rail with compact next-step shortcuts so curators and members can jump directly into fresh releases.
- Member registration with reactions, comments, and private upload visibility for curators while administrators retain full inventory insight.
- Spotlight profiles, gallery explorers with infinite scroll, intelligent caching, resilient legacy-image handling when auto-tag metadata is missing, and account settings that keep avatars and bios in sync.
- Model and image explorers fetch paginated windows with seamless “load more” controls so initial visits stay lightweight while deeper dives remain responsive.
- Dedicated notification center with live announcement, moderation, like, and comment queues that update in real time during active sessions.

## Quick Start

1. **Install dependencies**
   ```bash
   ./maintenance.sh install
   ```
2. **Configure environment variables**
   Copy the sample backend `.env` file and ensure Prisma has a SQLite connection string before running CLI commands:
   ```bash
   cp backend/.env.example backend/.env
   export DATABASE_URL="file:./dev.db"
   ```
   The development helper scripts load `.env`, and exporting `DATABASE_URL` keeps standalone Prisma tasks such as `npx prisma migrate reset` from failing on a fresh installation.
3. **Apply database migrations**
   ```bash
   npm --prefix backend run prisma:migrate
   ```
   This creates newly introduced tables—such as the notification inbox—and reconciles safety keyword schema tweaks before any services start.
4. **Start the services via the maintenance controller**
   ```bash
   ./maintenance.sh start
   ```
   The maintenance hub now launches the dedicated `vs-Backend` and `vs-Frontend` service scripts, refreshing the Prisma client before the API boots and tailing logs to `./logs`. The backend still downloads the SmilingWolf auto-tagging assets on first launch and prints `[startup] Downloading ...` so you can monitor progress. VisionSuit continues to degrade gracefully if the native ONNX Runtime CPU backend cannot load (for example, when `onnxruntime-node` lacks binaries for the installed Node.js version): startup logs `[startup] Auto tagger disabled`, the stack keeps serving requests, and affected uploads are flagged with a descriptive `tagScanError`. Reinstall the dependency with `npm --prefix backend rebuild onnxruntime-node`, align the Node.js version with the published binaries, or set `ORT_BACKEND_PATH` to the directory that contains the native bindings to restore automatic tagging.
5. **Seed and explore** – The backend ships with Prisma seed data. Visit the frontend URL shown in the terminal output and sign in with the seeded administrator account to configure services. Administrators can now launch Prisma Studio directly from the dashboard link—asset requests stay proxied through the backend so the interface loads end-to-end even when the frontend is served via the Vite development server. The proxy now rewrites Prisma Studio’s transport bootstrap so Prisma 6’s new `/api` default keeps flowing through the `/db` tunnel instead of colliding with the VisionSuit API namespace.

## Service Control

- `./maintenance.sh status` – Display aggregate health information from the `vs-Backend` and `vs-Frontend` service helpers alongside Prisma Studio if it is enabled.
- `./maintenance.sh stop` / `./maintenance.sh restart` – Gracefully stop or restart both services in sequence. Individual service wrappers live in `services/vs-backend.sh` and `services/vs-frontend.sh` when you need fine-grained control.
- `./maintenance.sh update` – Refresh backend and frontend dependencies, then re-run the Prisma migration workflow to apply schema updates.
- Historical helpers now live in `Legacy-scripts/` for reference if you need to review the previous combined launcher or installer behaviour.

For production deployments, review storage credentials, JWT secrets, GPU agent endpoints, and generator bucket provisioning before exposing the stack.

## Maintenance Restart Checklist

1. **Engage maintenance mode** – Toggle the "Enable maintenance mode (admins only)" switch under **Admin → Platform → Maintenance** or set `MAINTENANCE_MODE=true` in the backend environment configuration. Confirm the public UI shows the maintenance lock screen in an incognito browser session.
2. **Restart application services** – Apply your deployment changes and restart the dedicated `vs-Backend` and `vs-Frontend` service scripts. On self-managed hosts run `./maintenance.sh restart` to sequence both automatically, or target your supervisor units (for example, `systemctl restart vs-backend` and `systemctl restart vs-frontend`). Restart auxiliary services such as the GPU worker, asset proxy, or CDN cache if they were part of the maintenance scope.
3. **Verify health checks** – Call the platform status endpoint to confirm each service is healthy before reopening access:
   ```bash
   curl -s https://<your-host>/api/meta/platform | jq '{maintenanceMode, services}'
   ```
   Ensure `services.api`, `services.storage`, and `services.gpu` report `"status": "ONLINE"` (or `"UNKNOWN"` for intentionally offline components) and that `maintenanceMode` remains `true` while inspections run.
4. **Restore optional modules** – Re-enable the GPU generator or other optional integrations from the admin settings once their workers are confirmed online.
5. **Disable maintenance mode** – Flip the maintenance toggle off to reopen the site and monitor the notification center for any failure alerts triggered during restart.

## Database Maintenance

- **Refresh the Prisma baseline without downtime** – When upgrading from older releases that contained dozens of incremental migrations, run the helper to back up the SQLite file, clear historical migration records, and mark the consolidated baseline as applied:
  ```bash
  DATABASE_URL="file:./dev.db" ./scripts/refresh_prisma_baseline.sh
  ```
  The script writes a timestamped copy of the database next to the original file, removes the legacy migration entries from `_prisma_migrations`, and uses `prisma migrate resolve` to register `00000000000000_baseline` so subsequent deploys and `prisma migrate deploy` executions align with the trimmed migration directory.

## Moderation CLI Helpers

- **Approve all flagged assets** – Clear the moderation queue in one sweep after an incident review:
  ```bash
  npm --prefix backend run moderation:approve-flagged
  ```
  The command reconnects flagged models and images to the active catalog, removes their `flaggedAt` markers, and writes a moderation log entry for each asset so the audit trail records the bulk approval.

## Tagging CLI Helpers

- **Import model tags from CSV** – Attach structured tag metadata to existing LoRAs in bulk:
  ```bash
  npm --prefix backend run tags:import -- --file ./tags.csv
  ```
  The script matches rows by model slug, title, or storage filename (e.g., `MyModel.safetensors`), creates any missing `Tag` entries, and links every matched LoRA to each category listed in the CSV. Run the command with `--dry-run` first to preview matches or pass `--tag-category <group>` to group the imported labels under a shared tag category in the database.

## Bulk Import Helpers

- **Windows (`scripts/bulk_import_windows.ps1`)** – Pre-validates upload files, disables the implicit `Expect: 100-continue` header to keep self-hosted API proxies happy, unwraps transport exceptions so failures such as `Error while copying content to a stream` surface the underlying cause, and inspects paginated or flattened catalog responses so duplicate models are skipped even when `/api/assets/models` wraps items inside `items`, `data`, or `results`. Populate `./loras` and `./images` and run the script from PowerShell 7+.
- **Linux/macOS (`scripts/bulk_import_linux.sh`)** – Uses `curl` for the same two-phase workflow; consult the script header for usage flags and environment overrides.

## Repository Layout

- `backend/` – Node.js API, Prisma schema, moderation services, and generator dispatch logic.
- `frontend/` – React application with role-aware navigation and dashboards.
- `gpuworker/` – ComfyUI worker installer, VisionSuit GPU agent, and synchronization scripts.
- `config/` – JSON configuration for NSFW analysis thresholds and scheduler options.
- `docs/` – Technical documentation, deployment plans, audits, and workflow references.

## Documentation

- [Technical Overview](docs/technical-overview.md)
- [NSFW Moderation Deployment Plan](docs/nsfw-deployment-plan.md)
- [Workflow Plan](docs/workflow-plan.md)
- [Project Audit — 2025-10-05](docs/project-audit-2025-10-05.md)
- [Project Audit — 2025-09-27](docs/project-audit-2025-09-27.md)
- Additional planning notes and community updates live alongside these documents in the `docs/` directory.

## Community & Support

VisionSuit is actively evolving. Contributions, issues, and deployment learnings are welcome—open a discussion or pull request to share feedback and improvements. The anchored support bar keeps Discord, GitHub, and live service status links within reach for rapid triage.
