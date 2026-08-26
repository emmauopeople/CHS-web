# HSD-HARD-001A: API runtime admission and shutdown hardening

Status: Implemented

## Purpose

This increment establishes explicit, bounded HTTP admission controls for the
Release 1 API and verifies that shutdown drains in-flight work before closing
PostgreSQL. It is the first HSW-017 / R1-019 hardening increment.

The limits are deliberately compatible with intermittent, low-bandwidth desktop
synchronization. They prevent unlimited request upload and idle-connection time
without imposing a short application-handler deadline on valid database work.

## Runtime controls

| Environment variable | Default | Maximum | Effect |
| --- | ---: | ---: | --- |
| `API_BODY_LIMIT_BYTES` | 1,048,576 | 8,388,608 | Maximum decoded request body accepted by Fastify |
| `API_REQUEST_TIMEOUT_MS` | 120,000 | 900,000 | Maximum time to receive the complete HTTP request |
| `API_CONNECTION_TIMEOUT_MS` | 30,000 | 120,000 | Socket inactivity timeout |
| `API_KEEP_ALIVE_TIMEOUT_MS` | 5,000 | 120,000 | Idle HTTP/1.1 keep-alive lifetime |
| `DATABASE_POOL_MAX` | 10 | 100 | Maximum PostgreSQL connections owned by one API process |

Every value must be a positive integer. Startup fails before the listener opens
when a value is disabled, malformed, or exceeds its safety ceiling. The body
ceiling is intentionally above the Release 1 default so an operator can make a
reviewed deployment adjustment without allowing unbounded payloads.

Fastify explicitly closes idle connections during shutdown and returns `503` to
new requests after closing starts. Existing in-flight requests may finish;
PostgreSQL closes only after HTTP draining and Fastify close hooks complete.

## Signal behavior

`SIGINT` and `SIGTERM` share one idempotent shutdown operation. If both arrive,
the API starts closing only once. A successful close sets exit code `0`; a close
failure is logged without request or patient data and sets exit code `1`.

## Evidence

Automated tests prove that:

- explicit settings reach the Node HTTP server;
- oversized JSON requests receive a bounded `413` rejection;
- zero, malformed, and over-ceiling settings fail configuration loading;
- the API process cannot be configured with an unbounded PostgreSQL pool;
- an in-flight HTTP request completes before the database close hook runs;
- repeated termination signals cannot close shared resources twice; and
- shutdown failures produce a failing process exit code.

Run the package evidence with:

```bash
pnpm --filter @chs/api test
```

Run the complete Release 1 repository gates with:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Deployment guidance

- Keep the defaults unless measured request sizes or network conditions justify
  a change.
- Set any reverse-proxy request-body and timeout limits consistently; the proxy
  may be stricter, but it must not advertise a larger supported envelope than
  the API actually accepts.
- Do not use these variables to compensate for an unbounded sync contract. Batch
  and record constraints remain enforced by contract validation.
- Alert on repeated `413`, request-timeout, connection-timeout, and shutdown
  failure events without logging request bodies or patient identifiers.

## Out of scope

This increment does not add a reverse proxy, container resource limits, load
testing, dependency scanning, backup/restore rehearsal, or a production
orchestrator termination-grace configuration. Those remain later HSW-017 /
R1-019 and R1-020 release-hardening work.
