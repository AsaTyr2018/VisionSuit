## 2024-05-22 – Express startup fix
- **General**: Stabilized the backend boot process after Express failed to locate the request augmentation module.
- **Technical Changes**: Converted the Express request extension from `.d.ts` to `.ts`, refreshed backend linting, and documented the troubleshooting steps and upload endpoint in the README.
- **Data Changes**: None; runtime typings only.

## 2025-09-18 – Storage proxy hardening (0c8e4b3)
- **General**: Delivered a reliable storage proxy so MinIO assets stream through the backend with consistent limits and messaging.
- **Technical Changes**: Added `/api/storage/:bucket/:objectKey`, enriched Multer error handling, routed frontend downloads through the proxy, introduced shared storage helpers, and updated README limits.
- **Data Changes**: None; transport layer adjustments only.

## 2025-09-18 – MinIO storage foundation (16b920c)
- **General**: Introduced MinIO-backed storage with first-class setup guidance across the stack.
- **Technical Changes**: Added `lib/storage` with automatic bucket provisioning, gated server startup on successful bootstrap, wired new MinIO environment variables, templated `.env`, and extended the installer and README.
- **Data Changes**: None beyond new storage buckets created at runtime.

## 2025-09-18 – Platform bootstrap (21ef5ed)
- **General**: Established the initial VisionSuit platform spanning backend API, Prisma schema, and Vite frontend skeleton.
- **Technical Changes**: Implemented Express routing, LoRA/image/gallery/statistics endpoints, Prisma schema with seeds, responsive dashboard components, API helpers, lint/build automation, and comprehensive README guidance.
- **Data Changes**: Introduced the baseline SQLite schema and seed content for users, assets, galleries, and tags.

## 2025-09-18 – Express wildcard regression (37ed12b)
- **General**: Repaired storage downloads after Express 5 rejected wildcard parameters.
- **Technical Changes**: Replaced the proxy route with `/api/storage/:bucket/:objectKey(*)`, updated handler lookups, and aligned README documentation.
- **Data Changes**: None.

## 2025-09-18 – Unified dev starter (5957426)
- **General**: Simplified local development with a combined launcher for backend and frontend.
- **Technical Changes**: Added `dev-start.sh`, hardened Vite host/port parsing for 0.0.0.0 access, synchronized backend package metadata, and refreshed README workflow notes.
- **Data Changes**: None.

## 2025-09-18 – Node 18 crypto polyfill (620b2ab)
- **General**: Ensured the frontend works on Node 18.19 by polyfilling missing WebCrypto hashing APIs.
- **Technical Changes**: Added a reusable polyfill script, required it via npm scripts, typed the Vite config, and documented Node compatibility guidance.
- **Data Changes**: None.

## 2025-09-18 – Guided installer (78dbd3b)
- **General**: Reduced onboarding friction with an interactive installation script for both services.
- **Technical Changes**: Introduced `install.sh` to install dependencies, scaffold `.env` files, and optionally run Prisma tasks while documenting the workflow in the README.
- **Data Changes**: None.

## 2025-09-18 – Extended rollback tooling (805a7d9)
- **General**: Expanded the rollback utility to fully clean local toolchains when requested.
- **Technical Changes**: Taught `rollback.sh` to purge npm caches, global prefixes, and popular Node version managers while clearly documenting the destructive steps.
- **Data Changes**: None.

## 2025-09-18 – Dockerized install flow (a1b2c3d)
- **General**: Automated Docker, Portainer, and MinIO provisioning during installation.
- **Technical Changes**: Added Docker/Compose checks, optional Portainer setup, persistent MinIO container orchestration, and README updates covering prerequisites and persistence paths.
- **Data Changes**: None; infrastructure only.

## 2025-09-18 – Prisma configuration cleanup (b29726e)
- **General**: Unblocked Prisma CLI usage by removing conflicting environment overrides.
- **Technical Changes**: Deleted `prisma/.env`, updated ignores and rollback script references, and clarified README setup notes.
- **Data Changes**: None.

## 2025-09-18 – Repository reset (d09d717)
- **General**: Cleared the repository to prepare for the new VisionSuit codebase.
- **Technical Changes**: Removed legacy application files and reset README content.
- **Data Changes**: Purged prior project artifacts to start from a clean slate.

