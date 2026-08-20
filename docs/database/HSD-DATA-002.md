# HSD-DATA-002: Identity review evidence foundation

Status: Implemented

## Purpose

This increment makes sync-created identity-review cases usable by a later,
separately authorized review workflow. Before this change, a case retained its
desktop installation, local patient UUID, and possible canonical candidates,
but not the submitted demographic evidence needed to compare those candidates
safely.

Migration `0008_identity_review_evidence.sql` adds structured, append-only
evidence snapshots. Patient ingestion creates the review case, evidence,
candidate links, sync outcome, and record provenance in the same PostgreSQL
transaction.

This task does not expose review data through HTTP and does not resolve, merge,
create, or dismiss an identity.

## Minimum-necessary evidence

Each snapshot contains only fields needed for identity comparison and source
provenance:

- review-case, source-record, source-revision, and schema identifiers;
- captured, source-created, source-updated, received timestamps, and payload
  SHA-256 hash;
- desktop-local patient code and optional claimed CHS Medical ID;
- submitted and normalized name components;
- exact date of birth, or approximate age with its as-of date;
- sex, phone and normalized phone; and
- village and quarter; and
- for snapshots written after migration `0009`, acknowledgment and patient
  status needed by controlled new-person resolution.

The table deliberately excludes alternate contacts, residence notes,
screening/clinical data, raw request JSON, access tokens, and credentials. The
later resolution migration adds only acknowledgment and patient status because
both are mandatory when an authorized reviewer creates a canonical person. The
sync record continues to store hashes and stable error codes rather than raw
payloads.

These snapshots contain protected identity data. They are not part of the
general patient viewer or synchronization-monitoring responses. HSD-OPS-004A
protects review reads with the independent `IDENTITY_REVIEW` permission,
server-derived organization scope, a controlled reason, no-store responses,
and durable access auditing.

## Append-only revision model

One evidence snapshot is stored for each `(review_case_id, source_revision)`.
Source record identity is also unique within a case. A newer desktop revision
therefore adds evidence without overwriting the earlier decision context.

An exact sync replay is handled by the existing sync-record idempotency path and
does not add another snapshot. PostgreSQL uniqueness remains a second line of
defense.

Once a local patient has an open review case, a later unlinked revision remains
`REVIEW_REQUIRED` even when its corrected demographics no longer produce an
automatic candidate. This prevents a changed submission from bypassing the
manual-review boundary and creating a second person while the earlier case is
still open.

Candidate rows remain conservative possible links. New evidence may add
candidate links, but ingestion never selects or merges a candidate.

## PostgreSQL constraints and query support

The migration enforces:

- positive source revisions and unique revision/record keys per case;
- UUID foreign-key ownership by an identity-review case;
- SHA-256 payload-hash format and desktop patient-code format;
- bounded claimed-ID presence;
- nonblank display and normalized names;
- exactly one valid birth-date or approximate-age representation;
- allowed sex values; and
- ordered source timestamps.

`ix_identity_review_evidence_latest` supports retrieving the newest evidence
for a case without copying identity data into a second read store.

## Existing open cases

Migration `0008` does not invent or backfill demographic evidence for cases
created before the migration because raw patient payloads were intentionally
not retained. A later exact replay remains idempotent and cannot reconstruct
missing data. The desktop must submit a newer source revision for that local
patient to add a trustworthy evidence snapshot.

An identity-review API must represent a legacy case without evidence as
`EVIDENCE_PENDING`; it must not guess values from candidates or silently
resolve the case.

## Verification

Automated coverage verifies:

- immutable migration ordering, checksum discovery, table, constraints, and
  latest-evidence index;
- exclusion of raw JSON, residence notes, and alternate contacts from the
  evidence schema;
- atomic evidence creation for possible-duplicate and failed-known-ID cases;
- claimed-ID, source, normalized identity, and location evidence persistence;
- append-only snapshots across source revisions; and
- prevention of automatic person creation while a review case remains open.

## Query increment

HSD-OPS-004A adds a read-only, organization-scoped identity-review queue and
case-detail API over the newest evidence and masked candidate rows. Resolution
writes are implemented by HSD-OPS-004B; the React review workspace remains a
separate task.
