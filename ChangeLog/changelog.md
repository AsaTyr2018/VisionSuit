## 053 – [Standard Change] Dedicated service status page rollout
- **Type**: Standard Change
- **Reason**: The dashboard and sidebar were crowded by the embedded service status widgets, making it harder to surface uptime details in a focused way.
- **Change**: Introduced a standalone service status view accessible from the footer, added compact LED indicators to the footer link, removed the sidebar and home dashboard widgets, refreshed styles, and updated the README to reflect the new navigation.

## 052 – [Normal Change] Auto tagger graceful degradation
- **Type**: Normal Change
- **Reason**: Hosts running Node.js versions without matching `onnxruntime-node` binaries caused the CPU execution provider check to fail, blocking the entire backend from starting.
- **Change**: Allowed startup to continue when the ONNX backend is unavailable, record failed auto-tagging jobs with clear `tagScanError` messages, surfaced console warnings for skipped queues, and refreshed the README with recovery guidance.

## 051 – [Standard Change] ONNX CPU provider detection hardening
- **Type**: Standard Change
- **Reason**: Hosts with `onnxruntime-node` v1.23 reported the CPU execution provider as `CPUExecutionProvider`, causing startup to abort even though the native backend binaries were present.
- **Change**: Normalised CPU execution provider detection to accept both casing variants before session creation, retained the legacy fallback for older builds, and refreshed the README troubleshooting note with the clarified behaviour.

## 050 – [Standard Change] Paginated asset explorers
- **Type**: Standard Change
- **Reason**: Loading every model and image on initial dashboard visits slowed the UI and risked timeouts once the catalog grew.
- **Change**: Added cursor-aware pagination and metadata to the asset APIs, taught the frontend to request incremental windows with load-more controls, refreshed the README to highlight the streaming behaviour, and covered moderation/adult filters with regression tests.

## 049 – [Standard Change] Windows bulk uploader stream guard
- **Type**: Standard Change
- **Reason**: The Windows bulk importer intermittently crashed with `Error while copying content to a stream`, leaving operators without insight into the failing file or HTTP transport issue.
- **Change**: Hardened file preparation with explicit stream guards, disabled implicit 100-continue negotiation, wrapped upload calls to surface deep transport errors, and refreshed the README with the troubleshooting guidance.

## 048 – [Standard Change] ONNX runtime fallback for auto tagger
- **Type**: Standard Change
- **Reason**: Backend startup crashed on hosts without the native ONNX Runtime CPU provider, preventing the SmilingWolf auto tagger from loading.
- **Change**: Detected unavailable native providers, fell back to the bundled WebAssembly runtime via `onnxruntime-web`, refreshed dependencies, and documented the runtime behaviour in the README.

## 047 – [Standard Change] Hugging Face auto-tagger download hardening
- **Type**: Standard Change
- **Reason**: Backend startup failed after Hugging Face redirects left no temp file to rename and operators could not confirm the download status from the console output.
- **Change**: Taught the downloader to follow redirects without double-renaming, cleared stale temp artifacts, surfaced `[startup]` download logs, and refreshed the README so the first-boot Hugging Face fetch is clearly communicated.

## 046 – [Standard Change] README refresh & technical doc relocation
- **Type**: Standard Change
- **Reason**: The README had become cluttered with extensive technical detail, making it difficult to quickly understand the platform while keeping documentation consistent.
- **Change**: Streamlined the README with grouped core features, modernized onboarding guidance, and moved the deep technical description into `docs/technical-overview.md` so detailed guidance lives under the documentation directory.

## 045 – [Standard Change] Prisma Studio admin launch alignment
- **Type**: Standard Change
- **Reason**: Opening Prisma Studio from the admin sidebar on split-origin deployments redirected back to the frontend homepage, preventing administrators from reaching the proxied database tool.
- **Change**: Routed the Prisma Studio launcher through the configured API base URL and documented the behaviour so admins on separate frontend/backend hosts land on the `/db` proxy without manual URL tweaks.

## 044 – [Standard Change] Curator visibility moderation hardening
- **Type**: Standard Change
- **Reason**: Restore curator-facing visibility controls while ensuring flagged assets remain private until moderation approval.
- **Change**: Added backend support for curator visibility toggles on models and images, blocked publishing flagged assets without an admin clearance, and refreshed the README to highlight the enforced moderation workflow.

## 043 – [Standard Change] GPU agent naming correction
- **Type**: Standard Change
- **Reason**: Align GPU agent documentation with the official VisionSuit brand spelling so operators can search for the correct service name across guides and scripts.
- **Change**: Replaced the erroneous “VisionSIOt” reference in GPU agent guides, README instructions, and historical audit notes with “VisionSuit,” and clarified the audit log to record the fix.

## 042 – [Standard Change] Comprehensive project audit
- **Type**: Standard Change
- **Reason**: Document the current state of VisionSuit by comparing implementation details with published guidance to surface gaps, risks, and next steps.
- **Change**: Added the 2025-09-27 project audit report capturing architecture alignment, documentation gaps, high-impact risks, and remediation recommendations, and linked the latest audits from the README for easy discovery.

## 041 – [Standard Change] Trigger enforcement & flagged asset privacy
- **Type**: Standard Change
- **Reason**: Align moderation-critical behaviours with documented expectations by enforcing trigger keywords during edits and keeping flagged assets private to moderators and owners.
- **Change**: Required trigger values throughout the edit flow, tightened backend validation, introduced viewer-aware moderation visibility helpers, filtered explorers and profiles to hide flagged assets from the community, and documented the remediation in the January 14 sanity report follow-up.

## 040 – [Standard Change] Documentation sanity review refresh
- **Type**: Standard Change
- **Reason**: Capture the latest comparison between README claims and the implemented application to guide upcoming documentation or feature adjustments.
- **Change**: Added the 2025-01-14 documentation vs application sanity report detailing confirmed behaviours, remaining gaps from the prior review, and a newly identified inconsistency around flagged asset visibility.

## 039 – [Standard Change] Home trust & CTA rollout
- **Type**: Standard Change
- **Reason**: Align the documented home experience with actual UI elements so curators and administrators see actionable entry points and transparent trust signals when they land on the dashboard.
- **Change**: Added role-aware call-to-action cards and a Platform health trust panel to the home view, styled the new sections, refreshed README guidance, and marked the sanity check gap as resolved.

## 038 – [Standard Change] Prisma Studio service proxy
- **Type**: Standard Change
- **Reason**: Provide administrators with persistent database tooling without exposing the default Prisma Studio port or bypassing existing authentication flows.
- **Change**: Launched Prisma Studio alongside the dev stack, proxied it through `/db` with admin-only JWT validation and HttpOnly session cookies, surfaced an admin sidebar shortcut, routed `/db` through the dev proxy, documented the workflow, and ensured logout clears the Studio session.

## 037 – [Standard Change] NSFW moderation workspace integration
- **Type**: Standard Change
- **Reason**: Align the admin moderation experience with the structured NSFW verdicts now produced by the backend so moderators can act on the new signals without conflicting UI patterns.
- **Change**: Replaced the legacy moderation card grid with the split-pane workspace that consumes NSFW visibility, reasons, and score snapshots, pruned the unused grid styles, and refreshed the README to highlight the severity filters and signal-aware workflow.

## 036 – [Standard Change] NSFW swimwear CNN integration
- **Type**: Standard Change
- **Reason**: Prepare the NSFW moderation stack for its first full validation pass by pairing heuristic scoring with the trained nudity-versus-swimwear classifier.
- **Change**: Added on-device ONNX inference with configurable thresholds, extended the image analysis configuration schema, serialized CNN outputs, refreshed README guidance, and updated the deployment checklist to reflect the completed CNN work.

## 035 – [Standard Change] NSFW moderation regression tests
- **Type**: Standard Change
- **Reason**: Ensure the NSFW upload and rescan workflow keeps marking adult and potentially illegal content correctly.
- **Change**: Added targeted moderation unit tests covering metadata thresholds, keyword detection, and metadata screening fallbacks.

## 001 – [Fix] Express startup fix
- **General**: Stabilized the backend boot process after Express failed to locate the request augmentation module.
- **Technical Changes**: Converted the Express request extension from `.d.ts` to `.ts`, refreshed backend linting, and documented the troubleshooting steps and upload endpoint in the README.
- **Data Changes**: None; runtime typings only.

## 002 – [Fix] Storage proxy hardening (0c8e4b3)
- **General**: Delivered a reliable storage proxy so MinIO assets stream through the backend with consistent limits and messaging.
- **Technical Changes**: Added `/api/storage/:bucket/:objectKey`, enriched Multer error handling, routed frontend downloads through the proxy, introduced shared storage helpers, and updated README limits.
- **Data Changes**: None; transport layer adjustments only.

## 003 – [Addition] MinIO storage foundation (16b920c)
- **General**: Introduced MinIO-backed storage with first-class setup guidance across the stack.
- **Technical Changes**: Added `lib/storage` with automatic bucket provisioning, gated server startup on successful bootstrap, wired new MinIO environment variables, templated `.env`, and extended the installer and README.
- **Data Changes**: None beyond new storage buckets created at runtime.

## 004 – [Addition] Platform bootstrap (21ef5ed)
- **General**: Established the initial VisionSuit platform spanning backend API, Prisma schema, and Vite frontend skeleton.
- **Technical Changes**: Implemented Express routing, LoRA/image/gallery/statistics endpoints, Prisma schema with seeds, responsive dashboard components, API helpers, lint/build automation, and comprehensive README guidance.
- **Data Changes**: Introduced the baseline SQLite schema and seed content for users, assets, galleries, and tags.

## 005 – [Fix] Express wildcard regression (37ed12b)
- **General**: Repaired storage downloads after Express 5 rejected wildcard parameters.
- **Technical Changes**: Replaced the proxy route with `/api/storage/:bucket/:objectKey(*)`, updated handler lookups, and aligned README documentation.
- **Data Changes**: None.

## 006 – [Addition] Unified dev starter (5957426)
- **General**: Simplified local development with a combined launcher for backend and frontend.
- **Technical Changes**: Added `dev-start.sh`, hardened Vite host/port parsing for 0.0.0.0 access, synchronized backend package metadata, and refreshed README workflow notes.
- **Data Changes**: None.

## 007 – [Fix] Node 18 crypto polyfill (620b2ab)
- **General**: Ensured the frontend works on Node 18.19 by polyfilling missing WebCrypto hashing APIs.
- **Technical Changes**: Added a reusable polyfill script, required it via npm scripts, typed the Vite config, and documented Node compatibility guidance.
- **Data Changes**: None.

## 008 – [Addition] Guided installer (78dbd3b)
- **General**: Reduced onboarding friction with an interactive installation script for both services.
- **Technical Changes**: Introduced `install.sh` to install dependencies, scaffold `.env` files, and optionally run Prisma tasks while documenting the workflow in the README.
- **Data Changes**: None.

## 009 – [Addition] Extended rollback tooling (805a7d9)
- **General**: Expanded the rollback utility to fully clean local toolchains when requested.
- **Technical Changes**: Taught `rollback.sh` to purge npm caches, global prefixes, and popular Node version managers while clearly documenting the destructive steps.
- **Data Changes**: None.

## 010 – [Addition] Dockerized install flow (a1b2c3d)
- **General**: Automated Docker, Portainer, and MinIO provisioning during installation.
- **Technical Changes**: Added Docker/Compose checks, optional Portainer setup, persistent MinIO container orchestration, and README updates covering prerequisites and persistence paths.
- **Data Changes**: None; infrastructure only.

## 011 – [Fix] Prisma configuration cleanup (b29726e)
- **General**: Unblocked Prisma CLI usage by removing conflicting environment overrides.
- **Technical Changes**: Deleted `prisma/.env`, updated ignores and rollback script references, and clarified README setup notes.
- **Data Changes**: None.

## 012 – [Addition] Repository reset (d09d717)
- **General**: Cleared the repository to prepare for the new VisionSuit codebase.
- **Technical Changes**: Removed legacy application files and reset README content.
- **Data Changes**: Purged prior project artifacts to start from a clean slate.

## 013 – [Fix] Inline Vite polyfill (d5003cf)
- **General**: Delivered a built-in hash polyfill so the dev starter no longer crashes on missing `crypto.hash`.
- **Technical Changes**: Embedded compatibility logic inside `vite.config.ts`, expanded TypeScript settings, and documented the change.
- **Data Changes**: None.

## 014 – [Addition] Rollback utility (d7034e7)
- **General**: Added a dedicated rollback script to restore local environments quickly.
- **Technical Changes**: Implemented artifact and dependency cleanup for both services and described usage in the README.
- **Data Changes**: None; cleans up generated files only.

## 015 – [Fix] Storage proxy compatibility (eedd315)
- **General**: Fixed another Express wildcard incompatibility impacting storage downloads.
- **Technical Changes**: Switched the proxy to `:objectKey(.*)` to accept nested paths and validated linting (pending type fixes).
- **Data Changes**: None.

## 016 – [Addition] Frontend production pass (f80f7df)
- **General**: Elevated the landing experience with a hero flow and three-step upload wizard.
- **Technical Changes**: Built the UploadWizard component, toast system, hero CTA, API client hooks, and extensive styling updates while aligning README highlights.
- **Data Changes**: None.

## 017 – [Fix] Prisma environment standardization (fa46387)
- **General**: Normalized Prisma configuration so migrations run without manual variables.
- **Technical Changes**: Added a shared SQLite URL, updated ignore rules, removed legacy package settings, and refreshed README guidance.
- **Data Changes**: None; configuration only.

## 018 – [Addition] Explorer expansion (pending)
- **General**: Delivered data-driven explorers for LoRA assets and curated galleries.
- **Technical Changes**: Implemented advanced filtering, lazy loading, new card layouts, reusable chips, and README updates for the frontend workflow.
- **Data Changes**: None; UI consuming existing APIs.

## 019 – [Addition] Workflow plan
- **General**: Published the VisionSuit workflow roadmap covering components, phases, and risks.
- **Technical Changes**: Added planning documentation and referenced it from the README.
- **Data Changes**: None.

## 020 – [Addition] Gallery overhaul (0941b39)
- **General**: Replaced the legacy image gallery with a richer collection explorer and lightbox.
- **Technical Changes**: Added random preview tiles, five-column grids, scroll pagination, detailed lightbox metadata, supporting styles, and README updates.
- **Data Changes**: None.

## 021 – [Addition] Upload pipeline foundation (1bdf211)
- **General**: Transitioned uploads from a mock to a production-ready flow with governance messaging.
- **Technical Changes**: Implemented `POST /api/uploads`, added `UploadDraft` schema and validation, enhanced hero layout, enriched wizard error handling, refreshed styles, and documented the API.
- **Data Changes**: Added the `UploadDraft` table and related migration to persist draft sessions and file metadata.