## 2025-09-18 – Inline Vite polyfill (d5003cf)
- **General**: Delivered a built-in hash polyfill so the dev starter no longer crashes on missing `crypto.hash`.
- **Technical Changes**: Embedded compatibility logic inside `vite.config.ts`, expanded TypeScript settings, and documented the change.
- **Data Changes**: None.

## 2025-09-18 – Rollback utility (d7034e7)
- **General**: Added a dedicated rollback script to restore local environments quickly.
- **Technical Changes**: Implemented artifact and dependency cleanup for both services and described usage in the README.
- **Data Changes**: None; cleans up generated files only.

## 2025-09-18 – Storage proxy compatibility (eedd315)
- **General**: Fixed another Express wildcard incompatibility impacting storage downloads.
- **Technical Changes**: Switched the proxy to `:objectKey(.*)` to accept nested paths and validated linting (pending type fixes).
- **Data Changes**: None.

## 2025-09-18 – Frontend production pass (f80f7df)
- **General**: Elevated the landing experience with a hero flow and three-step upload wizard.
- **Technical Changes**: Built the UploadWizard component, toast system, hero CTA, API client hooks, and extensive styling updates while aligning README highlights.
- **Data Changes**: None.

## 2025-09-18 – Prisma environment standardization (fa46387)
- **General**: Normalized Prisma configuration so migrations run without manual variables.
- **Technical Changes**: Added a shared SQLite URL, updated ignore rules, removed legacy package settings, and refreshed README guidance.
- **Data Changes**: None; configuration only.

## 2025-09-18 – Explorer expansion (pending)
- **General**: Delivered data-driven explorers for LoRA assets and curated galleries.
- **Technical Changes**: Implemented advanced filtering, lazy loading, new card layouts, reusable chips, and README updates for the frontend workflow.
- **Data Changes**: None; UI consuming existing APIs.

## 2025-09-18 – Workflow plan
- **General**: Published the VisionSuit workflow roadmap covering components, phases, and risks.
- **Technical Changes**: Added planning documentation and referenced it from the README.
- **Data Changes**: None.

## 2025-09-19 – Gallery overhaul (0941b39)
- **General**: Replaced the legacy image gallery with a richer collection explorer and lightbox.
- **Technical Changes**: Added random preview tiles, five-column grids, scroll pagination, detailed lightbox metadata, supporting styles, and README updates.
- **Data Changes**: None.

## 2025-09-19 – Upload pipeline foundation (1bdf211)
- **General**: Transitioned uploads from a mock to a production-ready flow with governance messaging.
- **Technical Changes**: Implemented `POST /api/uploads`, added `UploadDraft` schema and validation, enhanced hero layout, enriched wizard error handling, refreshed styles, and documented the API.
- **Data Changes**: Added the `UploadDraft` table and related migration to persist draft sessions and file metadata.

## 2025-09-19 – Model detail refresh (3396953)
- **General**: Streamlined the model detail view for clearer information hierarchy.
- **Technical Changes**: Reworked layout into summary table plus preview, elevated download CTA styling, and synchronized README highlights.
- **Data Changes**: None.

## 2025-09-19 – Metadata table redesign (4b59727)
- **General**: Made model metadata easier to scan by normalizing nested payloads.
- **Technical Changes**: Added recursive normalization in the asset explorer, replaced definition lists with accessible tables, and refined table styling.
- **Data Changes**: None.

## 2025-09-19 – Focused model uploads (4fd2b2b)
- **General**: Tightened the model upload experience to prevent extraneous files.
- **Technical Changes**: Limited uploads to one model plus optional preview, hid gallery/type controls, updated review copy, and refreshed README guidance.
- **Data Changes**: None.

## 2025-09-19 – Model versioning (5b1e08a)
- **General**: Enabled versioned model management across backend and frontend.
- **Technical Changes**: Added `ModelVersion` schema and API endpoint, expanded storage cleanup, built the ModelVersion dialog, wired API client calls, and styled version chips.
- **Data Changes**: Added the `ModelVersion` table and relations for persisted Safetensor revisions.

## 2025-09-19 – Explorer layout polish (7c08273)
- **General**: Improved model explorer navigation with consistent grids and cross-links.
- **Technical Changes**: Locked the explorer to five-column lazy-loaded grids, added metadata sidebars, linked related galleries and models, and updated styles plus README highlights.
- **Data Changes**: None.

