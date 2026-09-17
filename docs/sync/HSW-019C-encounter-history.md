# HSW-019C: encounter addenda and review history

## Scope and records

This increment uploads source-owned encounter annotations to canonical PostgreSQL.
It leaves the clinical workflow unchanged. Patient Viewer retrieval and display
of these records belongs to HSW-019D; the new types are visible in Sync Monitoring.

| Resource | Payload | Revision |
| --- | --- | --- |
| `ENCOUNTER_ADDENDUM` | Original encounter, note, author and creation time | Immutable `1` |
| `ENCOUNTER_REVIEW_FLAG` | Original encounter, category, description, opening author and time | Immutable `1` |
| `ENCOUNTER_REVIEW_STATUS` | Flag, sequence, prior/new state, reason, actor and occurrence time | Immutable `1` |

Each child has a separate local identity and deterministic delivery ID derived
from installation, resource type, identity and revision. Closing a flag does not
alter its original definition. Notes never rewrite the originating encounter.
Histories can span the existing 100-record, 50-actor bounded batches.

## Lifecycle and provenance

The initial event is sequence 1, null to OPEN, with the flag's original opener
and opening time. Resolution and dismissal require a reason. Each later event
must follow the preceding event's state and cannot precede its timestamp.
Missing encounters, flags or prior events return retryable dependency outcomes;
the batch orchestrator retries dependencies that become available in the same
batch. Later batches can finish previously deferred records.

The contract also represents RESOLVED/DISMISSED to OPEN as a new reasoned event,
retaining the closure. The current desktop has no reopen action: it only opens,
resolves or dismisses a flag. Its migration therefore reconstructs exactly the
one opening and optional closure retained in existing rows. It does not invent
reopening events or add a reopening UI. A future desktop reopening feature must
extend its lifecycle storage before emitting those events.

Every event uses its actual author's actor catalog entry, including inactive
authors. Missing attribution fails closed. Capture time must equal the original
recording/occurrence timestamp, not the batch time. A later void does not erase
the encounter's previously recorded annotations.

## Storage and replay

PostgreSQL migration `0015_encounter_history_ingestion.sql` adds four normalized
tables: `encounter_history_resources`, `encounter_addenda`,
`encounter_review_flags`, and `encounter_review_status_events`. Composite foreign
keys keep identities, resource types, encounters and installation ownership
consistent. All four reject updates and deletes. Unique source identities and
flag sequences reject competing histories. Current flag state is the last
accepted event, rather than a mutable overwrite of earlier status.

The processor checks authenticated batch organization and location, resolves
only source-installation dependencies, and saves the resource, clinical row and
outcome atomically. Separate delivery and content hashes reject changed retries.
Exact record replay returns UNCHANGED; exact batch replay returns the stored
response. The sync ledger contains hashes and canonical links, not clinical note
payloads. Operational logs and outbox metadata exclude note and reason text.

## Desktop upgrade and deployment

Desktop migration 25 creates immutable status history, expands canonical mapping
types and queues existing local annotations. Legacy annotation signals that
previously were not eligible for transport are retargeted to their own child
identities; duplicate signals coalesce. Database triggers queue new notes, flag
definitions and events in the same caller-owned transaction as the clinical
write. A failed signal insert rolls back that write. Already closed flags cannot
have their reason or attribution rewritten. Startup validation checks the new
table and exact trigger definitions.

Deploy CHS-web and apply migration 0015 before upgrading desktop to schema 25.
Restart the API before allowing the desktop to send the new resource types.
No credentials or local database reset are needed.

## Acceptance

Automated coverage includes historical backfill, original authors, late status
changes, closure/reopening contract semantics, void retention, bounded batches,
missing dependencies, installation scope, altered replay, immutable rows and
transaction rollback. PostgreSQL integration runs in CI against PostgreSQL 18.

For paired Windows verification, record an addendum and open a review flag on a
completed test encounter. Allow sync, then resolve or dismiss the flag with a
reason and sync again. Confirm ACCEPTED/UNCHANGED outcomes for the three new
resource types in Sync Monitoring. Restart and confirm no duplicate history.
Patient Viewer will not show addenda/review history until its HSW-019D expansion.
