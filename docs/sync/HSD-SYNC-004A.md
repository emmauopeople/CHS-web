# HSD-SYNC-004A: Identity resolution delivery

Status: Implemented

## Purpose

This increment completes the ambiguous-patient identity round trip. When an
authorized reviewer resolves an identity-review case, the originating desktop
can receive the confirmed canonical person reference and CHS Medical ID even
if it has no newer patient revision to submit.

The delivery is a durable acknowledged outbox. It is not a one-time
notification and does not modify historical batch responses.

## Installation-authenticated endpoints

- `POST /api/v1/sync/identity-resolutions/pull`
- `POST /api/v1/sync/identity-resolutions/acknowledge`

Both endpoints require the active opaque bearer credential already bound to one
desktop installation. The installation ID is derived from the credential and
is never accepted from the request body. Both use contract version `1.0`, JSON
POST bodies, and non-cacheable responses.

Pull accepts an optional limit from 1 to 100 and returns only pending
assignments for the authenticated installation. Each assignment contains:

- the resolution reference;
- the desktop-local patient UUID and `PT-######` code;
- the source patient revision on which the review was resolved;
- the canonical person UUID and full CHS Medical ID; and
- the server resolution time.

No demographics, candidate list, reviewer identity, reviewer note, clinical
data, raw payload, or content hash is returned.

## Desktop application sequence

For each pulled assignment, the desktop sync engine must:

1. locate the patient by the immutable local patient UUID;
2. confirm the local code is consistent and that the assignment is not older
   than the applicable local identity state;
3. commit the canonical person reference and CHS Medical ID in one SQLite
   transaction without replacing the local patient UUID;
4. persist a client-generated acknowledgment UUID before transmission; and
5. acknowledge only after the SQLite transaction commits.

If the local patient is missing or already contains a conflicting central
identity, the desktop must retain the assignment unacknowledged and surface a
local reconciliation error. It must not silently overwrite the identity.

## Durability and idempotency

Migration `0010_identity_resolution_delivery.sql` creates one immutable
delivery snapshot per resolution. New resolutions enqueue their delivery in
the same serializable transaction that creates the canonical source link and
audit event. The migration backfills earlier resolutions, while pull also
performs an idempotent installation-scoped backfill to protect rolling
deployments where an older API instance may resolve a case after the migration
is applied.

Pull does not mark a row delivered. Pending assignments repeat across polling,
application restarts, and lost responses until acknowledged.

Acknowledgment records the client application time and server acknowledgment
time. Repeating the same acknowledgment UUID, resolution reference, and
application time returns the stored success with `replayed: true`. Reusing or
changing the acknowledgment command returns a stable conflict and does not
alter the stored state.

## Isolation and privacy

Queries always include the authenticated installation ID. An unknown
resolution and a resolution owned by another installation return the same
not-found response. Patient identifiers and Medical IDs do not appear in URLs,
logs, metric labels, or problem responses.

Prometheus counters report only whether a successful pull was empty or
contained deliveries, whether more rows were available, and whether an
acknowledgment was replayed.

## Verification

Automated tests cover contract schemas and synthetic fixtures, validation
before database access, migration ordering and constraints, transactional
enqueueing, installation isolation, redacted pull responses, exact
acknowledgment replay, conflicting acknowledgment rejection, non-cacheable
responses, and removal from the pending queue only after acknowledgment.

## Out of scope

The desktop SQLite sync worker that applies and acknowledges these assignments
belongs in the desktop repository. This increment does not rewrite stored batch
responses, transmit reviewer notes, merge two canonical people, or deliver
hospital/provider access tokens.
