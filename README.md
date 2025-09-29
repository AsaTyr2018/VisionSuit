# VisionSuit

VisionSuit is a self-hosted platform for curating AI image galleries, distributing LoRA adapters, and managing an on-site GPU generation workflow. It ships with a full-stack experience that keeps moderation, governance, and community tooling under your control.

## Core Features

### Operations & Governance
- Unified administrator workspace with environment alignment, `.env` synchronization for frontend and backend settings, and a dedicated service status page accessible from the footer with per-service health probes.
- Toggleable GPU generation module that lets admins disable the On-Site Generator, hides its navigation entry, and clearly marks the GPU worker as deactivated on the live status page.
- Role-aware access control backed by JWT authentication, admin onboarding flows, and guarded upload paths for curators.
- Member-to-curator application workflow with justification forms for members and inline approve/decline tooling—complete with optional decision notes—inside the Admin → Users console.
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
   The frontend now defaults to calling the API on the same origin, so `/api/*` requests automatically reach the backend through the Vite proxy and production reverse proxies. When the frontend and backend are served from different hosts, set `VITE_API_URL` (and optionally `DEV_API_PROXY_TARGET` during development) to point at the external API base URL.
3. **Apply database migrations**
   ```bash
   npm --prefix backend run prisma:migrate
   ```
   This creates newly introduced tables—such as the notification inbox—and reconciles safety keyword schema tweaks before any services start.
4. **Start the services via the maintenance controller**
   ```bash
   ./maintenance.sh start
   ```
   Installation now provisions `vs-backend.service` and `vs-frontend.service` so `./maintenance.sh start` simply proxies to `systemctl` on hosts with systemd. The backend still downloads the SmilingWolf auto-tagging assets on first launch and prints `[startup] Downloading ...` so you can monitor progress. VisionSuit continues to degrade gracefully if the native ONNX Runtime CPU backend cannot load (for example, when `onnxruntime-node` lacks binaries for the installed Node.js version): startup logs `[startup] Auto tagger disabled`, the stack keeps serving requests, and affected uploads are flagged with a descriptive `tagScanError`. Reinstall the dependency with `npm --prefix backend rebuild onnxruntime-node`, align the Node.js version with the published binaries, or set `ORT_BACKEND_PATH` to the directory that contains the native bindings to restore automatic tagging.
5. **Seed and explore** – The backend ships with Prisma seed data. Visit the frontend URL shown in the terminal output and sign in with the seeded administrator account to configure services. Administrators can now launch Prisma Studio directly from the dashboard link—asset requests stay proxied through the backend so the interface loads end-to-end even when the frontend is served via the Vite development server. The proxy now rewrites Prisma Studio’s transport bootstrap so Prisma 6’s new `/api` default keeps flowing through the `/db` tunnel instead of colliding with the VisionSuit API namespace.

## Service Control

- `./maintenance.sh status` – Proxy to `systemctl status` when the managed units are installed, or fall back to the legacy shell wrappers when systemd is unavailable.
- `./maintenance.sh stop` / `./maintenance.sh restart` – Gracefully stop or restart both services, using `systemctl` when present and the historical PID managers otherwise.
- `./maintenance.sh update` – Refresh backend and frontend dependencies, re-run Prisma migrations, reinstall the systemd unit files, and restart both services with the new build.
- Historical helpers now live in `Legacy-scripts/` for reference if you need to review the previous combined launcher or installer behaviour.

### Systemd deployment notes

- Systemd unit templates reside in `services/systemd/` and render to `/etc/systemd/system/vs-backend.service` and `/etc/systemd/system/vs-frontend.service` with the repository path baked in during installation.
- Override runtime configuration with optional environment files at `/etc/visionsuit/vs-backend.env` and `/etc/visionsuit/vs-frontend.env` before restarting the services.
- Hosts without systemd continue to use the legacy shell controllers; the maintenance entry points detect the environment automatically.

### Migrating from the legacy systemd unit

Administrators who previously enabled the `visionsuit-dev.service` unit can switch to the maintenance controller by running the migration helper:

```bash
sudo ./scripts/migrate_systemd_to_maintenance.sh
```

The script stops and removes the legacy systemd unit, installs a `/usr/local/bin/visionsuit-maintenance` wrapper that proxies to `maintenance.sh`, and prints follow-up steps so production automation can call `visionsuit-maintenance start|stop|status` instead of the retired service.

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

