# HSD-OPS-002A: React operations patient viewer

Status: Implemented

## Purpose

This increment adds the temporary internal React application that consumes the
authenticated and audited canonical-patient boundary delivered by
HSD-OPS-001A and HSD-OPS-001B. It lets authorized staff search clean,
deduplicated patients and inspect accepted screening and vital-sign history.

The viewer never reads PostgreSQL directly. It receives only the server-filtered
canonical representation from the operations API.

## Application boundary

`apps/operations-web` is a static React 19 and TypeScript application built with
Vite. It is a separate workspace package but remains part of the Release 1
modular-monolith deployment. In production, the ingress should serve the web
application and proxy `/api` to `apps/api` on the same public origin.

The browser calls only:

- `POST /api/v1/operations/patients/search`;
- `POST /api/v1/operations/patients/detail`.

Search terms, dates of birth, CHS Medical IDs, and canonical person IDs stay in
POST bodies and in-memory UI state. They do not appear in browser URLs. Requests
disable HTTP caching, and the web application does not log request or response
bodies.

## Human sign-in

The application uses OAuth 2.0 Authorization Code with PKCE against the
configured OpenID Connect provider. It is a public browser client and must not
be provisioned with a client secret. The implementation:

- creates a cryptographically random state and PKCE verifier;
- uses only the `S256` PKCE challenge method;
- validates returned state and limits a transaction to ten minutes;
- exchanges the authorization code directly with the configured token endpoint;
- accepts only a bounded Bearer access token with a bounded lifetime;
- stores the short-lived access token in `sessionStorage`, never `localStorage`;
- does not request, persist, or use a refresh token;
- removes the authorization code and state from the browser URL immediately;
- clears local authentication state on sign-out or API `401`.

The API remains the security authority. It verifies the token signature and
claims, rejects unenrolled identities, derives database grants, and records the
patient-access audit. Browser state never grants scope or permission.

Required build-time public configuration:

- `VITE_OPERATIONS_OIDC_AUTHORIZATION_ENDPOINT`
- `VITE_OPERATIONS_OIDC_TOKEN_ENDPOINT`
- `VITE_OPERATIONS_OIDC_CLIENT_ID`
- `VITE_OPERATIONS_OIDC_SCOPE`

Optional configuration:

- `VITE_OPERATIONS_OIDC_END_SESSION_ENDPOINT`
- `VITE_CHS_API_BASE_URL` (empty for the recommended same-origin deployment)

OIDC redirect URIs and post-logout redirect URIs must exactly match the deployed
viewer URL. Production endpoints and an explicit API base URL must use HTTPS.

## Patient-viewer behavior

Every search or detail read requires a controlled reason-for-access. Changing
the reason clears existing patient results and details so a new access context
must produce a new audited request.

The patient list shows:

- canonical name and CHS Medical ID;
- date of birth, sex, status, and residence;
- latest accepted screening time and location;
- server-paginated results limited to 25 patients per page.

The detail panel shows canonical demographics and paginated screening history,
including organization, location, practitioner, protocol, encounter state,
amendment context, vital-set status, anthropometrics, and blood-pressure
readings. HSD-OPS-006B adds acknowledgment status, a bounded in-scope identity
warning, and approved source deployment/location/revision/timestamp context to
the same detail response. It does not show raw synchronization payloads,
rejected records, quarantine data, or unresolved identity-review candidates as
clinical truth.

## Local development

1. Copy `.env.example` to `.env` and replace the example OIDC values with a
   development public-client registration.
2. Register `http://127.0.0.1:4173/` as its development redirect and logout URI.
3. Start PostgreSQL and the API.
4. Start the viewer.

```bash
docker compose up -d postgres
pnpm db:migrate
pnpm dev:api
pnpm dev:web
```

Vite serves the viewer at `http://127.0.0.1:4173` and proxies `/api` to
`http://127.0.0.1:3000`. The OIDC provider must allow authorization-code PKCE
for the public SPA client and allow its token endpoint to be called from the
development origin.

## Deployment requirements

The static files must be served with TLS and production security headers at the
ingress or web server, including a restrictive Content Security Policy,
`X-Content-Type-Options: nosniff`, a suitable `Referrer-Policy`, and clickjacking
protection. Static hashed assets may be cached; `index.html` should use a short
or no-cache policy. API responses containing patient data must remain
non-cacheable.

## Verification

- TypeScript checks the application and browser/API types in strict mode.
- API-client tests prove search evidence remains outside URLs, Bearer tokens use
  the authorization header, and malformed success bodies fail closed.
- formatting tests protect local-date display and missing-value behavior.
- HSD-OPS-006C runs the real Vite application in Chromium and proves sign-in
  protection, reason gating, POST-body privacy, bounded request states, canonical
  detail rendering, assurance context, vitals, and Lifestyle presentation.
- the production Vite build emits only static assets and no source maps.
- repository lint, type-check, unit, integration, build, and CI gates remain
  required.

## Out of scope

Medical ID recovery is delivered by HSD-OPS-002B, and controlled initial
operations-user provisioning is delivered by HSD-ADMIN-001B. This increment
does not implement identity-review queues, browser-based operations-user
administration, hospital/provider OAuth2 access, FHIR mapping or publication, a
FHIR server, lifestyle display before its canonical sync contract exists, or
LLM analysis.