## 2025-09-19 – Gallery albums (9225ba6)
- **General**: Introduced album-centric gallery browsing with immersive previews.
- **Technical Changes**: Added `GalleryAlbum` components, hero tiles, keyboard-aware lightbox, skeleton states, and removed outdated cards while updating documentation.
- **Data Changes**: None.

## 2025-09-19 – Admin control center (commit TBD)
- **General**: Reimagined the admin panel for large-scale moderation workloads.
- **Technical Changes**: Added bulk filters and actions across users, models, and images; extended gallery editors; implemented backend batch endpoints; refreshed styling; and aligned README highlights.
- **Data Changes**: None; operates on existing records.

## 2025-09-19 – Explorer copy cleanup (commit TBD)
- **General**: Completed the English localization of remaining asset explorer strings.
- **Technical Changes**: Translated residual German labels and logs and verified linting.
- **Data Changes**: None.

## 2025-09-19 – Authentication and admin suite (commit TBD)
- **General**: Secured VisionSuit with full JWT authentication and admin tooling.
- **Technical Changes**: Added login/me endpoints, password hashing, auth middleware, role-aware upload/asset routes, admin CRUD APIs, provisioning script, frontend auth context and dashboards, and updated styling plus README docs.
- **Data Changes**: Stores hashed credentials and role assignments within existing user tables.

## 2025-09-19 – Dialog-based explorers (commit TBD)
- **General**: Shifted model and gallery detail views into reusable dialogs for better focus on small screens.
- **Technical Changes**: Added modal navigation with backdrop/escape handling, parent callbacks, responsive CSS, and README updates.
- **Data Changes**: None.

## 2025-09-19 – Resilient gallery metadata (commit TBD)
- **General**: Prevented gallery crashes when metadata is missing or incomplete.
- **Technical Changes**: Made metadata fields optional in types, guarded lightbox and card rendering with optional chaining, and documented the resilience improvement.
- **Data Changes**: None.

## 2025-09-20 – Ranking administration suite (commit TBD)
- **General**: Empowered administrators to tune ranking math, expand the ladder, and moderate curator visibility.
- **Technical Changes**: Added configurable ranking settings and tier management APIs, introduced user-specific ranking overrides, refreshed profile scoring with dynamic weights, and surfaced ranking blocks in the UI.
- **Data Changes**: Added Prisma models and migrations for ranking settings, tiers, and per-user overrides.

## 2025-09-19 – Home dashboard alignment (commit TBD)
- **General**: Brought the home view in line with the explorer layout for consistent discovery.
- **Technical Changes**: Implemented modular home cards, responsive two-section grid, tagged CTA buttons, explorer tag filtering, and README updates.
- **Data Changes**: None.

## 2025-09-19 – Metadata extraction pipeline (commit TBD)
- **General**: Added automated metadata parsing for uploads to power richer search.
- **Technical Changes**: Built a backend metadata helper for PNG/JPEG/Safetensors, integrated results into upload processing and API payloads, wired frontend filters and admin dashboards to the new fields, and documented the automation.
- **Data Changes**: Persisted extracted metadata JSON on model/image assets and upload drafts.

## 2025-09-19 – Metadata dialog enhancements (commit TBD)
- **General**: Clarified safetensor metadata presentation and separated tag analysis.
- **Technical Changes**: Added recursive JSON detection for model aliases, filtered frequency stats, introduced a dedicated tag dialog, refined buttons/tables, and updated highlights.
- **Data Changes**: None.

## 2025-09-19 – UI streamline (commit TBD)
- **General**: Simplified dashboard chrome and clarified key call-to-actions.
- **Technical Changes**: Removed redundant header buttons, unified explorer labels, added role-aware gallery dropdown in the wizard with error messaging, and updated README notes.
- **Data Changes**: None.

## 2025-09-19 – Upload wizard translation (commit TBD)
- **General**: Completed the English-language UX for the upload wizard.
- **Technical Changes**: Translated all visible strings, added category mapping, refined copy in success/review states, ensured supporting components match, and noted the change in the README.
- **Data Changes**: None.

## 2025-09-19 – Storage route consolidation (commit TBD)
- **General**: Finalized Express storage routing compatible with Express 5 across GET and HEAD.
- **Technical Changes**: Migrated to `/:bucket/*`, shared handler logic, and explained the fix while awaiting final commit ID.
- **Data Changes**: None.