## 022 – [Addition] Model detail refresh (3396953)
- **General**: Streamlined the model detail view for clearer information hierarchy.
- **Technical Changes**: Reworked layout into summary table plus preview, elevated download CTA styling, and synchronized README highlights.
- **Data Changes**: None.

## 023 – [Addition] Metadata table redesign (4b59727)
- **General**: Made model metadata easier to scan by normalizing nested payloads.
- **Technical Changes**: Added recursive normalization in the asset explorer, replaced definition lists with accessible tables, and refined table styling.
- **Data Changes**: None.

## 024 – [Fix] Focused model uploads (4fd2b2b)
- **General**: Tightened the model upload experience to prevent extraneous files.
- **Technical Changes**: Limited uploads to one model plus optional preview, hid gallery/type controls, updated review copy, and refreshed README guidance.
- **Data Changes**: None.

## 025 – NSFW moderation plan refinement
- **Type**: Normal Change
- **Reason**: Addressed reviewer feedback about swimwear false positives, contextual minor detection, performance tuning, and moderation UX clarity before implementation begins.
- **Change**: Expanded the NSFW deployment plan with a swimwear CNN fallback, cosplay-aware minor heuristics, tunable worker pools, soft "Pending Review" states, preview blur options, and a future ONNX integration roadmap.

## 025 – [Addition] Model versioning (5b1e08a)
- **General**: Enabled versioned model management across backend and frontend.
- **Technical Changes**: Added `ModelVersion` schema and API endpoint, expanded storage cleanup, built the ModelVersion dialog, wired API client calls, and styled version chips.
- **Data Changes**: Added the `ModelVersion` table and relations for persisted Safetensor revisions.

## 026 – [Addition] Explorer layout polish (7c08273)
- **General**: Improved model explorer navigation with consistent grids and cross-links.
- **Technical Changes**: Locked the explorer to five-column lazy-loaded grids, added metadata sidebars, linked related galleries and models, and updated styles plus README highlights.
- **Data Changes**: None.

## 027 – [Addition] Gallery albums (9225ba6)
- **General**: Introduced album-centric gallery browsing with immersive previews.
- **Technical Changes**: Added `GalleryAlbum` components, hero tiles, keyboard-aware lightbox, skeleton states, and removed outdated cards while updating documentation.
- **Data Changes**: None.

## 028 – [Addition] Admin control center (commit TBD)
- **General**: Reimagined the admin panel for large-scale moderation workloads.
- **Technical Changes**: Added bulk filters and actions across users, models, and images; extended gallery editors; implemented backend batch endpoints; refreshed styling; and aligned README highlights.
- **Data Changes**: None; operates on existing records.

## 029 – [Fix] Explorer copy cleanup (commit TBD)
- **General**: Completed the English localization of remaining asset explorer strings.
- **Technical Changes**: Translated residual German labels and logs and verified linting.
- **Data Changes**: None.

## 030 – [Addition] Authentication and admin suite (commit TBD)
- **General**: Secured VisionSuit with full JWT authentication and admin tooling.
- **Technical Changes**: Added login/me endpoints, password hashing, auth middleware, role-aware upload/asset routes, admin CRUD APIs, provisioning script, frontend auth context and dashboards, and updated styling plus README docs.
- **Data Changes**: Stores hashed credentials and role assignments within existing user tables.

## 031 – [Addition] Dialog-based explorers (commit TBD)
- **General**: Shifted model and gallery detail views into reusable dialogs for better focus on small screens.
- **Technical Changes**: Added modal navigation with backdrop/escape handling, parent callbacks, responsive CSS, and README updates.
- **Data Changes**: None.

## 032 – [Fix] NSFW decoder dependency swap
- **Type**: Emergency Change
- **Reason**: Backend startup failed because the NSFW image analysis required the `pngjs` module, which was absent in new installs and broke the launch sequence.
- **Change**: Replaced the PNG decoder with `upng-js`, updated dependency manifests, and refreshed the synthetic test fixture so the analyzer no longer depends on `pngjs`.

## 032 – [Addition] NSFW image ingestion signals
- **Type**: Normal Change
- **Reason**: The moderation roadmap called for automatic adult tagging beyond keyword scans so that explicit previews and gallery uploads are caught even when creators avoid sensitive terms.
- **Change**: Wired the OpenCV heuristics analyzer into model preview and image upload flows, persisted analyzer telemetry alongside metadata, updated the keyword-based filter to honor these signals, refreshed documentation, and logged the rollout.

## 032 – [Addition] NSFW image analysis heuristics
- **Type**: Normal Change
- **Reason**: Extend the moderation stack beyond metadata by introducing an on-device image analyzer that scores skin exposure without requiring cloud services.
- **Change**: Added an OpenCV-based TypeScript module with JPEG/PNG decoding, skin masking, coverage heuristics, admin-configurable thresholds, and regression tests that differentiate nudity from swimwear while persisting settings in `config/nsfw-image-analysis.json`.

## 032 – [Addition] NSFW metadata snapshot
- **Type**: Normal Change
- **Reason**: Administrators needed an at-a-glance view to validate how new metadata thresholds affect existing LoRA assets.
- **Change**: Added a safety router endpoint that aggregates metadata scores per LoRA, exposed the data via the API client, rendered a refreshed admin preview table with styling, marked the deployment plan item complete, and documented the feature in the README.

## 032 – [Addition] NSFW threshold controls (commit TBD)
- **Type**: Normal Change
- **Reason**: Extend the in-progress NSFW filter rollout with tunable LoRA metadata thresholds so moderators can react to real catalog signals without code edits.
- **Change**: Added Administration → Safety sliders for adult/minor/bestiality thresholds, persisted overrides to `nsfw-metadata-filters.json` via the settings API, triggered adult flag recalculation on updates, refreshed documentation checklists, and highlighted the capability in the README.

## 033 – [Addition] NSFW metadata groundwork (commit TBD)
- **Type**: Normal Change
- **Reason**: Kick off the NSFW deployment by externalizing keyword packs and enabling deterministic scoring helpers for LoRA metadata.
- **Change**: Added JSON-backed metadata filter configuration, backend normalization/scoring utilities with automated tests, updated deployment checklist progress, and refreshed the README highlights.

## 032 – NSFW plan compliance clarifications
- **Type**: Normal Change
- **Reason**: Document reviewer feedback about prohibited datasets, queue pressure handling, and unused roadmap sections to keep the moderation plan accurate before development.
- **Change**: Removed the unused "Future Enhancements" roadmap, documented the BullMQ-based overload fallback, clarified the no-train policy for minor/bestiality CNNs, and outlined the new training source for the nude vs. swimwear model.

## 032 – [Fix] Resilient gallery metadata (commit TBD)
- **General**: Prevented gallery crashes when metadata is missing or incomplete.
- **Technical Changes**: Made metadata fields optional in types, guarded lightbox and card rendering with optional chaining, and documented the resilience improvement.
- **Data Changes**: None.

## 033 – [Change] NSFW deployment progress tracking
- **Type**: Normal Change
- **Reason**: Needed to translate the NSFW rollout blueprint into an actionable checklist with highlighted open questions before implementation begins.
- **Change**: Converted the NSFW deployment plan into status-aware checklists, tagged unresolved dependencies with explicit questions, and kept remaining tasks pending for future execution.

## 033 – [Addition] NSFW moderation deployment plan (commit TBD)
- **Type of Change**: Normal Change
- **Why**: Document the roadmap required to replace the legacy keyword-only NSFW filter with a multi-signal, self-hosted system.
- **What**: Added a deployment plan covering LoRA metadata screening heuristics, an OpenCV-based image analysis pipeline, admin fine-tuning controls, and linked the guide from the README.

## 034 – [Addition] Pose-aware NSFW heuristics
- **Type**: Normal Change
- **Reason**: Extend the in-progress NSFW rollout with torso-aware heuristics so limb-dominant uploads are escalated instead of silently passing automated checks.
- **Change**: Added silhouette-driven torso/hip analysis and limb-dominance review flags to `backend/src/lib/nsfw/imageAnalysis.ts`, introduced new thresholds in `config/nsfw-image-analysis.json`, expanded regression tests with synthetic limb fixtures, updated the deployment plan progress, and refreshed the README highlight for the analyzer.

## 034 – [Standard Change] Metadata tag search enhancement
- **Why**: Searching for models by their training tags returned no results because tag-frequency metadata only exposed counts and not the tag labels to the search index.
- **What**: Included tag-frequency labels from both `ss_tag_frequency` and `tag_frequency` metadata in the collected search strings, broadened helper detection to cover both structures, and refreshed the README highlight to mention the richer explorer search.

## 033 – [Fix] Windows bulk importer count guard (commit TBD)
- **Type**: Normal Change
- **Why**: The PowerShell helper intermittently crashed when PowerShell returned single objects without a `Count` property, producing confusing "property 'Count' cannot be found" errors during uploads.
- **What**: Added shared helpers that normalize enumerables into arrays and compute sizes safely, then refactored the Windows importer to rely on them for file, image, and batch processing.

## 033 – [Standard Change] Secure Windows bulk uploader redesign
- **Change Type**: Standard Change
- **Reason**: The previous Windows importer targeted a localhost-only API endpoint and skipped health verification, causing remote uploads to fail against VisionSuit deployments.
- **Updates**: Rebuilt `scripts/bulk_import_windows.ps1` around explicit VisionSuit URLs with service status probing, first-upload preview ordering, and resilient batch handling; refreshed README guidance to highlight the new configuration flow and health checks.

## 033 – [Normal Change] Windows importer duplicate guard
- **Change Type**: Normal Change
- **Reason**: Operators could accidentally re-upload already published LoRAs because the Windows bulk importer never compared local filenames to existing VisionSuit models.
- **Updates**: Queried `/api/assets/models` before uploads, skipped safetensors whose filenames match existing model titles, updated the Windows script logging, and refreshed the README to document the new duplicate protection.

## 033 – [Fix] Bulk upload verification hardening (commit TBD)
- **Change Type**: Normal Change
- **Reason**: Bulk uploads reported success even when models failed to appear in VisionSuit, so operators could not trust the automation.
- **Changes**: Added API-level verification to the Windows bulk import script, tightened response parsing, and updated the README with the new reliability behavior.

## 033 – [Update] Bulk import metadata alignment
- **Change Type**: Normal Change
- **Reason**: The refreshed upload flow introduced additional model, image, and collection fields, leaving the bulk scripts without a way to populate triggers, descriptions, visibility, and gallery targeting for new imports.
- **Changes**: Added metadata-aware defaults and JSON overrides to the Linux and Windows bulk upload scripts, surfaced warnings for invalid values, expanded parameter and environment controls, and refreshed the README to document the new workflow.

## 033 – [Fix] Automated Node.js provisioning (commit TBD)
- **Type**: Normal Change
- **Reason**: The installer aborted on fresh systems without Node.js even though the setup flow is expected to prepare every prerequisite automatically.
- **Changes**: Added an `ensure_node_and_npm` helper that provisions Node.js 18 LTS via NodeSource on Debian/Ubuntu or Homebrew on macOS, updated the README prerequisites, and confirmed npm availability before continuing.

## 033 – [Addition] Adult prompt keyword safety
- **General**: Introduced configurable prompt keywords so adult detection inspects metadata instead of relying on user-assigned tags.
- **Technical Changes**: Added the `AdultSafetyKeyword` Prisma model and migration, exposed keyword CRUD endpoints with updated backend detection logic, refreshed the admin safety panel UI plus API client and styles for keyword management, and documented the workflow in the README.
- **Data Changes**: Added the `AdultSafetyKeyword` table to persist managed prompt keywords.

## 033 – [Addition] Curator asset lifecycle tools
- **General**: Empowered curators and admins to fully manage models, collections, and images with safe deletion workflows and flexible gallery links.
- **Technical Changes**: Added a backend endpoint for linking models to galleries, refreshed the model explorer with irreversible delete confirmations and link management UI, expanded the gallery explorer with delete actions, updated shared styles, and extended the API client plus app state handlers.
- **Data Changes**: None; feature relies on existing Prisma models.

## 033 – [Addition] Ranking administration suite (commit TBD)
- **General**: Empowered administrators to tune ranking math, expand the ladder, and moderate curator visibility.
- **Technical Changes**: Added configurable ranking settings and tier management APIs, introduced user-specific ranking overrides, refreshed profile scoring with dynamic weights, and surfaced ranking blocks in the UI.
- **Data Changes**: Added Prisma models and migrations for ranking settings, tiers, and per-user overrides.

## 034 – [Addition] Home dashboard alignment (commit TBD)
- **General**: Brought the home view in line with the explorer layout for consistent discovery.
- **Technical Changes**: Implemented modular home cards, responsive two-section grid, tagged CTA buttons, explorer tag filtering, and README updates.
- **Data Changes**: None.

## 035 – [Update] English workflow plan
- **Change Type**: Normal Change
- **Reason**: The workflow documentation was only available in German, preventing non-German-speaking contributors from understanding the roadmap.
- **Changes**: Translated `docs/workflow-plan.md` into English while preserving the existing structure and intent.

## 035 – [Addition] Metadata extraction pipeline (commit TBD)
- **General**: Added automated metadata parsing for uploads to power richer search.
- **Technical Changes**: Built a backend metadata helper for PNG/JPEG/Safetensors, integrated results into upload processing and API payloads, wired frontend filters and admin dashboards to the new fields, and documented the automation.
- **Data Changes**: Persisted extracted metadata JSON on model/image assets and upload drafts.

## 036 – [Addition] Metadata dialog enhancements (commit TBD)
- **General**: Clarified safetensor metadata presentation and separated tag analysis.
- **Technical Changes**: Added recursive JSON detection for model aliases, filtered frequency stats, introduced a dedicated tag dialog, refined buttons/tables, and updated highlights.
- **Data Changes**: None.

## 037 – [Addition] UI streamline (commit TBD)
- **General**: Simplified dashboard chrome and clarified key call-to-actions.
- **Technical Changes**: Removed redundant header buttons, unified explorer labels, added role-aware gallery dropdown in the wizard with error messaging, and updated README notes.
- **Data Changes**: None.

## 038 – [Addition] Upload wizard translation (commit TBD)
- **General**: Completed the English-language UX for the upload wizard.
- **Technical Changes**: Translated all visible strings, added category mapping, refined copy in success/review states, ensured supporting components match, and noted the change in the README.
- **Data Changes**: None.

## 039 – [Fix] Storage route consolidation (commit TBD)
- **General**: Finalized Express storage routing compatible with Express 5 across GET and HEAD.
- **Technical Changes**: Migrated to `/:bucket/*`, shared handler logic, and explained the fix while awaiting final commit ID.
- **Data Changes**: None.


## 040 – [Addition] Streamlined installer (da2500c)
- **General**: Tuned the installer for production hosts with automatic IP detection.
- **Technical Changes**: Added smart IP/port prompts, synchronized `.env` files, injected MinIO defaults, and refreshed README installation guidance.
- **Data Changes**: None.

