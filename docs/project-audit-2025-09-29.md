# Project Audit — 2025-09-29

## Scorecard
| Area | Score | Rationale |
| --- | --- | --- |
| Documentation accuracy | 78/100 | README and technical docs cover the core dashboard, service probes, and notification flows, but a few promises (guided restarts, English-only messaging, background workers) overreach the current implementation.
| Frontend alignment | 85/100 | The React app ships the advertised "What's new" highlights, role-aware CTAs, maintenance lockouts, and live notification center, closely matching the narrative.
| Backend alignment | 72/100 | Core APIs, status probes, and generator toggles match the docs, yet upload streaming, localization, and worker automation lag behind written expectations.

## Method
- Reviewed `README.md`, the workflow and community feature plans, and prior audits to collect stated capabilities and standards.
- Cross-checked statements against key React components (`App.tsx`, admin panel), Express routes (`meta.ts`, `uploads.ts`, `storage.ts`), installer scripts, and backend dependencies.
- Looked for regressions or unfinished work called out in documentation (background workers, restart prompts, localization) to score alignment and identify remediation needs.

## Confirmed Alignment
- **Home experience parity** – README's description of the "What's new" rail, compact call-to-action pills, trust metrics, and footer service status matches the rendered React layout, including the service status link that opens the dedicated status page.
- **Live service probes** – `meta.ts` exposes the backend, MinIO, and GPU endpoints, and the frontend consumes them to drive the footer badge and status view just as the README promises.
- **Generator controls & notifications** – Admin settings persist `.env` updates, the GPU toggle feeds both backend and UI, and the SSE-driven notification center delivers announcements, moderation events, likes, and comments in real time, matching both README guidance and prior sanity checks.

## Key Gaps & Recommendations
| Area | Observation | Impact | Recommendation |
| --- | --- | --- | --- |
| Maintenance restart guidance | README advertises "guided restart prompts" alongside maintenance mode, but neither the frontend nor backend contains restart messaging or flows, so admins cannot follow the promised guidance. | Medium – Operators may overestimate downtime tooling and miss manual steps. | **Remediated –** README now documents a maintenance restart checklist that walks operators through enabling the lock, restarting services, verifying health probes, and restoring modules before reopening access.
| Language consistency | Remaining installer, storage proxy, backend, and UI messages have been translated to English, aligning with the English-only standard. | Medium – Mixed-language output previously complicated support and contradicted documentation expectations. | **Remediated –** Shell scripts, API responses, storage proxy, and UI confirmation prompts now use English messaging, restoring consistency with documentation.
| Workflow automation promises | The workflow/community plans describe chunked uploads, background workers (BullMQ/Redis), email digests, and reputation systems, yet the codebase still performs in-memory single-request uploads, lacks queue dependencies, and does not expose digest jobs. | High – Stakeholders planning integrations will be blocked; documentation should clarify that these features are roadmap items. | Update docs to mark these features as future work or adjust implementation priorities (streamed uploads, job worker, notification digests) to catch up with the published plans.
| Upload resilience | README and workflow plan promise 2 GB uploads with intelligent validation, but Express still buffers files in memory via `multer.memoryStorage`, risking crashes under the advertised limits. | High – Production uploads over ~1 GB can exhaust memory. | Implement streaming uploads to MinIO or adjust README limits/document required infrastructure.

## What Exists vs. What’s Missing
- **Implemented:** Service status probes and page, maintenance lockouts, SSE notifications, generator enable/disable controls, curator CTAs, and NSFW moderation tooling.
- **Outstanding:** Guided restart prompts, English-only installer responses, background worker infrastructure for notifications/digests, chunked upload pipeline, and automated reputation/digest systems promised in planning docs.

## Next Steps
1. Prioritize either implementing or softening the README statements around restart prompts and upload capacity in the next documentation sweep.
2. Schedule a localization pass for shell scripts and Express responses so operators receive consistent English feedback.
3. Align roadmap docs with current implementation status, highlighting background workers, chunked uploads, and digest emails as future milestones if they remain out of scope this quarter.
4. Track progress in future audits to confirm when these roadmap features land and adjust the scorecard accordingly.
