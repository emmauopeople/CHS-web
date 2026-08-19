# HSD-DATA-001: Canonical PostgreSQL schema foundation

Status: Draft for implementation review

## Purpose

This task defines the first canonical PostgreSQL model for Release 1. The model
must accept the HSD-SYNC-001 snapshots, support duplicate-safe medical-ID
assignment, power the temporary patient viewer, and preserve the clinical
relationships needed for later FHIR mapping.

PostgreSQL is the canonical application system of record. It is not a FHIR
server and its tables do not copy FHIR resource JSON. A later mapping service
will construct FHIR resources from normalized clinical rows and store them in a
separate FHIR server.

## FHIR relationship boundary

The model preserves these distinct concepts:

- an `organization` is the program or facility responsible for the service;
- a `location` is the physical or mobile place where screening occurred;
- a `practitioner` is the person who performed or asserted the screening data;
- a `practitioner_role` links that person to an organization, role, and
  optional location;
- a shared desktop `screening_session` is an operational day/location grouping;
- a `screening_encounter` is the individual patient's healthcare interaction;
- vitals and readings are the clinical facts used to build observations;
- source links and sync records preserve the data-import provenance.

The shared daily screening session is not mapped directly to a FHIR Encounter.
Each patient screening encounter is mapped separately.

## Canonical ownership and source identity

Canonical IDs are server UUIDs except `desktop_installations.id`, which retains
the stable desktop installation UUID. Desktop-local patient, session,
encounter, vitals, reading, protocol, and actor IDs are retained in dedicated
source-link columns or tables.

Source IDs never replace canonical IDs. A future reconciliation workflow may
link actor records from multiple installations to the same practitioner, but
the ingestion service must not make that inference automatically.

## Actor snapshots and clinical attribution

HSD-SYNC-001 includes a batch-level `actors` array containing:

- immutable local actor UUID;
- display name;
- desktop role (`LOCAL_ADMIN`, `NURSE`, or `TRAINED_SCREENER`);
- active status;
- source update timestamp.

Every submitted record references the actor responsible for the synchronized
mutation through `sourceActorLocalId`. Session, encounter, and vitals payloads
also reference their clinical actors separately. Every non-null reference must
resolve to exactly one actor snapshot. Usernames, password data, and
authentication secrets are not synchronized.

The ingestion mapping is explicit:

| Contract attribution | Canonical column |
| --- | --- |
| Session `openedByLocalActorId` | `screening_sessions.opened_by_practitioner_id` |
| Session `closedByLocalActorId` | `screening_sessions.closed_by_practitioner_id` |
| Encounter `recordedByLocalActorId` | `screening_encounters.recorded_by_practitioner_id` |
| Vitals `performedByLocalActorId` | `screening_vital_sets.recorded_by_practitioner_id` |

`sourceActorLocalId` remains linked to the immutable sync record and batch actor
snapshot for provenance. Ingestion must not use it as a fallback for a missing
clinical actor. The schema already has the required practitioner columns, so
this contract clarification does not require a new PostgreSQL migration.

## Core tables

### Administration and provenance

- `organizations`
- `locations`
- `desktop_installations`
- `location_source_links`
- `practitioners`
- `practitioner_source_links`
- `practitioner_roles`
- `screening_protocols`
- `protocol_source_links`

### Identity

- `persons`
- `person_identifiers`
- `patient_source_links`
- `identity_review_cases`
- `identity_review_candidates`

### Screening

- `screening_sessions`
- `screening_encounters`
- `screening_vital_sets`
- `vital_readings`

### Synchronization and audit

- `sync_batches`
- `sync_batch_actors`
- `sync_records`
- `audit_events`
- `schema_migrations`, owned by the migration runner

## FHIR mapping readiness

