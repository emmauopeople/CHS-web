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
screening session, protocol, and patient encounter ingestion. Vitals ingestion
and batch orchestration are next; the sync HTTP route remains closed until it
can return complete per-record outcomes.

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

## Operational endpoints

- `GET /health/live` — process liveness
- `GET /health/ready` — dependency readiness, including PostgreSQL
- `GET /health/startup` — startup completion
- `GET /metrics` — Prometheus exposition format
- `GET /version` — build and service version metadata

API documentation is available at `GET /docs` outside production.

## Commands

```bash
pnpm dev:api       # run the API in watch mode
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
- [HSD-DATA-001 canonical PostgreSQL schema](docs/database/HSD-DATA-001.md)

## Security note

Never commit real patient data, credentials, access tokens, or production
configuration. Synthetic fixtures must be used for development and tests.
