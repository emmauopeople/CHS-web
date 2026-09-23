# HSD-SYNC-005C: Lifestyle persistence and ingestion

Status: Draft for implementation review

## Purpose

This increment processes validated `LIFESTYLE / lifestyle.v1` records after
their patient, screening-session, and encounter dependencies. It persists one
completed seven-day Lifestyle snapshot as normalized PostgreSQL rows while
retaining the exact immutable alcohol, tobacco, and work baseline versions used
to interpret that week.

Raw Lifestyle request payloads are not stored. Canonical values, source IDs,
clinical actor provenance, source timestamps, source revisions, and SHA-256
content digests are retained.

## Canonical model

Migration `0011_lifestyle_ingestion.sql` adds 15 normalized tables:

- `lifestyle_assessments`, the completed encounter-owned snapshot;
- three immutable baseline tables and their beverage/product join tables;
- four weekly section tables for alcohol, tobacco, physical activity, and
  work, plus the other-activity weekly response;
- normalized tobacco-product, physical-activity, and other-activity child
  rows, including stable source row IDs and sequence values.

One Lifestyle assessment is allowed per canonical encounter. It retains the
person, session, organization, location, protocol, installation, source
location, clinical period, three baseline references, record revision, content
digest, and create/update attribution. The sync record points to the canonical
assessment through a type-constrained foreign key.

No Lifestyle table contains a raw payload or JSON column.

## Processing rules

For each Lifestyle record the processor:

1. verifies that the batch belongs to the authenticated installation and is
   still processing;
2. resolves every root, baseline, weekly, and child actor reference from the
   batch's immutable actor snapshots;
3. validates nested source timestamps and enforces delivery/snapshot
   idempotency;
4. resolves the installation-scoped patient and encounter dependencies;
5. verifies patient, session, organization, location, and source-location
   context;
6. accepts only a completed canonical-root local encounter, not a draft,
   amendment, or void;
7. requires the seven-day period to end on the screening session date;
8. inserts or exactly reuses each referenced immutable baseline version;
9. inserts the assessment, weekly sections, child rows, and terminal sync
   outcome in one transaction.

The shared machine contract remains responsible for closed-object validation,
conditional response rules, ranges, contiguous child sequences, actor presence,
unique child IDs/types, and alcohol arithmetic. PostgreSQL repeats structural,
referential, range, and uniqueness protections for the normalized rows.

## Baseline immutability

A baseline version is identified by both its installation-scoped local version
UUID and its `(person, version)` position. An existing version is reused only
when those identities and its canonical content digest all match. Reusing an ID
or version for different content is permanently rejected. Later baseline
versions never rewrite an already accepted weekly assessment.

## Dependencies and replay

- unavailable patient or encounter, or a local-root encounter still in draft:
  retryable `DEPENDENCY_NOT_AVAILABLE`;
- identical prior delivery or source snapshot: `UNCHANGED`;
- a stored `RETRY` is reprocessed in the same durable sync-record row after its
  dependency arrives;
- changed content under an existing delivery/snapshot key:
  `RECORD_PAYLOAD_MISMATCH`;
- lower source revision: `STALE_SOURCE_REVISION`;
- mismatched identity/context, voided/amended encounter state or invalid period, reused
  baseline identity/version, or a second assessment for the encounter:
  permanent `REJECTED`;
- a higher revision with identical completed content may advance the source
  revision, while changed completed clinical content returns
  `LIFESTYLE_TERMINAL_CONFLICT`.

### Recovery of premature uploads

Older desktop versions could upload a completed Lifestyle section before the
overall encounter completed. Older API versions permanently rejected that case
with `LIFESTYLE_ENCOUNTER_STATE_INVALID`. A new batch may reconsider that specific
legacy outcome only for the exact original record hash, with no canonical
Lifestyle target, one matching non-retryable error at `/payload/localEncounterId`,
and an installation-scoped local-root encounter currently draft or completed.
All normal context, provenance, period, baseline and content checks run again.
A draft remains retryable; a completed valid snapshot is accepted once. A void,
amendment, other error, or changed record does not qualify for this recovery.

The existing sync-record row is updated transactionally. Historical batch
responses remain unchanged, and subsequent accepted replays return `UNCHANGED`.
Install/restart this API before the coordinated desktop recovery update; no
schema migration or clinical data rewrite is required.

Accepted outcomes expose only the canonical Lifestyle assessment UUID. Patient
identity and Medical ID fields remain null for this non-patient resource.

## Concurrency

Lifestyle ingestion uses one transaction with a transaction-scoped PostgreSQL
advisory lock plus row locks on the batch, dependencies, baseline versions,
assessment, and durable outcome. This conservative Release 1 boundary prevents
competing deliveries from creating two versions of the same canonical week.

## Verification

- contract tests continue to validate all `lifestyle.v1` branches and fixtures;
- migration tests verify all 15 tables and the absence of raw payload JSON;
- PostgreSQL integration tests cover normalized persistence, actor provenance,
  exact replay, dependency retry recovery, immutable-baseline conflicts,
  terminal snapshot conflicts, encounter state, and period context;
- the HTTP route integration test proves same-batch patient → session →
  encounter → Lifestyle dependency ordering;
- repository lint, type-check, test, build, diff, and PostgreSQL integration
  gates are required before merge.

## Out of scope

This task does not implement desktop snapshot construction or transport,
operations-portal Lifestyle viewing, amendment/replacement/void behavior, Food,
OTC medication, referral, reporting, FHIR mapping, or raw payload retention.
