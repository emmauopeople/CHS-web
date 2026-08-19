# HSD-SYNC-001: Desktop-to-Web synchronization contract

Status: Draft for implementation review

Contract version: `1.0`

Owners: CHS desktop and CHS web teams

## Purpose

This contract defines the first production boundary between an approved CHS
desktop installation and the Release 1 web platform. It covers the first
vertical slice: patient demographics, screening sessions, screening
encounters, and vitals. It also defines how a newly assigned CHS medical ID is
returned to the desktop and how an authorized operator can recover a missing
ID.

The machine-readable source of truth is:

- `packages/contracts/openapi/sync-v1.openapi.json` for HTTP operations;
- `packages/contracts/schemas` for payload validation;
- `packages/contracts/fixtures` for synthetic compatibility examples.

## Desktop discovery decisions

The inspected desktop repository already provides stable UUIDs for the
installation and local entities, an IANA installation timezone, configured
locations, row/record versions, and a durable `sync_outbox` with retry state.

The current outbox payloads are audit notifications and do not contain complete
demographics or clinical measurements. A desktop sync worker must therefore
load the current SQLite rows and create the full versioned snapshots defined by
this contract. It must not upload the existing `payload_json` as if it were the
clinical record.

The desktop patient UUID and local `PT-######` code remain local identifiers.
The web service returns a separate `centralPersonId` and `chsMedicalId`. The
desktop stores the CHS medical ID in `patient_identifiers`; it never replaces
the local UUID. Clients treat the CHS medical ID as an opaque, case-sensitive
server value and do not parse meaning from its current display format.

Lifestyle and food-questionnaire structures are still evolving and are not in
contract version 1.0.

## HTTP operations

| Operation | Purpose | Authorization |
| --- | --- | --- |
| `POST /api/v1/sync/batches` | Submit one retry-safe batch | Installation bearer token |
| `GET /api/v1/sync/batches/{batchId}` | Recover a previously stored response | Same installation bearer token |
| `POST /api/v1/identity/medical-id-recovery` | Find an existing ID without creating one | Authorized operations bearer token |

Token issuance, installation registration, and operations-user authentication
are separate work items. They are represented as bearer-token security schemes
so endpoint implementation cannot accidentally ship unauthenticated.

An installation and its configured local-location UUID must be enrolled and
mapped before its token can submit batches. A token is bound to exactly one
installation; the server also verifies that the envelope location is an
approved location for that installation.

## Batch envelope

Each batch carries:

- `contractVersion`, fixed at `1.0`;
- client-generated `batchId` UUID;
- stable `installationId` and configured `locationId` UUIDs;
- installation IANA timezone;
- desktop application and SQLite schema versions;
- UTC batch creation timestamp;
- batch-level snapshots of the local actors referenced by records;
- between 1 and 100 versioned records.

The API request-body limit remains 1 MiB. The desktop must split larger work
into multiple batches without splitting a single record snapshot.

## Record model

Every record contains `recordId`, `resourceType`, `localResourceId`,
`sourceRevision`, `schemaVersion`, `operation`, `capturedAt`, and the full
resource `payload`. `recordId` is the durable delivery/idempotency identifier;
`localResourceId` is the immutable desktop entity UUID.

Version 1.0 accepts these snapshots:

- `PATIENT` / `patient.v1`;
- `SCREENING_SESSION` / `screening-session.v1`;
- `SCREENING_ENCOUNTER` / `screening-encounter.v1`;
- `VITALS` / `vitals.v1`.

Only `UPSERT` is allowed in version 1.0. A voided encounter is represented by a
new encounter snapshot with status `VOID`; records are not physically deleted.

`sourceActorLocalId` is mandatory and retained for mutation provenance: it is
the local user whose action created the versioned snapshot being synchronized.
It does not imply that this user performed the clinical work. Clinical
attribution is carried separately in the resource payload:

