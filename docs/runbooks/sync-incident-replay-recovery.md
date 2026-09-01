# Synchronization incident, replay, and recovery runbook

## Purpose

Use this procedure when a desktop synchronization batch times out, appears
stalled, reports a stable sync error code, or loses its original HTTP response.
The goal is to recover by resending the exact durable desktop outbox item while
preserving idempotency, auditability, and minimum-necessary access.

Do not use this procedure to inspect clinical payloads, change a batch ID,
modify PostgreSQL rows, delete canonical data, or force a browser-side replay.

## Required access and evidence

The incident owner must have the deployment-approved support role. The
operations portal requires an active `SYNC_MONITOR` grant and the audited
`OPERATIONS_SUPPORT` reason. Capture only:

- incident/change reference, environment, release commit, and time window;
- organization-scoped deployment and location labels;
- batch state, received/completed times, desktop and contract versions;
- accepted, unchanged, review, rejected, and retry counts;
- grouped stable error codes;
- actions, timestamps, owner, and final disposition; and
- the relevant CI recovery-evidence artifact for the release.

Do not copy request/response bodies, payload hashes, tokens, Medical IDs,
patient/record IDs, demographics, clinical values, error paths, or raw logs into
the incident record.

## Initial triage

1. Confirm the API liveness and PostgreSQL readiness endpoints are healthy.
2. Use Sync Monitoring with the narrowest organization and time scope.
3. Confirm the desktop deployment, application/schema version, contract
   version, batch state, age, and aggregate outcome/error counts.
4. Check for a concurrent wider outage: authentication failures, database pool
   saturation, API errors, stalled-batch growth, or recent deployment/config
   change.
5. Preserve the desktop outbox item unchanged. Never edit and resubmit it under
   the same batch ID.

## Decision table

| Observation | Safe action | Prohibited action |
| --- | --- | --- |
| Desktop timed out or lost the response | Retry the exact durable batch with the same batch ID and content | Creating a replacement ID or reconstructing the payload manually |
| `BATCH_IN_PROGRESS` | Back off with bounded jitter, then retry the exact POST; escalate if the deployment's stalled threshold is exceeded | Concurrent retry storms or database status edits |
| Complete response exists | Accept the exact POST replay or use authenticated GET response recovery | Reprocessing individual canonical rows |
| `BATCH_PAYLOAD_MISMATCH` | Stop retries, preserve the outbox item, compare desktop outbox history locally, and escalate as a data-integrity incident | Changing the stored hash, deleting the batch, or reusing the ID |
| `INVALID_INSTALLATION_TOKEN` | Verify installation status and use the approved credential rotation/re-enrollment procedure | Sending a token in chat, email, logs, or screenshots |
| Context/location/timezone authorization error | Stop and verify server-side enrollment/configuration | Changing envelope context merely to make the request pass |
| Record outcome is `RETRY` | Keep the exact source snapshot pending and follow the stable retryable error code | Marking the record delivered without a terminal outcome |
| Record outcome is `REVIEW_REQUIRED` | Leave delivery pending for the identity-review and acknowledgment workflow | Creating a second patient or Medical ID |
| Repeated 5xx, readiness failure, or broad stall | Declare/escalate an API/database incident and preserve retryable desktop outboxes | Unbounded retries or direct canonical-data repair |

## Exact retry and response recovery

The desktop is the authority for its durable unsent outbox item. An exact retry
must retain the same batch ID and canonical request content. Array ordering is
normalized by the server, but operators should not edit, reorder, or rebuild a
request during incident handling.

For an identical POST:

- an existing complete response is returned without repeating side effects;
- an interrupted `PROCESSING` batch can resume after its PostgreSQL advisory
  lock is available;
- already committed records return `UNCHANGED`; and
- a controlled `FAILED` batch without a response can return to `PROCESSING` and
  run through the same idempotent processors.

Authenticated GET response recovery is appropriate only when the desktop knows
the original batch ID and needs the immutable stored response. A missing or
still-processing response is not permission to create a replacement batch.

## Stalled processing

1. Confirm the batch is still incomplete and older than the deployment-approved
   threshold; do not infer a stall from a single slow request on a weak link.
2. Check readiness, pool saturation, error rate, deployment health, and whether
   another request currently owns the batch advisory lock.
3. Stop automated retry amplification at the edge while retaining durable
   outbox items.
4. Restore the failed API/database dependency through its approved runbook.
   PostgreSQL session advisory locks release when the owning session ends.
5. Resume with one exact desktop retry, then confirm the stored response and
   canonical counts/monitoring state are plausible.
6. Escalate repeated `BATCH_IN_PROGRESS`, invalid stored-response behavior, or
   any duplicate/identity-integrity concern to engineering and the data owner.

## Payload mismatch

`BATCH_PAYLOAD_MISMATCH` is a data-integrity guard, not a transient error.

1. Stop retrying that batch ID.
2. Preserve the original desktop database/outbox according to incident policy.
3. Record only release, deployment, time, and stable error metadata centrally.
4. Determine locally whether a software defect mutated content after assigning
   the batch ID. Do not copy clinical content into the support record.
5. Engineering must identify and correct the desktop defect before any new
   delivery is authorized. Never delete or rewrite the central batch to clear
   the conflict.

## Closure

Before closing the incident, confirm:

- the desktop received a valid terminal or retryable per-record outcome;
- unresolved identity reviews remain in the controlled review workflow;
- no duplicate canonical person, session, encounter, vitals, or Lifestyle rows
  were introduced;
- the batch is no longer unexpectedly stalled;
- credentials and scope remain valid;
- all temporary support exports were avoided or destroyed under policy; and
- follow-up defects, alerts, or runbook changes have named owners.

Retain only the approved minimum-necessary incident evidence. A recurring or
unexplained recovery event is a release blocker until its cause is understood.
