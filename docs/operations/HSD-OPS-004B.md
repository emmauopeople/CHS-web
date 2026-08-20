# HSD-OPS-004B: Identity review resolution API

Status: Implemented

## Purpose

This increment gives an authorized internal reviewer a controlled way to close
an open identity-review case. A reviewer can either link the desktop-local
patient to one of the case's existing canonical candidates or confirm that the
submitted evidence represents a new individual.

Resolution is an irreversible canonical identity decision. The API therefore
uses explicit concurrency, idempotency, authorization, evidence, and audit
boundaries rather than accepting a general-purpose person update.

## Protected endpoint

`POST /api/v1/operations/identity-reviews/resolve` requires:

- a valid operations OIDC bearer token;
- an active server-side `IDENTITY_REVIEW_RESOLVE` grant; the queue and detail
  endpoints separately require `IDENTITY_REVIEW` access;
- organization scope derived from PostgreSQL;
- `reasonCode: "IDENTITY_RECONCILIATION"`;
- a client-generated UUID `resolutionRequestId`;
- the case's most recently displayed `expectedUpdatedAt`; and
- a reviewer note between 10 and 1,000 characters.

The action is exactly one of:

- `LINK_EXISTING`, with a `candidatePersonReference` already attached to the
  case; or
- `CREATE_NEW`, with no candidate reference.

The response returns the resolved canonical person reference and its full CHS
Medical ID to the separately authorized review workflow. It is non-cacheable.

## Transaction and race safety

Resolution runs in a PostgreSQL serializable transaction and locks the review
case. The expected update timestamp rejects a stale browser decision. A case
can have only one durable resolution command and only one source link.

The resolution request UUID and a SHA-256 hash of the normalized command make
network retries idempotent. An exact retry returns the stored outcome with
`replayed: true`; reuse of the UUID for changed input is rejected.

`LINK_EXISTING` succeeds only when the selected person is a current candidate,
is active, and has an active primary CHS Medical ID. It does not overwrite that
person's demographics.

`CREATE_NEW` requires a complete latest evidence snapshot. It creates the
canonical person, primary CHS Medical ID, desktop source link, closed review
case, resolution record, and success audit atomically. A failure rolls back all
of them.

## Evidence compatibility

Migration `0009_identity_review_resolution.sql` adds nullable
`acknowledgment_status` and `patient_status` fields to review evidence. New
sync-created snapshots populate both because they are required by the
canonical person model. Legacy snapshots remain readable, but `CREATE_NEW`
fails closed until a newer desktop revision supplies complete evidence.

The migration also creates `identity_review_resolutions`, which records the
idempotency key, request hash, action, selected and resolved person references,
resolved Medical ID, reviewer, expected case version, note, and decision time.

## Audit and privacy

Every successful decision writes `IDENTITY_REVIEW_RESOLVE` in the same
transaction as the identity mutation. Denied, stale, not-found, and failed
attempts are also audited. Audit metadata contains only stable decision codes
and state summaries; it excludes demographics, the Medical ID, and the
reviewer note.

Unknown and out-of-scope case references return the same not-found response.
Stable conflict codes distinguish stale state, a closed case, an unavailable
candidate, incomplete evidence, and idempotency-key reuse.

## Desktop reconciliation

Resolution creates the canonical `patient_source_links` row. A later desktop
patient revision therefore receives the confirmed canonical person and CHS
Medical ID through the existing sync path. Previously stored batch responses
remain immutable and continue to replay exactly.

A dedicated desktop polling/recovery endpoint for delivering a resolution
without a newer patient revision is intentionally a separate sync increment.

## Verification

Automated tests cover strict validation before database access, migration
ordering and schema shape, evidence persistence, scoped candidate linking,
new-person and Medical ID creation, exact command replay, incomplete evidence,
atomic source linking, non-cacheable responses, and audit outcomes. PostgreSQL
integration coverage runs when `DATABASE_TEST_URL` is configured.

## Out of scope

This increment does not merge two canonical persons, dismiss cases, allow
free-form candidate selection, edit candidate demographics, build the React
review workspace, or rewrite historical sync responses.
