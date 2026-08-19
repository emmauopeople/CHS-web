# HSD-SYNC-002F: Batch orchestration and sync endpoint activation

Status: Draft for implementation review

## Purpose

This increment completes the first usable desktop-to-web synchronization path.
It connects the existing installation authentication, batch intake, patient,
session, encounter, and vitals processors behind the HSD-SYNC-001 HTTP
contract.

The API now exposes:

- `POST /api/v1/sync/batches` to submit a version 1.0 snapshot batch;
- `GET /api/v1/sync/batches/{batchId}` to recover the immutable stored response
  when the desktop loses the original HTTP response.

The Medical ID assigned by the patient processor is returned in that patient's
record outcome. No separate desktop callback is required.

## Request boundary

The POST route authenticates the opaque installation bearer token before
performing contract validation. The shared contracts package validates the
request against the canonical JSON Schema and then applies the cross-record
rules that JSON Schema cannot express safely:

- unique actor and record IDs;
- unique source snapshot keys;
- complete actor references;
- unique and contiguous vital-reading sequences;
- installation-bound measurement timezone.

Invalid requests receive a generic RFC 9457-style problem response. Validation
issues, submitted values, clinical payloads, and tokens are not written to logs
or returned in errors. The existing one MiB Fastify body limit remains active.

## Dependency processing

Request array order has no processing meaning. Records are sorted
deterministically by:

1. patient;
2. screening session;
3. screening encounter;
4. vitals;
5. local resource ID, source revision, and record ID within each type.

Outcomes are placed back in the exact request order before the response is
stored. A dependency retry is reprocessed in bounded passes so an amendment or
other same-type dependency later in the batch can resolve without requiring an
extra desktop round trip. Unresolved dependencies remain `RETRY`.

## Concurrency and crash recovery

One PostgreSQL session advisory lock is held for each internal batch while its
records are orchestrated. A concurrent delivery with the same batch ID receives
`BATCH_IN_PROGRESS`; it cannot run the processors twice concurrently.

The lock belongs to the database session and is released automatically if the
API process or connection fails. A later identical request can claim the
existing `PROCESSING` batch and resume it. Previously committed record outcomes
are returned as `UNCHANGED`, while unfinished records continue through their
idempotent processors. A controlled `FAILED` batch without a response can also
be returned to `PROCESSING` under the same lock.

If a complete response already exists, POST and GET return the stored JSON
without repeating clinical side effects. Reusing a batch ID with changed
content remains a `BATCH_PAYLOAD_MISMATCH` conflict.

## Atomic completion

After every record has one outcome, the orchestrator creates and validates the
HSD-SYNC-001 response. One final PostgreSQL transaction stores:

- `ACCEPTED`, `PARTIAL`, or `REJECTED` batch status;
- server receipt and completion timestamps;
- accepted, unchanged, review, rejected, and retry counts;
- the complete response body;
- the installation's latest successful contact time.

`ACCEPTED` means every record is accepted or unchanged. `REJECTED` means every
record is rejected or retryable. Mixed results, including identity review, are
`PARTIAL`. The desktop still uses each record outcome—not only the batch
status—to decide whether an outbox item is terminal or should retry.

## Observability

Prometheus exposition now includes aggregate sync batch and record-outcome
counters. Labels contain only bounded enums: batch status, replay flag,
resource type, and record status. Installation, patient, Medical ID, actor,
location, and record identifiers are never metric labels.

Existing HTTP metrics record method, route template, status code, and latency
for both sync operations. Structured request logs likewise omit bodies and
authorization headers.

## Verification

- runtime contract validation is checked against every valid and invalid
  HSD-SYNC-001 fixture;
- unit tests cover dependency ordering and batch-status aggregation;
- PostgreSQL integration tests cover interrupted-batch recovery, dependency
  processing, canonical persistence, original-order outcomes, Medical ID
  return, exact POST replay, GET recovery, aggregate metrics, authentication,
  invalid requests, payload conflicts, and concurrent batch claims;
- lint, type-check, unit, integration, contract, migration, and build gates are
  required before merge.

## Out of scope

This task does not implement the desktop sync worker, Medical ID recovery UI,
temporary patient viewer, FHIR mapping/publication, hospital/provider OAuth2,
or LLM-assisted analysis.
