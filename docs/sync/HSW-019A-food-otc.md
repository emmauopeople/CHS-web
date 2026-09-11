# HSW-019A: Finalized Food and OTC uploads

Status: Implemented on a coordinated pair of review branches; PostgreSQL-server and Windows verification required before merge.

## Scope

Adds `FOOD` / `food.v1` and `OTC` / `otc.v1` to the existing batch envelope.
Existing v1 resources and immutable stored batches remain valid. The API processes
these after encounters and returns the existing per-record outcome shape.
No FHIR service or conversion is introduced.

Each resource is an immutable snapshot of one completed encounter. Its local
resource ID is the local encounter UUID; source revision is exactly `1`.
Food and OTC use distinct resource types, delivery IDs, canonical assessment IDs,
and outcome rows. A later encounter status change does not revise its original
reported intake. Corrections require a future explicit amendment contract; the
server refuses overwrites of finalized content.

## Data mapping

| Source | Transport and PostgreSQL |
| --- | --- |
| `food_logs` | `reported_food_rows`: food code/name, optional frequency and preparation note |
| `otc_medication_logs` | `reported_otc_rows`: product, reason, dose, frequency, duration, source, nullable currently-taking answer |
| Completed encounter | `reported_intake_assessments`: encounter/person ownership, source installation, completion time and recorder |
| Retained Food/OTC draft header | Original response and reporting period; no draft row content is uploaded |
| Row recorder and time | Source actor resolved through authenticated batch actor snapshots; clinical attribution retained |

A missing legacy response or period is null, never inferred as declined, no use,
or none reported. Explicit responses retain their distinct meanings. Only the
finalized log rows are exported; incidental draft content is not substituted for
those final records. Null optional Food frequency is valid.

Both resources allow at most 100 rows. The contract rejects unknown fields,
unknown actor references, duplicate row IDs, invalid dates/periods, mismatched
encounter identity, inconsistent response/row combinations, and row timestamps
that differ from completion time. The desktop fails closed on oversized local
aggregates without reserving or deleting their work.

## Persistence and recovery

Migration `0012_food_otc_ingestion.sql` adds three normalized tables, foreign
keys to the canonical encounter/installation/person and practitioners, and
immutable finalized-row triggers. It adds the assessment target to `sync_records`.
No raw clinical request JSON is retained centrally.

The processor serializes ingestion, verifies installation/batch/organization/location
ownership, and waits for a completed encounter dependency. A previously completed
but now voided encounter can retain its original history; any later reader must
consult encounter status and exclude voided clinical data by default.

All child rows and the outcome commit together. A failed insert rolls everything
back. Exact batch replay returns the saved response. A changed record under the
same delivery identity/revision is rejected; finalized content cannot be overwritten.

## Desktop behavior and deployment order

1. Verify and deploy CHS-web with PostgreSQL migration 0012 first.
2. Upgrade the desktop with SQLite migration 0022. It retains existing resource
   mappings and queues two new notifications for every already-completed local
   encounter, including subsequently voided encounters with a completion time.
3. New encounter completion queues both notifications within its existing SQLite
   transaction, including encounters with explicit non-reporting answers.
4. The existing automatic worker sends the snapshots, recovers uncertain results,
   and writes each outcome independently. Accepted finalized snapshots retire the
   corresponding older draft-save notifications; retry/rejection never clears them.

An old server rejects unfamiliar resource types, so do not roll out the desktop
first. Do not modify stored request bytes or clear queues during rollback.
Reverting a binary does not downgrade either database schema.

## Verification

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm docs:check
pnpm db:migrate
pnpm db:test
git diff --check
```

`DATABASE_TEST_URL` must refer to a disposable PostgreSQL test database for
`db:test`. The new integration file covers normalized values, exact batch replay,
missing dependency retry, draft rejection/retry, changed-content rejection,
transaction rollback, immutable rows, and installation isolation.
Embedded PostgreSQL validation is additional evidence and does not replace the
PostgreSQL 18 server gate or the paired Windows desktop checks.

## Remaining work

Referrals/follow-ups/treatment actions, addenda/review flags, patient-history
retrieval/caching, and Food/OTC presentation in the operations patient viewer are
not enabled by this increment. See the [expansion sequence](sync-expansion-sequence.md).