| Canonical source | Later FHIR output | Required relationship/data |
| --- | --- | --- |
| `persons`, `person_identifiers` | `Patient` | demographics and CHS identifier |
| `practitioners`, source links | `Practitioner` | stable source identifier and display name |
| `practitioner_roles` | `PractitionerRole` | practitioner, organization, role, location, validity |
| `organizations` | `Organization` | responsible program/facility |
| `locations`, source links | `Location` | physical site, managing organization, and desktop source identity |
| `screening_encounters` | `Encounter` | patient, participant, service provider, location, period |
| vital sets/readings | `Observation` | subject, encounter, performer, effective time, code, value, unit, body site/method where applicable |
| sync batches, actor snapshots, records | `Provenance` | source system, source ID/revision, actor snapshot, recorded time, transformation activity |

Blood pressure can later become one vital-signs Observation panel with systolic
and diastolic components. Pulse, body weight, and waist circumference can be
separate Observations tied to the same patient encounter and performer. Exact
FHIR profiles and terminology mappings are versioned in the future mapping
service rather than hard-coded into the canonical clinical rows.

## Observation-supporting data rules

Every accepted screening encounter must have:

- one canonical person;
- one organization and location;
- one protocol version;
- one performing practitioner and, when resolved, practitioner role;
- source installation, local encounter ID, revision, content hash, and source
  timestamps;
- start time and optional completion time.

Every accepted vital set must reference its encounter and recording
practitioner. Every reading retains sequence, blood-pressure values, pulse,
measurement site, patient position, local clinical date/time, IANA timezone,
derived instant when available, and source timestamps.

Application validation is still required. PostgreSQL constraints enforce
structural invariants, bounds, uniqueness, ownership relationships, and
referential integrity; they do not perform identity matching or timezone
conversion.

## Medical-ID rules

- `(identifier_system, identifier_value)` is globally unique.
- At most one active primary identifier of a given type exists per person.
- Person creation and CHS medical-ID insertion occur in one transaction.
- Recovery reads an existing identifier and never inserts a replacement.
- Ambiguous matches create an identity review case rather than merging persons.

## Sync persistence rules

- Store request and record SHA-256 hashes, not raw PHI payloads.
- Preserve each batch's actor snapshots separately from the actor's latest
  source-link state.
- Store the final response JSON so a lost response can be replayed safely.
- Enforce unique `(installation_id, batch_id)` and
  `(installation_id, record_id)` delivery keys.
- Enforce unique source snapshot identity by installation, resource type,
  local resource ID, and source revision.
- A sync record points to at most one type-appropriate canonical target.
- Error JSON contains machine codes and JSON Pointers, never source values.

## Migration policy

Numbered SQL migrations are immutable after merge. The migration runner:

1. obtains a PostgreSQL advisory transaction lock;
2. creates `schema_migrations` if necessary;
3. verifies the SHA-256 checksum of every previously applied migration;
4. applies pending files in lexical order in one transaction;
5. records version, filename, checksum, and application time.

Application startup does not run migrations. Deployment runs the migration
command as a controlled job before rolling out API pods.

## FHIR references used for the design

- [FHIR R4 Observation](https://hl7.org/fhir/R4/observation.html)
- [FHIR R4 Encounter](https://hl7.org/fhir/R4/encounter.html)
- [FHIR R4 Practitioner](https://hl7.org/fhir/R4/practitioner.html)
- [FHIR R4 PractitionerRole](https://hl7.org/fhir/R4/practitionerrole.html)
- [FHIR R4 Organization](https://hl7.org/fhir/R4/organization.html)
- [FHIR R4 Location](https://hl7.org/fhir/R4/location.html)
- [FHIR R4 Provenance](https://hl7.org/fhir/R4/provenance.html)

FHIR R4 is used here as a stable relationship baseline. The canonical model
keeps FHIR version-specific serialization and profiles outside PostgreSQL so a
later FHIR-server decision can be made without redesigning the clinical schema.

## Out of scope

This task does not implement sync handlers, identity matching, medical-ID
generation, the patient viewer, OAuth2, FHIR serialization, a FHIR server, or
FHIR export tracking.
