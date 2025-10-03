# Production PostgreSQL Migration Runbook

This document captures the authoritative production workflow for moving VisionSuit from SQLite to PostgreSQL. Follow the stages below in order—each step produces artifacts consumed by the next one, and skipping a check risks data loss.

## 1. Prepare the PostgreSQL host

Copy `scripts/postgres-migration/postgress-prepare.sh` to the target host (for example, `/usr/local/sbin/postgress-prepare.sh`), log in with root privileges, and execute:

```bash
sudo bash /usr/local/sbin/postgress-prepare.sh \
  --db-name visionsuit \
  --db-user visionsuit \
  --linux-user visionsuit-migrator
```

The helper installs PostgreSQL when absent, creates the `visionsuit-migrator` Linux user with SSH key access (including root escalation), provisions the `visionsuit` database and owner role, generates a random database password, and writes `/root/vs-conf.txt` containing:

- `SSH_*` fields describing how VisionSuit should reach the host.
- A base64-encoded private key that matches the authorized key installed for both the automation user and `root`.
- `POSTGRES_*` credentials for the freshly created database, including `POSTGRES_HOST` (the hostname Prisma will use) and `POSTGRES_INTERNAL_HOST` (the tunnel target inside the server).

Store the generated file securely—anyone with `vs-conf.txt` can access the database host.

## 2. Deliver `vs-conf.txt` to the VisionSuit host

Copy the configuration bundle via an encrypted channel. A typical path is `/root/config/vs-conf.txt` on the VisionSuit server:

```bash
scp root@db.internal:/root/vs-conf.txt root@visionsuit:/root/config/vs-conf.txt
```

Verify the file’s permissions stay restricted (`chmod 600`).

## 3. Run the migration preflight

On the VisionSuit host, execute:

```bash
./scripts/postgres-migration/preflight.sh --config /root/config/vs-conf.txt
```

The preflight agent extracts the private key, establishes SSH connectivity, sets up a temporary tunnel to the PostgreSQL server, confirms that the database accepts logins, and activates the fallback external connector service (`POSTGRES_EXTERNAL_CONNECTOR_SERVICE`, default `visionsuit-external-connector`) once the credentials succeed so downstream consumers can fail over immediately. After successful validation it writes `.env-migration` in the repository root and stores the private key at `config/migration-ssh-key` (unless overridden). The env file contains:

- `DATABASE_URL` pointing at PostgreSQL.
- The SQLite source path used for exports.
- SSH connection parameters used by downstream tools.
- `POSTGRES_INTERNAL_HOST` and `POSTGRES_PORT`, which the migration helper uses to re-establish the tunnel during the live import.

Treat `.env-migration` as sensitive. Regenerate it by rerunning the preflight when the configuration bundle changes.

## 4. Execute the data migration

With `.env-migration` ready, run:

```bash
./scripts/postgres-migration/migration.sh
```

The migration script performs multiple safeguards:

1. Creates a timestamped copy of the SQLite file inside `run/migration/`.
2. Establishes an SSH tunnel with the credentials from `.env-migration` so the VisionSuit host talks to the PostgreSQL server over the hardened channel that was validated during preflight.
3. Drops pre-existing PostgreSQL tables to avoid conflicts.
4. Uses `pgloader` when available (or falls back to a `sqlite3`/`psql` pipeline) to import schema and data automatically.
5. Runs `VACUUM ANALYZE` on PostgreSQL to optimize fresh tables.
6. Compares row counts for every table; any mismatch stops the process and preserves the SQLite backup for investigation.

Set `MIGRATION_SKIP_TUNNEL=1` before running the script if the VisionSuit host can reach PostgreSQL directly without SSH port forwarding. Do not proceed until the script reports success.

## 5. Switch Prisma to PostgreSQL

After validation, finalize the cutover:

```bash
sudo ./scripts/postgres-migration/prisma-switch.sh
```

The helper rewrites `/etc/visionsuit/vs-backend.env` and `/etc/visionsuit/vs-frontend.env` with the PostgreSQL connection string and shadow database URL derived from `.env-migration`. It creates timestamped backups when the files already exist and restarts the `vs-backend` and `vs-frontend` systemd units. If systemd restarts fail the script aborts so you can investigate before clients connect to a partially configured stack.

## 6. Post-cutover validation

Confirm the deployment is healthy:

- Check `journalctl -u vs-backend -u vs-frontend` for Prisma connection errors.
- Inspect the application UI for missing data or write failures.
- Archive the SQLite backup produced in `run/migration/` and securely store `vs-conf.txt` for future maintenance runs.

Re-run the preflight and migration scripts for rehearsals or to refresh credentials; each helper is idempotent and safe to execute multiple times.