## 2025-09-19 – Streamlined installer (da2500c)
- **General**: Tuned the installer for production hosts with automatic IP detection.
- **Technical Changes**: Added smart IP/port prompts, synchronized `.env` files, injected MinIO defaults, and refreshed README installation guidance.
- **Data Changes**: None.

## 2025-09-19 – Storage wildcard fix (e59b9b2)
- **General**: Ensured storage endpoints load under Express 5 after wildcard parsing changes.
- **Technical Changes**: Adopted a named `:objectPath(*)` parameter, retained legacy fallback, and updated README endpoint documentation.
- **Data Changes**: None.

## 2025-09-20 – Avatar upload pipeline (commit TBD)
- **General**: Enabled secure on-platform avatar uploads with built-in validation and MinIO-backed delivery.
- **Technical Changes**: Added the `/api/users/:id/avatar` endpoint with strict MIME checks and size guards, updated auth user serialization, wired the React account settings dialog and API client for file uploads, and refreshed styles plus documentation.
- **Data Changes**: Stores uploaded avatars in the image bucket under user-specific prefixes; database schema unchanged.

## 2025-09-19 – Model version hierarchy controls (commit TBD)
- **General**: Enabled full lifecycle management of secondary model revisions directly from the admin console.
- **Technical Changes**: Added backend promotion and deletion endpoints, refined primary-version mapping to preserve chronology, exposed new API client helpers, and wired admin UI actions for promoting, renaming, and removing versions with refreshed README guidance.
- **Data Changes**: None.

## 2025-09-19 – Model card layout polish (commit TBD)
- **General**: Smoothed the model card experience by aligning primary actions and tightening the dataset tags table.
- **Technical Changes**: Converted the preview action stack to a full-width flex column, equalized button typography, and padded the tag frequency table with a fixed layout so headers and rows stay inside the dialog.
- **Data Changes**: None.

## 2025-09-20 – Trigger activator modelcards
- **General**: Added a dedicated Trigger/Activator field to modelcards with copy-to-clipboard handling during uploads and admin edits.
- **Technical Changes**: Extended the Prisma schema, API validation, upload wizard, admin panel, and explorer UI to capture and display trigger phrases while equalizing modelcard summary column sizing and styling the copy action.
- **Data Changes**: Introduced a nullable `trigger` column on `ModelAsset` records and seeded demo content with a default activator.

## 2025-09-19 – Storage object IDs (e78ced6)
- **General**: Moved storage downloads to stable object IDs resolved from the database.
- **Technical Changes**: Added the `StorageObject` table and migration, updated the proxy to look up metadata by ID, adjusted upload pipelines to create records, and refreshed README docs.
- **Data Changes**: Introduced `StorageObject` records referencing each stored asset.

## 2025-09-19 – Gallery upload wizard (ecb521e)
- **General**: Launched a gallery-specific upload wizard with backend support and documentation.
- **Technical Changes**: Added multi-image upload handling with validation, created gallery entries per file, linked explorer actions, adjusted toast handling, and updated README guidance.
- **Data Changes**: Persisted gallery draft assets and cover updates during uploads.

## 2025-09-19 – README refresh
- **General**: Modernized and translated the README into clear English.
- **Technical Changes**: Reorganized highlights, architecture overview, installation, workflow, upload pipeline, and troubleshooting content for clarity.
- **Data Changes**: None.

## 2025-09-19 – Product shell refresh (bb636b9)
- **General**: Updated the frontend shell with persistent navigation and service health indicators.
- **Technical Changes**: Added a permanent sidebar, surface status API `/api/meta/status`, refreshed home tiles, introduced a standalone image explorer, and aligned README docs.
- **Data Changes**: None.

## 2025-09-20 – Launch day polish (bcd8f72)
- **General**: Elevated the landing page into a production control panel with trust cues and CTAs.
- **Technical Changes**: Added sticky topbar, hero, trust metrics, CTA panels, wizard auto-refresh callbacks, extensive styling, README updates, and corrected prior changelog references.
- **Data Changes**: None.

## 2025-09-20 – Direct MinIO pipeline (pending)
- **General**: Connected uploads directly to MinIO with immediate asset availability.
- **Technical Changes**: Updated upload endpoints to stream to MinIO with checksums, created assets/galleries in one pass, exposed storage metadata in APIs, refreshed frontend cards/wizard messaging, and documented the flow.
- **Data Changes**: Assets and galleries now persist MinIO bucket/object names alongside existing metadata.

