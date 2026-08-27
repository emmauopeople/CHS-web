# PostgreSQL backup and restore runbook

## Purpose

Use this procedure to design, execute, and record a controlled PostgreSQL
restore for the CHS operational database. Complete it in staging with
production-equivalent controls before any real patient data is accepted.

The repository's `pnpm db:rehearse` command is for synthetic local and CI data
only. Never run that command against staging or production: it intentionally
creates and drops temporary databases.

## Required deployment decisions

The deployment owner must record and approve all of the following before
production:

- hosting provider, database region, and permitted backup region;
- RPO and RTO;
- automated backup frequency and retention;
- point-in-time recovery window;
- encryption key ownership and rotation;
- backup-reader and restore-operator identities;
- incident commander and clinical/business validation owners;
- legal hold, deletion, and retention requirements; and
- evidence location and access-retention policy.

An unresolved item blocks production readiness.

## Backup controls

Provider-native encrypted automated backups and point-in-time recovery are the
primary production controls. A logical custom-format archive may supplement
them for portability and migration rehearsals.

For any logical archive:

- use the PostgreSQL 18 `pg_dump` client against PostgreSQL 18;
- use a least-privilege backup role with only the required read and lock access;
- use `--format=custom --no-owner --no-privileges`;
- write directly to approved encrypted storage, never a developer workstation;
- calculate and retain a SHA-256 checksum separately from the archive;
- record database/server version, migration version, start/end time, size, and
  operator identity without recording credentials or patient values;
- deny public access and restrict restore permission independently from read;
  and
- alert on failed, late, unexpectedly small, or unexpectedly large backups.

Never place a password in a command line, shell history, support screenshot, CI
log, or repository file. Use the platform secret manager, a protected password
file, workload identity, or another deployment-approved non-interactive method.

## Restore rehearsal

1. Open a tracked change/incident record and identify the exact backup or
   point-in-time target.
2. Confirm the target is an empty, isolated, private staging database. Do not
   overwrite the active database.
3. Record the source engine version, selected restore point, checksum, expected
   migration count, and approved operators.
4. Restore with the provider-native workflow. For a logical archive, use
   PostgreSQL 18 `pg_restore` with `--exit-on-error --no-owner --no-privileges`
   and an explicitly named empty target database.
5. Run `pnpm db:migrate` against the restored target. A same-release restore must
   report zero applied migrations and all known migrations present.
6. Verify schema and application integrity:

   - migration filenames and checksums match the deployed release;
   - required tables, constraints, and indexes exist;
   - organization, installation, patient, encounter, vitals, Lifestyle, sync,
     identity-review, access-grant, and audit counts are internally plausible;
   - active CHS medical IDs remain unique;
   - foreign-key and check constraints are valid;
   - the API readiness check passes against the isolated target; and
   - a synthetic/de-identified read-only acceptance workflow succeeds.

7. Have the database owner and clinical/business validator sign the evidence.
8. Measure the actual recovery point and elapsed recovery time against the
   approved RPO/RTO. A miss requires remediation and a repeated rehearsal.
9. Keep the restored database isolated until evidence review is complete, then
   destroy it through the provider's approved deletion workflow.

## Cutover after a real incident

Do not cut over automatically from this repository. The incident commander must
confirm the recovery point, integrity results, authorization configuration,
outbox/replay implications, and expected data-loss window. Before directing
traffic to the restored database:

- stop or fence writers;
- preserve the failed database and logs according to incident policy;
- validate credentials, grants, and network rules on the restored target;
- run readiness and minimum-necessary acceptance checks;
- document any batches that desktops must safely replay; and
- approve DNS/secret/configuration changes through the deployment change
  process.

After cutover, monitor authentication failures, API errors, database pool
saturation, sync replay/conflict rates, identity-review volume, and audit
completeness. Do not delete the former database until evidence and retention
requirements allow it.

## Evidence record

Retain the following without patient data or credentials:

- change/incident reference and environment;
- backup identifier or restore timestamp;
- PostgreSQL and tool versions;
- migration count and release commit;
- archive checksum and size, when applicable;
- start, ready, validation, and completion times;
- achieved RPO and RTO;
- validation checklist results;
- operator and approver identities; and
- remediation actions and next rehearsal date.

The evidence location must be access-controlled and included in the release
readiness review.