- a session has `openedByLocalActorId` and, when closed,
  `closedByLocalActorId`;
- an encounter has `recordedByLocalActorId`;
- a vital set has `performedByLocalActorId`.

Every non-null actor reference must resolve to exactly one entry in the batch
`actors` array. Actor snapshots include only the local UUID, display name,
role, active status, and source update timestamp; usernames and authentication
data are excluded. An actor may be inactive when the historical record is
synchronized, but the actor snapshot remains required.

A desktop-local user is not automatically treated as a verified centrally
authenticated provider. The web platform creates a source-linked practitioner
record and may reconcile it with a centrally verified practitioner only through
an explicit review or future provider-enrollment workflow.

### Desktop source mapping

| Contract field | Desktop source |
| --- | --- |
| `batchId` | New UUID persisted with the sync attempt before transmission |
| `recordId` | Durable `sync_outbox.id` selected for the snapshot |
| `installationId` | `installation.id` singleton |
| `locationId` | Configured installation location UUID |
| Patient `sourceRevision` | `patients.row_version` |
| Session `sourceRevision` | `screening_sessions.row_version` |
| Encounter `sourceRevision` | `screening_encounters.record_version` |
| Vitals `sourceRevision` | `screening_vitals_drafts.row_version` |
| `sourceActorLocalId` | Relevant local `created_by`, `updated_by`, or `recorded_by` UUID |
| Session `openedByLocalActorId` | `screening_sessions.opened_by` |
| Session `closedByLocalActorId` | `screening_sessions.closed_by`; null while open |
| Encounter `recordedByLocalActorId` | `screening_encounters.recorded_by` |
| Vitals `performedByLocalActorId` | Encounter `recorded_by` for the current desktop workflow |

The actor display name and role come from the desktop `users` row referenced by
each UUID. The combination provides enough source identity to distinguish the
operator who changed a record from the clinician who opened, closed, recorded,
or performed it, and later construct Practitioner and PractitionerRole
relationships without synchronizing credentials.

The current desktop schema records one actor for an encounter rather than one
actor per vital reading. Therefore `performedByLocalActorId` is the encounter's
`recorded_by` actor in version 1.0. If a later workflow allows different people
to perform individual readings, a versioned additive contract change must
introduce reading-level attribution; ingestion must not infer it from the sync
operator.

A session snapshot also includes the protocol key, version label, and checksum,
so the web platform does not infer clinical meaning from a desktop-local
protocol UUID alone.

## Ordering and references

Records may reference another local entity in the same batch or one accepted by
an earlier batch from the same installation. The server processes dependencies
in this order: patient, session, encounter, vitals. Array order has no semantic
meaning.

If a reference cannot be resolved, that record receives a retryable
`DEPENDENCY_NOT_AVAILABLE` outcome. Independent records may still be accepted.

## Time and units

Desktop persistence uses UTC timestamps for record provenance. A vitals reading
also carries `measurementLocalDate`, `measurementLocalTime`, and
`measurementTimezone`, because the clinical measurement time is entered in
local time. The server preserves those source fields and derives an instant
only with timezone-aware conversion; it must not assume UTC. Reading timezones
must match the enrolled installation timezone, and reading sequence numbers are
unique and contiguous from 1 within each vital set.

Client timestamps are provenance, not trusted ordering controls. The server
uses `sourceRevision` for entity ordering and its own receive timestamp for
operational sequencing.

Units are fixed in version 1.0: weight is kilograms, waist circumference is
centimetres, blood pressure is mmHg, and pulse is beats per minute.

## Idempotency and retry rules

The server enforces both:

- unique delivery key: `(installationId, recordId)`;
- unique snapshot key: `(installationId, resourceType, localResourceId,
  sourceRevision)`.

Submitting the same `batchId` with the same canonical payload hash returns the
stored response without repeating side effects. Reusing that `batchId` with
different canonical content returns HTTP `409` and code
`BATCH_PAYLOAD_MISMATCH`.

