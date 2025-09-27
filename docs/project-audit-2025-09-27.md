# Project Audit — 2025-09-27

## Scope & Method
- Reviewed the primary product narrative in `README.md`, existing audit reports, and supporting plan documents to understand the promised feature set and operational goals.【F:README.md†L1-L74】【F:docs/sanity-check-report-2025-01-14.md†L1-L52】【F:docs/nsfw-deployment-plan.md†L1-L40】
- Cross-checked documentation statements against key implementation points in the React front end, Express backend, configuration files, and installation scripts.【F:frontend/src/App.tsx†L1000-L1245】【F:backend/src/lib/settings.ts†L327-L366】【F:backend/src/routes/uploads.ts†L30-L35】【F:install.sh†L12-L158】
- Inventoried quality gates by inspecting the automated test suites, package scripts, and repository tooling footprint.【d888fd†L1-L4】【F:frontend/package.json†L1-L21】【0392fc†L1-L2】

## Architecture Snapshot
| Layer | Documented expectation | Implementation status |
| ----- | ---------------------- | --------------------- |
| Frontend | Vite + React console delivering dashboard, explorers, admin tooling, and upload wizard.【F:README.md†L5-L47】 | `App.tsx` renders the home trust panel, role-aware CTAs, explorers, admin workspace, and generator integration as described.【F:frontend/src/App.tsx†L1091-L1245】 |
| Backend | Express 5 + Prisma API handling authentication, uploads, moderation, storage proxying, and settings writes.【F:README.md†L65-L73】 | Back-end routes cover uploads, admin settings, safety tuning, generator dispatching, and moderation workflows; settings writes mutate `.env` files directly.【F:backend/src/routes/uploads.ts†L30-L35】【F:backend/src/lib/settings.ts†L327-L366】 |
| GPU Worker | Dedicated ComfyUI node plus optional GPU agent for job dispatch.【F:README.md†L136-L158】【F:gpuworker/README.md†L1-L68】 | `gpuworker/` ships installer, rollback tooling, MinIO helpers, and agent service instructions matching the docs.【F:gpuworker/README.md†L1-L112】 |

## Confirmed Alignments
- **Operations dashboard parity** – The README promises a home dashboard with service badges, moderation coverage, and curator CTAs, all of which are implemented verbatim in `App.tsx` (take-action grid, platform health metrics, service LEDs).【F:README.md†L5-L38】【F:frontend/src/App.tsx†L1091-L1214】 Impact: ✅ *Documentation accurately reflects delivered UI behaviour.*
- **Administrative settings sync** – Documentation states that admins can rewrite site metadata and connection endpoints without shell access. The backend’s `applyAdminSettings` persists values into both backend and frontend `.env` files and refreshes runtime config accordingly.【F:README.md†L9-L10】【F:backend/src/lib/settings.ts†L327-L366】 Impact: ✅ *Doc + code alignment reduces operational surprises.*
- **Moderation workflow coverage** – README claims layered moderation (flagging, audit placeholders, admin workspace). Frontend filtering helpers and admin queue components match this behaviour, hiding flagged assets from members and surfacing “In audit” overlays.【F:README.md†L10-L11】【F:frontend/src/App.tsx†L1000-L1089】【F:frontend/src/components/AdminPanel.tsx†L556-L609】 Impact: ✅ *End-user guidance remains trustworthy.*

## Gaps & Risks
| Area | Observation | Impact |
| --- | --- | --- |
| Documentation typo | The GPU agent section previously misspelled “VisionSuit” as “VisionSIOt,” which could hinder command discovery when readers searched for the exact string in the repo or external docs. The documentation now consistently references VisionSuit.【F:README.md†L148-L158】【F:gpuworker/README.md†L61-L73】【F:gpuworker/agent/README.md†L1-L24】 | Low – Cosmetic, now resolved but worth monitoring in future edits. |
| Installation UX | `install.sh` mixes German prompts and error messages in an otherwise English codebase, conflicting with the documentation language standard and confusing anglophone operators.【F:install.sh†L12-L158】 | Medium – Increases onboarding friction and support load. |
| Large-file uploads | README guarantees 2 GB uploads, yet every upload endpoint uses `multer.memoryStorage()` with a 2 GB per-file limit; storing multi-gigabyte buffers in RAM is likely to exhaust server memory before they reach MinIO.【F:README.md†L46-L47】【F:backend/src/routes/uploads.ts†L30-L35】【F:backend/src/lib/uploadLimits.ts†L1-L2】 | High – Production upload jobs can crash the API; documentation over-promises reliability. |
| Validation messaging | Several backend validation errors remain in German (e.g., version update schema), creating inconsistent operator feedback and complicating localization plans.【F:backend/src/routes/assets.ts†L482-L488】 | Low – Cosmetic but noticeable to admins. |
| Automated testing | Backend tests focus solely on NSFW heuristics, and the frontend exposes no test or CI scripts; there is no visible continuous integration config at the repo root.【d888fd†L1-L4】【F:frontend/package.json†L1-L21】【0392fc†L1-L2】 | High – Critical flows (auth, uploads, settings) lack regression coverage; deployment risk is elevated. |
| Release automation | No CI/CD pipelines or lint hooks are defined in the repository, so documentation claims about reliability and governance lack supporting automation.【0392fc†L1-L2】 | Medium – Manual processes invite drift and configuration errors. |

## Recommendations
1. **Harden upload streaming** – Switch to disk or stream-to-MinIO adapters (e.g., multer-s3, temporary file staging) before accepting 2 GB payloads, and revise the README if lower limits are unavoidable.【F:backend/src/routes/uploads.ts†L30-L35】【F:backend/src/lib/uploadLimits.ts†L1-L2】
2. **Localize tooling** – Update `install.sh` and backend validation strings to English defaults (or add locale switching) to satisfy the documentation language requirement.【F:install.sh†L12-L158】【F:backend/src/routes/assets.ts†L482-L488】
3. **Expand automated coverage** – Introduce end-to-end and unit tests for authentication, uploads, admin settings, and generator dispatch; wire them into CI so documentation about governance is backed by tooling.【d888fd†L1-L4】【F:frontend/package.json†L1-L21】【0392fc†L1-L2】
4. **Polish documentation** – Correct the GPU agent typo, add an “Audits & Reports” index entry in the README, and continue referencing audit artifacts to keep stakeholders aligned.【F:README.md†L148-L158】
