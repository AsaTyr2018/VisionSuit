# Project Ironquill – Medium-Severity Engagement Systems

Project Ironquill assembles the roadmap initiatives rated at severity 6–7. These efforts expand community interaction loops and supporting infrastructure without yet demanding the deepest architectural rework.

## Scope of Updates
- **Reactions & counters** – Ship per-item likes for models, images, and galleries plus aggregated counters on tiles and dashboards (Severity 6–7).
- **Follow graph foundations** – Introduce follow relationships for creators, galleries, or models to prepare personalized discovery (Severity 7).
- **Collection collaboration** – Enable shared editing and generate short, shareable links with previews (Severity 6–7).
- **Badge administration** – Provide admin tooling to grant or revoke reputation badges once scoring exists (Severity 7).
- **Profile activity surfacing** – Add an activity timeline to profile pages (Severity 7).
- **Core schema extensions** – Create `Reaction`, `Follow`, `Subscription`, and collection-centric tables (`Collection`, `CollectionEntry`, `CollectionCollaborator`) (Severity 6–7).
- **Community API layer** – Launch `/api/community/*` endpoints guarded by JWTs and basic rate limiting (Severity 7).
- **Cursor pagination rollout** – Refactor list endpoints to support cursor-based pagination (Severity 6).
- **Frontend enhancements** – Implement reaction bars across tiles and deliver a profile revamp exposing badges, follower counts, and collections (Severity 7).
- **Operational guardrails** – Stand up an audit logging pipeline to capture community events (Severity 7).
- **Engagement metric tracking** – Target 30% weekly reaction participation with supporting analytics (Severity 7).
- **Policy alignment** – Finalize storage/privacy guidelines for comment media and evaluate third-party API exposure (Severity 6–7).

## Content Update Strategy
1. **Interaction-first storytelling**
   - Produce release notes and in-product highlights that celebrate the new reaction and follow mechanics.
   - Refresh creator documentation to explain how activity timelines and badge administration influence visibility.
2. **Navigation & discovery refresh**
   - Update profile layouts and gallery tiles to visually integrate reaction controls, follower counts, and collaboration indicators.
   - Introduce onboarding tooltips or spotlight tours that teach the follow graph and collaborative collections.
3. **Trust & policy communication**
   - Publish clear privacy/storage guidelines for media contributions, ensuring contributors know how assets are processed.
   - Document API exposure policies and rate limits tied to the new `/api/community` namespace.

## Technical Considerations
- Schema migrations must be sequenced to avoid blocking existing gallery workflows; start with new tables that can sit idle until endpoints are ready.
- Rate limiting can begin with in-process tracking before moving to distributed stores, keeping early implementation manageable.
- Cursor pagination will require coordinated frontend updates to handle `nextCursor` responses across explorers and dashboards.
- Audit logging should piggyback on the new reaction/follow events to avoid duplicative instrumentation work later.

## Dependencies & Sequencing
- Complete Project Silverleaf before enabling collaborative collections to guarantee guideline acknowledgements are in place.
- Align backend and frontend delivery for reactions/follows so the user experience is cohesive on launch day.
- Reserve discovery marketing pushes until engagement analytics dashboards can accurately report the 30% weekly participation target.
