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
canonical screening and vitals detail views, and a permission-controlled
one-time workflow for recovering an existing CHS Medical ID.
The operations API also exposes a scoped, redacted view of desktop sync batch
health. The React operations portal consumes it through a low-bandwidth,
manually refreshed synchronization dashboard.

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

Both routes require an enrolled installation bearer token. Batch responses
return one outcome per submitted record in the original request order.

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

## Commands

```bash
pnpm dev:api       # run the API in watch mode
pnpm dev:web       # run the React operations viewer
pnpm admin:screening-context:provision -- --input <file> # create organization/location IDs
pnpm admin:installation:enroll -- --input <file> # enroll one desktop installation
pnpm admin:installation:rotate -- --input <file> # atomically replace its token
pnpm admin:installation:revoke -- --input <file> # explicitly revoke a token
pnpm db:migrate    # apply checksum-protected PostgreSQL migrations
pnpm db:test       # test migrations and constraints against PostgreSQL
pnpm build         # compile every workspace package
pnpm typecheck     # type-check every workspace package
pnpm test          # run automated tests
pnpm lint          # run lint checks
```

## Documentation

- [Release 1 architecture](docs/architecture/release-1.md)
- [Desktop sync discovery checklist](docs/sync/desktop-contract-discovery.md)
- [HSD-SYNC-001 desktop-to-web contract](docs/contracts/HSD-SYNC-001.md)
- [HSD-SYNC-002A sync batch intake foundation](docs/sync/HSD-SYNC-002A.md)
- [HSD-SYNC-002B patient identity ingestion](docs/sync/HSD-SYNC-002B.md)
- [HSD-SYNC-002C screening session and protocol ingestion](docs/sync/HSD-SYNC-002C.md)
- [HSD-SYNC-002D patient screening encounter ingestion](docs/sync/HSD-SYNC-002D.md)
- [HSD-SYNC-002E vitals and blood-pressure reading ingestion](docs/sync/HSD-SYNC-002E.md)
- [HSD-SYNC-002F batch orchestration and HTTP routes](docs/sync/HSD-SYNC-002F.md)
- [HSD-SYNC-003A controlled desktop installation enrollment](docs/sync/HSD-SYNC-003A.md)
- [HSD-SYNC-003B desktop credential rotation and revocation](docs/sync/HSD-SYNC-003B.md)
- [HSD-ADMIN-001A canonical screening context provisioning](docs/administration/HSD-ADMIN-001A.md)
- [HSD-OPS-001A canonical patient query service](docs/operations/HSD-OPS-001A.md)
- [HSD-OPS-001B authenticated and audited patient access](docs/operations/HSD-OPS-001B.md)
- [HSD-OPS-002A React operations patient viewer](docs/operations/HSD-OPS-002A.md)
- [HSD-OPS-002B Medical ID recovery](docs/operations/HSD-OPS-002B.md)
- [HSD-OPS-003A synchronization monitoring API](docs/operations/HSD-OPS-003A.md)
- [HSD-OPS-003B React synchronization dashboard](docs/operations/HSD-OPS-003B.md)
- [HSD-DATA-001 canonical PostgreSQL schema](docs/database/HSD-DATA-001.md)

## Security note

Never commit real patient data, credentials, access tokens, or production
configuration. Synthetic fixtures must be used for development and tests.
