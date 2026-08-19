# HSD-SYNC-002D: Patient screening encounter ingestion

Status: Draft for implementation review

## Purpose

This increment processes validated `SCREENING_ENCOUNTER /
screening-encounter.v1` records after secure batch intake. It creates the
canonical patient-level healthcare interaction that later vital sets and FHIR
Observations reference.

The shared daily screening session remains operational context. Each canonical
screening encounter represents one person's interaction and retains its person,
session, organization, location, protocol, recording practitioner, source
installation, and source identifiers.

## Processing order

For each encounter record the processor:

1. verifies the batch is processing for the authenticated installation;
2. resolves the mutation actor and distinct recording practitioner from the
   immutable batch actor snapshots;
3. enforces delivery and source-snapshot idempotency;
4. validates status-specific fields and source/clinical time ordering;
5. verifies the payload location matches the enrolled batch location;
6. resolves the canonical person through the installation's patient source
   link;
7. resolves the canonical screening session and verifies its organization,
   location, protocol, and session period;
8. resolves and validates an amendment target when present;
9. creates or advances the canonical encounter and stores the terminal record
   outcome.

Raw encounter payloads are not retained in sync tables or logs. Canonical
clinical fields and SHA-256 digests are stored.

## Dependencies and retry

Patient and session records may be in the same batch or an earlier batch. If a
patient, session, or amendment target is not yet available, the processor emits
`RETRY` with `DEPENDENCY_NOT_AVAILABLE` and a JSON Pointer path.

An identical delivery previously stored as `RETRY` can be processed again after
its dependency becomes available. The original sync-record row is advanced to
the final outcome, preserving the durable delivery key without inserting a
duplicate row. Changed content under that delivery or snapshot key is rejected.

## Encounter identity

The following canonical relationships are immutable after creation:

- canonical person and source patient UUID;
- canonical screening session and source session UUID;
- organization, canonical location, and source location UUID;
- canonical protocol and source protocol-version UUID;
- recording practitioner;
- local encounter UUID, source type, start instant, and source creation instant;
- amendment target, when the encounter is an amendment.

The sync mutation actor is retained separately in `sync_records`. It is never
substituted for `recordedByLocalActorId`.

`practitioner_role_id` remains null unless a future verified provider-enrollment
workflow resolves an appropriate central role. Ingestion does not guess a role
from a desktop authorization label.

## Lifecycle rules

Valid snapshots have these shapes:

- `DRAFT`: no completion time, amendment fields, or void reason;
- `COMPLETED`: completion time is required and amendment/void fields are null;
- `AMENDED`: completion time, a separate prior encounter target, and a nonblank
  amendment reason are required;
- `VOID`: a nonblank void reason is required and amendment fields are null.

The allowed lifecycle for one local encounter is `DRAFT → COMPLETED → VOID`,
with direct `DRAFT → VOID` also allowed. `COMPLETED`, `AMENDED`, and `VOID`
clinical fields cannot be silently replaced. A correction is a separate
`AMENDED` encounter linked to an existing completed or amended encounter for the
same person.

The encounter start must be on or after the session opening instant. When the
session is closed, encounter start and completion must not exceed its closing
instant. Completion cannot precede start.

## Idempotency and outcomes

- exact prior delivery or source snapshot: `UNCHANGED`;
- changed content under an existing key: `RECORD_PAYLOAD_MISMATCH`;
- lower source revision: `STALE_SOURCE_REVISION`;
- unavailable patient, session, or amendment dependency: retryable `RETRY`;
- context, identity, period, status, transition, or terminal conflicts:
  permanent `REJECTED`;
- accepted results expose only the canonical encounter UUID. Patient identity
  and Medical ID response fields remain null for this non-patient resource.

## Concurrency

Encounter changes use a transaction-scoped PostgreSQL advisory lock plus row
locks for referenced and existing canonical records. The conservative Release 1
lock prevents concurrent deliveries from advancing one local encounter out of
order. It can be partitioned later only with equivalent race-safety proof.

## Verification

- JSON Schema fixtures verify status-specific encounter shapes;
- PostgreSQL integration tests cover canonical relationships, distinct mutation
  and clinical attribution, exact retries, dependency recovery, lifecycle
  advancement, terminal regression, amendments, invalid context, stale
  revisions, and delivery-content conflicts;
- repository lint, type-check, test, build, and PostgreSQL CI gates are required.

## Out of scope

This task does not ingest vital sets/readings, create verified practitioner
roles, complete batches, expose the Fastify sync routes, implement the desktop
sync worker, map FHIR resources, or build the React patient viewer.
