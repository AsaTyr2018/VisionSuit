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
- **Trigger field still optional on edit** – *(Status captured during the 2025-01-14 review; see remediation status below.)* The README states the modelcard Trigger/Activator field "is required during uploads or edits." The edit dialog trimmed the trigger and sent `null` when empty, and the backend schema transformed blank or missing triggers into `null`, so edits did not enforce the requirement.
- **Flagged assets remain visible to other members** – *(Status captured during the 2025-01-14 review; see remediation status below.)* Documentation claimed flagged assets disappear for the community while creators see "In Audit" placeholders. In practice, the placeholder logic only hid flagged items from the asset owner; other non-admin members still received the full asset cards because the visibility filters did not remove flagged entries.

## Comparison with 2025-01-07 report
- The previously confirmed home trust panel and action cards remain intact, so no regression from the prior "resolved" note.
- The Trigger/Activator validation gap called out on 2025-01-07 is still outstanding; documentation should be softened or the edit form should enforce the requirement.
- Newly observed divergence: the README overstates how broadly flagged assets are hidden, indicating the moderation story needs either stricter filtering or updated language.

## Remediation status (2025-01-14 follow-up)
- **Trigger enforcement restored** – The edit dialog now blocks submissions without a trigger keyword and always submits the trimmed value, while the backend schema rejects empty updates so edit flows honour the documented requirement.【F:frontend/src/components/ModelAssetEditDialog.tsx†L173-L204】【F:backend/src/routes/assets.ts†L374-L406】
- **Community hiding for flagged assets** – Frontend helpers now distinguish between hidden, placeholder, and visible states so flagged assets drop from shared explorers and profiles for non-admin viewers, yet owners retain "In Audit" placeholders as described in the README.【F:frontend/src/lib/moderation.ts†L1-L35】【F:frontend/src/App.tsx†L86-L174】【F:frontend/src/components/AssetExplorer.tsx†L782-L851】【F:frontend/src/components/GalleryExplorer.tsx†L121-L326】【F:frontend/src/components/UserProfile.tsx†L308-L448】
