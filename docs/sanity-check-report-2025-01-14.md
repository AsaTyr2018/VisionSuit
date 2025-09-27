# Documentation vs Application Sanity Check — 2025-01-14

## Scope and Method
- Reviewed the current `README.md` feature highlights and moderation workflow guidance.
- Cross-referenced claims against the latest frontend React components, backend routes, and supporting libraries.
- Focused on areas covered in the 2025-01-07 sanity check to verify prior gaps and identify any new divergences.

## Documentation statements confirmed by the codebase
- **Home call-to-actions and trust metrics** – The README describes a home dashboard with quick action cards and a "Platform health" trust panel summarising moderation coverage and live service status. `App.tsx` still renders the call-to-action grid and trust panel with curator counts, moderation percentages, and LED service badges, matching the documentation.【F:README.md†L7-L7】【F:README.md†L31-L31】【F:frontend/src/App.tsx†L1081-L1203】
- **Live environment controls** – Documentation claims that Administration → Settings propagates site metadata and connection details back into the backend and frontend `.env` files while updating the in-memory config. `applyAdminSettings` writes the appropriate environment variables, refreshes runtime config, and persists NSFW thresholds exactly as stated.【F:README.md†L9-L9】【F:backend/src/lib/settings.ts†L327-L383】
- **Adult prompt governance** – The README notes configurable prompt keyword lists that drive adult tagging and rescans. The Admin panel loads, creates, and deletes adult prompt keywords via dedicated forms, and the safety routes expose the required CRUD endpoints, aligning with the docs.【F:README.md†L11-L11】【F:frontend/src/components/AdminPanel.tsx†L1262-L3132】【F:backend/src/routes/safety.ts†L787-L860】

## Documentation gaps or inaccuracies
- **Trigger field still optional on edit** – The README states the modelcard Trigger/Activator field "is required during uploads or edits." The edit dialog trims the trigger and happily sends `null` when empty, and the backend schema transforms blank or missing triggers into `null`, so edits do not enforce the requirement.【F:README.md†L51-L51】【F:frontend/src/components/ModelAssetEditDialog.tsx†L161-L205】【F:backend/src/routes/assets.ts†L385-L415】
- **Flagged assets remain visible to other members** – Documentation claims flagged assets disappear for the community while creators see "In Audit" placeholders. In practice, the placeholder logic only hides flagged items from the asset owner; other non-admin members still receive the full asset cards because the visibility filters do not remove flagged entries.【F:README.md†L10-L10】【F:README.md†L45-L45】【F:frontend/src/lib/moderation.ts†L3-L16】【F:frontend/src/components/AssetExplorer.tsx†L812-L895】【F:frontend/src/components/GalleryExplorer.tsx†L150-L214】

## Comparison with 2025-01-07 report
- The previously confirmed home trust panel and action cards remain intact, so no regression from the prior "resolved" note.
- The Trigger/Activator validation gap called out on 2025-01-07 is still outstanding; documentation should be softened or the edit form should enforce the requirement.
- Newly observed divergence: the README overstates how broadly flagged assets are hidden, indicating the moderation story needs either stricter filtering or updated language.