## 041 – [Fix] Storage wildcard fix (e59b9b2)
- **General**: Ensured storage endpoints load under Express 5 after wildcard parsing changes.
- **Technical Changes**: Adopted a named `:objectPath(*)` parameter, retained legacy fallback, and updated README endpoint documentation.
- **Data Changes**: None.

## 042 – [Addition] Avatar upload pipeline (commit TBD)
- **General**: Enabled secure on-platform avatar uploads with built-in validation and MinIO-backed delivery.
- **Technical Changes**: Added the `/api/users/:id/avatar` endpoint with strict MIME checks and size guards, updated auth user serialization, wired the React account settings dialog and API client for file uploads, and refreshed styles plus documentation.
- **Data Changes**: Stores uploaded avatars in the image bucket under user-specific prefixes; database schema unchanged.

## 043 – [Addition] Model version hierarchy controls (commit TBD)
- **General**: Enabled full lifecycle management of secondary model revisions directly from the admin console.
- **Technical Changes**: Added backend promotion and deletion endpoints, refined primary-version mapping to preserve chronology, exposed new API client helpers, and wired admin UI actions for promoting, renaming, and removing versions with refreshed README guidance.
- **Data Changes**: None.

## 044 – [Addition] Model card layout polish (commit TBD)
- **General**: Smoothed the model card experience by aligning primary actions and tightening the dataset tags table.
- **Technical Changes**: Converted the preview action stack to a full-width flex column, equalized button typography, and padded the tag frequency table with a fixed layout so headers and rows stay inside the dialog.
- **Data Changes**: None.

## 045 – [Addition] Trigger activator modelcards
- **General**: Added a dedicated Trigger/Activator field to modelcards with copy-to-clipboard handling during uploads and admin edits.
- **Technical Changes**: Extended the Prisma schema, API validation, upload wizard, admin panel, and explorer UI to capture and display trigger phrases while equalizing modelcard summary column sizing and styling the copy action.
- **Data Changes**: Introduced a nullable `trigger` column on `ModelAsset` records and seeded demo content with a default activator.

## 046 – [Addition] Storage object IDs (e78ced6)
- **General**: Moved storage downloads to stable object IDs resolved from the database.
- **Technical Changes**: Added the `StorageObject` table and migration, updated the proxy to look up metadata by ID, adjusted upload pipelines to create records, and refreshed README docs.
- **Data Changes**: Introduced `StorageObject` records referencing each stored asset.

## 047 – [Addition] Gallery upload wizard (ecb521e)
- **General**: Launched a gallery-specific upload wizard with backend support and documentation.
- **Technical Changes**: Added multi-image upload handling with validation, created gallery entries per file, linked explorer actions, adjusted toast handling, and updated README guidance.
- **Data Changes**: Persisted gallery draft assets and cover updates during uploads.

## 048 – [Addition] README refresh
- **General**: Modernized and translated the README into clear English.
- **Technical Changes**: Reorganized highlights, architecture overview, installation, workflow, upload pipeline, and troubleshooting content for clarity.
- **Data Changes**: None.

## 049 – [Addition] Product shell refresh (bb636b9)
- **General**: Updated the frontend shell with persistent navigation and service health indicators.
- **Technical Changes**: Added a permanent sidebar, surface status API `/api/meta/status`, refreshed home tiles, introduced a standalone image explorer, and aligned README docs.
- **Data Changes**: None.

## 050 – [Addition] Launch day polish (bcd8f72)
- **General**: Elevated the landing page into a production control panel with trust cues and CTAs.
- **Technical Changes**: Added sticky topbar, hero, trust metrics, CTA panels, wizard auto-refresh callbacks, extensive styling, README updates, and corrected prior changelog references.
- **Data Changes**: None.

## 051 – [Addition] Direct MinIO pipeline (pending)
- **General**: Connected uploads directly to MinIO with immediate asset availability.
- **Technical Changes**: Updated upload endpoints to stream to MinIO with checksums, created assets/galleries in one pass, exposed storage metadata in APIs, refreshed frontend cards/wizard messaging, and documented the flow.
- **Data Changes**: Assets and galleries now persist MinIO bucket/object names alongside existing metadata.

## 052 – [Addition] Community roadmap documentation
- **General**: Documented the planned community engagement features and surfaced the roadmap in public docs.
- **Technical Changes**: Added a dedicated community features plan detailing reactions, comments, follows, collections, and the supporting architecture; linked the plan from the README via a new Community Roadmap section.
- **Data Changes**: None; documentation-only update outlining future schema additions.

## 053 – [Addition] Historical changelog migration
- **General**: Consolidated all legacy changelog entries into the unified format and cleaned up redundant files.
- **Technical Changes**: Transcribed prior per-commit notes into the new changelog layout and removed superseded markdown entries.
- **Data Changes**: None.

## 054 – [Addition] Preview gallery quick actions
- **General**: Moved linked image collection access directly beneath the model preview with action-style buttons.
- **Technical Changes**: Updated the asset detail preview card to render gallery navigation buttons alongside downloads and refreshed the associated styling while removing the old section list.
- **Data Changes**: None.

## 055 – [Addition] Model card action polish (commit TBD)
- **General**: Tightened the model card actions by matching button styling and clarifying the surrounding tag and metadata layout.
- **Technical Changes**: Reduced preview action width stretching, unified the open-collection button palette with downloads, simplified its label, introduced a detail grid for tags versus metadata, and refreshed spacing utilities for both sections.
- **Data Changes**: None.

## 056 – [Addition] Model card layout restructure
- **General**: Rebuilt the model card layout into a two-column canvas with more breathing room and stabilized table alignment.
- **Technical Changes**: Introduced a responsive layout grid for summary and metadata panes, widened the dialog container, enforced fixed table layouts, and added flexible metadata scroll containers.
- **Data Changes**: None.

## 057 – [Addition] Model card width expansion
- **General**: Enlarged the model detail dialog so metadata columns remain readable on wide screens.
- **Technical Changes**: Adjusted the dialog container to span 80% of the viewport (capped at 1400px) and loosened the tablet breakpoint width to retain proportional spacing.
- **Data Changes**: None.

## 058 – [Addition] Model card metadata centering
- **General**: Realigned the model card so the metadata panel sits beneath the preview and regains breathing room.
- **Technical Changes**: Repositioned the metadata section inside the summary grid, removed the squeezing flex growth, and added styling to center the metadata card below the preview.
- **Data Changes**: None.

## 059 – [Addition] Model version management enhancements (commit TBD)
- **General**: Empowered curators and admins to rename model versions from the modelcard while giving the metadata section more breathing room.
- **Technical Changes**: Added `PUT /api/assets/models/:modelId/versions/:versionId`, expanded the frontend API client, introduced an edit dialog with permission checks, refined version chip labelling with edit controls, and stretched the metadata card styling.
- **Data Changes**: None; operates on existing model/version records without schema updates.

## 060 – [Fix] Asset explorer crash fix (commit TBD)
- **General**: Restored the model gallery so the Asset Explorer shows tiles instead of failing with a blank screen.
- **Technical Changes**: Reordered the `activeAsset` memo and its permission guard ahead of dependent effects to remove the temporal dead zone runtime error that crashed the component on load.
- **Data Changes**: None.

## 061 – [Addition] Gallery detail grid expansion (commit TBD)
- **General**: Extended the gallery detail view to surface six thumbnails per row on wide screens without distorting the layout.
- **Technical Changes**: Updated `.gallery-detail__grid` breakpoints and thumbnail sizing in `frontend/src/index.css` to provide a six-column base with responsive fallbacks and square previews.
- **Data Changes**: None; visual styling only.

## 062 – [Addition] Administration workspace restyle
- **General**: Modernized the admin console with a lighter visual rhythm and clearer hierarchy for moderation workflows.
- **Technical Changes**: Reworked administration CSS with glassmorphism cards, pill navigation, refined forms/tables, enhanced focus states, and refreshed README guidance.
- **Data Changes**: None.

## 063 – [Addition] Compact moderation grid (commit TBD)
- **General**: Reimagined the admin image moderation space as a dense grid with inline previews and quick actions to keep hundreds of thousands of assets scannable.
- **Technical Changes**: Introduced thumbnail resolution helpers, expandable edit sections, condensed metadata badges, subtle action buttons, and refreshed README guidance to describe the new workflow.
- **Data Changes**: None; presentation-only adjustments.

## 064 – [Addition] Moderation workflow foundation
- **General**: Introduced end-to-end asset moderation with member flagging, admin queue review, and audit overlays so sensitive content stays obscured for non-admins.
- **Technical Changes**: Expanded Prisma with moderation enums/logging, implemented flag, queue, approve, and remove endpoints, exposed moderation metadata on profiles, enhanced the React API client and explorers with blur overlays plus feedback messaging, and added a Moderation tab with queue actions and styles in the admin panel alongside updated README guidance.
- **Data Changes**: Added the `ModerationLog` model and new moderation status/flag columns on model and image assets, including relations to the user who flagged the content.

## 064 – [Fix] Admin search event pooling fix
- **General**: Restored admin panel filters so typing in search fields no longer crashes the interface.
- **Technical Changes**: Captured input and select values before enqueuing state updates throughout `AdminPanel.tsx` to avoid React's SyntheticEvent pooling from clearing `currentTarget`.
- **Data Changes**: None; UI state handling only.

## 065 – [Addition] Admin model grid parity (commit TBD)
- **General**: Brought the models administration view in line with the image moderation cards, including clear version lineage per asset.
- **Technical Changes**: Replaced the tabular model manager with card-based layouts, surfaced version metadata with storage links, added expansion controls, refreshed styling, and updated README guidance.
- **Data Changes**: None; presentation layer only.

## 066 – [Addition] Community plan feasibility documentation
- **General**: Captured the community roadmap feasibility assessment in dedicated documentation and linked it from the main README.
- **Technical Changes**: Added `docs/community-features-plan-analysis.md` mirroring the prior review tables and refreshed the README community roadmap section with a reference to the new analysis.
- **Data Changes**: None; documentation-only addition for planning purposes.
## 067 – [Addition] Severity-based community update plans
- **General**: Published severity-grouped content update roadmaps to steer community feature rollout communications.
- **Technical Changes**: Added dedicated plan documents for Projects Silverleaf, Ironquill, and Novashield plus updated the README to reference them.
- **Data Changes**: None; documentation-only planning assets.

## 068 – [Addition] Interactive home spotlights (commit TBD)
- **General**: Elevated the home dashboard with clickable previews that jump directly into the explorers.
- **Technical Changes**: Added media buttons on home tiles that focus the respective model or gallery, introduced gallery lookups for image cards, updated hover/focus styling, and refreshed README guidance.
- **Data Changes**: None.

## 069 – [Fix] Modelcard primary-first ordering
- **General**: Ensured modelcard version listings surface the primary release before sequential versions for quicker recognition.
- **Technical Changes**: Updated backend asset mapping to keep the primary version at the top while numerically ordering the remaining versions and retaining latest-version metadata via creation timestamps.
- **Data Changes**: None; response payload ordering only.

## 070 – [Addition] Dialog-driven user onboarding (pending)
- **General**: Reimagined account creation with preset-driven dialogs and clearer role guidance for administrators.
- **Technical Changes**: Added a multi-step `UserCreationDialog` with validation and password generation, introduced role summary popups, revamped the admin onboarding panel styling, extended status handling, and refreshed README highlights.
- **Data Changes**: None; interface and workflow updates only.

## 071 – [Addition] Client bulk import scripts
- **General**: Equipped curators with turnkey client importers so LoRA weights and previews can be staged locally and pushed to the VisionSuit server in bulk.
- **Technical Changes**: Added dedicated Linux/macOS and Windows scripts that validate matching preview folders, pick a random cover image, generate a manifest, and upload packages over SSH; refreshed the README with setup and execution guidance.
- **Data Changes**: None; tooling additions only.

## 072 – [Addition] API-driven bulk import helpers
- **General**: Reworked the client import tooling to authenticate against VisionSuit and upload LoRAs through the official pipeline instead of SSH transfers.
- **Technical Changes**: Replaced the staging/manifest workflow with direct `POST /api/uploads` calls in both scripts, added credential prompts and file-cap trimming, refreshed README guidance, and documented password handling.
- **Data Changes**: None; ingestion now flows through existing upload drafts and storage objects.

## 073 – [Fix] Frontend title alignment (commit TBD)
- **General**: Updated the browser tab title to reflect the VisionSuit brand instead of the Vite starter text.
- **Technical Changes**: Changed the HTML document title in `frontend/index.html` to "VisionSuit" for production readiness.
- **Data Changes**: None.
## 074 – [Addition] Sidebar service status refinement
- **General**: Elevated the service indicator deck with cohesive glassmorphism cards and contextual badges.
- **Technical Changes**: Reworked the sidebar status markup with service initials, introduced gradient icon styling and status-aware card accents, refreshed health pill visuals, and updated the README highlight to describe the polished cards.
- **Data Changes**: None; presentation-only updates for health indicators.

## 075 – [Addition] Sidebar status LED redesign (commit TBD)
- **General**: Replaced the sidebar service text badges with compact LED indicators that stay visible within the card layout.
- **Technical Changes**: Updated the service status header markup, introduced dedicated LED styling with accessibility helpers, and refreshed the README highlight to mention the beacons.
- **Data Changes**: None.

## 076 – [Addition] Curator edit controls (commit TBD)
- **General**: Enabled curators to edit their own models, galleries, and images directly from the explorers without requiring admin access.
- **Technical Changes**: Added role-aware edit dialogs for models, images, and collections, refreshed state management in the explorers, expanded styling for new action buttons, and updated README guidance.
- **Data Changes**: None; updates operate on existing records only.

## 077 – [Fix] Gallery explorer resilience (commit TBD)
- **General**: Restored the gallery explorer so collections with missing owners or entry arrays render instead of crashing to an empty panel.
- **Technical Changes**: Added defensive helpers for owner and entry access, updated filters/sorters to use the safe lookups, hardened the detail dialogs, and refreshed README guidance about handling incomplete payloads.
- **Data Changes**: None; safeguards run entirely on the client.

## 078 – [Fix] Gallery explorer initialization fix (commit TBD)
- **General**: Restored the gallery explorer lightbox so collections open without crashing.
- **Technical Changes**: Moved the active gallery memoization before dependent effects to prevent accessing uninitialized bindings.
- **Data Changes**: None.

## 079 – [Fix] Image edit dialog layering fix
- **General**: Ensured the image edit dialog surfaces above the lightbox when curators edit a single gallery image.
- **Technical Changes**: Raised the modal z-index styling in `frontend/src/index.css` so edit dialogs overlay the gallery image modal backdrop.
- **Data Changes**: None; styling adjustment only.

