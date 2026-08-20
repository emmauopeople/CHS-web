# HSD-OPS-003A: Synchronization monitoring API

Status: Draft for implementation review

## Purpose

This increment provides a safe operations boundary for answering whether
desktop synchronization is succeeding, failing, waiting for review, retrying,
or stalled. It is business-level synchronization visibility, not infrastructure
monitoring. Prometheus, Grafana, Fluent Bit, and OpenSearch remain deployment
concerns.

The API reads durable canonical sync metadata already stored in PostgreSQL. It
does not inspect or return clinical payloads.

## Authorization boundary

Migration `0007_sync_operations_monitoring.sql` adds the dedicated
`SYNC_MONITOR` permission. It is independent of `PATIENT_READ` and
`MEDICAL_ID_RECOVER`.

Both routes require:

- a valid OIDC bearer access token;
- an active, enrolled operations user;
- an active server-side `SYNC_MONITOR` grant;
- global or organization scope derived only from that grant; and
- the controlled `OPERATIONS_SUPPORT` reason.

The browser cannot supply organization scope. Out-of-scope and nonexistent
batch references both return the same `404` response. Requests use POST JSON
bodies and disable HTTP caching so filters and references do not appear in
URLs.

## API boundary

### Batch search

`POST /api/v1/operations/sync/batches/search` supports:

- batch status;
- installation UUID;
- received-from and received-to instants with explicit timezone offsets; and
- bounded pagination from 1 to 100 rows per page.

Newest batches appear first. Each item contains the opaque internal batch
reference, source batch UUID, deployment, organization and location names,
desktop and contract versions, timestamps, duration, status, and accepted,
unchanged, review-required, rejected, and retry counts.

The API derives one operational attention state:

- `HEALTHY`: completed without review, rejection, retry, or failure;
- `ATTENTION`: partial, rejected, failed, or containing review/retry/rejection
  outcomes; or
- `STALLED`: still processing at least 15 minutes after receipt.

### Batch detail

`POST /api/v1/operations/sync/batches/detail` returns the same batch summary
plus:

- counts grouped by resource type and outcome status; and
- counts grouped by stable error code and retryability.

This endpoint is diagnostic but not a raw record browser. It gives operators
enough information to recognize patterns such as dependency retries or invalid
patient records without disclosing the affected patient or submitted values.

## Redaction rules

Neither route returns:

- `sync_batches.response_body`;
- batch or record payload hashes;
- source/local record identifiers;
- canonical patient or clinical resource identifiers;
- submitted payloads or demographic/clinical values;
- error paths; or
- error messages.

Only stable uppercase error codes matching the contract-safe pattern are
returned. Any unexpected value is collapsed to `UNKNOWN`.

## Audit behavior

The API durably records:

- `SYNC_BATCH_LIST_VIEW` for list/filter queries; and
- `SYNC_BATCH_DETAIL_VIEW` for a targeted batch read.

Success, permission denial, invalid query, not-found, and unexpected failure
outcomes are recorded with the derived authorization scope, request ID,
controlled reason, route, and redacted result metadata. Filters are represented
as presence flags or controlled enum values; audit metadata does not contain
submitted timestamps, installation search values, raw errors, or clinical
information.

## Persistence and indexes

Migration `0007_sync_operations_monitoring.sql` adds indexes for:

- organization/status/received-time batch listing;
- organization/installation/received-time filtering; and
- grouped batch record outcomes.

No sync workflow table or immutable source record is rewritten by monitoring.

## Verification

Automated coverage checks:

- permission isolation from `PATIENT_READ`;
- organization-scoped list and detail access;
- indistinguishable out-of-scope and missing details;
- status and installation filters;
- healthy, attention, and stalled derivation;
- grouped outcomes and stable error-code counts;
- exclusion of payloads, hashes, error paths, and messages;
- durable success, denial, and not-found audits; and
- migration ordering, permission constraint, and query indexes.

HSD-OPS-003B will add the React synchronization dashboard on this API without
changing its authorization or redaction boundary.