## 2025-09-20 – Community roadmap documentation
- **General**: Documented the planned community engagement features and surfaced the roadmap in public docs.
- **Technical Changes**: Added a dedicated community features plan detailing reactions, comments, follows, collections, and the supporting architecture; linked the plan from the README via a new Community Roadmap section.
- **Data Changes**: None; documentation-only update outlining future schema additions.

## 2025-09-20 – Historical changelog migration
- **General**: Consolidated all legacy changelog entries into the unified format and cleaned up redundant files.
- **Technical Changes**: Transcribed prior per-commit notes into the new changelog layout and removed superseded markdown entries.
- **Data Changes**: None.

## 2025-09-20 – Preview gallery quick actions
- **General**: Moved linked image collection access directly beneath the model preview with action-style buttons.
- **Technical Changes**: Updated the asset detail preview card to render gallery navigation buttons alongside downloads and refreshed the associated styling while removing the old section list.
- **Data Changes**: None.

## 2025-09-20 – Model card action polish (commit TBD)
- **General**: Tightened the model card actions by matching button styling and clarifying the surrounding tag and metadata layout.
- **Technical Changes**: Reduced preview action width stretching, unified the open-collection button palette with downloads, simplified its label, introduced a detail grid for tags versus metadata, and refreshed spacing utilities for both sections.
- **Data Changes**: None.

## 2025-09-20 – Model card layout restructure
- **General**: Rebuilt the model card layout into a two-column canvas with more breathing room and stabilized table alignment.
- **Technical Changes**: Introduced a responsive layout grid for summary and metadata panes, widened the dialog container, enforced fixed table layouts, and added flexible metadata scroll containers.
- **Data Changes**: None.

## 2025-09-20 – Model card width expansion
- **General**: Enlarged the model detail dialog so metadata columns remain readable on wide screens.
- **Technical Changes**: Adjusted the dialog container to span 80% of the viewport (capped at 1400px) and loosened the tablet breakpoint width to retain proportional spacing.
- **Data Changes**: None.

## 2025-09-20 – Model card metadata centering
- **General**: Realigned the model card so the metadata panel sits beneath the preview and regains breathing room.
- **Technical Changes**: Repositioned the metadata section inside the summary grid, removed the squeezing flex growth, and added styling to center the metadata card below the preview.
- **Data Changes**: None.

## 2025-09-20 – Model version management enhancements (commit TBD)
- **General**: Empowered curators and admins to rename model versions from the modelcard while giving the metadata section more breathing room.
- **Technical Changes**: Added `PUT /api/assets/models/:modelId/versions/:versionId`, expanded the frontend API client, introduced an edit dialog with permission checks, refined version chip labelling with edit controls, and stretched the metadata card styling.
- **Data Changes**: None; operates on existing model/version records without schema updates.

## 2025-09-20 – Asset explorer crash fix (commit TBD)
- **General**: Restored the model gallery so the Asset Explorer shows tiles instead of failing with a blank screen.
- **Technical Changes**: Reordered the `activeAsset` memo and its permission guard ahead of dependent effects to remove the temporal dead zone runtime error that crashed the component on load.
- **Data Changes**: None.

## 2025-09-20 – Gallery detail grid expansion (commit TBD)
- **General**: Extended the gallery detail view to surface six thumbnails per row on wide screens without distorting the layout.
- **Technical Changes**: Updated `.gallery-detail__grid` breakpoints and thumbnail sizing in `frontend/src/index.css` to provide a six-column base with responsive fallbacks and square previews.
- **Data Changes**: None; visual styling only.

## 2025-09-20 – Administration workspace restyle
- **General**: Modernized the admin console with a lighter visual rhythm and clearer hierarchy for moderation workflows.
- **Technical Changes**: Reworked administration CSS with glassmorphism cards, pill navigation, refined forms/tables, enhanced focus states, and refreshed README guidance.
- **Data Changes**: None.

## 2025-09-21 – Compact moderation grid (commit TBD)
- **General**: Reimagined the admin image moderation space as a dense grid with inline previews and quick actions to keep hundreds of thousands of assets scannable.
- **Technical Changes**: Introduced thumbnail resolution helpers, expandable edit sections, condensed metadata badges, subtle action buttons, and refreshed README guidance to describe the new workflow.
- **Data Changes**: None; presentation-only adjustments.

