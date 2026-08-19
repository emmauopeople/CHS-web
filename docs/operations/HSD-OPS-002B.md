# HSD-OPS-002B: Medical ID recovery

Status: Draft for implementation review

## Purpose

This increment lets authorized internal staff recover a patient’s existing CHS
Medical ID when its desktop copy is unavailable. It does not create a new
identifier, select between ambiguous identities, or merge people.

The workflow runs against accepted canonical PostgreSQL data and is exposed in
the React operations application added by HSD-OPS-002A.

## Authorization boundary

Both recovery endpoints require:

- a valid OIDC bearer access token;
- an active, enrolled operations user;
- a server-side `MEDICAL_ID_RECOVER` grant;
- global or organization scope derived from that grant; and
- a controlled reason-for-access.

`PATIENT_READ` does not imply recovery permission. The browser cannot submit an
organization scope. Recovery requests use POST JSON bodies, disable caching,
and keep demographics, candidate references, tokens, and Medical IDs out of
URLs.

## State machine

### 1. Masked candidate search

`POST /api/v1/operations/medical-id-recovery/search` accepts the patient’s full
name and exact date of birth. Matching is deliberately conservative: normalized
full name and date of birth must match exactly, the person must have an active
primary CHS Medical ID, and the person must be visible within the authorized
organization scope.

The server returns one of three non-disclosing outcomes:

- `NOT_RESOLVED`: no eligible candidate is safely available;
- `CANDIDATE_FOUND`: one masked candidate plus a five-minute confirmation
  token; or
- `REVIEW_REQUIRED`: multiple masked candidates and a review-case reference,
  with no confirmation token.

Zero matches and out-of-scope matches produce the same response. Candidate
references are opaque UUIDs. Candidate names, dates of birth, and residences
remain masked; the Medical ID is never returned by this step.

### 2. One-time confirmation

`POST /api/v1/operations/medical-id-recovery/reveal` requires the recovery
token, opaque candidate reference, explicit confirmation, and a reason. A
successful reveal is allowed only when:

- exactly one candidate was found;
- the token is unexpired and unused;
- the operations user and OIDC session match the search step; and
- the candidate still has an active primary CHS Medical ID.

The random token is never stored directly; PostgreSQL stores its SHA-256 hash.
The case changes atomically from `PENDING_CONFIRMATION` to `REVEALED`, so retrying
the token cannot reveal the ID again. A denial returns a generic not-available
response.

## Persistence and audit

Migration `0006_medical_id_recovery.sql` adds:

- `medical_id_recovery_cases`, containing the state, hashed token, hashed
  session binding, candidate count, and expiry; and
- `medical_id_recovery_candidates`, linking opaque candidate references to
  canonical people.

The migration also adds `REVIEW_REQUIRED` as an audit outcome. Search,
permission denial, ambiguity, successful reveal, replay, and unavailable-case
outcomes are audited. Audit metadata contains counts, scope, request context,
and state information only; it excludes submitted names, dates of birth,
candidate Medical IDs, and recovery tokens.

## React workflow

The operations application now provides a dedicated **Recover Medical ID**
view. It shares the required reason selector with the patient viewer, presents
masked candidates, requires explicit staff confirmation, and displays a
successfully recovered ID only in the current in-memory view. Changing the
reason clears recovery state. No recovery token or revealed identifier is
written to browser URLs or persistent storage.

Ambiguous candidates display the review-case reference and cannot be revealed
from this interface. Identity-review resolution and proof-based desktop
relinking are separate future increments.

## Verification

Automated coverage checks:

- dedicated permission and durable denial auditing;
- organization-scope isolation and indistinguishable not-found outcomes;
- masked candidate responses with no Medical ID disclosure;
- one-time, OIDC-session-bound reveal;
- ambiguous review cases without reveal tokens;
- unchanged active identifier count after recovery;
- migration ordering and recovery-table creation; and
- browser client use of POST bodies and strict response validation.
