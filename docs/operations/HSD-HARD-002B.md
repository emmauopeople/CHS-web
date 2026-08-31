# HSD-HARD-002B: Synchronization incident and recovery drill

Status: Implemented

## Purpose

This increment adds the second R1-020 release-evidence slice: a repeatable,
PostgreSQL-backed drill for synchronization interruption, replay, response
recovery, and controlled failed-batch recovery. It also adds the operator
runbook used to diagnose these conditions without inspecting clinical payloads
or editing canonical records.

The drill uses the existing synthetic HSD-SYNC-001 fixture in a randomized,
ephemeral PostgreSQL schema. It does not connect to a desktop, staging, or
production database and it does not establish deployment-specific incident
ownership or response-time objectives.

## Recovery scenarios

The dedicated command proves all of the following through the real Fastify
HTTP and PostgreSQL boundary:

1. one patient record is committed while the containing batch remains
   `PROCESSING`, representing an interrupted worker;
2. an exact POST resumes the batch, returns the committed patient as
   `UNCHANGED`, completes the remaining records, and stores one accepted
   response;
3. another exact POST returns that stored response byte-for-byte at the JSON
   value boundary without repeating side effects;
4. GET response recovery returns the same stored response;
5. changed content under the same batch ID is rejected with
   `BATCH_PAYLOAD_MISMATCH` and creates no rows; and
6. a controlled `FAILED` batch without a response returns to `PROCESSING` under
   the existing advisory lock and completes idempotently.

After both recovery paths, the isolated schema contains two batch envelopes but
only one canonical person, session, encounter, vital set, and reading. Any
duplicate canonical row fails the command.

## Safety boundary

The harness creates and drops only a schema matching:

```text
chs_recovery_<32 lowercase hexadecimal characters>
```

The cleanup guard rejects `public`, caller-selected names, suffixes, shell
fragments, and any other schema. The command requires `DATABASE_TEST_URL`. The
parsed database name must start with `test_` or end with `_test`, except for the
repository's exact loopback Compose URL from `.env.example`. This narrow local
exception requires the `chs` role, `chs-local-only` password, `chs` database,
and default PostgreSQL port. Never point the command at staging or production.

The `FAILED` transition is injected directly only inside this synthetic,
ephemeral schema to exercise the already implemented recovery path. Operators
must not update `sync_batches`, delete sync rows, or alter payload hashes during
an incident.

## Evidence artifact

Each successful run writes
`apps/api/recovery-results/sync-recovery-evidence.json`. It records:

- runtime and loopback transport;
- the five recovery scenario names and pass states;
- bounded outcome and canonical row counts;
- stable HTTP status/error-code evidence; and
- explicit synthetic-fixture and no-duplicate markers.

It excludes request and response bodies, database URLs, tokens, schema names,
batch/record/installation/location IDs, Medical IDs, demographics, clinical
values, and payload hashes. The command checks the serialized artifact against
all source identifiers before writing it. GitHub Actions retains the artifact
for 14 days; generated local evidence is ignored by Git.

## Running the drill

Set `DATABASE_TEST_URL` through the existing local `.env` mechanism. The
checked-in `.env.example` value works with the repository's local Compose
PostgreSQL service. Then run:

```bash
pnpm test:recovery
```

The command fails if PostgreSQL is unavailable, migrations cannot be applied,
any recovery response differs, changed content is accepted, canonical counts
change unexpectedly, source identifiers would enter the evidence, or isolated
schema cleanup is unsafe.

## Operator procedure

Use [Synchronization incident, replay, and recovery](../runbooks/sync-incident-replay-recovery.md)
for deployment incidents. It requires exact immutable retries, bounded backoff,
scoped monitoring, and escalation for payload conflicts. It never instructs an
operator to replay from the browser, edit PostgreSQL, or expose a payload.

## Scope boundary

This increment does not implement the desktop sync worker, an operator retry
button, automatic production replay, dead-letter storage, deployment alerting,
or an incident-management platform. Deployment owners must still approve
on-call roles, severity rules, communications, retention, and evidence storage
before go-live.
