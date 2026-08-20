# HSD-SYNC-002A: Sync batch intake foundation

Status: Implemented

## Purpose

This increment establishes the secure, transactional boundary used by the
future `POST /api/v1/sync/batches` handler. It authenticates an enrolled desktop
installation, binds the request to its approved organization and location,
creates the retry-safe batch, and preserves immutable actor snapshots.

The HTTP operation is intentionally not registered in this increment. Release
1 must not expose an endpoint that accepts clinical data before patient and
screening processors can produce truthful per-record outcomes.

## Installation credentials

Migration `0002_desktop_installation_credentials.sql` adds rotatable opaque
installation credentials. A credential belongs to exactly one desktop
installation and stores only:

- a non-secret display prefix;
- a SHA-256 digest of a high-entropy token;
- an administrative label;
- active or revoked state;
- issuance, optional expiry, revocation, and last-use timestamps.

The expected token format is `chs_inst_v1_` followed by 43 base64url
characters, representing 32 random bytes. The raw token is shown only when the
controlled [HSD-SYNC-003A](HSD-SYNC-003A.md) enrollment command creates it. It
is never stored, logged, placed in metrics, or included in errors.

Credential rotation/revocation and hospital/provider OAuth2 are separate tasks.
Installation bearer tokens authorize desktop synchronization only.

## Authentication rules

Authentication accepts exactly one bearer token. The server derives the token
prefix and digest and selects a credential only when:

- the credential is active, not revoked, and not expired;
- the linked desktop installation is active;
- the digest and prefix both match.

Missing credentials and invalid credentials use stable generic errors. The
database query never receives the raw token. The resulting internal context
contains the installation, organization, canonical configured location, and
IANA timezone.

## Transactional intake

The intake service performs these steps in one PostgreSQL transaction:

1. verify the authenticated installation matches the request envelope;
2. lock the active installation row, serializing intake for that desktop;
3. resolve the submitted desktop location UUID through
   `location_source_links` to the configured canonical location;
4. calculate a canonical SHA-256 request digest;
5. detect a new, in-progress, completed, conflicting, or failed prior batch;
6. create a `PROCESSING` batch when it is new;
7. create or safely refresh source-linked practitioners;
8. preserve the submitted actors in `sync_batch_actors`;
9. commit before returning control to the future clinical processor.

Actor and record array order has no effect on the batch digest. Object keys are
also sorted recursively. Record-internal array order remains significant unless
a future contract explicitly declares otherwise.

No raw clinical payload is retained. `sync_records` are deliberately not
created by intake because record-level idempotency and canonical targets must be
decided by the clinical processors. This also prevents a repeated record in a
new batch from violating a uniqueness constraint before it can receive the
contract-required `UNCHANGED` outcome.

## Retry and replay states

For the same installation and batch ID:

- a different canonical digest raises `BATCH_PAYLOAD_MISMATCH`;
- the same digest with `PROCESSING` returns `IN_PROGRESS`;
- the same digest with a stored response returns `REPLAY` and that exact JSON;
- a non-processing batch without a response returns `RECOVERY_REQUIRED` for
  controlled repair rather than silently reprocessing it.

The future HTTP orchestration layer maps these internal outcomes to the
HSD-SYNC-001 response and problem contracts.

## Verification

- unit tests cover strict bearer parsing, hashing, canonical JSON, order-neutral
  batch identity, and generic authentication failures;
- migration tests cover credential state, digest uniqueness, and idempotent
  application of both migrations;
- PostgreSQL integration tests cover authentication, new intake, actor
  persistence, in-progress retry, order-neutral retry, payload mismatch,
  transaction rollback, and stored-response replay;
- repository lint, type-check, test, build, and PostgreSQL test commands pass.

## Out of scope

This task did not itself issue tokens, register Fastify sync routes, validate
raw HTTP bodies against JSON Schema, process patient or clinical records,
assign medical IDs, implement medical-ID recovery, or implement the desktop
sync worker. Those web-side capabilities are delivered by later documented
increments; the desktop worker remains in the desktop repository.
