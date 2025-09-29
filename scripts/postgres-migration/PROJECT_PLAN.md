# VisionSuit Database Migration Project Plan

## Objective
Transition VisionSuit deployments from the bundled SQLite database to a dedicated PostgreSQL instance without disrupting production traffic or losing historical data.

## Scope
- Support **fresh installations** that should immediately provision and migrate to PostgreSQL.
- Provide an **upgrade path for existing SQLite installations**, including automated backups and validation gates.
- Ship automation scripts that prepare remote PostgreSQL targets, orchestrate maintenance windows, and allow for fallback to SQLite if needed.

## Constraints & Assumptions
- Automation must operate in English and target Linux hosts that run the existing maintenance scripts.
- Operators can provide SSH credentials or DSN details for the remote PostgreSQL server.
- SQLite remains available as a fallback until cutover verification succeeds.
- Prisma schema adjustments to support PostgreSQL compatibility will be tracked separately from these orchestration scripts.

## Deliverables
1. **Target preparation script** that validates connectivity to the remote PostgreSQL service, ensures the database and user exist, and checks TLS requirements.
2. **Fresh install migration script** that provisions PostgreSQL, applies Prisma migrations against it, and replaces SQLite references in environment files.
3. **Production upgrade script** that:
   - Enables maintenance mode and blocks writes.
   - Exports the existing SQLite database.
   - Imports data into PostgreSQL using Prisma or a bulk loader.
   - Runs verification queries and Prisma health checks.
   - Switches application configuration to PostgreSQL and optionally rolls back if validation fails.
4. **Runbook** covering manual validation, rollback, and monitoring steps post-cutover.

## High-Level Timeline
| Week | Milestone |
| --- | --- |
| 1 | Finalize Prisma schema compatibility review and document required adjustments. |
| 2 | Implement PostgreSQL target preparation helper and add CI smoke tests against Postgres. |
| 3 | Build fresh install automation and validate with clean deployments. |
| 4 | Deliver production upgrade script, including automated backups and verification hooks. |
| 5 | Draft and test rollback procedures, finalize documentation, and schedule pilot migrations. |

## Open Questions
- Should the automation manage database user creation or assume pre-provisioned credentials?
- How will binary assets stored on disk be handled during migrations that require moving hosts?
- Do we need blue/green Prisma clients for uninterrupted service during cutover?

## Next Steps
- Document environment variables required for PostgreSQL (e.g., `DATABASE_URL`, `SHADOW_DATABASE_URL`).
- Prototype Prisma migration runs against a managed PostgreSQL service to confirm compatibility.
- Draft detailed step-by-step instructions for both automation scripts to flesh out placeholder sections.
