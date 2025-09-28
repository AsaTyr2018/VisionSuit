# VisionSuit

VisionSuit is a self-hosted platform for curating AI image galleries, distributing LoRA adapters, and managing an on-site GPU generation workflow. It ships with a full-stack experience that keeps moderation, governance, and community tooling under your control.

## Core Features

### Operations & Governance
- Unified administrator workspace with environment alignment, `.env` synchronization for frontend and backend settings, and a dedicated service status page accessible from the footer.
- Role-aware access control backed by JWT authentication, admin onboarding flows, and guarded upload paths for curators.
- Configurable registration policies, maintenance modes, and guided restart prompts for safe rollouts.

### Moderation & Safety
- Layered moderation queues with severity filters, audit trails, and rejection requirements for administrators.
- Centralized NSFW pipeline that blends OpenCV heuristics, ONNX swimwear detection, and configurable scheduler pools stored in `config/nsfw-image-analysis.json`.
- Prompt governance with keyword enforcement, adult tagging, automated rescans, and SmilingWolf/wd-swinv2 auto-tagging for prompt-free uploads.

### Creation & Distribution
- Guided three-step upload wizard for LoRA models and gallery renders with drag-and-drop validation and revisioned model cards.
- On-site generator hub that dispatches SDXL workflows to GPU agents, supports multi-LoRA blends, and streams artifacts through authenticated proxies.
- MinIO-backed storage pipeline with secure download proxying, size guardrails, and curated collection linking.

### Community Experience
- Home view centered on a "What's new" highlight rail with compact next-step shortcuts so curators and members can jump directly into fresh releases.
- Member registration with reactions, comments, and private upload visibility for curators while administrators retain full inventory insight.
- Spotlight profiles, gallery explorers with infinite scroll, intelligent caching, and account settings that keep avatars and bios in sync.
- Model and image explorers fetch paginated windows with seamless “load more” controls so initial visits stay lightweight while deeper dives remain responsive.

## Quick Start

1. **Install dependencies**
   ```bash
   ./install.sh
   ```
2. **Configure environment variables**
   Copy the sample backend `.env` file and ensure Prisma has a SQLite connection string before running CLI commands:
   ```bash
   cp backend/.env.example backend/.env
   export DATABASE_URL="file:./dev.db"
   ```
   The development helper scripts load `.env`, and exporting `DATABASE_URL` keeps standalone Prisma tasks such as `npx prisma migrate reset` from failing on a fresh installation.
3. **Start the development stack**
   ```bash
   ./dev-start.sh
   ```
   The backend will automatically download the SmilingWolf auto-tagging assets on first launch and prints `[startup] Downloading ...` messages so you can track progress in the console.
   VisionSuit now degrades gracefully if the native ONNX Runtime CPU backend cannot be loaded (for example, when `onnxruntime-node` does not provide binaries for the installed Node.js version). Startup logs `[startup] Auto tagger disabled` and continues serving requests, while affected uploads remain flagged with a descriptive `tagScanError`. Reinstall the dependency with `npm --prefix backend rebuild onnxruntime-node`, align the Node.js version with the published binaries, or set `ORT_BACKEND_PATH` to the directory that contains the native bindings to restore automatic tagging.
4. **Seed and explore** – The backend ships with Prisma seed data. Visit the frontend URL shown in the terminal output and sign in with the seeded administrator account to configure services.

For production deployments, review storage credentials, JWT secrets, GPU agent endpoints, and generator bucket provisioning before exposing the stack.

## Bulk Import Helpers

- **Windows (`scripts/bulk_import_windows.ps1`)** – Pre-validates upload files, disables the implicit `Expect: 100-continue` header to keep self-hosted API proxies happy, and unwraps transport exceptions so failures such as `Error while copying content to a stream` surface the underlying cause. Populate `./loras` and `./images` and run the script from PowerShell 7+.
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
- Additional planning notes and community updates live alongside these documents in the `docs/` directory.

## Community & Support

VisionSuit is actively evolving. Contributions, issues, and deployment learnings are welcome—open a discussion or pull request to share feedback and improvements.
