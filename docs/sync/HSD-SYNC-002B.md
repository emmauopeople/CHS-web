# HSD-SYNC-002B: Patient identity ingestion and Medical ID assignment

Status: Implemented

## Purpose

This increment processes validated `PATIENT / patient.v1` records after secure
batch intake. It creates or advances canonical people, assigns a CHS Medical ID
to a new person, links an existing Medical ID only after identity verification,
and sends ambiguous identities to review without disclosing candidate data.

The complete Fastify sync route and dependency-ordered batch orchestration are
delivered by HSD-SYNC-002F.

## Identity resolution order

Patient processing is conservative and follows this order:

1. replay an already processed delivery or source snapshot;
2. resolve the installation's existing patient source link;
3. when a CHS Medical ID was supplied, resolve that exact active identifier;
4. verify a new source link using normalized full name and exact date of birth;
5. without a known ID, search for possible duplicates using normalized name
   plus exact date of birth, normalized phone, or approximate age within one
   year;
6. open an identity-review case when one or more candidates exist;
7. create a new canonical person and Medical ID only when no candidate exists.

Candidate matches are never auto-merged. Approximate age can trigger review for
people without a known birth date, but it is not strong enough to link an
existing Medical ID automatically. Such a link requires manual review.

Name normalization removes accents and punctuation, ignores case and spacing,
and sorts name tokens so `NFOR Mbah, Emile` and `Émile Nfor-Mbah` compare
consistently. The original name remains unchanged in the canonical person row.
Phone comparison removes formatting and normalizes nine-digit Cameroon mobile
numbers to the `237` country-code form; the original phone text is preserved.

## Medical ID

The generated display form is `CHS-XXXX-XXXX-XXXX`. Its 12 random Crockford
Base32 characters provide 60 bits of entropy and omit letters that are easily
confused when a card or handwritten number is read. The value is opaque and
non-sequential; clients must not derive meaning from it.

The identifier system is the versioned URI `urn:chs:id:medical-id:v1` and the
identifier type is `CHS_MEDICAL_ID`. PostgreSQL uniqueness is authoritative.
Generation retries a collision without exposing an intermediate value.

New-person creation, identifier insertion, source linking, and the accepted
sync record occur in one PostgreSQL transaction. If identifier issuance cannot
complete, none of those rows commit.

## Record idempotency and ordering

The processor enforces both HSD-SYNC-001 keys before changing canonical data:

- `(installation_id, record_id)` for delivery identity;
- `(installation_id, resource_type, local_resource_id, source_revision)` for
  source-snapshot identity.

The full record receives a canonical SHA-256 digest; the patient source link
also retains a digest of the demographic payload. An exact retry returns
`UNCHANGED`. Changed content under an existing key returns
`RECORD_PAYLOAD_MISMATCH`. A revision below the accepted source revision returns
`STALE_SOURCE_REVISION`.

## Concurrency

Patient identity decisions acquire a transaction-scoped PostgreSQL advisory
lock. This prevents two installations from simultaneously checking the same
demographics, both finding no candidate, and issuing two central identities.
The conservative global lock is appropriate for Release 1 screening volume;
it can later be partitioned only with equivalent race-safety proof.

Indexes added by migration `0003_patient_identity_matching_indexes.sql`
support name/birth-date, name/phone, name/approximate-age, and active Medical ID
lookup.

## Outcome and privacy rules

- a new person returns `ACCEPTED`, `ASSIGNED`, the central person UUID, and the
  new CHS Medical ID;
- an accepted update or exact retry returns the existing ID as `CONFIRMED`;
- an ambiguous match returns `REVIEW_REQUIRED` and `PENDING_REVIEW`, with no
  person UUID or Medical ID;
- an unknown or conflicting known ID is rejected with a stable code;
- errors contain only machine codes and JSON Pointers, never patient values;
- raw patient payloads are not persisted in sync tables or logs.

Migration `0008_identity_review_evidence.sql` adds the structured,
minimum-necessary evidence needed by a future protected review workflow. The
snapshot is stored outside sync tables, excludes raw JSON and nonessential
fields, is append-only by source revision, and is created atomically with the
review outcome. Once review is open, later unlinked revisions remain in review
until an authorized resolution workflow acts.

HSD-OPS-004B implements that workflow. New evidence snapshots also retain the
submitted acknowledgment and patient status needed for canonical person
creation. After resolution creates the source link, a newer patient revision
returns the confirmed Medical ID through this sync processor; immutable stored
responses for older batches are not rewritten.

For a patient outcome, `canonicalResourceId` and `centralPersonId` both identify
the canonical `persons.id` row.

## Verification

- unit tests cover Medical ID format and demographic normalization;
- PostgreSQL integration tests cover atomic assignment, source advancement,
  exact retries, stale revisions, verified known-ID linking, duplicate review,
  non-disclosure, unknown/conflicting IDs, and transaction rollback;
- migration tests verify the immutable identity lookup indexes;
- repository lint, type-check, test, build, and PostgreSQL CI gates are required.

## Out of scope

This sync task does not itself resolve review cases, recover a lost Medical ID, process
session/encounter/vitals records, complete batches, expose sync HTTP routes,
implement the desktop sync worker, or build the React patient viewer.