## 080 – [Addition] Image metadata layout compaction
- **General**: Shortened the image metadata edit experience by spreading controls into columns so the dialog stays within the viewport.
- **Technical Changes**: Widened the image edit dialog container and introduced a responsive three-column grid for metadata fields in `frontend/src/components/ImageAssetEditDialog.tsx` and `frontend/src/index.css`.
- **Data Changes**: None; purely presentational improvements to existing metadata inputs.

## 081 – [Addition] Curator profile spotlight
- **General**: Introduced curator profile pages with contribution stats, ranks, and full listings of each curator’s models and collections.
- **Technical Changes**: Added a public `/api/users/:id/profile` endpoint, new profile view state management, reusable curator link styling, `UserProfile` component, and expanded explorers/admin panels to open profiles.
- **Data Changes**: None; profile data is derived from existing users, models, galleries, and images.

## 082 – [Fix] Upload wizard asset type wiring fix
- **General**: Restored both model and gallery uploads by ensuring each wizard mode automatically supplies the correct asset type to the API.
- **Technical Changes**: Renamed the upload wizard form state to `assetType`, adjusted validations, review summaries, and submission payloads to use the field, and forwarded the computed type to `createUploadDraft` so the backend receives `lora` or `image` as expected.
- **Data Changes**: None; fixes adjust client-side form wiring only.

## 083 – [Fix] Primary view initialization guard
- **General**: Fixed the blank screen on startup by ensuring the primary view navigation helper initializes before any effects run.
- **Technical Changes**: Moved the `openPrimaryView` callback above dependent effects in `frontend/src/App.tsx` so React doesn’t hit the temporal dead zone when guarding the admin view.
- **Data Changes**: None; state management only.

## 084 – [Addition] Self-service account settings
- **General**: Empowered curators to manage their own profile details and passwords directly from the console sidebar.
- **Technical Changes**: Added authenticated profile/password routes, new API helpers, an account settings modal with validation, refreshed sidebar styling, and updated README guidance.
- **Data Changes**: None; updates operate on existing user records only.

## 085 – [Fix] Avatar relay hardening
- **General**: Ensured curator avatars remain visible regardless of MinIO hostname settings by proxying them through the API and removing the manual URL field from account settings.
- **Technical Changes**: Added a `/api/users/:id/avatar` stream endpoint, centralized avatar URL resolution with request-aware helpers, updated user serializers to emit proxied links, refreshed the React profile view to normalize avatar sources, and simplified the account settings dialog plus docs.
- **Data Changes**: None; avatars continue to upload into the existing image bucket with unchanged storage paths.

## 086 – [Addition] Admin ranking controls UI
- **General**: Introduced a ranking administration tab so operators can adjust scoring weights, manage tiers, and moderate individual curators from one place.
- **Technical Changes**: Extended the frontend API client with ranking helpers, wired App state to load settings and tiers, built ranking forms with validation/status feedback in the admin panel, and refreshed the README to highlight the feature.
- **Data Changes**: None; interfaces call existing ranking endpoints without schema updates.

## 087 – [Fix] Ranking administration guardrails
- **General**: Restored the ranking admin workspace so weights, tiers, and curator actions work reliably for administrators.
- **Technical Changes**: Required authenticated admin access for `/api/rankings` endpoints, buffered ranking input handlers against React event reuse, and refreshed README guidance around the responsive admin panel.
- **Data Changes**: None.

## 088 – [Addition] Model management mainframe
- **General**: Simplified the admin model overview to focus on previews and names while moving detailed editing into the mainframe workspace.
- **Technical Changes**: Reworked the `AdminPanel` model tab to highlight grid cards with a Manage action, introduced a dedicated mainframe form/versions layout, refreshed selection handling, and updated styling to support the new structure.
- **Data Changes**: None; presentation and client-side workflow updates only.

## 089 – [Addition] Private visibility with curator audits
- **General**: Locked down private models, images, and collections so they’re only visible to their owners, while giving administrators an explicit Audit switch on curator profiles to moderate hidden uploads on demand.
- **Technical Changes**: Added optional auth middleware, Prisma `isPublic` flags for models and images, request-level filtering across asset and gallery endpoints, profile visibility signalling, audit-aware gallery serialization, and refreshed the React profile view with an Audit control, privacy notices, and private badges.
- **Data Changes**: Introduced a Prisma migration that persists the new `isPublic` columns for `ModelAsset` and `ImageAsset` records.

## 090 – [Fix] Model version migration guard
- **General**: Unblocked local migrations by ensuring the new model version table setup skips recreating already-provisioned structures.
- **Technical Changes**: Updated the `add_asset_visibility` Prisma migration to conditionally create the `ModelVersion` table and associated indexes when they are missing.
- **Data Changes**: None; existing `ModelVersion` rows remain untouched.

## 091 – [Fix] Admin visibility restoration
- **General**: Restored comprehensive moderation access so administrators always see every model, gallery, and image without toggling audit mode in the workspace.
- **Technical Changes**: Let admin requests bypass `isPublic` filters across asset and gallery listings, ensured gallery serialization includes private entries for admins, and allowed admin profile views to include private uploads while leaving audit mode behavior intact.
- **Data Changes**: None; visibility rules operate on existing records only.

## 092 – [Fix] Curator deletion & linking hardening
- **General**: Finalized curator-facing deletion and gallery linking so model and collection maintenance works without admin support.
- **Technical Changes**: Regenerated the Prisma client, tightened gallery mapper typings, restored missing backend type imports, and verified linting for both backend and frontend workspaces.
- **Data Changes**: None; the feature operates on existing Prisma models.

## 093 – [Fix] Model explorer initialization guard
- **General**: Prevented the model explorer from crashing when opening the page by initializing gallery linking state safely.
- **Technical Changes**: Reordered the gallery memoization and effect in `frontend/src/components/AssetExplorer.tsx` so React never references `linkableGalleries` before it is computed.
- **Data Changes**: None; client-side state management only.

## 094 – [Addition] Collection cover picker
- **General**: Replaced the manual cover URL input with dedicated actions to upload a new image or pick one from the collection itself.
- **Technical Changes**: Added a gallery cover upload endpoint with image validation and storage cleanup, refreshed the gallery editor UI with preview/status handling, selection grid styling, and API wiring for immediate updates, and exposed a client helper for the new upload call.
- **Data Changes**: None; cover selections reuse existing gallery/image records.

## 095 – [Addition] Vite host allow list helper (commit TBD)
- **General**: Simplified approving external domains for the front-end dev server.
- **Technical Changes**: Added a Node helper to append domains to `frontend/allowed-hosts.json`, taught `vite.config.ts` to load the allow list, and documented the workflow in the README.
- **Data Changes**: None; stores hostnames in a tracked configuration file only.

## 096 – [Fix] Neutralize Vite host documentation
- **General**: Replaced references to a private domain with a neutral example so operators can copy commands safely.
- **Technical Changes**: Updated the README usage sample for the allowed-host helper and refreshed the default `frontend/allowed-hosts.json` entry to use `example.com`.
- **Data Changes**: Adjusted the tracked allow-list file to contain only the placeholder `example.com`.

## 097 – [Addition] Frontend-origin routing control
- **General**: Enabled external access through the frontend without exposing backend or MinIO internals.
- **Technical Changes**: Added same-origin API routing tokens, automatic Vite proxying with `DEV_API_PROXY_TARGET`, installer support for the proxy target, and refreshed README guidance for reverse proxy deployments.
- **Data Changes**: None; configuration and documentation updates only.

## 098 – [Fix] Avatar public URL rewrite
- **General**: Ensured curator avatars load on public domains by rewriting leftover MinIO links to flow through the API proxy.
- **Technical Changes**: Taught the storage resolver to map HTTP MinIO URLs back to bucket/object pairs so avatar serialization always emits `/api/users/:id/avatar`, and refreshed the README highlight around the hardened avatar delivery.
- **Data Changes**: None; existing avatar records are reinterpreted at runtime without touching persisted values.

## 099 – [Fix] Avatar loopback rewrite (commit TBD)
- **General**: Ensured curator avatars never leak loopback URLs when profiles are loaded externally.
- **Technical Changes**: Taught the avatar resolver to reroute any localhost or 127.0.0.0/8 links through the configured API base so the frontend serves same-origin assets.
- **Data Changes**: None.

## 033 – [Addition] On-site generator planning
- **General**: Documented the ComfyUI-based on-site image generator concept with architecture, workflow pipeline, and rollout phases, and linked the plan in the README roadmap.
- **Technical Changes**: Added `docs/on-site-image-generator-plan.md` detailing service topology, pipeline stages, storage strategy, and operational guidance; updated README to reference the new plan.
- **Data Changes**: None; planning documentation only.

## 100 – [Addition] Generator queue & credit planning refresh
- **General**: Expanded the on-site generator roadmap with detailed queue management and virtual credit policies.
- **Technical Changes**: Documented Redis-backed queue operations, prioritization tiers, credit-aware submissions, ledger schema considerations, and monitoring/operational responses.
- **Data Changes**: None; outlined prospective metadata and credit ledger fields only.

## 101 – [Addition] Member likes rollout
- **General**: Enabled the USER member role with public registration, single-tap image likes, and updated guest restrictions across the platform.
- **Technical Changes**: Added a shared gallery include builder with like hydration, enforced auth on download/like routes, refreshed the gallery explorer UI for accessible inline like controls, updated admin role summaries, and wired the API client plus profile views to surface total like counts.
- **Data Changes**: Introduced the `ImageLike` table with composite keys and defaulted new accounts to the USER role via Prisma migration.

## 102 – [Fix] Public storage access restoration
- **General**: Restored public asset previews and downloads after the storage proxy started rejecting guest traffic.
- **Technical Changes**: Replaced the blanket auth guard on `/api/storage` with role-aware access checks that map objects back to their owning models, images, galleries, or avatars, and refreshed README guidance about guest downloads.
- **Data Changes**: None; access rules only.

## 103 – [Addition] Admin private preview access
- **General**: Let administrators review private images inline without downloading files manually.
- **Technical Changes**: Accepted access tokens supplied via query parameters in the storage proxy middleware and taught the front-end storage resolver to append the persisted auth token so `<img>` requests authenticate transparently.
- **Data Changes**: None; authentication flow only.

## 104 – [Addition] Intelligent preview cache tokens (commit TBD)
- **General**: Sped up gallery and model browsing by keeping recent imagery hot in the browser while still refreshing instantly when assets change.
- **Technical Changes**: Added cache-aware storage resolvers that append short-lived tokens based on `updatedAt` timestamps, updated all preview consumers to use the smarter resolver, and documented the behavior in the README.
- **Data Changes**: None; cache keys derive from existing metadata.

## 105 – [Addition] Role-gated model downloads
- **General**: Hid the model download button from guests so only signed-in members can fetch safetensors.
- **Technical Changes**: Updated the asset explorer to require USER-or-higher roles before rendering the download link and added README guidance about the new requirement.
- **Data Changes**: None.

## 106 – [Addition] Comment threads for models & gallery images
- **General**: Opened persistent discussions on modelcards and gallery imagery with inline like toggles for every response.
- **Technical Changes**: Added Prisma tables for model/image comments plus likes, exposed REST endpoints for loading, posting, and reacting to comments, wired new API helpers, built a reusable CommentSection component with anchors in both explorers, and refreshed styling plus README highlights for the quick comment links.
- **Data Changes**: Introduced the `ModelComment`, `ModelCommentLike`, `ImageComment`, and `ImageCommentLike` tables via Prisma migration.

## 107 – [Addition] Gallery comment visibility controls
- **General**: Prioritized the enlarged image view by relocating gallery comments into a collapsible side panel.
- **Technical Changes**: Embedded the comment section inside the metadata column, added a show/hide toggle with smooth focus handling, adjusted modal layout measurements, and refined styles so the side rail scrolls independently without obscuring the media.
- **Data Changes**: None; UI-only adjustments.

## 108 – [Addition] Support channel and credits
- **General**: Added community support details and proper project attribution.
- **Technical Changes**: Introduced a global footer in the frontend with Discord support and MythosMachina/AsaTyr credits, and refreshed the README with matching links.
- **Data Changes**: None.

## 109 – [Addition] GPU worker bootstrap
- **General**: Added a dedicated installer to provision ComfyUI GPU workers with MinIO connectivity.
- **Technical Changes**: Introduced `gpuworker/install.sh`, MinIO helper scripts for model manifests, LoRA sync, and output uploads, plus documentation updates in the main README and a focused GPU worker guide.
- **Data Changes**: None; scripts interact with runtime storage only.

## 110 – [Addition] GPU worker MinIO endpoint prompt (pending)
- **General**: Streamlined GPU worker setup by capturing the target MinIO endpoint during installation.
- **Technical Changes**: Added an interactive prompt to `gpuworker/install.sh` that records the endpoint and secure-mode flag inside `/etc/comfyui/minio.env`, refreshed the worker README, and updated the project README instructions.
- **Data Changes**: None; only environment templates are updated.

## 111 – [Addition] GPU worker driver automation
- **General**: Equipped the GPU worker installer with intelligent GPU detection and automated driver/runtime setup for NVIDIA and AMD hosts.
- **Technical Changes**: Added vendor detection with lspci/nvidia-smi/ROCm tools, provisioned CUDA or ROCm repositories, adjusted PyTorch index selection, expanded base dependencies, and refreshed GPU worker documentation plus the project README.
- **Data Changes**: None.

## 112 – [Fix] GPU worker AWS CLI fallback (commit TBD)
- **General**: Unblocked the GPU worker installer on distributions that no longer ship `awscli` via APT.
- **Technical Changes**: Added an `ensure_aws_cli` helper that installs the official AWS CLI v2 bundle when necessary and refreshed the README to explain the behavior.
- **Data Changes**: None.

## 113 – [Addition] GPU worker MinIO test harness (commit TBD)
- **General**: Added standalone scripts so GPU render nodes can validate MinIO storage without the full VisionSuit stack.
- **Technical Changes**: Shipped bucket provisioning, checkpoint/LoRA upload, and output download helpers plus README instructions for their usage.
- **Data Changes**: Scripts can create MinIO buckets and upload test assets during validation runs.

## 114 – [Addition] ComfyUI workflow CLI validation
- **General**: Added a non-interactive workflow runner so operators can validate renders without the ComfyUI web UI.
- **Technical Changes**: Introduced `gpuworker/scripts/test-run-workflow.sh` to source MinIO credentials, post workflows to `/prompt`, poll queue/history endpoints, report asset identifiers, and optionally call `test-export-outputs`.
- **Data Changes**: Reads existing MinIO environment variables and touches only ComfyUI’s HTTP API plus optional MinIO downloads; no repository data is persisted.

