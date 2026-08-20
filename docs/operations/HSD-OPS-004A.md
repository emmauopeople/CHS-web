# HSD-OPS-004A: Identity review query API

Status: Implemented

## Purpose

This increment provides the read-only backend boundary for investigating open
patient identity-review cases. It lets a separately authorized internal
reviewer compare the newest submitted desktop identity evidence with masked
canonical candidates before using the controlled resolution action implemented
by HSD-OPS-004B.

This is not a patient-search endpoint and does not expose review data to users
with only `PATIENT_READ`, `MEDICAL_ID_RECOVER`, or `SYNC_MONITOR` access.

## Protected endpoints

- `POST /api/v1/operations/identity-reviews/search`
- `POST /api/v1/operations/identity-reviews/detail`

Both endpoints require:

- a valid operations OIDC bearer token;
- an active server-side `IDENTITY_REVIEW` grant;
- scope derived from PostgreSQL rather than the request;
- `reasonCode: "IDENTITY_RECONCILIATION"`; and
- a non-cacheable JSON POST body.

The search endpoint supports evidence state, installation, opened-time, and
bounded pagination filters. It lists open cases only. The detail endpoint
accepts a UUID case reference and returns the same not-found response for an
unknown case and a case outside the caller's organization scope.

## Data-minimization boundary

The queue is designed for triage. It returns case and deployment context,
candidate count, source revision/timing, local patient code, a masked submitted
name, and masked birth evidence. Cases created before evidence snapshots were
available are explicitly returned as `EVIDENCE_PENDING`.

The case-detail endpoint returns the newest minimum-necessary submitted
evidence because an authorized reviewer must compare what the desktop supplied.
The claimed CHS Medical ID remains masked. Every canonical candidate is also
masked:

- name components expose their first character only;
- dates of birth expose the day only, while approximate ages expose age and
  as-of year;
- phone numbers expose only their last two characters;
- residence words expose their first character only; and
- CHS Medical IDs expose the prefix and final four characters only.

Raw request JSON, payload hashes, normalized identity fields, clinical data,
credentials, and access tokens are never returned. A queue response does not
contain exact submitted demographics.

## Consistency and failure behavior

Case detail and candidate rows are read in a PostgreSQL repeatable-read,
read-only transaction. A malformed persisted evidence or candidate birth
invariant fails closed as an internal error; it is not silently omitted or
reported as a missing case.

All responses carry `Cache-Control: no-store`; protected routes also set
`Pragma: no-cache`. Invalid filters are rejected before database access.

## Audit

Every authorized query attempt writes an append-only audit event with the
controlled reason and one of these actions:

- `IDENTITY_REVIEW_LIST_VIEW`
- `IDENTITY_REVIEW_DETAIL_VIEW`

Audit outcomes distinguish success, denied input, scoped not-found, and
unexpected error. Authorization denials retain only a one-way principal
fingerprint when no enrolled operations user can be attached. Audit metadata
contains scope and query/result summaries, never submitted evidence or
candidate identity data.

## Verification

Automated tests cover validation before database access, organization scoping,
legacy evidence state, queue and candidate masking, repeatable-read cleanup,
indistinguishable missing/out-of-scope cases, dedicated authorization, reason
enforcement, non-cacheable responses, and durable audit outcomes. PostgreSQL
integration tests run when `DATABASE_TEST_URL` is configured.

## Out of scope

This query increment does not itself resolve, merge, create, dismiss, or mutate
identity cases. HSD-OPS-004B provides the separate guarded resolution endpoint.
HSD-OPS-004C provides the React identity-review workspace.
