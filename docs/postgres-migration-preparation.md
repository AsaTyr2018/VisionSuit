# PostgreSQL Target Preparation Guide

This guide walks operators through the preparation workflow for migrating VisionSuit from SQLite to a managed PostgreSQL host. Follow the steps below in order to guarantee that remote access, PostgreSQL roles, and compatibility checks are in place before running the migration orchestrators.

## 1. Bootstrap the remote host

Run `remote_prepare_helper.sh` on the PostgreSQL target (over SSH or after copying the script to the host):

```bash
sudo ./scripts/postgres-migration/remote_prepare_helper.sh \
  --unix-user visionsuit \
  --pg-role visionsuit \
  --pg-createdb \
  --pg-database visionsuit \
  --ssh-pubkey "$(cat ~/.ssh/visionsuit.pub)"
```

The helper performs three critical tasks:

1. **Provision SSH access** – It creates or updates the UNIX account, installs the provided public key for that user, and grants the same key root login rights. The script records the access details—including the exported public key—in `~/visionsuit_remote_access.txt` so automation on the VisionSuit server can reuse them without guesswork.
2. **Capture the access summary** – Inspect the text file on the remote host to confirm the hostname, SSH fingerprint, and role provisioning status:
   ```bash
   sudo cat ~visionsuit/visionsuit_remote_access.txt
   ```
   Share the matching private key with the VisionSuit server so it can authenticate as the deployment user (and escalate to root) via SSH.
3. **Create the PostgreSQL role** – The helper ensures the specified role exists with passwordless `LOGIN` privileges and optional `CREATEDB` rights. Configure `pg_hba.conf` to authorise the VisionSuit server’s host or SSH tunnel for the role.

## 2. Validate tooling and remote compatibility

After the remote host is ready, run the local sanity validator from the repository root. Provide the Prisma project path, the SSH destination, and the remote PostgreSQL URL that the helper confirmed:

```bash
./scripts/postgres-migration/sanity_check.sh \
  --prisma-project ./backend \
  --postgres-url "postgres://visionsuit@db.internal:5432/visionsuit?sslmode=require" \
  --ssh-target visionsuit@db.internal \
  --require-extensions pg_trgm,uuid-ossp
```

The script verifies local Prisma dependencies, validates the remote PostgreSQL version, checks extension availability, and confirms connectivity over SSH.

## 3. Prepare the database and run rehearsals

With access validated, continue with the orchestration scripts:

- `prepare_postgres_target.sh` – Creates the target database when missing, enforces TLS requirements, and installs required extensions.
- `fresh_install_postgres_setup.sh` – Provisions a clean PostgreSQL environment and deploys the VisionSuit schema for new installs.
- `upgrade_sqlite_to_postgres.sh` – Automates the SQLite-to-PostgreSQL rehearsal, including backups, `pgloader` imports, Prisma migrations, and data validation.

Each orchestrator accepts environment toggles to skip phases or reuse existing resources. Review the script headers for the full list of options before running production migrations.
