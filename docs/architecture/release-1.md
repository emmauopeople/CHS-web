# Release 1 architecture

## Goal

Release 1 proves the complete desktop-to-cloud path before FHIR work begins:

1. Receive idempotent batches from an authorized desktop installation.
2. Validate, normalize, and deduplicate incoming screening data.
3. Persist only canonical clean records in PostgreSQL.
4. Create a permanent CHS medical ID when a new individual is accepted.
5. Return record outcomes and the CHS medical ID to the desktop client.
6. Recover an existing CHS medical ID without creating a replacement.
7. Allow authorized internal staff to view canonical patient data and sync
   operations in a temporary React application.

## Deployment unit

Release 1 is a modular monolith, not a set of microservices. It consists of:

- `apps/api`: Fastify HTTP API with internal domain modules.
- `apps/operations-web`: React single-page operations and patient viewer.
- PostgreSQL: system of record for canonical and operational data.
- Migration runner: immutable, SQL-first database changes.

Module boundaries must remain explicit so sync ingestion, identity resolution,
patient records, and audit capabilities can be separated later if measured
scaling or ownership needs justify it.

## Initial module boundaries

- `diagnostics`: health, readiness, startup, metrics, and version routes.
- `sync`: batch receipt, idempotency, record outcomes, and retry-safe responses.
- `identity`: person matching, duplicate review, medical-ID assignment/recovery.
- `screening`: normalized encounters, observations, and source provenance.
- `operations`: internal queries used by the temporary React application.
- `audit`: append-only records of sensitive reads and state changes.

The `diagnostics` module, HSD-SYNC-001 contract, canonical schema, internal
sync-intake foundation, and patient identity/Medical ID processor are
implemented. Screening session, source-linked protocol, patient encounter, and
vitals ingestion are also implemented. Authenticated desktop sync submission
and stored-response recovery routes are registered. Their orchestration layer
validates the shared contract, processes dependency order, resumes interrupted
batches safely, and stores complete per-record responses before acknowledging
the desktop.

The operations module has a read-only canonical patient list and clinical
detail service with explicit global or organization access scope. Protected POST
routes validate OIDC access tokens, derive permission and scope from server-side
grants, require a reason-for-access, and record sensitive-read audit events
before returning patient data. The temporary React viewer consumes this
boundary using Authorization Code with PKCE and keeps patient identifiers out of
browser URLs.

The operations module also exposes a separate Medical ID recovery boundary.
An active `MEDICAL_ID_RECOVER` grant and reason-for-access are required. The
first step performs conservative exact demographic matching within the
server-derived organization scope and returns masked candidates only. A unique
candidate receives a five-minute, session-bound, one-time confirmation token;
ambiguous evidence becomes a non-revealable review case. The confirmation step
reads the already active identifier and never inserts or replaces one. Both
steps are durably audited.

Synchronization support now includes a separate operational monitoring
boundary. A dedicated `SYNC_MONITOR` grant controls access independently of
patient viewing and Medical ID recovery. Scoped API queries show batch state,
desktop/version context, outcome counts, stalled processing, and grouped stable
error codes. They deliberately exclude clinical payloads, response bodies,
payload hashes, record identifiers, error paths, and error messages. A React
dashboard will consume this boundary in HSD-OPS-003B.

## Non-negotiable data rules

- Every accepted source record retains source organization, installation,
  local record ID, payload schema version, timestamps, and provenance.
- The same batch or record can be retried without creating duplicates.
- CHS medical-ID assignment and canonical-person creation are atomic.
- A missing medical ID is recovered; it is never replaced merely because the
  desktop copy was lost.
- Ambiguous identity matches enter a review workflow rather than being merged
  automatically.
- Raw payload retention, if approved, is separated from canonical data and has
  an explicit retention policy.
- Patient data and credentials never appear in application logs or metric
  labels.

## Deferred capabilities

FHIR mapping/server integration, hospital/provider OAuth2 access, the LLM
analysis service, and the Prometheus/Grafana/Fluent Bit/OpenSearch deployment
are not Release 1 application features. Release 1 exposes compatible telemetry
endpoints and structured logs so the observability stack can be added during
deployment.
