# HSD-SYNC-002C: Screening session and protocol ingestion

Status: Draft for implementation review

## Purpose

This increment processes validated `SCREENING_SESSION / screening-session.v1`
records after secure batch intake. It creates source-linked canonical protocol
versions and screening sessions while preserving the operational relationships
needed by later encounter ingestion and FHIR provenance mapping.

The shared desktop screening session remains an operational day/location
grouping. It is not itself a patient FHIR Encounter; each later canonical
patient screening encounter will reference this session and map separately.

## Processing order

For each session record the processor:

1. verifies the batch is still processing for the authenticated installation;
2. resolves the mutation actor and the distinct opening/closing clinical actors
   from immutable batch actor snapshots;
3. enforces delivery and source-snapshot idempotency;
4. verifies the payload location is the batch's enrolled source location;
5. derives the local calendar date from `openedAt` using the installation IANA
   timezone and compares it with `sessionDate`;
6. validates source and clinical time ordering;
7. resolves or creates the canonical protocol and its desktop source link;
8. creates or advances the canonical screening session;
9. stores a terminal sync record with the canonical session target.

Raw session payloads are not retained in sync tables or logs. Only canonical
clinical fields and SHA-256 content digests are persisted.

## Protocol identity

A protocol version is canonically identified by organization, protocol key,
version label, and checksum. Equivalent source versions reuse one canonical
protocol but retain separate `protocol_source_links` rows.

Once an installation's local protocol-version UUID is linked, its key, version,
and checksum cannot change. Reusing that UUID for different content returns
`PROTOCOL_SOURCE_CONFLICT`; it never silently repoints historical sessions.

New protocol versions are marked active and use the session opening instant as
their initial effective instant. Protocol activation administration is deferred
from this ingestion task.

## Session invariants

The following fields define session identity and cannot change after creation:

- installation, organization, canonical location, and source location;
- canonical protocol and source protocol-version UUID;
- local session UUID and local calendar date;
- opening practitioner and opening instant.

Notes may advance with a higher source revision. Session state moves only
`OPEN → CLOSED`. A closed session cannot reopen, and its closing practitioner
or closing instant cannot later be replaced. PostgreSQL also enforces that the
closing instant is not before the opening instant.

The sync mutation actor is stored separately from `openedByLocalActorId` and
`closedByLocalActorId`. No ingestion fallback substitutes the mutation actor for
a missing clinical actor.

## Idempotency and outcomes

The processor uses both HSD-SYNC-001 keys and a canonical full-record digest:

- an exact prior delivery or source snapshot returns `UNCHANGED`;
- changed content under an existing key returns `RECORD_PAYLOAD_MISMATCH`;
- a revision below the canonical session revision returns
  `STALE_SOURCE_REVISION`;
- location, date, protocol, immutable identity, closure, and state conflicts
  return permanent `REJECTED` outcomes with JSON Pointer paths;
- accepted outcomes return only the canonical session UUID. Patient and Medical
  ID fields remain null for non-patient resources.

## Concurrency

Protocol linking and session changes use a transaction-scoped PostgreSQL
advisory lock. This conservative Release 1 lock prevents concurrent batches
from creating competing source links or advancing the same session out of
order. It can be partitioned later only with equivalent race-safety proof.

## Verification

- unit tests cover timezone-aware date derivation and invalid inputs;
- PostgreSQL integration tests cover protocol/session creation, clinical actor
  attribution, exact retries, open-to-closed transition, state regression,
  closure conflicts, stale revisions, record-content conflicts, location/date
  rejection, protocol-source conflicts, and canonical protocol reuse;
- repository lint, type-check, test, build, and PostgreSQL CI gates are required.

## Out of scope

This task does not process patient encounters or vitals, create practitioner
roles, complete batches, expose Fastify sync routes, implement the desktop sync
worker, map FHIR resources, or build the React viewer.
