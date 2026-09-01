# Release 1 API guide

## Boundary

Release 1 exposes one Fastify API for registered desktop synchronization,
authorized operations workflows, and platform diagnostics. All patient and
support responses come from normalized canonical or bounded operational queries.
No route returns raw synchronization payloads, credential material, hashes,
unresolved candidate demographics as clinical truth, or rejected records in a
patient timeline.

The executable desktop contract and OpenAPI document are in
`packages/contracts`. Development builds also expose Swagger UI at `/docs`;
production deployments must publish approved API documentation separately and
must not rely on the development UI.

The companion [`release-1-catalog.json`](release-1-catalog.json) is the
machine-readable route inventory. Tests compare it with every Release 1 route
literal and require this guide to cover every method/path pair.

## Authentication models

| Model | Used by | Rule |
| --- | --- | --- |
| None | Health, metrics, version | Deployment ingress must still restrict operational endpoints such as metrics according to platform policy. |
| Installation bearer | `/api/v1/sync/*` | Hashed, revocable credential bound to one active installation, organization, configured location, and timezone. |
| OIDC bearer | `/api/v1/operations/*` | Verified issuer/audience/signature plus an enrolled active operations user and an active scoped permission grant. |

Machine credentials never authorize operations endpoints. Human OIDC sessions
never substitute for installation credentials. Every operations route enforces
organization scope, and patient/recovery/support actions record minimum-necessary
audit evidence.

## Endpoint inventory

| Method and path | Authentication / permission | Purpose |
| --- | --- | --- |
| `GET /health/live` | None | Process liveness. |
| `GET /health/startup` | None | Startup completion. |
| `GET /health/ready` | None | PostgreSQL-backed readiness. |
| `GET /metrics` | None | Prometheus-compatible bounded metrics. |
| `GET /version` | None | Build commit and build-time metadata. |
| `POST /api/v1/sync/batches` | Installation bearer | Submit or exactly replay a bounded batch. |
| `GET /api/v1/sync/batches/:batchId` | Installation bearer | Recover that installation's stored response. |
| `POST /api/v1/sync/identity-resolutions/pull` | Installation bearer | Pull pending central identity decisions. |
| `POST /api/v1/sync/identity-resolutions/acknowledge` | Installation bearer | Acknowledge a durable desktop identity update. |
| `POST /api/v1/operations/patients/search` | OIDC + `PATIENT_READ` | Reason-gated paginated canonical patient search. |
| `POST /api/v1/operations/patients/detail` | OIDC + `PATIENT_READ` | Canonical timeline, vitals, Lifestyle, assurance, and provenance. |
| `POST /api/v1/operations/medical-id-recovery/search` | OIDC + `MEDICAL_ID_RECOVER` | Create an expiring case and return masked candidates. |
| `POST /api/v1/operations/medical-id-recovery/reveal` | OIDC + `MEDICAL_ID_RECOVER` | Reveal one verified existing ID once. |
| `POST /api/v1/operations/identity-reviews/search` | OIDC + `IDENTITY_REVIEW` | Search scoped review cases. |
| `POST /api/v1/operations/identity-reviews/detail` | OIDC + `IDENTITY_REVIEW` | Read bounded review evidence. |
| `POST /api/v1/operations/identity-reviews/resolve` | OIDC + `IDENTITY_REVIEW_RESOLVE` | Resolve one case with an immutable decision. |
| `POST /api/v1/operations/sync/batches/search` | OIDC + `SYNC_MONITOR` | Search bounded sync metadata. |
| `POST /api/v1/operations/sync/batches/detail` | OIDC + `SYNC_MONITOR` | Read grouped outcomes and safe error codes. |

`AUDIT_READ` is reserved in the database permission vocabulary but has no
Release 1 HTTP endpoint.

## Request and response rules

- External JSON objects reject unknown fields where route schemas define the
  body. The synchronization contract also performs cross-record semantic
  validation.
- Operations list routes use server-side pagination with bounded page sizes;
  the browser never downloads the full patient or support dataset.
- Operations POST bodies carry filters and reason codes so patient values do not
  enter URLs, proxy logs, or browser history.
- Every response sets `Cache-Control: no-store`; sensitive operations responses
  also set `Pragma: no-cache`.
- Successful exact batch replays return the stored response without repeating
  canonical writes. A reused batch ID with different content returns
  `BATCH_PAYLOAD_MISMATCH`.
- Errors use stable safe codes and a request ID. Internal exception details,
  SQL, tokens, hashes, patient values, and request bodies are not returned.

## Common status families

| Status | Meaning |
| --- | --- |
| `200` | Request completed, including exact replay or a bounded empty result. |
| `400` | Invalid schema, query, identifier, state, or contract content. |
| `401` | Missing, invalid, expired, or revoked bearer authentication. |
| `403` | Principal is valid but lacks permission, organization scope, or installation context. |
| `404` | Scoped resource or stored response does not exist. |
| `409` | Idempotency/content conflict, in-progress state, stale resolution, or incompatible lifecycle. |
| `429` | Reserved for deployment rate limiting when configured at the platform boundary. |
| `500` | Sanitized unexpected server failure. |
| `503` | Dependency, authentication-key, readiness, or shutdown unavailability. |

Clients must branch on the stable problem `code`, not human-readable titles.
Retry only outcomes explicitly defined as retryable; do not retry authorization,
payload-mismatch, or validation failures by assigning a new identifier.

## Local verification

```bash
pnpm docs:check
pnpm --filter @chs/api test:integration
```

The API integration suite verifies authentication, organization isolation,
audit behavior, exact replay, recovery, and non-leakage. The documentation gate
verifies inventory coverage; it is not a substitute for those behavioral tests.
