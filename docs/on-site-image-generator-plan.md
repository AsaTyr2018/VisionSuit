# On-Site Image Generator Project Plan

## Executive Summary
The on-site image generator introduces an internal rendering service that runs [ComfyUI](https://github.com/comfyanonymous/ComfyUI) in headless mode. VisionSuit will orchestrate prompt execution against MinIO-hosted checkpoints, workflows, and LoRA assets, returning curated renders that curators can accept into collections or discard. This document defines the architecture, workflow pipeline, phased delivery plan, data management strategy, and operational playbook for the feature.

## Objectives
- Deliver a self-hosted, low-latency rendering service that avoids third-party inference dependencies.
- Reuse existing MinIO object storage for ComfyUI models, checkpoints, LoRAs, and generated images.
- Provide a governed pipeline that captures prompts, metadata, and moderation actions when renders are reviewed.
- Integrate the generator seamlessly with existing VisionSuit authentication, collections, and gallery workflows.

## High-Level Architecture
| Component | Responsibility |
| --- | --- |
| **ComfyUI Headless Node** | Runs the ComfyUI server in API-only mode, loads workflow JSON graphs, and executes queued prompt jobs.
| **Generator API (new backend service)** | Acts as a thin orchestration layer around ComfyUI. Handles job creation, state polling, credential validation, and MinIO object hand-offs.
| **VisionSuit Core API** | Issues signed job requests on behalf of authenticated curators/admins, persists job metadata, and exposes review endpoints.
| **Job Queue** | Dedicated generation queue (Redis Streams/BullMQ) that schedules jobs, enforces concurrency, and enables prioritization tiers.
| **MinIO Buckets** | Stores source models/workflows (read-only for generator) and generated renders (write-once, lifecycle managed).
| **Collections Service** | Extends existing gallery/collection modules to accept generator outputs, tagging accepted images and purging discarded artifacts.

## Data Flow Overview
1. Curator submits a prompt from the VisionSuit UI along with workflow parameters and optional LoRA selections.
2. VisionSuit Core API authenticates the request, validates quotas/credit balance, and creates a `GeneratorJob` record with the requested priority.
3. The Generator API enqueues the job in the generation queue. Worker processes pull the next eligible job, resolve workflow assets from MinIO, and post a payload to ComfyUI.
4. ComfyUI streams progress updates; the Generator API proxies these updates to VisionSuit for real-time UI feedback and marks queue status transitions (`queued` → `in_progress` → `completed/failed`).
5. Generated images are uploaded to a dedicated MinIO bucket. Metadata (prompt, seed, workflow version) and credit charges are persisted with the job.
6. Curator reviews the results: approved images are copied/moved into collections and linked to the originating model; rejected images are flagged for lifecycle deletion and credit refunds (if policy dictates).

## Generation Queue Strategy
- **Topology**: A Redis-backed queue (Streams + consumer groups or BullMQ) sits between the VisionSuit Core API and ComfyUI workers. Each GPU worker registers a consumer that fetches jobs based on resource tags (`default`, `high-vram`, etc.).
- **Priorities**: Jobs include a priority field derived from role or credit spend. The queue sorts by priority first and submission time second to guarantee fairness while honoring paid upgrades.
- **Backpressure**: When queue depth exceeds configured thresholds, the API slows new submissions by surfacing estimated wait times or disallowing low-priority jobs until capacity recovers.
- **Status Tracking**: Job states progress through `queued`, `dispatching`, `in_progress`, `awaiting_review`, `completed`, or `failed`. State transitions emit events that update UI progress bars and trigger notifications.
- **Retry & Dead-Letter**: Failed jobs automatically retry up to N times with exponential backoff. Persistent failures are moved into a dead-letter stream for manual inspection without blocking the main queue.
- **Audit Trail**: Queue events log worker assignment, dequeue timestamps, and ComfyUI performance metrics to support debugging and SLA analysis.

## Workflow Pipeline
### 1. Submission
- UI exposes a “Generate with ComfyUI” dialog that collects prompt text, negative prompt, seed/variation controls, model & LoRA selections, resolution presets, and workflow choice.
- API validates user role, rate limits, and required parameters. Jobs are stamped with workflow version hashes for reproducibility.

### 2. Preparation
- Generator API resolves MinIO object keys for the chosen base model, LoRA weights, and workflow graph.
- Temporary working directories are created per job. Files are streamed from MinIO using signed URLs or SDK downloads.
- Optional: apply configuration templates to inject prompt parameters into the workflow JSON before submission.

### 3. Execution
- ComfyUI receives a POST `/prompt` payload referencing the prepared workflow.
- Generator API tracks the returned `prompt_id`, monitors `/history` or websocket events, and handles retries on transient errors.
- Resource controls (max concurrent jobs, VRAM watchdog) are enforced before scheduling new executions.

### 4. Post-Processing
- On job completion, image artifacts are downloaded from ComfyUI’s output directory.
- Artifacts are uploaded to MinIO under `generated/<job-id>/...` and checksummed.
- Job metadata is updated with result URIs, generation time, and ComfyUI performance stats.

### 5. Review & Curation
- VisionSuit UI shows thumbnails, metadata, and moderation controls.
- “Add to Collection” copies the asset into the curator’s selected collection and tags it as `generated` with references to the originating workflow.
- “Discard” flags the artifact for deletion. A nightly cleanup job purges discarded outputs and releases temporary state.

### 6. Lifecycle Management
- Configurable retention policies prune stale jobs, unsuccessful renders, and orphaned artifacts.
- Observability hooks publish metrics (job counts, latency, GPU usage) to the existing monitoring stack or lightweight dashboards.

## Phased Delivery Plan
### Phase 0 – Foundations
- Audit GPU availability, VRAM requirements, and storage throughput.
- Containerize ComfyUI in headless mode with baked-in MinIO credentials (read-only for models, read-write for outputs).
- Define Prisma schema extensions for `GeneratorJob`, `GeneratorArtifact`, and moderation fields.

### Phase 1 – Minimal Viable Generator
- Implement Generator API service with health endpoints, job submission, prioritized queue placement, and status polling.
- Build frontend submission dialog with validation, optimistic UI states, credit balance display, and estimated wait-time messaging.
- Persist job metadata, prompt parameters, artifact locations, queue state, and credit debits per job.
- Manual collection import: users download outputs individually (pre-curation) while the review UI is finalized.

### Phase 2 – Integrated Review Flow
- Add review dashboard with accept/discard controls, bulk actions, credit refund automation, and metadata displays.
- Wire accepted renders into existing collection/gallery tables with audit trails.
- Automate discard cleanup, retention policies, and queue reconciliation (e.g., releasing reserved GPU slots).
- Harden error handling (timeouts, GPU restarts) and add alerting across queue depth, worker lag, and credit anomalies.

### Phase 3 – Advanced Automation
- Introduce preset workflows, shared prompt templates, and granular queue prioritization (e.g., admin fast lane, credit boosts).
- Enable multi-image batching and variation sweeps in a single job submission with per-batch credit settlement.
- Add webhook-style callbacks or websocket streaming for sub-second progress updates.
- Expose API endpoints for programmatic job submission (with scoped API tokens) for power users, including signed credit deductions.

## Virtual Pay-Per-Generation Model
- **Credit System**: VisionSuit issues virtual credits (non-monetary) that represent the right to run a generation. Each job consumes a base credit amount that scales with resolution, workflow complexity, or batching.
- **Earning & Allocation**: Credits are assigned through admin grants, daily refresh quotas, or achievements (e.g., curating content). Admins can bulk adjust balances via a ledger interface.
- **Spending Mechanics**: Users may boost job priority by spending extra credits. The queue checks available balance before enqueuing and blocks submissions when credits are insufficient.
- **Refund Policy**: Failed jobs automatically refund credits; discarded outputs optionally refund partial credits depending on moderation policies.
- **Transparency**: UI surfaces current balance, estimated cost before submission, and historical statements per job for governance.
- **Governance**: The system logs all credit transactions (debits, credits, refunds) to support audits and detect abuse.

## Data & Storage Considerations
- **Buckets**: reuse `models/` for checkpoints & LoRAs, add `generator-workflows/` (JSON graphs), and `generator-outputs/` for renders.
- **Metadata**: store prompt text, negative prompt, scheduler, steps, CFG scale, seed, workflow hash, model versions, queue state, worker ID, and credit cost.
- **Credits Ledger**: Introduce a `GeneratorCreditTransaction` table that records user, job, delta, reason (`debit`, `refund`, `grant`), and resulting balance for transparency.
- **Versioning**: tag each workflow JSON with semantic versions; include checksum validation during job prep.
- **Retention**: default 7-day retention for discarded outputs, 30-day retention for unreviewed jobs, infinite for curated assets.
- **Security**: Generator API authenticates via service tokens issued by VisionSuit. ComfyUI runs inside a private network segment with no public exposure. Ledger writes require dual authorization to prevent tampering.

## Operational Playbook
- **Deployment**: Ship Docker Compose profiles for the Generator API and ComfyUI service. Provide systemd units for GPU hosts if Compose is unavailable.
- **Monitoring**: Add structured logs, Prometheus exporters (GPU usage, job latency, queue depth, credit spend rates), and health probes for automated restarts.
- **Scaling**: Support horizontal GPU scaling by assigning generator instances to dedicated queues and sharding jobs by resource tags (e.g., `high-vram`). Worker auto-scaling ties into queue lag thresholds.
- **Disaster Recovery**: Document backup steps for workflow definitions and MinIO buckets. Generator nodes remain stateless beyond caches.
- **Credit Operations**: Provide admin tooling to adjust credit balances, export ledger snapshots, and reconcile anomalies detected by monitoring alerts.

## Risks & Mitigations
| Risk | Impact | Mitigation |
| --- | --- | --- |
| GPU outages or driver instability | Failed jobs, degraded UX | Implement retry logic, proactive health checks, and node cordoning during maintenance.
| MinIO bandwidth contention | Slow job preparation | Leverage presigned URLs with caching, consider local warm caches for popular models.
| Workflow drift | Inconsistent results | Version control workflow JSON, enforce checksums, and require approvals for publishing new presets.
| Prompt abuse | Policy violations | Extend moderation rules to generator submissions, log prompt history, and flag sensitive keywords.
| Storage bloat | Increased costs | Enforce retention policies, deduplicate identical outputs via hashing, and surface storage metrics to admins.
| Queue saturation | Long wait times, frustrated users | Track queue depth, surface live wait estimates, autoscale GPU workers, and temporarily throttle low-priority submissions.
| Credit abuse | Unfair priority access | Enforce ledger audits, set spending caps, and require admin approval for large grants.

## Open Questions
- Preferred queue technology (native ComfyUI queue vs. external Redis/BullMQ with priority support)?
- Should prompts be encrypted at rest for privacy-sensitive deployments?
- Required SLA for job completion to size GPU capacity appropriately?
- How frequently should free credits refresh, and what governance is needed for manual grants?
- Do we allow credit pooling for teams or shared collections?

## Next Steps
1. Validate GPU hardware availability and capture baseline benchmarks using a representative workflow.
2. Finalize Prisma schema updates and draft API contracts for job submission and review.
3. Prototype the Generator API locally against a ComfyUI docker container to validate MinIO integrations and end-to-end queue dispatch.
4. Draft UI wireframes for submission and review dialogs, aligning with existing VisionSuit design language, queue state visualization, and credit balance prompts.
5. Schedule a design review to confirm moderation requirements, storage retention policies, queue prioritization tiers, and credit refund rules before implementation.
6. Define admin workflows for granting/revoking credits and reconciling ledger discrepancies.
