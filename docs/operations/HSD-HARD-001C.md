# HSD-HARD-001C: Bounded API load and concurrency evidence

Status: Implemented

## Purpose

This increment adds a repeatable Release 1 performance-regression gate for the
real Fastify HTTP and PostgreSQL boundary. It is the third HSW-017 / R1-019
hardening increment and changes no clinical, synchronization, authorization, or
database behavior.

The evidence is intentionally bounded. It proves that the configured database
pool can queue a short concurrent burst, accepted sync replays remain
idempotent, and response latency stays below a generous regression ceiling on a
shared CI runner. It is not a production capacity forecast.

## Load profiles

| Profile | Requests | Concurrency | p95 ceiling | Required correctness |
| --- | ---: | ---: | ---: | --- |
| PostgreSQL readiness | 80 | 16 | 2,000 ms | Every response is `200`, `ready`, and reports PostgreSQL `pass` |
| Accepted sync replay | 48 | 8 | 5,000 ms | Every response exactly replays the stored accepted batch |

The harness runs the API on an ephemeral loopback TCP port with a four-connection
PostgreSQL pool. It creates an isolated schema, applies every immutable
migration, enrolls one synthetic installation, accepts the existing synthetic
four-record contract fixture once, and then runs both profiles. Before and after
the replay burst it verifies that exactly one batch, person, session, encounter,
vital set, and reading exist. This makes duplicate creation a failed load gate,
not merely a latency observation.

## Evidence artifact

Each run writes `apps/api/load-results/api-load-evidence.json` with:

- request and concurrency counts;
- success count;
- p50, p95, maximum, and budget latency in milliseconds;
- Node runtime, transport, and configured database-pool size; and
- an explicit synthetic-fixture marker.

The file contains no request or response bodies, patient fields, installation
credential, database URL, schema name, record identifier, or payload hash.
GitHub Actions retains the artifact for 14 days. Generated local evidence is
ignored by Git.

## Running the gate

Set `DATABASE_TEST_URL` through the existing `.env` mechanism, then run:

```bash
pnpm test:load
```

The dedicated command fails when the database URL is absent, any response is
incorrect, canonical row counts change, a request exceeds the per-request
timeout, or a p95 ceiling is exceeded. The regular unit suite does not run this
profile implicitly.

Continue to run all Release 1 gates:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm db:test
pnpm test:e2e
pnpm test:load
```

## Interpreting a failure

1. Treat a correctness or duplicate-row failure as a release blocker.
2. Compare the JSON artifact and job logs with the last successful run.
3. Re-run once on the same commit to distinguish a shared-runner latency spike
   from a repeatable regression; do not dismiss repeated failures.
4. Profile the affected route and PostgreSQL queries before changing a ceiling.
5. Change request counts, concurrency, or budgets only in a separately reviewed
   hardening change with recorded evidence.

## Scope boundary

This evidence does not establish production throughput, user concurrency,
regional network behavior, slow-upload behavior, horizontal scaling, soak or
stress limits, reverse-proxy capacity, or a production SLO. Production sizing
still requires representative infrastructure and traffic. Backup/restore
rehearsal, container resource limits, and orchestrator termination grace remain
later R1-020 deployment-readiness work.
