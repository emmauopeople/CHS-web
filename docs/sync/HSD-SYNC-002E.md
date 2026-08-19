# HSD-SYNC-002E: Vitals and blood-pressure reading ingestion

Status: Draft for implementation review

## Purpose

This increment processes validated `VITALS / vitals.v1` records after secure
batch intake. It creates the canonical vital set and source-stable blood
pressure readings that later map to FHIR Observations.

Every accepted vital set is linked to one canonical patient encounter, person,
installation, and performing practitioner. Blood pressure, pulse, weight, and
waist values retain their source units and clinical timing context.

## Processing order

For each vitals record the processor:

1. verifies the batch is processing for the authenticated installation;
2. resolves the mutation actor and distinct clinical performer from immutable
   batch actor snapshots;
3. enforces delivery and source-snapshot idempotency;
4. validates parent and reading source timestamps, unique source reading IDs,
   and contiguous sequence numbers;
5. resolves the canonical encounter and its person/location context;
6. verifies the performer is the encounter's recording practitioner;
7. converts each supplied local measurement date/time to an instant using the
   enrolled installation's IANA timezone;
8. validates measurement order and encounter-period bounds;
9. creates or advances the canonical vital set and diffs its draft readings;
10. stores a terminal per-record outcome.

Raw vitals payloads are not stored in synchronization tables or error details.
Canonical values, source timestamps, and SHA-256 content digests are persisted.

## Observation-ready relationships

The canonical model preserves the fields needed for later FHIR mapping:

- `screening_vital_sets.encounter_id` supplies Observation `encounter`;
- the encounter's person supplies Observation `subject`;
- `recorded_by_practitioner_id` supplies Observation `performer`;
- encounter organization, location, and protocol remain available through the
  encounter/session context;
- local reading IDs and sequences retain source provenance;
- blood pressure uses mmHg, pulse uses beats/minute, weight uses kilograms, and
  waist circumference uses centimetres;
- local clinical date/time, IANA timezone, and derived instant are all retained.

Exact FHIR resource profiles and terminology coding remain the responsibility
of the later mapping service.

## Clinical time conversion

The server never treats an entered local measurement time as UTC. It converts
the local date and minute using the installation IANA timezone and verifies the
round trip.

The reading timezone must match the installation timezone. A nonexistent local
time during a daylight-saving gap returns `MEASUREMENT_TIME_INVALID`. A repeated
local time that maps to two instants returns `MEASUREMENT_TIME_AMBIGUOUS`; the
server does not guess. A future additive contract can carry an explicit UTC
offset or fold choice for such deployments.

When a draft has no local measurement time, `measured_at` remains null. Complete
vitals require a full blood-pressure reading, pulse, site, position, and local
time. Derived instants cannot precede the encounter start, exceed its completion
time when present, or move backward by reading sequence.

## Identity and lifecycle

One vital set is allowed per encounter. These fields are immutable after
creation:

- canonical encounter and person;
- installation and local vital-set UUID;
- clinical performer;
- source creation instant.

A `DRAFT` may advance through higher source revisions. Draft updates are applied
as a child-row diff: removed readings are deleted, retained source reading IDs
keep their canonical IDs, and new readings are inserted. Retained readings must
keep their relative order, although their sequence numbers may compact around
insertions or removals.

The only forward status transition is `DRAFT → VITALS_COMPLETE`. A completed
vital set cannot return to draft or have its clinical content replaced. A
clinical correction must use a separate amended encounter and its own vital
set, preserving the original history.

## Dependencies and idempotency

- unavailable encounter: retryable `DEPENDENCY_NOT_AVAILABLE`;
- identical prior delivery or source snapshot: `UNCHANGED`;
- identical delivery previously stored as `RETRY`: safely reprocessed after the
  encounter arrives, using the same durable sync-record row;
- changed content under an existing delivery/snapshot key:
  `RECORD_PAYLOAD_MISMATCH`;
- lower source revision: `STALE_SOURCE_REVISION`;
- context, performer, reading, time, identity, lifecycle, and terminal
  conflicts: permanent `REJECTED`.

Accepted outcomes expose only the canonical vital-set UUID. Patient identity
and Medical ID response fields remain null for this non-patient resource.

## Concurrency

Vitals ingestion uses a transaction-scoped PostgreSQL advisory lock and row
locks for the encounter, vital set, readings, and durable sync outcome. This
conservative Release 1 lock prevents competing deliveries from changing one
draft or completing it out of order.

## Verification

- unit tests cover IANA conversion, UTC offsets, impossible local times,
  daylight-saving gaps, and repeated hours;
- contract fixtures cover complete-reading requirements, contiguous sequence,
  performer presence, and installation-timezone binding;
- PostgreSQL integration tests cover canonical relationships, distinct mutation
  and performer attribution, derived instants, exact retry, draft child diffs,
  stable canonical reading IDs, completion locking, dependency recovery,
  invalid reading/time/performer context, void encounters, and one-set-per-
  encounter enforcement;
- repository lint, type-check, test, build, and PostgreSQL CI gates are required.

## Out of scope

This task does not complete sync batches, expose the Fastify sync routes,
implement the desktop sync worker, map or submit FHIR resources, create verified
practitioner roles, or build the React patient viewer.
