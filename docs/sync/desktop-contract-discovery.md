# Desktop sync contract discovery

Status: completed for the HSD-SYNC-001 version 1 vertical slice. The resulting
decisions and machine-readable artifacts are documented in
[`HSD-SYNC-001`](../contracts/HSD-SYNC-001.md).

The sync API was not finalized until the existing desktop data model and
offline retry behavior were understood. No real patient data was used for this
exercise.

## Required inputs

- Current desktop repository or exported database schema.
- One synthetic example for every screening/questionnaire type.
- Current local identifiers for individuals, encounters, forms, observations,
  devices/installations, and facilities.
- Field types, units, optionality, allowed values, and validation rules.
- How edits, corrections, deletions, and partially completed screenings are
  represented.
- Current sync attempt/retry logic and how the desktop records acknowledgement.
- Expected maximum records and bytes per batch on low-bandwidth connections.
- Desktop application version and local schema version fields.
- Facility and screening-team identifiers available on the desktop.

## Questions to resolve

1. Is a stable installation ID already created and persisted?
2. Is every local record assigned an immutable ID before its first sync?
3. Can records change after they have synced? If so, how is version order known?
4. Does the desktop need partial batch acceptance with per-record outcomes?
5. Which demographic attributes are reliable enough for deterministic or
   probabilistic duplicate detection?
6. Which fields are clinically meaningful versus UI-only or calculated?
7. What must be returned with a newly assigned CHS medical ID?
8. What evidence can safely support medical-ID recovery?
9. What retention is required for rejected or unprocessable source payloads?
10. What clock, timezone, locale, and units assumptions exist offline?

## Contract outputs

Discovery will produce versioned JSON Schemas and OpenAPI definitions for:

- sync batch envelope;
- individual demographics;
- screening encounter and measurements;
- per-record acceptance, rejection, or review outcome;
- CHS medical-ID assignment acknowledgement;
- durable reviewer-resolution pull and local-commit acknowledgment;
- medical-ID recovery request and response;
- compatibility/error responses.

The accepted schemas will be represented in synthetic contract tests shared by
the API and desktop application.

## Findings

- Stable installation, location, patient, session, encounter, vitals, and
  reading UUIDs already exist.
- The installation stores an IANA timezone and records expose row or record
  revisions.
- The current outbox is durable but its payloads are audit notifications, not
  complete clinical snapshots.
- The desktop sync worker must materialize the current full snapshot from
  SQLite and keep the outbox ID as its delivery idempotency key.
- Patient local codes are installation-local. A returned CHS medical ID is an
  additional identifier and never replaces the desktop patient UUID.
- Version 1 covers patient demographics, sessions, encounters, and vitals.
  Lifestyle and food payloads remain deferred until their desktop persistence
  models stabilize.
- Reviewer-resolved identity assignments remain pending on the web until the
  originating desktop commits the canonical identifiers locally and sends an
  idempotent acknowledgment.