## 2025-09-20 – Admin search event pooling fix
- **General**: Restored admin panel filters so typing in search fields no longer crashes the interface.
- **Technical Changes**: Captured input and select values before enqueuing state updates throughout `AdminPanel.tsx` to avoid React's SyntheticEvent pooling from clearing `currentTarget`.
- **Data Changes**: None; UI state handling only.

## 2025-09-19 – Admin model grid parity (commit TBD)
- **General**: Brought the models administration view in line with the image moderation cards, including clear version lineage per asset.
- **Technical Changes**: Replaced the tabular model manager with card-based layouts, surfaced version metadata with storage links, added expansion controls, refreshed styling, and updated README guidance.
- **Data Changes**: None; presentation layer only.

## 2025-09-20 – Community plan feasibility documentation
- **General**: Captured the community roadmap feasibility assessment in dedicated documentation and linked it from the main README.
- **Technical Changes**: Added `docs/community-features-plan-analysis.md` mirroring the prior review tables and refreshed the README community roadmap section with a reference to the new analysis.
- **Data Changes**: None; documentation-only addition for planning purposes.
## 2025-09-19 – Severity-based community update plans
- **General**: Published severity-grouped content update roadmaps to steer community feature rollout communications.
- **Technical Changes**: Added dedicated plan documents for Projects Silverleaf, Ironquill, and Novashield plus updated the README to reference them.
- **Data Changes**: None; documentation-only planning assets.

## 2025-09-20 – Interactive home spotlights (commit TBD)
- **General**: Elevated the home dashboard with clickable previews that jump directly into the explorers.
- **Technical Changes**: Added media buttons on home tiles that focus the respective model or gallery, introduced gallery lookups for image cards, updated hover/focus styling, and refreshed README guidance.
- **Data Changes**: None.

## 2025-09-20 – Modelcard primary-first ordering
- **General**: Ensured modelcard version listings surface the primary release before sequential versions for quicker recognition.
- **Technical Changes**: Updated backend asset mapping to keep the primary version at the top while numerically ordering the remaining versions and retaining latest-version metadata via creation timestamps.
- **Data Changes**: None; response payload ordering only.

## 2025-09-19 – Dialog-driven user onboarding (pending)
- **General**: Reimagined account creation with preset-driven dialogs and clearer role guidance for administrators.
- **Technical Changes**: Added a multi-step `UserCreationDialog` with validation and password generation, introduced role summary popups, revamped the admin onboarding panel styling, extended status handling, and refreshed README highlights.
- **Data Changes**: None; interface and workflow updates only.

## 2025-09-21 – Client bulk import scripts
- **General**: Equipped curators with turnkey client importers so LoRA weights and previews can be staged locally and pushed to the VisionSuit server in bulk.
- **Technical Changes**: Added dedicated Linux/macOS and Windows scripts that validate matching preview folders, pick a random cover image, generate a manifest, and upload packages over SSH; refreshed the README with setup and execution guidance.
- **Data Changes**: None; tooling additions only.

## 2025-09-20 – API-driven bulk import helpers
- **General**: Reworked the client import tooling to authenticate against VisionSuit and upload LoRAs through the official pipeline instead of SSH transfers.
- **Technical Changes**: Replaced the staging/manifest workflow with direct `POST /api/uploads` calls in both scripts, added credential prompts and file-cap trimming, refreshed README guidance, and documented password handling.
- **Data Changes**: None; ingestion now flows through existing upload drafts and storage objects.

## 2025-09-22 – Frontend title alignment (commit TBD)
- **General**: Updated the browser tab title to reflect the VisionSuit brand instead of the Vite starter text.
- **Technical Changes**: Changed the HTML document title in `frontend/index.html` to "VisionSuit" for production readiness.
- **Data Changes**: None.
## 2025-09-23 – Sidebar service status refinement
- **General**: Elevated the service indicator deck with cohesive glassmorphism cards and contextual badges.
- **Technical Changes**: Reworked the sidebar status markup with service initials, introduced gradient icon styling and status-aware card accents, refreshed health pill visuals, and updated the README highlight to describe the polished cards.
- **Data Changes**: None; presentation-only updates for health indicators.