## 114 – [Addition] SDXL workflow validation pack (Testing only)
- **General**: Delivered an automation-focused SDXL validation workflow that pairs with the ComfyUI API runner for hands-free checks.
- **Technical Changes**: Added `gpuworker/workflows/validation.json` capturing the calicomixPonyXL base plus DoomGirl LoRA pipeline and updated the GPU worker README with usage guidance and paths.
- **Data Changes**: New workflow JSON references the `calicomixPonyXL_v20.safetensors` checkpoint and `DoomGirl.safetensors` adapter for validation renders.


## 115 – [Fix] ComfyUI workflow polling hardening
- **General**: Prevented the GPU workflow validator from spamming jq errors when the ComfyUI API emits non-JSON responses during queue polling.
- **Technical Changes**: Added a reusable `jq_safe` helper that type-checks queue and history payloads before parsing, guarded every jq lookup, and refreshed the GPU worker plus root README sections to note the resilience.
- **Data Changes**: None; the scripts only inspect HTTP responses and print metadata.

## 116 – [Fix] ComfyUI API-format validation workflow
- **General**: Fixed GPU workflow validation runs that previously failed on ComfyUI by supplying an API-format prompt.
- **Technical Changes**: Replaced `gpuworker/workflows/validation.json` with a direct ComfyUI prompt map and updated both READMEs to stress exporting workflows via **Save (API Format)** before posting them with `test-run-workflow.sh`.
- **Data Changes**: Workflow JSON now stores node parameters in API layout while still referencing the `calicomixPonyXL_v20.safetensors` checkpoint and `DoomGirl.safetensors` LoRA.

## 117 – [Addition] GPU worker checkpoint sync helper
- **General**: Equipped GPU render nodes with a direct command to mirror required checkpoints ahead of validation runs.
- **Technical Changes**: Added a MinIO-backed `sync-checkpoints` utility, registered it with the installer, pre-created the checkpoints directory, and expanded the workflow tester to surface missing assets with actionable guidance.
- **Data Changes**: Refreshed the primary README and GPU worker guide to document the new helper and the need to sync checkpoints alongside LoRAs.

## 118 – [Fix] ComfyUI asset path alignment
- **General**: Ensured GPU workers drop synchronized assets where ComfyUI actually loads them.
- **Technical Changes**: Pointed the installer and MinIO helper scripts at `/opt/comfyui/models` and `/opt/comfyui/output`, refreshed documentation, and kept legacy overrides intact through environment variables.
- **Data Changes**: None; directories only change location defaults.

## 119 – [Addition] ComfyUI rollback utility
- **General**: Added a targeted rollback path so GPU worker tests can return a host to its pre-install ComfyUI state instantly.
- **Technical Changes**: Introduced `gpuworker/rollback-comfy.sh` to stop the service, remove the checkout, helper binaries, MinIO env file, and dedicated user/group, while updating both READMEs with usage guidance.
- **Data Changes**: None; the rollback only deletes generated runtime artifacts.

## 120 – [Fix] Windows metadata accessor guard (commit TBD)
- **Change Type**: Normal Change
- **Reason**: The Windows bulk import script crashed while processing metadata JSON because dictionary-based overrides do not expose a `title` property.
- **Changes**: Added a metadata accessor helper that supports dictionaries and `PSCustomObject` instances and updated `Build-UploadProfile` to use it for every override lookup.

## 120 – [Addition] On-Site Generator access controls & wizard
- **General**: Introduced a VisionSuit-native On-Site Generator view with a guided prompt builder, LoRA mixer, and per-user request history alongside an admin toggle that controls who can see the feature.
- **Technical Changes**: Added generator settings/request tables and routes to the backend, wired new API helpers, created the React wizard plus admin configuration tab, and expanded global styling for the generator UI.
- **Data Changes**: New Prisma models store generator visibility and submitted requests; migrations update the SQLite schema accordingly.

## 121 – [Fix] On-Site generator base-model bucket filter
- **General**: Corrected the generator's base-model picker so it mirrors the ComfyUI checkpoints stored in MinIO.
- **Technical Changes**: Added a configurable `VITE_GENERATOR_BASE_MODEL_BUCKET` defaulting to `comfyui-models`, prioritized bucket matching over heuristic tag guesses in the wizard, and updated documentation plus `.env` templates.
- **Data Changes**: None; the change only touches configuration defaults and client-side filtering.

## 122 – [Addition] Generator base picker & trigger helper
- **General**: Clarified the On-Site Generator by limiting the base-model list to real ComfyUI checkpoints and surfacing clickable trigger hints from the selected LoRAs inside the prompt step.
- **Technical Changes**: Hardened base-model detection against LoRA heuristics, added a non-LoRA fallback when no bucket match exists, extracted trigger phrases from model metadata, wired a click-to-insert handler on the prompt step, refreshed the generator styles, and updated the README highlight.
- **Data Changes**: None; UI-only improvements leveraging existing model metadata.

## 123 – [Addition] Generator MinIO-backed base-model feed
- **General**: Ensured the On-Site Generator surfaces only real ComfyUI checkpoints by reading the dedicated MinIO bucket instead of relying on heuristics that exposed LoRA assets.
- **Technical Changes**: Added a backend `/api/generator/base-models` endpoint driven by the new `GENERATOR_BASE_MODEL_BUCKET` config, refactored mapping utilities for reuse, fetched and rendered the base-model list on the client with loading/error states, updated styles, and refreshed documentation plus env templates.
- **Data Changes**: None; changes are configuration-driven with no schema updates.

## 124 – [Addition] Generator checkpoint sync helper
- **General**: Diagnosed missing base models in the On-Site Generator and added a synchronization path so MinIO checkpoints appear in the picker once they land in the bucket.
- **Technical Changes**: Introduced `backend/scripts/syncGeneratorBaseModels.ts` with a matching `npm run generator:sync-base-models` alias to upsert public checkpoint assets, ensure ownership, and flag metadata for the generator pipeline.
- **Data Changes**: None; the helper only registers existing MinIO objects without altering stored checkpoint files.

## 125 – [Addition] Generator manifest-backed base model feed
- **General**: Allowed the On-Site Generator to surface base models even when MinIO access is limited to manifest reads instead of bucket listings.
- **Technical Changes**: Added manifest parsing and normalization inside `/api/generator/base-models`, introduced the configurable `GENERATOR_BASE_MODEL_MANIFEST` default, refreshed `.env` templates, and documented the workflow in the README.
- **Data Changes**: None; updates touch configuration defaults and documentation only.

## 126 – [Addition] Generator base-model auto-sync
- **General**: Ensured On-Site Generator base checkpoints appear immediately by syncing the database from the ComfyUI bucket on demand.
- **Technical Changes**: Added reusable generator base-model sync helpers, wired the `/api/generator/base-models` route to auto-register checkpoints using manifest sizes, refreshed the CLI sync script, and documented the behavior in the README.
- **Data Changes**: No schema updates; existing base-model metadata is normalized when the sync runs.

## 127 – [Addition] On-Site generator base model curation
- **General**: Empowered administrators to curate the generator’s base-model list directly from the dashboard so members see only vetted checkpoints.
- **Technical Changes**: Extended Prisma generator settings with a JSON base-model collection, updated the settings and base-model routes to serve the curated definitions, refreshed the admin generator form with add/remove controls, and taught the On-Site Generator to consume the new payload with inline availability warnings.
- **Data Changes**: `GeneratorSettings` now persists the configured base models as structured JSON entries, enabling future edits without additional tables.

## 128 – [Fix] Generator settings recovery
- **General**: Stopped the admin generator settings view from crashing when legacy rows contain invalid JSON.
- **Technical Changes**: Added a sanitization fallback for generator settings, retrying reads after normalizing bad `baseModels` payloads.
- **Data Changes**: Automatically rewrites malformed generator `baseModels` entries to an empty array when encountered.

## 129 – [Fix] Generator base-model JSON parsing
- **General**: Restored the On-Site Generator base-model list so curated admin entries surface for users again.
- **Technical Changes**: Normalized generator settings reads to decode string and buffer payloads before schema validation, keeping alignment with the stored database format and logging parse failures for diagnostics.
- **Data Changes**: None; existing generator settings rows are read without mutation.

## 130 – [Addition] Generator base-model catalog hydration
- **General**: Taught the On-Site Generator to populate its Step 1 picker with the real base models stored in the database so curators always select live checkpoints.
- **Technical Changes**: Added a `/api/generator/base-models/catalog` route that returns hydrated `ModelAsset` records, refreshed the generator client to merge curated settings with the catalog, updated selection labels and previews to rely on database titles, introduced catalog loading states, and exposed the new helper through the API module.
- **Data Changes**: None; the change reads existing generator assets without modifying stored rows.

## 131 – [Addition] Generator preset label passthrough
- **General**: Ensured the On-Site Generator surfaces the exact base-model names curated in Administration → Generator so admins control the dropdown wording members see.
- **Technical Changes**: Updated the generator wizard to render curated labels in the picker, review step, and preview pane while still surfacing catalog metadata for verification, and refreshed the README highlight to reflect the mirrored naming behavior.
- **Data Changes**: None; existing generator settings and assets are read without mutation.

## 132 – [Addition] Admin asset console densification
- **General**: Reimagined Administration → Models and Images with compact tables, quick filters, and drawer-style details that stay responsive even with massive asset libraries.
- **Technical Changes**: Replaced the legacy card grid with density-toggleable collections, added visibility/metadata chips, wired dialog-driven model and image editing, connected version upload/rename flows, and introduced a new styling system to support the streamlined layout.
- **Data Changes**: None; the overhaul only touches front-end presentation and API interactions.

## 133 – [Addition] Admin asset editor tab workflows
- **General**: Streamlined model and image editing inside the admin console with tabbed dialogs, quick owner reassignment, and contextual sidebars that keep critical metadata in view.
- **Technical Changes**: Reworked the `ModelAssetEditDialog` and `ImageAssetEditDialog` components with accessible tab navigation, owner selection, and summary rails, updated the admin panel to pass curator options, and introduced supporting styles for the new layout.
- **Data Changes**: None; edits only modify front-end workflows and reuse existing API endpoints.

## 134 – [Fix] Admin asset overview cleanup
- **General**: Restored a clean Administration → Models & Images overview with focused cards, dedicated detail pages, and the long-missing visibility controls.
- **Technical Changes**: Replaced the density toggles with thumbnail grids, added modal preview support, introduced model/image detail layouts, wired visibility toggles via the API payloads, refreshed admin styling, and updated the README to match the streamlined flow.
- **Data Changes**: None; the change only touches front-end rendering and existing endpoints.

## 135 – [Fix] Administration dialog and filter polish
- **General**: Improved the admin workspace by widening the model edit dialog and replacing the image metadata chips with a model-focused picker.
- **Technical Changes**: Added an XL layout modifier to the model edit dialog, wired the component to use the larger width, introduced a metadata-derived model datalist with filtering logic, updated image filter state management, and refreshed documentation to describe the new picker.
- **Data Changes**: None.

## 136 – [Fix] Model edit dialog layout tuning
- **General**: Sharpened the Administration → Model edit dialog so the expanded layout matches the surrounding workspace.
- **Technical Changes**: Limited extra-large edit dialogs to half-width with responsive bounds and centered the tab list for clearer navigation.
- **Data Changes**: None.

## 137 – [Fix] Model edit dialog ownership fallback
- **General**: Prevented the model edit dialog from crashing when opened via the explorer by guaranteeing owner options are always available.
- **Technical Changes**: Made the dialog tolerate missing owner lists by defaulting to an empty array and wired the asset explorer to pass its curated owner options into the component.
- **Data Changes**: None.

## 138 – [Addition] Moderation workflow and admin queue
- **General**: Introduced end-to-end moderation so members can flag problematic models or renders while administrators triage them without disrupting the main library.
- **Technical Changes**: Added moderation enums, status fields, and logs to the Prisma schema with new backend routes for flagging, approving, and removing assets; extended mappers and user profile responses; wired frontend explorers, home tiles, and the new Administration → Moderation tab with blur overlays, queue actions, and API helpers; and layered supporting CSS for audit indicators.
- **Data Changes**: Prisma migration adds moderation status metadata to model/image assets and a `ModerationLog` table for future notification history.

## 139 – [Fix] Moderation visibility adjustments
- **General**: Tightened moderation UX so flagged models and renders vanish for the community while creators receive a clear “In Audit” placeholder entry.
- **Technical Changes**: Filtered flagged assets in public listings for non-admins, added shared moderation helpers, rendered audit placeholders across the home tiles, explorers, gallery detail views, and curator profiles, and refreshed README guidance.
- **Data Changes**: None; visibility logic only.

## 140 – [Addition] Moderation tiles and collection safeguards
- **General**: Reimagined the Administration → Moderation queue with tile-based cards and an expanded review dialog that surfaces reporters, reasons, and report counts while automatically hiding linked collections during investigations.
- **Technical Changes**: Added Prisma-backed model/image moderation report tables, updated flag endpoints to record every report, refreshed the moderation queue API payloads, rebuilt the admin queue UI with card grids and a decision modal that enforces typed rejection notes, and extended styling for the new layout.
- **Data Changes**: Introduced `ModelModerationReport` and `ImageModerationReport` tables and ensured flagged models temporarily hide their collections while revoked models fully delete associated collections.

## 141 – [Addition] Moderation queue comfort refinements
- **General**: Softened the moderation workspace with a cozy tile grid that highlights who reported an asset, why it was flagged, and how often, while surfacing a clear hold notice on collections affected by moderation.
- **Technical Changes**: Summarized moderation reports into reporter/reason chips inside the admin queue and detail dialog, refreshed the tile styling, enforced rejection reasons server-side, exposed `isUnderModeration` from the gallery mapper, and added a gallery detail notice so curators know why a collection is hidden.

## 142 – [Fix] Windows bulk import parameter order
- **General**: Resolved the Windows bulk import helper startup by promoting connection settings to script parameters.
- **Technical Changes**: Converted server connection variables into the script-level `param` block so it loads before any assignments and continues defaulting directories and credentials.
- **Data Changes**: None.

## 141 – [Fix] Windows bulk importer resiliency
- **General**: Ensured the Windows bulk upload helper works on legacy shells and locates image previews stored alongside each LoRA.
- **Technical Changes**: Added a `System.Net.Http` assembly bootstrap for Windows PowerShell 5.1, resolved absolute paths for the source folders, introduced sibling image folder discovery, tightened image filtering, and guarded disposable cleanup.
- **Data Changes**: None.

## 143 – [Fix] Moderation reports schema wiring
- **General**: Restored the moderation queue so admins can review flagged assets without API errors.
- **Technical Changes**: Added moderation report mappers, regenerated the Prisma client, and taught the API to return reporter summaries for flagged models.
- **Data Changes**: Introduced `ModelModerationReport` and `ImageModerationReport` tables with cascading foreign keys.

