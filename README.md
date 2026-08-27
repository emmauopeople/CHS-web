# Community Health Screening — Web Platform

Cloud-side services for the offline-first Community Health Screening (CHS)
application.

Release 1 receives screening data from approved desktop installations,
validates and normalizes it, removes duplicates, stores canonical records in
PostgreSQL, assigns a CHS medical ID, and provides an internal patient viewer.

FHIR mapping, a FHIR server, hospital/provider OAuth2 access, and LLM-assisted
analysis are intentionally deferred until later releases.

## Repository status

This repository is building the Release 1 foundation. The API operational
endpoints, desktop synchronization contract, canonical PostgreSQL schema, and
secure sync-intake foundation are implemented. Patient identity ingestion and
atomic CHS Medical ID assignment are implemented internally, along with
screening session, protocol, patient encounter, and vitals ingestion. The batch
orchestrator exposes authenticated submit and response-recovery routes with
dependency ordering, crash recovery, durable outcomes, and exact replay.
The operations module provides scoped, read-only canonical patient list and
clinical-detail queries through OIDC-authenticated, database-authorized,
reason-for-access protected, and audited POST endpoints. The React operations
viewer consumes this boundary with PKCE sign-in, reason-gated patient search,
canonical screening, vitals, and Lifestyle detail views, and a
permission-controlled one-time workflow for recovering an existing CHS Medical ID.
Chromium workflow tests now exercise the protected patient viewer, its
reason-gated POST requests, bounded loading/error/empty states, and the canonical
detail presentation against deterministic synthetic responses.
The protected patient-detail API and React viewer return and render finalized
normalized Lifestyle assessments with their exact immutable baseline versions,
weekly responses, ordered activity rows, and completion provenance.
The operations API also exposes a scoped, redacted view of desktop sync batch
health. The React operations portal consumes it through a low-bandwidth,
manually refreshed synchronization dashboard.
Internal operations identities and their least-privilege portal grants can be
created through a controlled operator command after the OIDC identity exists.
Sync-created identity-review cases retain append-only, minimum-necessary
evidence snapshots without raw payload JSON. A separately authorized,
organization-scoped operations API now exposes a masked review queue and
audited case detail. Authorized reviewers can now resolve a case by linking a
listed candidate or atomically creating a new canonical person and CHS Medical
ID. The React portal provides the corresponding masked queue, protected
evidence comparison, and confirmation-gated resolution workspace.
Reviewer-resolved identities are now placed in an installation-scoped durable
delivery queue so the originating desktop can pull, apply, and acknowledge the
confirmed CHS Medical ID without submitting a newer patient revision.
Lifestyle synchronization now has an additive machine contract and central
ingestion for one completed encounter-owned snapshot with immutable referenced
alcohol, tobacco, and work baseline versions. PostgreSQL stores the aggregate
as normalized canonical rows with source provenance and replay-safe outcomes;
raw Lifestyle payload JSON is not retained. Desktop transport and
amendment/void behavior remain follow-up tasks.

## Prerequisites

- Node.js 24 LTS
- Corepack with pnpm
- Docker with Compose (for local PostgreSQL)

## Local setup

```bash
corepack enable
pnpm install
cp .env.example .env
docker compose up -d postgres
pnpm db:migrate
pnpm dev:api
```

The API listens on `http://localhost:3000` by default.

The API starts with bounded request-body, request-receipt, socket-idle, and
keep-alive limits. Their reviewed defaults are present in `.env.example`; see
[HSD-HARD-001A](docs/operations/HSD-HARD-001A.md) before changing them in a
deployment.

Pull requests and `main` are checked by dependency, credential, and static
analysis workflows documented in
[HSD-HARD-001B](docs/operations/HSD-HARD-001B.md). Run the locally reproducible
checks with `pnpm security:check`.

Configure the public OIDC SPA values in `.env`, then run `pnpm dev:web` in a
second terminal. The patient viewer listens on `http://127.0.0.1:4173` and
proxies `/api` to the local API. See
[HSD-OPS-002A](docs/operations/HSD-OPS-002A.md) for identity-provider and
redirect-URI requirements.

## Operational endpoints

- `GET /health/live` — process liveness
- `GET /health/ready` — dependency readiness, including PostgreSQL
- `GET /health/startup` — startup completion
- `GET /metrics` — Prometheus exposition format
- `GET /version` — build and service version metadata

API documentation is available at `GET /docs` outside production.

## Desktop synchronization endpoints

- `POST /api/v1/sync/batches` — validate, authenticate, and process a batch
- `GET /api/v1/sync/batches/{batchId}` — recover its stored response
- `POST /api/v1/sync/identity-resolutions/pull` — pull pending resolved identity assignments
- `POST /api/v1/sync/identity-resolutions/acknowledge` — acknowledge one assignment after local commit

