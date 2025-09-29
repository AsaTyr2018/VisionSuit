# PostgreSQL Target Preparation Guide

This guide describes the automated preparation workflow for migrating VisionSuit from SQLite to a managed PostgreSQL host. The automation bundle now ships the dedicated SSH credentials and configuration that the remote helper consumes, so operators only need to copy a handful of files and execute the scripted steps below.

## 1. Mint the automation bundle on the VisionSuit host

Run the upgrade orchestrator in automation-only mode to generate the SSH key pair and the configuration file consumed by the remote helper:

```bash
POSTGRES_URL="postgres://visionsuit_migrate@db.internal:5432/visionsuit?sslmode=require" \
  SQLITE_PATH="backend/prisma/dev.db" \
  UPGRADE_AUTOMATION_ONLY=true \
  ./scripts/postgres-migration/upgrade_sqlite_to_postgres.sh
```

The helper writes three assets under `scripts/postgres-migration/generated/`:

- `visionsuit_migration` and `visionsuit_migration.pub` – the private/public SSH key pair dedicated to remote automation.
- `visionsuit_migration_config.env` – the parameter file that declares the remote UNIX user, sudo flag, PostgreSQL role, database grants, and the exported public key.

Regenerate the bundle any time you need to rotate credentials by re-running the command above. You can override usernames, roles, and filenames through the `UPGRADE_REMOTE_*` environment variables before invoking the helper.

## 2. Bootstrap the remote host with the helper

Copy the remote helper and generated configuration to the PostgreSQL target and execute it with elevated privileges:

```bash
scp scripts/postgres-migration/remote_prepare_helper.sh \
    scripts/postgres-migration/generated/visionsuit_migration_config.env \
    admin@db.internal:/tmp/
ssh admin@db.internal 'sudo bash /tmp/remote_prepare_helper.sh --config /tmp/visionsuit_migration_config.env'
```

When the configuration file sits next to the script you can omit `--config`; the helper automatically loads `visionsuit_migration_config.env` from the current directory. During execution it will:

1. **Provision SSH access** – Create or update the UNIX deployment account, install the supplied public key for both the user and root, and grant optional sudo access based on the automation bundle.
2. **Capture the access summary** – Write `~/visionsuit_remote_access.txt` that records the hostname, SSH fingerprint, and key material. Review the file and store the matching private key from the automation bundle on the VisionSuit server.
3. **Create the PostgreSQL role** – Ensure the configured PostgreSQL role exists with passwordless `LOGIN` privileges, optional `CREATEDB`, and database grants when a name is provided.
4. **Persist automation defaults** – Copy the used `visionsuit_migration_config.env` into the deployment user’s home directory so future runs reuse the same parameters without re-supplying flags.

## 3. Validate local tooling and remote compatibility

After the remote host is ready, run the local sanity validator from the repository root. Provide the Prisma project path, the SSH destination, the generated private key, and the PostgreSQL URL confirmed by the helper:

```bash
./scripts/postgres-migration/sanity_check.sh \
  --prisma-project ./backend \
  --postgres-url "postgres://visionsuit_migrate@db.internal:5432/visionsuit?sslmode=require" \
  --ssh-target visionsuit-migrator@db.internal \
  --ssh-identity scripts/postgres-migration/generated/visionsuit_migration \
  --require-extensions pg_trgm,uuid-ossp
```

The script verifies local Prisma dependencies, validates the remote PostgreSQL version, checks extension availability, and confirms connectivity over SSH using the automation-generated credentials.

## 4. Prepare the database and run rehearsals

With access validated, continue with the orchestration scripts:

- `prepare_postgres_target.sh` – Creates the target database when missing, enforces TLS requirements, and installs required extensions.
- `fresh_install_postgres_setup.sh` – Provisions a clean PostgreSQL environment and deploys the VisionSuit schema for new installs.
- `upgrade_sqlite_to_postgres.sh` – Automates the SQLite-to-PostgreSQL rehearsal, including backups, `pgloader` imports, Prisma migrations, and data validation. It automatically reuses the automation bundle to refresh SSH keys or defaults when needed.

Each orchestrator accepts environment toggles to skip phases or reuse existing resources. Review the script headers for the full list of options before running production migrations.