A repeated record/snapshot with the same canonical content returns
`UNCHANGED`. A repeated idempotency key with different content is rejected with
`RECORD_PAYLOAD_MISMATCH`. A revision lower than the last accepted revision is
rejected with `STALE_SOURCE_REVISION`.

The desktop should coalesce multiple pending audit events for one entity into
the latest full snapshot. It marks an outbox item sent only after a terminal
`ACCEPTED`, `UNCHANGED`, `REVIEW_REQUIRED`, or non-retryable `REJECTED` outcome.
`RETRY` remains pending and uses bounded exponential backoff with jitter.

## Partial acceptance and outcomes

A valid envelope returns HTTP `200` with a stored batch response. `batchStatus`
is `ACCEPTED`, `PARTIAL`, or `REJECTED`. Every submitted `recordId` has exactly
one outcome:

- `ACCEPTED`: canonical state was created or advanced;
- `UNCHANGED`: this exact snapshot was already processed;
- `REVIEW_REQUIRED`: identity resolution is ambiguous;
- `REJECTED`: permanent validation or conflict failure;
- `RETRY`: transient failure or unresolved dependency.

Patient outcomes may include `centralPersonId`, `chsMedicalId`, and
`medicalIdStatus`. Error details use stable machine codes and JSON Pointers;
they must not echo patient values.

## CHS medical-ID assignment

When a patient is accepted as a new central person, canonical-person creation
and CHS medical-ID assignment are one PostgreSQL transaction. The response
returns both IDs in that patient outcome. If the patient snapshot contains a
known CHS medical ID, the server verifies it against the resolved person.

Possible duplicates are never merged automatically. They return
`REVIEW_REQUIRED`; no new medical ID is issued until review resolves the case.

## Medical-ID recovery

Recovery is an authenticated and audited internal operation. It never creates,
reassigns, or replaces an ID. The caller supplies the desktop installation and
patient identifiers plus demographic evidence. The response is one of:

- `MATCH_FOUND`, with the existing CHS medical ID;
- `NO_MATCH`, with no identity information;
- `REVIEW_REQUIRED`, with a case ID but no candidate patient disclosure.

Rate limiting, authorization, reason-for-access capture, and audit persistence
are mandatory in the endpoint implementation.

## Compatibility policy

Additive optional fields may be introduced within version 1 only after both
clients tolerate unknown response properties. Any new required field, changed
meaning, removed enum value, or incompatible validation rule requires a new
major contract path after version 1.0 is implemented. This draft amendment adds
required clinical-attribution fields before either sync endpoint or desktop
worker exists, so it remains contract version `1.0`. The desktop pins a reviewed
contract release and includes its own application/schema versions on every
batch.

## Security and privacy

- TLS is mandatory outside local development.
- Tokens and patient data never appear in logs, traces, metric labels, URLs, or
  error messages.
- Fixtures contain synthetic people only.
- The server binds the token to its installation and rejects an envelope whose
  `installationId` does not match.
- Raw request retention is disabled unless a separately approved encrypted
  retention policy is implemented.

## Acceptance criteria

- OpenAPI 3.1 documents all three operations and their security schemes.
- JSON Schema validates every version 1 request and response fixture.
- Invalid fixtures prove rejection of missing provenance, unknown properties,
  invalid enums, out-of-range vitals, unknown clinical actors, and invalid
  session-closing attribution.
- All local references, revisions, units, and time semantics are explicit.
- Batch and record retry behavior is deterministic.
- A patient outcome can return both central IDs without replacing desktop IDs.
- Recovery cannot create an ID or disclose candidate lists.
- Repository lint, type-check, test, and build commands pass.

## Out of scope

This task does not implement Fastify handlers, PostgreSQL migrations, a desktop
transport worker, token issuance, lifestyle/food records, FHIR mapping, a FHIR
server, provider access, the React viewer, or LLM analysis.
