# HSD-OPS-001A: Canonical patient query service

Status: Implemented

## Purpose

This increment establishes the read-only PostgreSQL service that will power the
temporary React patient viewer. It reads only accepted canonical entities; the
browser never connects directly to PostgreSQL.

The service is intentionally internal. No patient HTTP route is registered
until operations-user authentication, authorization, reason-for-access, and
read auditing are implemented.

## Patient list

`listCanonicalPatients` returns a bounded, alphabetical page containing:

- canonical person UUID and active primary CHS Medical ID;
- display name, DOB or approximate-age context, sex, status, and residence;
- the latest non-void screening time, state, and location visible within the
  caller's access scope.

The query supports:

- exact, case-normalized CHS Medical ID search;
- normalized name-prefix search;
- exact DOB filtering;
- active, inactive, deceased, or all status filtering;
- page sizes from 1 to 100 and a bounded page number.

Search values will later be carried in redacted POST bodies, not URLs, because
names and Medical IDs must never appear in access logs, metric labels, or query
strings.

## Patient clinical detail

`getCanonicalPatientDetail` returns canonical demographics and paginated,
newest-first screening history. Each screening includes:

- encounter state and period;
- session date and protocol version;
- organization and physical screening location;
- recording practitioner;
- amendment relationship and reason when applicable;
- vital-set state, weight, waist measurement, notes, and performer;
- ordered blood-pressure/pulse readings with source local time, IANA timezone,
  and derived clinical instant.

HSD-OPS-005A extends the same scoped result with one finalized normalized
Lifestyle assessment per encounter, including its exact immutable baseline
versions and weekly responses. Desktop-local identifiers, hashes, and raw
payloads remain excluded.

Voided encounters are excluded from clinical history and latest-screening
summaries. Draft encounters and vital sets remain visible with their explicit
state so incomplete data is not presented as completed care.

## Identity boundary

The service starts from `persons` joined to an active primary CHS Medical ID.
An unresolved identity-review submission does not create a new canonical
person, so it cannot appear as a duplicate patient in the viewer. Review cases
and candidate scores remain outside patient-facing results.

Desktop-local patient codes, source UUIDs, sync hashes, and raw payloads are not
returned.

## Authorization-ready scope

Every service call requires an explicit access scope:

- `GLOBAL` for a future centrally authorized CHS operations administrator;
- `ORGANIZATIONS` with at least one validated organization UUID.

Organization eligibility is established through canonical patient source
registrations and their enrolled desktop installations. Screening history is
filtered again by encounter organization, preventing an organization-scoped
caller from reading another organization's encounter merely because the same
person has visited both.

The future HTTP layer must derive this scope from authenticated server-side
claims. It must never accept a global flag or arbitrary organization list from
the React client.

## Consistency and performance

List and detail operations run in repeatable-read, read-only PostgreSQL
transactions. Detail loading uses one patient query, one count, one paginated
relationship query, and one batched vital-reading query; it does not issue a
query per screening.

Migration `0004_patient_viewer_query_indexes.sql` adds:

- status and normalized-name prefix lookup for patient lists;
- newest-first non-void encounter history lookup by person.

The existing active Medical ID and patient-source indexes support identifier
search and authorization scope.

## Verification

- unit tests reject malformed scopes, pagination, dates, and person IDs before
  PostgreSQL is contacted;
- migration tests verify the two read indexes and idempotent migration history;
- PostgreSQL integration tests verify organization isolation, global access,
  name/Medical ID/DOB search, pagination, canonical-only results, non-void
  history, practitioner/location/protocol relationships, and complete vital
  readings;
- repository lint, type-check, test, build, and PostgreSQL CI gates are
  required.

## Out of scope

This task does not expose patient HTTP routes, authenticate operations users,
write sensitive-read audit events, build the React interface, implement Medical
ID recovery, resolve identity-review cases, map FHIR resources, or allow
hospital/provider access.
