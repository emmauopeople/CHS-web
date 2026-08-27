# HSD-HARD-002A: PostgreSQL backup and restore rehearsal

Status: Implemented

## Purpose

This increment adds the first R1-020 release-evidence slice: a repeatable,
synthetic PostgreSQL logical backup and restore rehearsal plus an operator
procedure for the later deployment environment.

It proves that the current migration-defined schema and a synthetic canonical
row survive a real `pg_dump` custom archive and `pg_restore` cycle. It does not
claim that local CI timing establishes a production recovery point objective
(RPO), recovery time objective (RTO), encrypted-backup policy, or managed-cloud
point-in-time recovery capability.

## Rehearsal lifecycle

The dedicated command:

1. resolves the PostgreSQL 18 container used by Docker Compose or GitHub Actions;
2. creates randomized source and restore databases with guarded names;
3. applies all immutable migrations to the source database;
4. inserts one synthetic organization record;
5. creates a custom-format archive with `pg_dump`;
6. lists and size-checks the archive before restore;
7. restores into the empty isolated database with `--exit-on-error`;
8. reruns the migration verifier and requires zero pending migrations;
9. compares tables, constraints, indexes, migration checksums, and the synthetic
   row through an exact SHA-256 manifest fingerprint; and
10. deletes the temporary archive and both randomized databases.

The restore must contain 46 tables and all 11 migrations. The source and
restored manifest fingerprints must be identical.

## Destructive-target controls

Database creation and cleanup accept only names matching:

```text
chs_rehearsal_source_<12 lowercase hexadecimal characters>
chs_rehearsal_restore_<12 lowercase hexadecimal characters>
```

Archive cleanup accepts only:

```text
/tmp/chs-rehearsal-<same 12-character suffix>.dump
```

The Docker container reference must be a 12-to-64-character hexadecimal
container ID. The script does not accept a service name, shell fragment, glob,
production database name, or caller-selected deletion target.

## Evidence artifact

Each successful run writes
`packages/database/rehearsal-results/backup-restore-evidence.json`. It records:

- PostgreSQL and `pg_dump` versions;
- archive format and byte size;
- elapsed rehearsal time;
- restored table, constraint, index, and migration counts; and
- the source and restored manifest fingerprints.

It excludes database URLs, credentials, container IDs, generated database
names, archive paths, SQL, and row contents. GitHub Actions retains the
synthetic evidence for 14 days; local generated evidence is ignored by Git.

## Run locally

Start the repository PostgreSQL service and use the existing local-only
`DATABASE_TEST_URL` from `.env`:

```bash
docker compose up -d postgres
pnpm db:rehearse
```

When `DATABASE_REHEARSAL_CONTAINER_ID` is absent, the script resolves the
Compose `postgres` container. The command must never be pointed at production.

## Deployment procedure

The deployment-facing procedure is
[PostgreSQL backup and restore](../runbooks/postgresql-backup-restore.md). It
requires provider-native encrypted backups and point-in-time recovery where
available, plus an isolated restore rehearsal before real patient data is
accepted.

## Scope boundary

This increment does not select a cloud provider, storage region, encryption key,
retention period, RPO, RTO, legal hold, production database role, or incident
owner. It does not automate a production cutover or treat a logical dump as a
replacement for provider-native continuous backups. Those decisions remain
deployment gates before production go-live.