## 144 – [Addition] Dual-phase bulk import hardening
- **General**: Elevated the Linux and Windows bulk import helpers with an admin-only, two-pass workflow that uploads LoRA weights with a random preview before streaming every gallery render in follow-up batches.
- **Technical Changes**: Split the scripts into model and gallery upload stages, enforced administrator role detection, chunked gallery uploads to bypass the per-request file limit, and refreshed the README with the updated flow and requirements.
- **Data Changes**: None.

## 14.5 – [Addition] MyLora migration helper
- **General**: Added a turnkey script to migrate LoRA archives from MyLora into VisionSuit without touching databases by hand.
- **Technical Changes**: Introduced `scripts/migrate_mylora_to_visionsuit.py` with session-based MyLora scraping, VisionSuit upload orchestration, duplicate detection, and preview harvesting plus README guidance for dependency setup.
- **Data Changes**: None; the tool reads from MyLora and writes through existing VisionSuit APIs.

## 145 – [Fix] Moderation dialog initialization guard
- **General**: Prevented the Administration → Moderation dialog from crashing when opening a flagged asset for review.
- **Technical Changes**: Hoisted the moderation action matcher into a memoized callback so busy-state checks run after initialization instead of reading an uninitialized const.
- **Data Changes**: None; runtime state handling only.

## 146 – [Addition] Adult safety controls polish
- **General**: Finalized the NSFW governance experience with a focused admin Safety tab and clear badges when adult assets surface for opted-in viewers.
- **Technical Changes**: Suppressed duplicate status banners on the Safety tab, reset adult-tag errors when navigating away, refreshed the home tiles and explorer cards with adult badges gated by the viewer preference, and updated styling plus documentation to explain the workflow.
- **Data Changes**: None; UI and messaging updates only.


## 147 – [Fix] Comprehensive adult-content enforcement
- **General**: Ensured NSFW governance reacts to admin keywords and preview prompts so adult assets are consistently flagged and hidden from guests.
- **Technical Changes**: Extended the adult detector to evaluate multiple metadata sources, captured LoRA preview EXIF data during uploads and versioning, recalculated model flags when versions are added or removed, refreshed keyword-driven batch recalculations, and documented the stricter behaviour in the README.
- **Data Changes**: Newly uploaded or versioned models now persist parsed preview metadata inside their version JSON; existing records are reevaluated without schema changes.

## 148 – [Addition] Administration settings and GPU health probes
- **General**: Added a Settings tab under Administration so operators can rename the site, toggle registration or maintenance mode, and update service endpoints while surfacing GPU worker status alongside other service beacons.
- **Technical Changes**: Introduced a backend settings service that reads and writes the frontend/backend `.env` files, exposed secured admin routes plus a public platform config endpoint, translated service status messaging, extended health checks with GPU node probing, wired new React state for platform config, rendered tabbed settings forms, refreshed service badges, and updated styling, README guidance, and API helpers accordingly.
- **Data Changes**: None.

## 033 – [Addition] VisionSuit GPU agent service
- **General**: Introduced a managed GPU agent package that executes VisionSuit dispatches on the ComfyUI node and reports results back to VisionSuit.
- **Technical Changes**: Added the FastAPI-based agent with workflow templating, MinIO sync, callback handling, installer, systemd unit, configuration sample, and refreshed documentation across the GPU worker and root README files.
- **Data Changes**: None; runtime configuration only.

## 034 – [Fix] GPU agent service import path
- **General**: Restored the freshly installed GPU agent so the systemd service boots without module import failures.
- **Technical Changes**: Switched the FastAPI entrypoint to absolute imports, updated the systemd unit to launch `uvicorn main:app`, and refreshed the README guidance for manual runs.
- **Data Changes**: None.

## 035 – [Addition] GPU agent integration bridge
- **General**: Wired VisionSuit's on-site generator to the GPU agent so dispatches share a consistent envelope and health probes target the new service.
- **Technical Changes**: Added a root health endpoint to the FastAPI agent, introduced a TypeScript agent client and dispatcher, updated generator routes to submit jobs and manage busy/error states, refreshed admin health checks, expanded configuration/env parsing for workflows and output buckets, and documented the handshake in the README.
- **Data Changes**: None.

## 036 – [Fix] GPU agent client fetch fallback
- **General**: Restored backend startups by removing the hard dependency on the external Undici package.
- **Technical Changes**: Replaced the generator agent client with a fetch-based helper that wraps network failures and dropped the Undici dependency from the backend package manifest.
- **Data Changes**: None.

## 037 – [Addition] Multi-base generator payloads
- **General**: Reworked the On-Site Generator to select multiple curated base models via a checkbox matrix so members can bundle several checkpoints with a single request.
- **Technical Changes**: Added a `baseModelSelections` JSON column plus migration, updated generator routes and dispatcher to persist and forward the full base-model roster, refreshed API typings, and rebuilt the wizard with a matrix UI, richer preview, review summaries, and history badges that surface every selected model.
- **Data Changes**: New Prisma migration adds the nullable `baseModelSelections` column to `GeneratorRequest` for storing the curated base-model bundle.

## 149 – [Fix] On-Site generator base-model checkboxes
- **General**: Restored the generator wizard’s base-model picker so curators can toggle curated checkpoints via an accessible checkbox matrix before dispatching jobs.
- **Technical Changes**: Replaced the button-based cards with labelled checkboxes, refreshed the styling to accommodate the new control layout, and noted the checkbox matrix in the README for up-to-date operator guidance.
- **Data Changes**: None.

## 150 – [Fix] Generator honors configured base models
- **General**: Ensured the On-Site Generator trusts administrator-defined base models even when no catalog asset exists, so GPU-resident checkpoints remain selectable without extra syncing.
- **Technical Changes**: Made generator requests tolerate missing `ModelAsset` links, derive storage paths from Administration → Generator settings, updated dispatch fallbacks, exposed the new availability in the API response, refreshed the React wizard to accept configuration-backed entries, and documented the behavior in the README.
- **Data Changes**: Added a Prisma migration that allows `GeneratorRequest.baseModelId` to be null while preserving existing records.

## 151 – [Fix] Generator base model guard (commit TBD)
- **General**: Stopped the On-Site Generator from crashing when a configured base model lacks catalog metadata.
- **Technical Changes**: Filtered base model asset identifiers before computing the LoRA exclusion set so null assets no longer trigger runtime errors.
- **Data Changes**: None.

## 152 – [Addition] Generator callback pipeline
- **General**: Enabled VisionSuit to receive live GPU agent status updates, capture generated artifacts, and surface finished renders directly in the On-Site Generator history.
- **Technical Changes**: Added configurable callback base URLs, new generator callback endpoints, Prisma-backed artifact persistence, refreshed mapper logic, and front-end history enhancements with artifact galleries and failure messaging.
- **Data Changes**: Introduced the `GeneratorArtifact` table and new `GeneratorRequest` columns for callback state (`errorReason`, `outputBucket`, `outputPrefix`).

## 153 – [Addition] Generator queue governance
- **General**: Delivered queue maintenance controls so administrators can pause/resume GPU dispatches, retry held jobs, and manage user-level generator access while curators see live queue telemetry.
- **Technical Changes**: Added Prisma-backed queue state and blocklist models with new REST endpoints, wired admin UI controls and generator wizard banners, refreshed API helpers and styles, and taught the GPU agent to stream ComfyUI queue activity in health probes and status callbacks.
- **Data Changes**: Added `GeneratorQueueState` and `GeneratorQueueBlock` tables plus a migration that persists queue snapshots and per-user generation blocks.

## 154 – [Fix] GPU agent reservation guard
- **General**: Restored GPU job acceptance by preventing idle agents from rejecting new dispatches with spurious conflicts.
- **Technical Changes**: Replaced the zero-time `asyncio.wait_for` lock acquisition with an immediate lock check and acquisition to avoid TimeoutErrors when the worker is idle.
- **Data Changes**: None.

## 155 – [Fix] LoRA filename restoration (commit TBD)
- **General**: Ensured GPU jobs load MinIO-hosted LoRAs by storing them under their dispatched filenames instead of opaque IDs.
- **Technical Changes**: Added filename lookup logic sourced from job extras, renamed legacy cached assets, removed stale UUID downloads, and documented the lifecycle update.
- **Data Changes**: None; filesystem layout only.

## 156 – [Addition] Queue clearing administration control (commit TBD)
- **General**: Empowered administrators to flush the active GPU queue directly from the Administration → Generator screen when dispatches need a clean slate.
- **Technical Changes**: Added a secured backend clear action that marks pending jobs as cancelled, folded cancellations into queue metrics, exposed the capability via the API client, surfaced a dedicated UI control with dynamic success messaging, and updated generator history to explain cleared requests.
- **Data Changes**: None; existing queue records are only reclassified when the action runs.

## 157 – [Fix] GPU agent reinstall reset (commit TBD)
- **General**: Guaranteed GPU agent upgrades start from a pristine environment by tearing down any prior service before reinstalling.
- **Technical Changes**: Extended the installer to stop and disable existing systemd units, purge `/opt/visionsuit-gpu-agent`, recreate fresh directories, drop stale unit files ahead of deployment, and documented the reset flow in the README.
- **Data Changes**: None; adjustments operate on runtime directories only.

## 158 – [Fix] Workflow auto-seeding guard
- **General**: Prevented generator dispatches from reaching the GPU agent without a ready Comfy workflow template.
- **Technical Changes**: Added backend checks that ensure the workflow bucket exists, upload the configured template from a local path or inline JSON when absent, and guard dispatches with descriptive errors alongside refreshed README guidance.
- **Data Changes**: None; MinIO contents are synchronized automatically when needed.

## 159 – [Fix] Bundled generator workflow bootstrap
- **General**: Eliminated missing-workflow dispatch failures by shipping a default ComfyUI graph and automatic MinIO seeding.
- **Technical Changes**: Added `backend/generator-workflows/default.json`, taught the backend to fall back to the bundled template and default parameter bindings, updated the GPU agent to mutate legacy node layouts, refreshed environment samples, and documented the workflow behavior in the README.
- **Data Changes**: Seeds `generator-workflows/default.json` into MinIO on demand; no database schema updates.

## 160 – [Fix] GPU agent permission automation (commit TBD)
- **General**: Eliminated permission errors on the GPU agent by provisioning access during installation.
- **Technical Changes**: Added configurable service user variables, templated the systemd unit, automatically applied ACLs to ComfyUI directories, and refreshed the GPU agent README with override guidance.
- **Data Changes**: None; filesystem ACL updates only.

## 161 – [Addition] Generator run termination controls (commit TBD)
- **General**: Equipped administrators with an active job monitor so they can cancel stuck GPU renders directly from the queue.
- **Technical Changes**: Added a guarded cancellation endpoint, taught generator callbacks to preserve admin cancellations, enabled status-filtered request queries, refreshed the API client with cancel helpers, and introduced an active job list with prompt summaries and styling in the admin panel.
- **Data Changes**: None.

## 161 – [Fix] GPU agent workflow isolation
- **General**: Prevented remote GPU workers from crashing when VisionSuit dispatched workflows with backend-only filesystem paths.
- **Technical Changes**: Added an opt-in `GENERATOR_WORKFLOW_EXPOSE_LOCAL_PATH` flag, defaulted dispatch envelopes to MinIO-hosted templates, and documented the new control in the README.
- **Data Changes**: None; configuration defaults only.

## 162 – [Addition] Generator failure telemetry and admin log
- **General**: Ensured stuck generator jobs now flip to error while giving administrators a dedicated log of GPU failure diagnostics.
- **Technical Changes**: Taught the GPU agent to emit error status callbacks with normalized reasons, tightened backend failure handling and masking for non-admins, exposed an `/api/generator/errors` endpoint plus admin UI log with refreshed styles, and extended the API client/types to surface detailed failure entries.
- **Data Changes**: None; leverages existing `GeneratorRequest` records.

## 163 – [Addition] GPU agent git-driven updater
- **General**: Added a maintenance script so operators can refresh deployed GPU agents directly from the repository clone.
- **Technical Changes**: Introduced `installer/update.sh` to pull the latest sources from the home-directory git checkout, resynchronise them into `/opt/visionsuit-gpu-agent`, upgrade the virtual environment dependencies, reapply service ownership, refresh the systemd unit, and restart the daemon. Documented the new workflow in the GPU agent README.
- **Data Changes**: None; updates only touch code and Python dependencies in the agent runtime.

## 164 – [Fix] GPU agent ComfyUI endpoint alignment
- **General**: Made the GPU agent mirror the working ComfyUI connection strategy from the CLI tester while letting VisionSuit callbacks target an operator-defined base URL.
- **Technical Changes**: Allowed the agent to derive its ComfyUI API URL from either a full endpoint or a scheme/host/port trio, normalised the HTTP client base path, documented the options in both READMEs and the sample config, and exposed `GENERATOR_CALLBACK_BASE_URL` in the backend environment template for failure callback routing.
- **Data Changes**: None; configuration surface only.

## 165 – [Fix] GPU agent callback base rewrite
- **General**: Ensured GPU-side failure reports can reach VisionSuit when the backend exposes callback endpoints on a non-local host.
- **Technical Changes**: Added an optional `callbacks.base_url` setting, taught the agent to rewrite relative callback targets against it, updated the sample configuration, and expanded both READMEs with deployment guidance.
- **Data Changes**: None; configuration schema extension only.


## 166 – [Fix] ComfyUI workflow format diagnostics
- **General**: Hardened GPU agent workflow submissions with upfront validation and clearer ComfyUI error messages so 400 responses highlight misformatted prompts instead of failing silently.
- **Technical Changes**: Added API-format checks that detect legacy editor exports, enforced required node fields, and surfaced ComfyUI response bodies when `/prompt` rejects a payload. Documented the export requirements in the README for operators.
- **Data Changes**: None; validation affects in-flight dispatch payloads only.

## 167 – [Fix] ComfyUI checkpoint payload normalization
- **General**: Ensured generator submissions reference ComfyUI checkpoints using the filename expected by the API.
- **Technical Changes**: Adjusted the GPU agent workflow context so `base_model_path` resolves to the checkpoint filename while exposing the absolute path separately for diagnostics.
- **Data Changes**: None.

## 168 – [Fix] GPU callback host override
- **General**: Restored generator completion updates when the GPU agent runs on a separate host by letting it retarget VisionSuit callbacks away from loopback addresses.
- **Technical Changes**: Hardened callback base URL derivation to skip empty public-domain hints, always bundled callback paths in dispatch envelopes, taught the agent to rewrite absolute URLs against `callbacks.base_url`, and refreshed the README guidance to highlight the override.
- **Data Changes**: None; configuration behavior only.

