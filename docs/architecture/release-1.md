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

Identity review now has persistence, query, and controlled resolution boundaries.
Sync-created cases retain append-only, minimum-necessary demographic evidence
and source provenance without storing raw request JSON. Reviewers require an
independent `IDENTITY_REVIEW` grant and controlled reason; queue hints and every
canonical candidate are masked, organization scope is server-derived, and
reads are audited. An open case remains review-required across later unlinked
desktop revisions, preventing demographic edits from bypassing manual review
and creating a second canonical person. A reviewer can link only a listed
active candidate or atomically create a new person and Medical ID from complete
evidence. Serializable locking, stale-state checks, idempotency keys, and
transactional auditing protect this irreversible decision. Resolution uses an
independent `IDENTITY_REVIEW_RESOLVE` grant, so read-only investigation cannot
mutate identity state. The React portal exposes this boundary through a manual,
low-bandwidth queue and review panel. It displays masked queue and candidate
data, requests exact submitted evidence only for an opened case, and requires a
reviewer note plus explicit confirmation before sending a version-guarded,
idempotent resolution command.
Each successful resolution also creates a durable desktop delivery in the same
transaction. An installation-authenticated pull/acknowledgment boundary repeats
the confirmed canonical person and Medical ID until the originating desktop
reports that its SQLite update committed. This closes the review round trip
without mutating historical batch responses or requiring a newer patient
snapshot.

Lifestyle synchronization is frozen against desktop schema version 15, and its
additive machine contract and central ingestion are implemented as one
completed `LIFESTYLE` / `lifestyle.v1` full snapshot. It depends on its accepted
encounter and carries the exact referenced alcohol, tobacco, and work baseline
versions. Fifteen normalized PostgreSQL tables retain the aggregate, exact
baseline history, actor attribution, source identity, and replay-safe outcome
without storing raw payload JSON. Desktop drafts and in-progress work remain
local. Desktop transport and amendment/void semantics remain follow-up work.
The authorized patient-detail query and React viewer now expose the finalized
normalized assessment, exact baseline versions, weekly responses, ordered child
rows, and completion provenance under the existing organization scope and read
audit. The viewer uses the existing patient-detail request without adding a
second query or browser-to-database path.

The patient-detail query also exposes bounded identity-assurance and source
provenance. Acknowledgment state, an in-scope open-review warning/count, source
deployment/location labels, revisions, and source/server timestamps travel on
the same audited response. Source registrations and review warnings are scoped
independently by installation organization, while desktop patient identifiers,
hashes, review evidence, and raw payloads remain excluded. The React patient
header now renders acknowledgment and the scoped warning directly, with source
count/latest receipt in the summary and detailed deployment, revision, and
source/server timestamps in an accessible disclosure. The browser validates the
nested response and makes no additional request.

The patient viewer also has deterministic Chromium workflow evidence. The
browser suite starts the real Vite application, injects a synthetic short-lived
session, and intercepts the operations HTTP boundary with synthetic canonical
responses. It verifies the unauthenticated barrier, reason-gated POST requests,
absence of patient evidence from URLs, loading/empty/error behavior, and the
complete patient detail presentation. Server authorization, auditing, scope,
and PostgreSQL behavior remain covered by the API integration suite rather than
being simulated in the browser test.

Synchronization support now includes a separate operational monitoring
boundary. A dedicated `SYNC_MONITOR` grant controls access independently of
patient viewing and Medical ID recovery. Scoped API queries show batch state,
desktop/version context, outcome counts, stalled processing, and grouped stable
error codes. They deliberately exclude clinical payloads, response bodies,
payload hashes, record identifiers, error paths, and error messages. The React
operations portal consumes this boundary through a manually refreshed,
responsive dashboard with explicit loading, empty, error, and scoped-not-found
states. Page summary cards are clearly limited to either all matching batches
or the current page so the UI does not overstate aggregate health.

## Non-negotiable data rules

- Every accepted source record retains source organization, installation,
  local record ID, payload schema version, timestamps, and provenance.
- The same batch or record can be retried without creating duplicates.
- CHS medical-ID assignment and canonical-person creation are atomic.
- A missing medical ID is recovered; it is never replaced merely because the
  desktop copy was lost.
- Ambiguous identity matches enter a review workflow rather than being merged
  automatically.
- A completed Lifestyle week retains the exact immutable baseline versions
  used for interpretation; a later active baseline never rewrites history.
- Lifestyle drafts and in-progress weekly work are not central canonical
  records and must not be synchronized as `lifestyle.v1`.
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