### PostgreSQL Migration Planning

- **PostgreSQL migration workspace** – Early planning artifacts and evolving automation for moving from SQLite to a remote PostgreSQL instance now live in `scripts/postgres-migration/`. The directory includes:
  - `PROJECT_PLAN.md` outlining goals, deliverables, and the development timeline for the migration effort.
  - `sanity_check.sh`, which confirms local Prisma dependencies are installed and that the remote PostgreSQL host meets minimum version and extension requirements over SSH before any stateful steps run.
  - `remote_prepare_helper.sh`, a remote-side bootstrapper that creates the dedicated SSH deployment account, grants the supplied key root access, writes a `~/visionsuit_remote_access.txt` summary with the exported public key, and provisions a passwordless PostgreSQL role (with optional `CREATEDB`) so migrations can execute cleanly. When `visionsuit_migration_config.env` sits next to the script it auto-loads the bundle and runs without prompting for additional arguments.
  - `prepare_postgres_target.sh`, which validates connectivity, optionally creates the target database, enforces TLS policies, and installs required extensions before the cutover.
  - `fresh_install_postgres_setup.sh` and `upgrade_sqlite_to_postgres.sh`, which now run the sanity validator automatically (unless `FRESH_INSTALL_SKIP_SANITY=true` or `UPGRADE_SKIP_SANITY=true`) before preparing the target and proceeding with installation or upgrade workflows.
  - `docs/postgres-migration-preparation.md`, the end-to-end preparation guide covering the remote helper, sanity checks, and the follow-up orchestration scripts.
  - `scripts/postgres-migration/generated/`, created the first time the upgrade helper runs, containing a dedicated SSH key pair and `visionsuit_migration_config.env`. Set `UPGRADE_AUTOMATION_ONLY=true` to exit immediately after generating the automation bundle whenever you need to refresh keys or regenerate the config file.

  Example usage when rehearsing a migration:
  ```bash
  # 1. Generate automation assets on the VisionSuit host (exits after writing keys/config)
  POSTGRES_URL="postgres://visionsuit_migrate@db.internal:5432/visionsuit?sslmode=require" \
    SQLITE_PATH="backend/prisma/dev.db" \
    UPGRADE_AUTOMATION_ONLY=true \
    ./scripts/postgres-migration/upgrade_sqlite_to_postgres.sh

  # 2. Copy the remote helper and config bundle to the PostgreSQL host and execute it
  scp scripts/postgres-migration/remote_prepare_helper.sh \
      scripts/postgres-migration/generated/visionsuit_migration_config.env \
      admin@db.internal:/tmp/
  ssh admin@db.internal 'sudo bash /tmp/remote_prepare_helper.sh'

  # 3. Validate Prisma tooling and the remote PostgreSQL target using the generated private key
  ./scripts/postgres-migration/sanity_check.sh \
    --prisma-project ./backend \
    --postgres-url "postgres://visionsuit_migrate@db.internal:5432/visionsuit?sslmode=require" \
    --ssh-target visionsuit-migrator@db.internal \
    --ssh-identity scripts/postgres-migration/generated/visionsuit_migration \
    --require-extensions pg_trgm,uuid-ossp
  ```

  Review the generated `visionsuit_remote_access.txt` and copied `visionsuit_migration_config.env` files in the deployment user's home directory on the target host to confirm the published key material and granted PostgreSQL privileges before handing the credentials to the VisionSuit server. Adjust `UPGRADE_REMOTE_*` environment variables if you need different user, role, or database names when regenerating the automation bundle.

  Set `FRESH_INSTALL_SANITY_SSH_TARGET` or `UPGRADE_SANITY_SSH_TARGET` (plus optional `*_SANITY_SSH_PORT`/`*_SANITY_SSH_IDENTITY`) before invoking the orchestration scripts so they can run the compatibility checks automatically.
- The upgrade automation now orchestrates the full rehearsal: it can stop services through `maintenance.sh`, take timestamped `.backup` and `.dump` snapshots of the SQLite file under `backups/postgres-migration/`, run `pgloader` to import data, execute Prisma `migrate deploy`/`generate`/`migrate status`, verify table row counts between SQLite and PostgreSQL, and optionally run a custom health check command before resuming traffic. Each phase is toggleable with `UPGRADE_*` environment variables so operators can dry-run the flow or reuse individual steps while testing their infrastructure.

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
