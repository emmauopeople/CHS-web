# Community Health Screening — Web Platform

Cloud-side services for the offline-first Community Health Screening (CHS)
application.

Release 1 receives screening data from approved desktop installations,
validates and normalizes it, removes duplicates, stores canonical records in
PostgreSQL, assigns a CHS medical ID, and provides an internal patient viewer.

FHIR mapping, a FHIR server, hospital/provider OAuth2 access, and LLM-assisted
analysis are intentionally deferred until later releases.

## Repository status

This repository is at the Release 1 contract stage. The API foundation and its
operational endpoints are implemented. The desktop synchronization contract is
defined from the inspected desktop data model before clinical migrations or
ingestion handlers are added.

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
pnpm build         # compile every workspace package
pnpm typecheck     # type-check every workspace package
pnpm test          # run automated tests
pnpm lint          # run lint checks
```

## Documentation

- [Release 1 architecture](docs/architecture/release-1.md)
- [Desktop sync discovery checklist](docs/sync/desktop-contract-discovery.md)
- [HSD-SYNC-001 desktop-to-web contract](docs/contracts/HSD-SYNC-001.md)

## Security note

Never commit real patient data, credentials, access tokens, or production
configuration. Synthetic fixtures must be used for development and tests.
