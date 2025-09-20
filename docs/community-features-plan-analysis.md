# Community Features Plan – Feasibility Analysis

This document summarizes the feasibility review of the community roadmap based on the current VisionSuit codebase. Each item lists an estimated severity from 1 (trivial) to 10 (extremely difficult) alongside implementation notes.

## Feature Portfolio

### 1. Reactions & Likes
| Item | Severity (1–10) | Feasibility Notes |
| --- | --- | --- |
| ❤️ Per-item likes for models, image assets, and galleries | 7 | The Prisma schema only models users, assets, images, galleries, tags, and upload drafts, so introducing per-item reactions requires new tables and relations plus corresponding API routes. |
| Aggregated counters visible on tiles, detail dialogs, and creator dashboards | 6 | Existing cards and explorers render metadata only; none of the UI components track or display reaction counters, so substantial frontend work is needed once backend data exists. |
| Daily like quotas to curb spam | 8 | There is no middleware or persistence for rate limiting or activity quotas; current routes simply expose CRUD endpoints, so implementing per-user quotas would require new tracking tables, business logic, and possibly Redis or similar storage that is not part of the stack today. |

### 2. Comments & Threads
| Item | Severity | Feasibility Notes |
| --- | --- | --- |
| Contextual comment threads scoped to each asset or gallery | 8 | Neither backend nor frontend code references comments, so adding threaded discussions means designing new Prisma models, endpoints, and UI workflows from scratch. |
| Rich-text (Markdown-lite) with attachment support | 8 | File handling is presently limited to uploads of models/images; supporting rich-text with inline images would need new storage flows, sanitization, and UI components beyond the current form elements. |
| Inline moderation controls with flagging pipeline | 9 | No moderation workflow exists for community content, and the admin panel currently manages only users, models, images, and galleries; extending it to handle comment moderation plus flag submission/resolution introduces complex state management and review tooling. |

### 3. Follows & Subscriptions
| Item | Severity | Feasibility Notes |
| --- | --- | --- |
| Follow creators, galleries, or models | 7 | User relationships are absent from the schema, so follow functionality requires new tables and endpoints; authentication only covers login/me today. |
| Personal feed combining followed entities, uploads, discussions | 8 | The frontend app exposes Home/Models/Images/Admin views with static data fetches and no personalized timeline logic, so creating a feed would require new APIs and state management. |
| Email or in-app weekly digest | 9 | There is no mailer, scheduler, or background job system; package dependencies lack nodemailer, BullMQ, or cron tooling, making digest generation a large infrastructure addition. |

### 4. Collections & Playlists
| Item | Severity | Feasibility Notes |
| --- | --- | --- |
| Curators assemble public/private collections mixing models and galleries | 4 | Galleries already support public/private states and can include both model and image entries, so this is largely supported, though combining galleries into collections may still need new relations. |
| Collaborative collections with role-based permissions | 7 | Ownership is singular; no collaborator model exists, so shared editing would require new join tables and access checks across API and UI. |
| Shareable short links with previews | 6 | Current routing exposes slugs but no short-link service; implementing this demands link generation, persistence, and preview metadata rendering beyond current capabilities. |

### 5. Reputation & Badges
| Item | Severity | Feasibility Notes |
| --- | --- | --- |
| Reputation points from likes, comments, endorsements | 8 | There is no ledger or scoring mechanism; adding one requires capturing interactions (which themselves do not yet exist) and computing totals for display. |
| Tiered badges unlocking perks | 8 | User model lacks badge fields and role granularity; implementing tiers demands schema updates, policy enforcement, and UI surfacing of new states. |
| Admin tooling to grant/revoke badges | 7 | Admin UI currently manages activation and metadata only, so badge administration would necessitate new forms and endpoints. |

### 6. Moderation & Safety
| Item | Severity | Feasibility Notes |
| --- | --- | --- |
| Community guidelines banner & acknowledgement | 5 | The shell layout could show an additional banner, but no state exists to record acknowledgements, so new backend fields and frontend UX are needed. |
| Flagging reasons feeding moderation queue | 8 | Current system has no flag models or queues; implementing this requires schema additions, submission endpoints, and an admin review UI beyond existing grids. |
| Shadow-ban capability & automated throttling | 9 | User model only tracks `isActive`; nuanced bans or throttling would need behavioral metrics, middleware hooks, and probably background heuristics not present today. |

### 7. Notifications & Activity Log
| Item | Severity | Feasibility Notes |
| --- | --- | --- |
| In-app notification center with unread counts | 9 | No notification entities or real-time channels exist; adding them entails new tables, API endpoints, and frontend components, plus delivery strategy. |
| Activity timeline on profile pages | 7 | Profiles do not yet have dedicated pages or activity aggregation, so building this needs both backend aggregation endpoints and new frontend routes. |
| Webhooks for community events | 8 | The backend only serves HTTP REST; no webhook framework or background job queue exists, so event publishing infrastructure must be introduced. |

## Technical Architecture