All four routes require an enrolled installation bearer token. Batch responses
return one outcome per submitted record in the original request order.
Identity assignments remain pending and repeat safely until the same
installation acknowledges that its local SQLite update committed.

Infrastructure operators enroll a desktop and issue its first one-time token
with `pnpm admin:installation:enroll -- --input <enrollment.json>`. See
[HSD-SYNC-003A](docs/sync/HSD-SYNC-003A.md) for the controlled procedure and
security requirements.

Before enrollment, operators create the canonical screening organization and
location with `pnpm admin:screening-context:provision -- --input <context.json>`.
This infrastructure process is documented in
[HSD-ADMIN-001A](docs/administration/HSD-ADMIN-001A.md) and is separate from
future hospital/provider onboarding.

Operators replace or invalidate an installation token with the guarded
`admin:installation:rotate` and `admin:installation:revoke` commands documented
in [HSD-SYNC-003B](docs/sync/HSD-SYNC-003B.md).

## Operations patient endpoints

- `POST /api/v1/operations/patients/search` — search canonical patients
- `POST /api/v1/operations/patients/detail` — read canonical clinical detail

Both routes require a valid OIDC access token, an active server-side
`PATIENT_READ` grant, and a controlled reason-for-access. Search and patient
identifiers remain in redacted JSON bodies rather than URLs. The API derives
global or organization scope from PostgreSQL grants; it never accepts scope from
the browser.

## Medical ID recovery endpoints

- `POST /api/v1/operations/medical-id-recovery/search` — find masked recovery candidates
- `POST /api/v1/operations/medical-id-recovery/reveal` — reveal one confirmed existing ID once

Medical ID recovery requires a separate `MEDICAL_ID_RECOVER` grant. Exact
name-and-date-of-birth evidence returns masked candidates only. Ambiguous
evidence creates a review case without a reveal token; a unique candidate can
be confirmed once within five minutes and only from the originating OIDC
session. Recovery never allocates or replaces an identifier.

## Synchronization monitoring endpoints

- `POST /api/v1/operations/sync/batches/search` — list scoped batch health and outcome counts
- `POST /api/v1/operations/sync/batches/detail` — read grouped resource outcomes and error codes

Both endpoints require the dedicated `SYNC_MONITOR` grant and the controlled
`OPERATIONS_SUPPORT` reason. They return operational metadata and stable error
codes only. Raw payloads, stored response bodies, payload hashes, record IDs,
patient identifiers, error paths, and error messages are excluded.

The operations portal provides a Sync Monitoring workspace for filtering,
paging, and inspecting these redacted results. Filters and batch references
remain in non-cacheable POST bodies and are not stored in browser URLs.

## Identity review endpoints

- `POST /api/v1/operations/identity-reviews/search` — list scoped open review cases
- `POST /api/v1/operations/identity-reviews/detail` — compare submitted evidence with masked candidates
- `POST /api/v1/operations/identity-reviews/resolve` — link a listed candidate or create a new canonical identity

Search and detail require `IDENTITY_REVIEW`; resolution separately requires
`IDENTITY_REVIEW_RESOLVE`. All three require the controlled
`IDENTITY_RECONCILIATION` reason. Queue identity hints and all canonical
candidates are masked, missing and out-of-scope case references are
indistinguishable, and every query or resolution attempt is audited. Resolution
requires a stale-state guard, an idempotency key, a reviewer note, and complete
evidence. The React Identity Review workspace keeps protected values out of
URLs, discloses exact evidence only after a case is opened, and requires an
explicit confirmation before resolution.

## Operations access provisioning

After creating an internal account in the configured identity provider,
infrastructure operators bind its exact issuer/subject and grant only the
required portal permissions with
`pnpm admin:operations-access:provision -- --input <access.json>`. The command
supports `PATIENT_READ`, `MEDICAL_ID_RECOVER`, `IDENTITY_REVIEW`,
`IDENTITY_REVIEW_RESOLVE`, and `SYNC_MONITOR` at global or organization scope. See
[HSD-ADMIN-001B](docs/administration/HSD-ADMIN-001B.md).

## Commands

