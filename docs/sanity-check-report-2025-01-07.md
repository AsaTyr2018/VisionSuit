# Documentation vs Application Sanity Check — 2025-01-07

## Scope and Method
- Reviewed the current `README.md` feature highlights and "Good to Know" guidance.
- Cross-referenced claims against backend implementation (Express + Prisma services), frontend React components, and configuration files.
- Focused on core functional areas that affect administrators and curators: environment controls, safety tooling, NSFW analysis, and the on-site generator experience.

## Documentation statements confirmed by the codebase
- **Live environment controls** – The documentation notes that Administration → Settings writes site metadata and service endpoints back to both `.env` files with restart guidance. The backend `applyAdminSettings` routine updates backend/front-end environment files and refreshes the in-memory config exactly as described.【F:README.md†L9-L9】【F:backend/src/lib/settings.ts†L327-L420】
- **Adult prompt governance** – The README describes configurable prompt keywords that drive adult tagging and rescan automation. The admin panel exposes keyword management while the safety routes persist keywords, trigger rescans, and broadcast changes to the analyzer, aligning with the docs.【F:README.md†L11-L18】【F:frontend/src/components/AdminPanel.tsx†L1281-L1333】【F:backend/src/routes/safety.ts†L787-L860】
- **NSFW runtime scheduler** – Documentation claims a scheduler with pressure handling, metrics, and fast-mode fallbacks. The `NsfwAnalysisScheduler` class implements queue depth tracking, pressure heuristics, retry/backoff, and exposes metrics consumers can poll, matching the description.【F:README.md†L15-L17】【F:backend/src/lib/nsfw/runtime.ts†L1-L200】
- **On-Site Generator hub** – The README outlines curated base-model lists, serialized dispatch, capped history, and artifact import workflows. Frontend generator state management slices history to the last ten inactive jobs, and the backend dispatcher hydrates configured models while materializing workflows, reflecting the documented behaviour.【F:README.md†L24-L24】【F:frontend/src/components/OnSiteGenerator.tsx†L300-L360】【F:backend/src/lib/generator/dispatcher.ts†L320-L380】

## Documentation gaps or inaccuracies
- **Resolved: trust metrics & call-to-action panels** – The home view now includes a "Take action" card row and a "Platform health" trust panel summarizing curator counts, moderation coverage, and live service status, matching the README guidance.【F:frontend/src/App.tsx†L1025-L1111】【F:frontend/src/index.css†L621-L770】
- **Trigger field not required during edits** – The docs state that the modelcard Trigger/Activator field "is required during uploads or edits." While uploads enforce a trigger, the edit dialog and API accept empty triggers and persist them as null, so edits do not require the field. Update the docs or add validation if the field should remain mandatory on edit.【F:README.md†L51-L51】【F:frontend/src/components/ModelAssetEditDialog.tsx†L161-L205】【F:backend/src/routes/assets.ts†L392-L416】

## Suggested follow-ups
1. Clarify the README home layout bullet or reinstate the intended trust/CTA components to align the product story with the UI.
2. Decide whether the Trigger/Activator should be optional during edits; either update validation to enforce it or soften the documentation language to match current behaviour.