### Data Model Additions
| Item | Severity | Feasibility Notes |
| --- | --- | --- |
| `Reaction` table with uniqueness constraints | 7 | Requires new Prisma model plus migrations and relation wiring in API handlers that do not yet exist. |
| `Comment`, `CommentThread`, `CommentReaction` tables | 8 | No comment-related schema is present; hierarchical threads and reactions would be a sizable modeling effort with cascading logic. |
| `Follow` and `Subscription` tables | 7 | Current schema lacks any follower relationships, so additions must cover polymorphic targets and indexing for feeds. |
| `Collection`, `CollectionEntry`, `CollectionCollaborator` tables | 6 | Galleries partially cover collections, but collaborator support and potential nested content require new structures beyond existing `Gallery` relations. |
| `ReputationLedger` table | 8 | Tracking point changes needs a dedicated ledger plus aggregation queries, none of which exist currently. |
| `Notification` entities with status tracking | 8 | No notification persistence exists, so adding tables and lifecycle management is necessary for in-app delivery and read states. |
| Audit columns on community tables | 4 | Existing tables already use `createdAt`/`updatedAt`, so extending that pattern is straightforward once new tables are defined. |

### API Surface
| Item | Severity | Feasibility Notes |
| --- | --- | --- |
| `/api/community/*` REST endpoints with JWT & rate limiting | 7 | Router currently exposes only auth, assets, galleries, uploads, storage, and users; new namespaces and middleware (including rate limiting) must be built. |
| Real-time updates via WebSocket/SSE | 9 | The server is a plain Express app without real-time transport; introducing WS/SSE requires architectural changes and potentially new dependencies. |
| Bulk moderator endpoints | 8 | Existing endpoints focus on CRUD; batch moderation operations for community content would need careful authorization and transaction handling beyond current patterns. |
| Cursor-based pagination | 6 | Most endpoints currently return entire collections; shifting to cursor-based pagination involves query rewrites and frontend adjustments to consume paginated results. |

### Frontend Enhancements
| Item | Severity | Feasibility Notes |
| --- | --- | --- |
| Comment composer with moderation controls | 8 | The UI lacks any comment components; building a composer with optimistic updates and admin controls entails significant new React state and design work. |
| Reaction bar across tiles with skeleton states | 7 | Existing cards render static metadata; adding interactive reaction bars with loading skeletons requires redesigning these components and wiring to new APIs. |
| Notification drawer & full-page feed | 8 | There is no notification context or routes; implementing this would introduce new global state, routing, and styling beyond the current sidebar layout. |
| Profile revamp with badges, follower counts, collections | 7 | Profiles beyond login are absent; implementing dedicated profile pages with new metrics requires both backend data and frontend routing work. |

### Infrastructure & Ops
| Item | Severity | Feasibility Notes |
| --- | --- | --- |
| Background worker (BullMQ) for notifications/digests | 9 | No worker process or queue library exists; Node dependencies are limited to Express/Prisma, so adopting BullMQ introduces new services (Redis) and deployment complexity. |
| Redis caching layer for counters | 8 | Current setup stores everything in SQLite; integrating Redis involves new services, configuration, and cache invalidation logic. |
| Search indexing for comments/collections | 8 | Search today relies on Prisma queries; indexing comments requires adopting a search service or extending queries to cover new tables, which is non-trivial. |
| Audit logging pipeline with export | 7 | There is no centralized audit log; implementing one demands new persistence, possibly background jobs, and export tooling outside current scope. |

## Rollout Phases
| Phase | Severity | Feasibility Notes |
| --- | --- | --- |
| M1 – Reactions, basic comments, moderation queues | 8 | Each component of the foundation requires substantial backend/frontend work absent today, making the combined milestone heavy. |
| M2 – Follows, notification center, personal feed | 9 | Depends on prior features plus new feed/notification infrastructure, which is currently non-existent. |
| M3 – Collaborative collections, reputation badges | 8 | Requires new permission models and scoring systems that build atop earlier milestones and extend schema/UI significantly. |
| M4 – Webhooks, analytics dashboards, advanced digests | 9 | Demands eventing, telemetry, and reporting stacks beyond the current product footprint, plus the digest infrastructure noted earlier. |

## Success Metrics
| Metric | Severity | Feasibility Notes |
| --- | --- | --- |
| 30% weekly reaction participation | 7 | Requires reaction tracking plus analytics to compute user-level engagement; no telemetry framework exists yet. |
| Median flag response <12 hours | 8 | Needs flag queues, moderator tooling, and operational monitoring that the current stack does not provide. |
| 20% uplift from follows/digests | 8 | Measuring uplift requires baseline analytics and the follow/digest systems, both of which are missing, implying significant instrumentation work. |
| Satisfaction >4/5 on surveys | 5 | Surveys are external to the codebase, but integrating feedback capture or tooling would still need new processes beyond current functionality. |

## Open Questions
| Topic | Severity | Feasibility Notes |
| --- | --- | --- |
| Storage & privacy policies for comment media | 6 | Media uploads currently target MinIO via existing pipelines; extending policies to community content is doable but needs governance and possibly bucket segregation not yet configured. |
| Federation/API exposure for third-party tools | 7 | Present API is internal-focused without OAuth or external rate limits; opening it up requires authentication redesign and stability hardening. |
| Legal requirements for digests | 6 | Email digests aren’t implemented; complying with regional laws would need opt-in tracking and unsubscribe flows plus audit trails that are currently absent. |

## Overall Assessment
Most community features outlined in the plan are not yet supported by the current VisionSuit codebase; they demand extensive backend schema work, new REST/real-time endpoints, significant React UI expansion, and additional infrastructure such as Redis, background workers, and email delivery systems.
