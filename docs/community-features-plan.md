# Community Features Plan

## Vision & Objectives
- Foster meaningful interactions around LoRA models and galleries while preserving the curated feel of VisionSuit.
- Encourage high-quality contributions through lightweight feedback loops and recognition systems.
- Maintain moderation control so the community layer remains safe, respectful, and aligned with hosting policies.

## Feature Portfolio
### 1. Reactions & Likes
- ❤️ Per-item likes for models, image assets, and galleries.
- Aggregated counters visible on tiles, detail dialogs, and creator dashboards.
- Daily like quotas to curb spam and provide balanced engagement signals.

### 2. Comments & Threads
- Contextual comment threads scoped to each asset or gallery.
- Rich-text (Markdown-lite) with attachment support limited to images hosted within VisionSuit.
- Inline moderation controls: hide, lock, or pin threads; flagging pipeline for community reports.

### 3. Follows & Subscriptions
- Users can follow creators, galleries, or specific LoRA models for revision updates.
- Personal feed page combining followed entities, recent uploads, and highlighted discussions.
- Email or in-app digest for weekly highlights (optional opt-in per user).

### 4. Collections & Playlists
- Curators can assemble public or private collections combining models and galleries.
- Collaborative collections with role-based permissions (owner, editor, viewer).
- Shareable short links with auto-generated previews for social promotion.

### 5. Reputation & Badges
- Reputation points derived from received likes, approved comments, and curator endorsements.
- Tiered badges (Contributor, Curator, Expert) unlocking subtle perks like early access to new upload tools.
- Admin tooling to grant or revoke badges manually for events or moderation decisions.

### 6. Moderation & Safety
- Community guidelines banner and mandatory acknowledgement on first interaction.
- Flagging reasons (spam, inappropriate, copyright) trigger review queue in the admin workspace.
- Shadow-ban capability and automated throttling when users exceed abuse heuristics.

### 7. Notifications & Activity Log
- In-app notifications center with unread counts in the sidebar shell.
- Activity timeline on profile pages summarising uploads, likes, comments, and badge events.
- Webhooks for integrating community events into Discord/Slack channels (optional).

## Technical Architecture
### Data Model Additions
- `Reaction` table linking user ↔ target asset with uniqueness constraints to avoid duplicates.
- `Comment`, `CommentThread`, and `CommentReaction` tables with hierarchical support.
- `Follow` and `Subscription` tables referencing users, galleries, and models.
- `Collection`, `CollectionEntry`, and `CollectionCollaborator` tables to manage curated sets.
- `ReputationLedger` capturing point changes and their sources for transparency.
- `Notification` entities with status tracking (delivered, read, archived).
- Audit columns (`createdAt`, `updatedAt`, `deletedAt`) on all community tables for soft deletion.

### API Surface
- REST endpoints under `/api/community/*` with JWT protection and rate limiting.
- Real-time updates delivered via WebSocket or Server-Sent Events channel for notifications and live comment streams.
- Bulk endpoints for moderators (approve, hide, delete comments; resolve flags; adjust reputation).
- Pagination-first design with cursor-based navigation to scale beyond initial launch.

### Frontend Enhancements
- Comment composer component with optimistic updates and inline moderation controls for admins.
- Reaction bar shared across gallery and model tiles with skeleton states for loading.
- Notification drawer integrated into the existing sidebar shell, plus dedicated full-page feed.
- Profile revamp showing reputation badges, follower counts, and collections managed by the user.

### Infrastructure & Ops
- Background worker (BullMQ) to process notification fan-out, email digests, and reputation calculations.
- Caching layer (Redis) for hot counters (likes, comment totals) with periodic reconciliation jobs.
- Search indexing updates to include comments and collection metadata for discoverability.
- Audit logging pipeline for moderation actions with export capability for compliance reviews.

## Rollout Phases
1. **Foundation (Milestone M1)**: Implement reactions, basic comments, and moderation queues.
2. **Engagement (M2)**: Launch follows, notification center, and personal feed.
3. **Curation (M3)**: Introduce collaborative collections and reputation badges.
4. **Ecosystem (M4)**: Ship webhooks, analytics dashboards, and advanced digest emails.

## Success Metrics
- 30% of active users leave at least one reaction per week within two months of launch.
- Median response time to community flags under 12 hours via the moderation queue.
- 20% uplift in repeat visits driven by follows and digest notifications over baseline traffic.
- Positive satisfaction scores (>4/5) in quarterly surveys related to community interactions.

## Open Questions
- Determine storage and privacy policies for user-generated comment media.
- Decide on federation or API exposure for third-party community tools.
- Validate legal requirements for email digests (double opt-in, unsubscribe flows) per region.