## 169 – [Addition] GPU agent asset validation and cancellation
- **General**: Hardened GPU job execution with strict ComfyUI asset name validation, friendlier LoRA/model naming, resumable callbacks, and a cooperative cancellation path that reports partial uploads without aborting the job.
- **Technical Changes**: Introduced pretty-name symlink management for checkpoints and LoRAs with metadata fallbacks, invalidated and refreshed ComfyUI asset caches before submission, enforced whitelist validation via `/object_info`, added retrying callbacks and cancellation tokens, derived dynamic timeouts, captured node errors in failure callbacks, exposed `POST /jobs/cancel`, updated upload metadata plus deterministic key naming, and refreshed the sample configuration and README to document the new knobs.
- **Data Changes**: Generator outputs now land under `comfy-outputs/{job_id}/{index}_{seed}.{ext}` with expanded object metadata (model, LoRAs, prompt, seed, steps).

## 170 – [Fix] GPU agent cancel request model scope
- **General**: Restored the GPU agent startup by providing FastAPI access to the cancellation payload schema.
- **Technical Changes**: Moved the `CancelRequest` Pydantic model to module scope so dependency resolution succeeds when registering `/jobs/cancel`.
- **Data Changes**: None.

## 171 – [Fix] GPU agent callback schema alignment
- **General**: Brought the GPU agent heartbeat, success, and failure callbacks in line with the generator control-plane schema so VisionSuit receives live progress, timing, and artifact metadata straight from ComfyUI runs.
- **Technical Changes**: Added runtime tracking for prompt IDs and heartbeat counters, mapped status events onto the new state machine, enriched success payloads with artifact manifests and generation parameters, normalized failure/cancel responses with reason codes and activity snapshots, and attached idempotency keys plus S3 URLs when uploading outputs.
- **Data Changes**: None; S3 object locations are unchanged while callbacks now carry additional descriptive fields.

## 172 – [Fix] GPU agent ComfyUI status normalization
- **General**: Prevented GPU renders from stalling after ComfyUI reported successful completions using `status_str` payloads.
- **Technical Changes**: Normalized ComfyUI history polling to read `status_str`, raw string values, and `completed` flags so `success`/`completed` runs exit promptly while `error` states still raise failures.
- **Data Changes**: None; status polling only interprets existing history metadata.

## 173 – [Addition] GPU agent callback route-back
- **General**: Enabled VisionSuit to accept the GPU agent's state-machine callbacks and bundled a helper to provision the MinIO buckets required for round-trip generations.
- **Technical Changes**: Extended the generator callback schemas to consume `job_id`/`state` payloads, mapped agent states onto VisionSuit statuses with queue activity persistence, normalised completion artifact manifests, reconciled failure reasons, and shipped `backend/scripts/setupGeneratorBuckets.ts` to auto-create model, workflow, and output buckets.
- **Data Changes**: None; existing generator request and artifact records now reuse the uploaded bucket/key pairs reported by the agent.

## 174 – [Fix] Generator artifact proxying
- **General**: Routed finished generator renders through the VisionSuit API so history thumbnails and downloads work under public domains.
- **Technical Changes**: Added `GET|HEAD /api/generator/requests/:id/artifacts/:artifactId`, streamed MinIO objects with auth-aware access checks, rewrote artifact URLs in the generator mapper, and documented the proxy in the README.
- **Data Changes**: None.

## 175 – [Fix] Serialized generator queue (commit TBD)
- **General**: Prevented concurrent GPU jobs from colliding by enforcing a single global dispatch slot while giving every member a personal queue dashboard and token-aware artifact links that open without manual authentication headers.
- **Technical Changes**: Added queue-state locking with `activeRequestId`/`lockedAt`, centralized dispatch in a serialized `processGeneratorQueue`, scoped queue stats per user with global metrics for admins, refreshed admin/frontend displays to respect the new payload shape, and appended access tokens to generator artifact URLs. The README now highlights the serialized queue and automatic proxy authorization.
- **Data Changes**: Introduced nullable `activeRequestId` and `lockedAt` columns on `GeneratorQueueState` to track the in-flight job and lock acquisition timestamp.

## 176 – [Addition] Generator admin layout segmentation
- **General**: Organized the generator administration console into focused sections so queue operations, error telemetry, and access controls stay easy to scan.
- **Technical Changes**: Added a segmented sub-navigation with dedicated queue, failure log, and access panels, reset the active sub-tab when leaving the generator view, refreshed copy, styled the new controls, and updated the README to explain the streamlined workflow.
- **Data Changes**: None.

## 177 – [Addition] Generator queue activity tabs (commit TBD)
- **General**: Kept the on-site generator focused on live work by separating active jobs from historical runs and trimming archived completions.
- **Technical Changes**: Added queue history sub-tabs with tablist semantics, filtered the data model so completed and failed entries cap at the ten most recent, refreshed the generator history styles to accommodate the new controls, and documented the UX in the README.
- **Data Changes**: None.

## 178 – [Fix] On-Site generator single-base targeting
- **General**: Ensured the On-Site Generator only queues one curated base checkpoint per request and trimmed the LoRA gallery to twenty visible adapters while catalog searches still span every stored entry.
- **Technical Changes**: Replaced the base-model checkbox matrix with a radio-driven roster that preserves defaults/reset behaviour, tightened submission guards around the lone selection, sliced the LoRA list to the first twenty matches with a refinement hint, and refreshed the README to explain the focused picker.
- **Data Changes**: None.

## 179 – [Addition] Generator artifact detail imports
- **General**: Opened a dedicated detail page for completed generator artifacts with an embedded download control and a guided import workflow that can slot renders into an existing collection or spin up a new gallery instantly.
- **Technical Changes**: Added `POST /api/generator/requests/:id/artifacts/:artifactId/import`, streamed artifact buffers to extract metadata and detect adult signals, created Prisma transactions that mint `ImageAsset` records plus gallery entries, refreshed the frontend history cards to open the detail view, built the new React form with gallery loading, download handling, and success feedback, and introduced supportive styling for the preview/metadata layout. Updated the README to describe the new flow.
- **Data Changes**: None; the import API reuses existing image and gallery tables without altering the schema.

## 180 – [Fix] Generator artifact import memory guard
- **General**: Prevented artifact imports from buffering massive generator renders so detail-page onboarding stays responsive.
- **Technical Changes**: Added a 32 MiB streaming guard that only hydrates metadata when safe, skips buffer hydration for oversized files, and preserves adult-content checks using request data fallbacks while keeping gallery creation intact.
- **Data Changes**: None.

## 181 – [Addition] Default workflow LoRA loader wiring
- **General**: Threaded the bundled SDXL workflow through a dedicated LoRA loader so generator jobs can target curated adapters without manual graph edits.
- **Technical Changes**: Inserted a `LoraLoader` node into `backend/generator-workflows/default.json`, bound its filename and strength inputs to `primary_lora_*` parameters, taught the dispatcher to surface those values from request selections, and covered the new context builder with node-based unit tests plus README guidance.
- **Data Changes**: None.

## 182 – [Fix] Sanitized LoRA parameter propagation
- **General**: Ensured generator jobs feed ComfyUI the sanitized LoRA adapter name and intended strength so queued renders honor the on-site selections.
- **Technical Changes**: Preserved normalized LoRA filenames in the agent context, derived primary strength values from request metadata, exposed the raw payloads under `loras_metadata`, ignored conflicting extras, and added unit coverage that verifies the workflow payload binds the sanitized adapter and strengths.
- **Data Changes**: None.

## 183 – [Fix] Restored LoRA filenames for ComfyUI consumption
- **General**: Delivered `.safetensors` LoRA adapters to ComfyUI under their original upload names so hashed MinIO keys no longer break loader discovery.
- **Technical Changes**: Taught the backend dispatcher to include `displayName`/`originalName` metadata for base models and LoRAs, look up stored original filenames, and fall back to deterministic `.safetensors` labels; updated the GPU agent to apply those names when caching, migrate legacy downloads, ensure cache files carry an extension, and clean up stale symlinks; refreshed the READMEs to document the restored naming flow.
- **Data Changes**: None.

## 184 – [Fix] GPU agent symlink fallback
- **General**: Guaranteed ComfyUI still sees cached checkpoints and LoRAs when the GPU worker mounts model directories from filesystems that disallow symlinks.
- **Technical Changes**: Detected per-directory symlink support in the GPU agent, fell back to copying cached assets into the ComfyUI tree when links fail, migrated existing caches into place, and refreshed both READMEs to document the new behaviour.
- **Data Changes**: None.

## 185 – [Addition] GPU job manifest archives (commit TBD)
- **General**: Captured every GPU dispatch for troubleshooting with persistent manifests and status timelines.
- **Technical Changes**: Added structured job logging inside `GPUAgent`, wrote manifest/event helpers with cancellation hooks, introduced regression tests, and refreshed GPU agent documentation plus configuration comments.
- **Data Changes**: Stores JSON manifests and JSONL event logs under `<outputs>/logs/<jobId>/` on the GPU node.

## 186 – [Fix] Manifest-aligned LoRA staging
- **General**: Ensured the GPU worker delivers primary LoRA adapters to ComfyUI under the manifest-declared filename so dispatch logs and runtime bindings stay consistent.
- **Technical Changes**: Sanitized and applied the `primary_lora_name` override while materializing cached LoRAs, updated parameter-context expectations, and refreshed README guidance on the rename flow.
- **Data Changes**: None; cached files continue to download from the same MinIO objects.

## 187 – [Fix] Primary LoRA override now replaces stale adapters
- **General**: Guaranteed the GPU agent always presents the manifest-named primary LoRA to ComfyUI, even when repeated jobs reuse the same filename.
- **Technical Changes**: Added a cache-rename stage for the primary adapter, taught non-symlink materialization and symlink creation to overwrite existing files when the manifest demands a specific name, and covered the new behaviour with unit tests plus README guidance.
- **Data Changes**: None; only temporary cache filenames and symlinks change.

## 188 – [Fix] Direct LoRA staging for ComfyUI
- **General**: Ensured dispatched LoRAs appear where ComfyUI expects them by delivering downloads straight into the configured `models/loras` directory instead of a hidden cache folder.
- **Technical Changes**: Pointed the GPU agent's LoRA materialisation flow at the primary directory, migrated any legacy `cache/` contents on the fly, refreshed the supporting unit tests, and updated the agent README to describe the direct staging behaviour.
- **Data Changes**: None.

## 189 – [Fix] SDXL prompt mapping parity and audit artefacts
- **General**: Realigned the on-site generator and GPU agent so SDXL prompts, negatives, and LoRA selections land on the intended nodes while the job manifest reflects the exact payload that reached ComfyUI.
- **Technical Changes**: Sanitised generator defaults, filtered workflow bindings when no LoRA is present, chained multiple `LoraLoader` nodes with job-scoped adapter filenames, collapsed the loader automatically when the selection list is empty, synchronised the manifest and status logs with resolved parameters, emitted an `applied-workflow.json` dump before submission, and extended the regression suite to cover the new flow.
- **Data Changes**: Stores the final `/prompt` payload alongside each job manifest under `<outputs>/logs/<jobId>/applied-workflow.json`.

## 190 – [Fix] SDXL payload dimension propagation
- **General**: Ensured ComfyUI receives SDXL prompts with matching encoder and latent dimensions so LoRA-powered renders no longer error on malformed payloads.
- **Technical Changes**: Bound the generator’s width and height parameters to both SDXL text-encoder nodes plus their target dimensions, refreshed the validation workflow’s checkpoint loader inputs, and documented the dimension propagation in the README.
- **Data Changes**: None.

## 191 – [Fix] SDXL workflow payload unification
- **General**: Lined up the On-Site Generator, GPU agent, and ComfyUI payload so SDXL jobs carry the selected checkpoint, prompts, LoRAs, and resolution without manual tweaks.
- **Technical Changes**: Rebased the default and validation workflow JSON on the unified SDXL graph, updated the GPU agent tests and documentation to verify every binding, refreshed sampler defaults, and clarified the main README around the new `SaveImage` outputs.
- **Data Changes**: None.

## 192 – [Fix] GPU agent workflow defaults respect dispatch payloads
- **General**: Stopped the GPU agent from overwriting prompts, LoRA selections, or step counts with stale defaults so queued renders now match the on-site generator input.
- **Technical Changes**: Applied workflow defaults as true fallbacks inside `_build_parameter_context`, expanded the regression suite to cover override precedence, raised the bundled SDXL workflow templates to 80 sampling steps, and refreshed the README plus example config to document the behaviour.
- **Data Changes**: None.
## 193 – [Fix] GPU agent enforces generator sampling inputs
- **General**: Locked sampling controls, resolution, and sampler selection to the on-site generator payload so ComfyUI runs use the exact user-supplied values.
- **Technical Changes**: Removed hard-coded fallbacks in the agent parameter builder, added double validation that compares workflow bindings and sampler connections, reset the bundled workflow templates to neutral placeholders, refreshed tests and configuration guidance, and documented the stricter contract.
- **Data Changes**: None; workflow templates now ship with zeroed placeholders only.

## 194 – [Fix] On-site generator forwards sampler & scheduler
- **General**: Ensured every on-site generation request captures the chosen sampler and scheduler so GPU jobs survive the agent's required-parameter validation.
- **Technical Changes**: Added sampler/scheduler columns to `GeneratorRequest`, trimmed/normalized the API payload, passed the values through the dispatcher, and refreshed the React wizard with dropdown selectors plus review/history displays that mirror the GPU contract.
- **Data Changes**: Backfilled existing generator requests with the default `dpmpp_2m_sde_gpu` sampler and `karras` scheduler while keeping future rows non-null by default.

## 195 – [Fix] GPU sampler fallback (commit TBD)
- **General**: Restored GPU jobs that failed when sampler and scheduler values only lived in the worker defaults.
- **Technical Changes**: Allowed reserved workflow defaults to populate sampler and scheduler bindings, added coverage for the fallback behaviour, and refreshed the README to explain the configuration path.
- **Data Changes**: None; runtime validation only.

## 196 – [Fix] GPU agent accepts scheduler from dispatch payload
- **General**: Prevented the GPU agent from rejecting generator jobs when the scheduler travels inside the main parameter payload instead of the legacy `extra` map.
- **Technical Changes**: Added explicit `sampler` and `scheduler` fields to the dispatch schema, normalised them before validation, seeded the workflow context with the trimmed values, and refreshed the parameter-context regression tests to cover the direct bindings.
- **Data Changes**: None.

## 197 – [Fix] SDXL prompt polarity correction
- **General**: Ensured on-site generator jobs feed positive prompts and negatives into their intended SDXL text encoders so ComfyUI receives the right conditioning.
- **Technical Changes**: Bound both global and local text fields for the positive and negative CLIP nodes in the default workflow parameter map and expanded the GPU agent regression test to verify the mirrored bindings.
- **Data Changes**: None.

## 198 – [Feature] Installer startup mode selection
- **Type**: Normal Change
- **Reason**: Provide administrators with an immediate choice between manual launches and an automatically managed service so deployments match their operational requirements without editing system files later.
- **Changes**: Added a startup-mode prompt to `install.sh`, provisioned an optional `visionsuit-dev.service` systemd unit with automatic enablement, emitted manual launch guidance when skipping automation, and updated the README with the new workflow.