```bash
pnpm dev:api       # run the API in watch mode
pnpm dev:web       # run the React operations viewer
pnpm admin:operations-access:provision -- --input <file> # create an internal viewer grant
pnpm admin:screening-context:provision -- --input <file> # create organization/location IDs
pnpm admin:installation:enroll -- --input <file> # enroll one desktop installation
pnpm admin:installation:rotate -- --input <file> # atomically replace its token
pnpm admin:installation:revoke -- --input <file> # explicitly revoke a token
pnpm db:migrate    # apply checksum-protected PostgreSQL migrations
pnpm db:test       # test migrations and constraints against PostgreSQL
pnpm build         # compile every workspace package
pnpm typecheck     # type-check every workspace package
pnpm test          # run automated tests
pnpm test:e2e      # run Chromium operations-workflow tests
pnpm test:load     # run bounded HTTP/PostgreSQL concurrency evidence
pnpm lint          # run lint checks
pnpm security:check # scan repository files and production dependencies
```

## Documentation

- [Release 1 architecture](docs/architecture/release-1.md)
- [Desktop sync discovery checklist](docs/sync/desktop-contract-discovery.md)
- [HSD-SYNC-001 desktop-to-web contract](docs/contracts/HSD-SYNC-001.md)
- [HSD-SYNC-005A Lifestyle contract discovery](docs/contracts/HSD-SYNC-005A-lifestyle-contract-discovery.md)
- [HSD-SYNC-005B Lifestyle machine contract](docs/contracts/HSD-SYNC-005B-lifestyle-machine-contract.md)
- [HSD-SYNC-005C Lifestyle persistence and ingestion](docs/sync/HSD-SYNC-005C.md)
- [HSD-SYNC-002A sync batch intake foundation](docs/sync/HSD-SYNC-002A.md)
- [HSD-SYNC-002B patient identity ingestion](docs/sync/HSD-SYNC-002B.md)
- [HSD-SYNC-002C screening session and protocol ingestion](docs/sync/HSD-SYNC-002C.md)
- [HSD-SYNC-002D patient screening encounter ingestion](docs/sync/HSD-SYNC-002D.md)
- [HSD-SYNC-002E vitals and blood-pressure reading ingestion](docs/sync/HSD-SYNC-002E.md)
- [HSD-SYNC-002F batch orchestration and HTTP routes](docs/sync/HSD-SYNC-002F.md)
- [HSD-SYNC-003A controlled desktop installation enrollment](docs/sync/HSD-SYNC-003A.md)
- [HSD-SYNC-003B desktop credential rotation and revocation](docs/sync/HSD-SYNC-003B.md)
- [HSD-SYNC-004A identity resolution delivery](docs/sync/HSD-SYNC-004A.md)
- [HSD-ADMIN-001A canonical screening context provisioning](docs/administration/HSD-ADMIN-001A.md)
- [HSD-ADMIN-001B operations access provisioning](docs/administration/HSD-ADMIN-001B.md)
- [HSD-OPS-001A canonical patient query service](docs/operations/HSD-OPS-001A.md)
- [HSD-OPS-001B authenticated and audited patient access](docs/operations/HSD-OPS-001B.md)
- [HSD-OPS-002A React operations patient viewer](docs/operations/HSD-OPS-002A.md)
- [HSD-OPS-002B Medical ID recovery](docs/operations/HSD-OPS-002B.md)
- [HSD-OPS-003A synchronization monitoring API](docs/operations/HSD-OPS-003A.md)
- [HSD-OPS-003B React synchronization dashboard](docs/operations/HSD-OPS-003B.md)
- [HSD-OPS-004A identity review query API](docs/operations/HSD-OPS-004A.md)
- [HSD-OPS-004B identity review resolution API](docs/operations/HSD-OPS-004B.md)
- [HSD-OPS-004C React identity review workspace](docs/operations/HSD-OPS-004C.md)
- [HSD-OPS-005A canonical Lifestyle patient query](docs/operations/HSD-OPS-005A.md)
- [HSD-OPS-005B React Lifestyle patient panel](docs/operations/HSD-OPS-005B.md)
- [HSD-OPS-006A patient identity assurance and source provenance query](docs/operations/HSD-OPS-006A.md)
- [HSD-OPS-006B React patient assurance and source provenance](docs/operations/HSD-OPS-006B.md)
- [HSD-OPS-006C browser patient-viewer workflow evidence](docs/operations/HSD-OPS-006C.md)
- [HSD-HARD-001A API runtime admission and shutdown hardening](docs/operations/HSD-HARD-001A.md)
- [HSD-HARD-001B automated security and supply-chain gates](docs/operations/HSD-HARD-001B.md)
- [HSD-HARD-001C bounded API load and concurrency evidence](docs/operations/HSD-HARD-001C.md)
- [HSD-DATA-001 canonical PostgreSQL schema](docs/database/HSD-DATA-001.md)
- [HSD-DATA-002 identity review evidence foundation](docs/database/HSD-DATA-002.md)

## Security note

Never commit real patient data, credentials, access tokens, or production
configuration. Synthetic fixtures must be used for development and tests.