## 2025-09-23 – Sidebar status LED redesign (commit TBD)
- **General**: Replaced the sidebar service text badges with compact LED indicators that stay visible within the card layout.
- **Technical Changes**: Updated the service status header markup, introduced dedicated LED styling with accessibility helpers, and refreshed the README highlight to mention the beacons.
- **Data Changes**: None.

## 2025-09-19 – Curator edit controls (commit TBD)
- **General**: Enabled curators to edit their own models, galleries, and images directly from the explorers without requiring admin access.
- **Technical Changes**: Added role-aware edit dialogs for models, images, and collections, refreshed state management in the explorers, expanded styling for new action buttons, and updated README guidance.
- **Data Changes**: None; updates operate on existing records only.

## 2025-09-23 – Gallery explorer resilience (commit TBD)
- **General**: Restored the gallery explorer so collections with missing owners or entry arrays render instead of crashing to an empty panel.
- **Technical Changes**: Added defensive helpers for owner and entry access, updated filters/sorters to use the safe lookups, hardened the detail dialogs, and refreshed README guidance about handling incomplete payloads.
- **Data Changes**: None; safeguards run entirely on the client.

## 2025-09-23 – Gallery explorer initialization fix (commit TBD)
- **General**: Restored the gallery explorer lightbox so collections open without crashing.
- **Technical Changes**: Moved the active gallery memoization before dependent effects to prevent accessing uninitialized bindings.
- **Data Changes**: None.

## 2025-09-20 – Image edit dialog layering fix
- **General**: Ensured the image edit dialog surfaces above the lightbox when curators edit a single gallery image.
- **Technical Changes**: Raised the modal z-index styling in `frontend/src/index.css` so edit dialogs overlay the gallery image modal backdrop.
- **Data Changes**: None; styling adjustment only.

## 2025-09-24 – Image metadata layout compaction
- **General**: Shortened the image metadata edit experience by spreading controls into columns so the dialog stays within the viewport.
- **Technical Changes**: Widened the image edit dialog container and introduced a responsive three-column grid for metadata fields in `frontend/src/components/ImageAssetEditDialog.tsx` and `frontend/src/index.css`.
- **Data Changes**: None; purely presentational improvements to existing metadata inputs.

## 2025-09-24 – Curator profile spotlight
- **General**: Introduced curator profile pages with contribution stats, ranks, and full listings of each curator’s models and collections.
- **Technical Changes**: Added a public `/api/users/:id/profile` endpoint, new profile view state management, reusable curator link styling, `UserProfile` component, and expanded explorers/admin panels to open profiles.
- **Data Changes**: None; profile data is derived from existing users, models, galleries, and images.

## 2025-09-24 – Upload wizard asset type wiring fix
- **General**: Restored both model and gallery uploads by ensuring each wizard mode automatically supplies the correct asset type to the API.
- **Technical Changes**: Renamed the upload wizard form state to `assetType`, adjusted validations, review summaries, and submission payloads to use the field, and forwarded the computed type to `createUploadDraft` so the backend receives `lora` or `image` as expected.
- **Data Changes**: None; fixes adjust client-side form wiring only.

## 2025-09-24 – Primary view initialization guard
- **General**: Fixed the blank screen on startup by ensuring the primary view navigation helper initializes before any effects run.
- **Technical Changes**: Moved the `openPrimaryView` callback above dependent effects in `frontend/src/App.tsx` so React doesn’t hit the temporal dead zone when guarding the admin view.
- **Data Changes**: None; state management only.

## 2025-09-24 – Self-service account settings
- **General**: Empowered curators to manage their own profile details and passwords directly from the console sidebar.
- **Technical Changes**: Added authenticated profile/password routes, new API helpers, an account settings modal with validation, refreshed sidebar styling, and updated README guidance.
- **Data Changes**: None; updates operate on existing user records only.

## 2025-09-24 – Avatar relay hardening
- **General**: Ensured curator avatars remain visible regardless of MinIO hostname settings by proxying them through the API and removing the manual URL field from account settings.
- **Technical Changes**: Added a `/api/users/:id/avatar` stream endpoint, centralized avatar URL resolution with request-aware helpers, updated user serializers to emit proxied links, refreshed the React profile view to normalize avatar sources, and simplified the account settings dialog plus docs.
- **Data Changes**: None; avatars continue to upload into the existing image bucket with unchanged storage paths.