## 199 – [Fix] NodeSource keyring provisioning
- **Type**: Normal Change
- **Reason**: The installer failed to add the NodeSource repository on fresh systems because the ASCII-armored signing key was written without converting it into the keyring format that `apt` expects.
- **Changes**: Updated `install.sh` to dearmor the NodeSource GPG key, ensure the keyring directory exists with the right permissions, and use optional `sudo` wrappers when writing the key and repository list.

## 200 – [Fix] Linux bulk importer response verification
- **Change Type**: Normal Change
- **Reason**: The Linux/macOS bulk uploader reported success even when the API skipped creating the model, leaving galleries populated with renders but no matching LoRA asset in VisionSuit.
- **Changes**: Added asset-slug validation to `scripts/bulk_import_linux.sh` so the run aborts when the API response lacks the expected identifiers, and refreshed the README reliability note to document the cross-platform verification step.

## 201 – [Fix] Windows bulk importer asset verification
- **Change Type**: Normal Change
- **Reason**: The Windows bulk uploader could continue batching gallery images before the API exposed the new model, leading to collections with renders but no matching LoRA asset in VisionSuit.
- **Changes**: Updated `scripts/bulk_import_windows.ps1` to verify the model is visible via the VisionSuit API before scheduling additional image batches and adjusted the README reliability note to highlight the Windows workflow safeguard.

## 202 – [Fix] Windows bulk importer visibility wait extension
- **Type**: Normal Change
- **Reason**: The Windows bulk uploader still aborted for successful imports because the API sometimes needs more than 30 seconds to surface a freshly created model, causing the verification loop to fail.
- **Changes**: Increased the verification retry budget in `scripts/bulk_import_windows.ps1` to ten attempts with capped exponential backoff (roughly 90 seconds) and refreshed the README reliability note to document the longer wait window.

## 203 – [Fix] Authenticated asset queries bypass HTTP caches
- **Type**: Normal Change
- **Reason**: Windows bulk imports continued to fail on fresh installations because cached `GET /api/assets/models` responses returned HTTP 304 without the new model payload, preventing the verification loop from ever seeing the uploaded asset.
- **Changes**: Disabled Express ETags and applied no-store cache headers to all `/api` responses so authenticated clients always receive fresh payloads, and extended the README reliability note to explain the cache-busting behaviour.

## 204 – [Fix] Storage proxy encoding for model previews
- **Type**: Normal Change
- **Reason**: Newly uploaded models stored successfully in MinIO and the database, but VisionSuit could not display or download them because the storage proxy route rejected object IDs that still contained slash characters.
- **Changes**: Updated `buildStorageProxyUrl` in `frontend/src/lib/storage.ts` to URL-encode the full object identifier before constructing the proxy path so requests hit `/api/storage/:bucket/:objectId` with the expected payload, restoring preview and download access for fresh models.

## 205 – [Fix] Adult asset visibility alignment
- **Type**: Normal Change
- **Reason**: Adult-rated models and renders appeared in curator profiles but disappeared from the explorers because the backend asset feeds and client-side filters hid them whenever the viewer's safe-mode toggle was off, even for the uploading curator or a logged-in administrator.
- **Changes**: Allowed administrators and asset owners to bypass the adult-content filter in `/api/assets/models` and `/api/assets/images`, mirrored the same ownership-aware logic in `frontend/src/App.tsx`, and kept the existing restrictions for guests and non-owner viewers with safe mode enabled.

## 206 – [Fix] Windows bulk importer reliability sweep
- **Type**: Normal Change
- **Reason**: The Windows bulk uploader occasionally skipped gallery images and kept processing additional models even when the API never exposed the freshly uploaded asset, leaving curators with partial collections.
- **Changes**: Sorted LoRA inputs for deterministic processing, added cache-busting verification polls, introduced retry logic with exponential backoff for model and gallery batch uploads, upgraded the safeguard to abort the entire run after any verification failure, hardened the HTTP client against caching, and refreshed the README reliability note with the new behaviour.

## 207 – [Fix] Windows bulk importer health check normalization
- **Type**: Normal Change
- **Reason**: The Windows bulk uploader aborted before authenticating when `ServerBaseUrl` already ended in `/api`, doubling the VisionSuit routes during the `/api/meta/status` probe and returning HTTP 404 even though the server was healthy.
- **Changes**: Taught `ConvertTo-AbsoluteUri` in `scripts/bulk_import_windows.ps1` to deduplicate overlapping path segments and adjusted the README so administrators know they can paste either the site root or API endpoint without tripping the health check.
## 034 – [Fix] Windows bulk import metadata lookup
- **Change Type**: Normal Change
- **Reason**: Windows bulk imports failed immediately after authentication because the script passed multiple `-Path` parameters while collecting metadata candidates.
- **Details**: Updated the candidate metadata collection to evaluate each `Join-Path` call individually so only a single `-Path` parameter is supplied per invocation.

## 208 – [Enhancement] Owner visibility and storage reindexer
- **Type**: Normal Change
- **Reason**: Curators could lose track of private or moderated uploads because viewer-facing filters hid their own assets, and administrators needed a recovery tool to reconcile database metadata with MinIO after manual storage edits.
- **Changes**: Relaxed gallery, asset feed, and profile queries so authenticated owners always see every model, image, and gallery entry they uploaded regardless of moderation status, visibility, or safe-mode settings. Added `backend/scripts/reindexStorage.ts` together with the `npm run storage:reindex` helper to rescan MinIO, recreate missing `StorageObject` rows, and refresh file metadata.

## 209 – [Fix] Registration lock indicator
- **Type**: Normal Change
- **Reason**: Visitors could still open the registration dialog even after administrators disabled self-service signups, leading to confusing error toasts instead of a clear closed state.
- **Changes**: Updated `frontend/src/App.tsx` to keep the **Create account** button visible but disabled whenever registration or maintenance mode is off-limits and surface the corresponding notice. Refreshed the README to call out the locked button behaviour so operators know what to expect when closing signups.

## 210 – [Fix] Self-service registration toggle sync
- **Type**: Normal Change
- **Reason**: After administrators turned off self-service registration, the backend kept the locked state cached so re-enabling the toggle in the admin panel had no effect until the server restarted.
- **Changes**: Refreshed `backend/src/lib/settings.ts` to update the runtime platform flags after saving admin settings and had `frontend/src/components/AdminPanel.tsx` reload the platform configuration so the registration toggle immediately applies across the interface.

## 211 – [Update] Gallery lightbox navigation QoL
- **Change Type**: Normal Change
- **Reason**: Reviewers needed a faster way to step through gallery images without repeatedly closing the lightbox or targeting small thumbnails.
- **Changes**: Added swipe, click, and keyboard arrow navigation to the gallery image modal, introduced focus styles for the interactive lightbox surface, and documented the streamlined workflow in the README.

## 212 – [Fix] Windows bulk importer single-item guard
- **Type**: Normal Change
- **Reason**: Windows bulk uploads that only included one LoRA or a single preview image crashed because the script attempted to read the `.Count` property from scalar file objects.
- **Changes**: Wrapped the Windows importer’s file enumerations in arrays so lone safetensors and preview images are counted correctly, and refreshed the README Windows workflow guidance with the single-item support tip.

## 213 – [Enhancement] Automated NSFW metadata screening
- **Type**: Normal Change
- **Reason**: LoRA uploads still relied on manual tag audits, so adult and disallowed themes slipped through until curators reviewed them by hand.
- **Changes**: Extended the safetensor ingestion pipeline to normalize tag-frequency tables, persist normalized counts and score breakdowns in model metadata, compare the totals against configurable thresholds, automatically mark adult LoRAs, flag minor/bestiality matches for moderation with visibility locks, and documented the completed checklist items in the NSFW deployment plan alongside a refreshed README highlight.

## 214 – [Enhancement] NSFW analyzer runtime scheduler
- **Type**: Normal Change
- **Reason**: The OpenCV pipeline had no way to throttle bursts of uploads, so moderators risked timeouts and inconsistent scoring when CPU pressure spiked.
- **Changes**: Added configurable worker-pool and queue runtime settings, shipped a dedicated scheduler with retry/backoff and fast-mode degradation, exposed tuning controls through the admin safety writer, expanded NSFW image analysis options for fast heuristics, refreshed README highlights, and checked off the runtime milestones in the deployment plan with new regression tests.

## 215 – [Enhancement] NSFW upload enforcement and rescan tooling
- **Type**: Normal Change
- **Reason**: Adult and disallowed themes could still slip through initial ingestion, and administrators had no way to refresh legacy assets after updating heuristics.
- **Changes**: Introduced reusable NSFW moderation helpers that automatically mark new uploads as adult or queue them for moderation when metadata, prompts, or OpenCV analysis detect minor/bestiality signals; persisted the screening payload on LoRA metadata; exposed `/api/safety/nsfw/rescan` to replay the checks across existing models and images with storage-backed analysis; added an Administration → Safety control to trigger the rescan with live summaries; and refreshed the README to highlight the automated enforcement and rescan workflow.

## 216 – [Update] NSFW swimwear heuristic realignment
- **Type**: Normal Change
- **Reason**: The safety team confirmed we will not maintain the proposed `nude_vs_swimwear.onnx` checkpoint, so the roadmap needed to stop referencing the unavailable model.
- **Changes**: Updated `docs/nsfw-deployment-plan.md` to focus on OpenCV heuristics and add the official decision note, and refreshed the README highlight to call out that the NSFW pipeline no longer depends on the retired ONNX model.

## 217 – [Feature] OpenCV moderation heuristics enforcement
- **Type**: Normal Change
- **Reason**: Documentation alone left the NSFW filter ineffective because uploads still relied solely on keyword heuristics while referencing the deprecated `nude_vs_swimwear.onnx` fallback.
- **Changes**: Added an OpenCV-inspired skin and garment analyzer (`backend/src/lib/nsfw-open-cv.ts`), wired it into image/model upload flows, generator imports, and moderation recalculations, persisted the resulting summaries in new Prisma `moderationSummary` columns, and refreshed the README highlight to note the backend now executes the heuristics on every upload.

## 218 – [Fix] Prisma schema moderation summary alignment
- **Type**: Normal Change
- **Reason**: Model uploads attempted to persist OpenCV moderation summaries, but the Prisma schema lacked the `moderationSummary` field on `ModelAsset`, leaving generated clients unaware of the column and blocking writes at runtime.
- **Changes**: Declared the `moderationSummary` JSON column on the `ModelAsset` model inside `backend/prisma/schema.prisma` and reformatted the schema with `npx prisma format` so Prisma Client exposes the field to the upload pipeline.

## 219 – [Fix] Image moderation summary include correction
- **Type**: Emergency Change
- **Reason**: The backend crashed on startup because `prisma.imageAsset.findMany` attempted to include the scalar `moderationSummary` field as a relation, triggering a PrismaClientValidationError.
- **Changes**: Updated `backend/src/routes/assets.ts` to stop including `moderationSummary` via `buildImageInclude`, allowing Prisma to hydrate the scalar field without throwing during image queries.

## 220 – [Enhancement] Centralized NSFW moderation workflow
- **Type**: Normal Change
- **Reason**: OpenCV heuristics ran in isolated spots, leaving gallery uploads, generator imports, and rescan jobs out of sync and preventing legacy images from storing moderation summaries or triggering automatic flags.
- **Changes**: Introduced a reusable NSFW workflow helper that fans buffers through the scheduler-backed analyzer and OpenCV heuristics, updated uploads, generator imports, and the `/api/safety/nsfw/rescan` route to persist moderation summaries and reuse the shared decisions, locked generator imports when minor/bestiality cues appear, refreshed README highlights, and documented the rollout in this changelog.



## 221 – [Analysis] Documentation sanity check report
- **Type**: Normal Change
- **Reason**: A documentation review was requested to ensure the README accurately reflects the implemented VisionSuit features.
- **Changes**: Documented a sanity-check report that confirms key README highlights against backend/frontend behaviour and calls out mismatches (missing trust/CTA panels and optional trigger edits) to guide future documentation or feature updates.

## 222 – [Fix] Prisma Studio hostname flag correction
- **Type**: Normal Change
- **Reason**: Launching Prisma Studio with the outdated `--host` flag caused the CLI to abort before starting, leaving the developer database console unavailable during local server boot.
- **Changes**: Updated `dev-start.sh` to pass the supported `--hostname` parameter so Prisma Studio binds to the requested interface without error when running the development stack helper.

## 223 – [Feature] Promptless upload tagging queue
- **Type**: Normal Change
- **Reason**: Prompt-free renders skipped NSFW screening because the moderation workflow relies on textual cues that were missing from those uploads.
- **Changes**: Added a CPU-backed SmilingWolf/wd-swinv2 tagger that downloads on startup when absent, queued promptless gallery uploads behind a “Scan in Progress” placeholder until tagging and moderation complete, persisted scan status and auto-tag summaries in Prisma, exposed the state via the API and front end, and refreshed the README to document the workflow.

## 224 – [Fix] Hugging Face redirect handling
- **Type**: Emergency Change
- **Reason**: The backend failed to start because Hugging Face returned relative redirect URLs for the auto tagger assets, causing the download helper to throw an invalid URL error and abort initialization.
- **Changes**: Updated `backend/src/lib/tagging/wdSwinv2.ts` to resolve relative redirects against the original request URL before retrying the download and to report redirect resolution failures clearly.

## 225 – [Fix] Auto tagger CPU backend enforcement
- **Type**: Normal Change
- **Reason**: Falling back to the WebAssembly runtime hid missing native dependencies and left the wd-swinv2 tagger without the expected CPU execution provider.
- **Changes**: Locate the installed `onnxruntime-node` native backend automatically, fail fast when the CPU provider is still missing, remove the WebAssembly dependency, and refresh the README with instructions for reinstalling or pointing `ORT_BACKEND_PATH` at the native binaries.

## 226 – [Fix] Prisma migration shadow database rebuild
- **Type**: Normal Change
- **Reason**: Fresh installations failed because the `add_moderation_summary` migration attempted to add existing columns to the SQLite shadow database, producing duplicate-column errors during `prisma migrate`.
- **Changes**: Rebuilt the Prisma migration to recreate the `ModelAsset`, `ModelVersion`, and `ImageAsset` tables with moderation summary and tagging metadata columns so SQLite resets and deploys succeed without conflicts.

## 227 – [Update] Floating support footer menu
- **Type**: Normal Change
- **Reason**: The support footer needed to stay accessible without occupying space while browsing, prompting a request for a scroll-aware menu bar with icon-based support links.
- **Changes**: Converted the footer into a floating bar that hides on downward scroll and appears when scrolling up, swapped Discord and GitHub links for icon buttons, condensed the VisionSuit Support and credits text, and added a placeholder Service Status link within the new layout.
