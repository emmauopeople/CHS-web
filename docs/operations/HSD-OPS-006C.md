# HSD-OPS-006C: browser patient-viewer workflow evidence

Status: Implemented

## Purpose

This increment adds browser-level evidence for the Release 1 operations patient
viewer. It exercises the application that staff actually use instead of proving
only isolated React components and API-client functions.

The suite is deterministic and contains synthetic data only. It does not require
a live identity provider, API process, or PostgreSQL database.

## Test boundary

Playwright starts `apps/operations-web` through its normal Vite development
entry point and runs the workflow in Chromium. Tests may seed a short-lived
synthetic session in the same `sessionStorage` key used by the application so
they can reach the authenticated workspace without weakening production sign-in
code.

The browser intercepts only these same-origin requests:

- `POST /api/v1/operations/patients/search`;
- `POST /api/v1/operations/patients/detail`.

Responses are typed synthetic canonical fixtures. The application still builds
the request, sends the Bearer header, validates the response, manages state, and
renders its production components. API integration tests remain responsible for
OIDC verification, PostgreSQL grants and organization scope, audit durability,
and canonical query behavior.

## Evidence

The browser suite proves that:

- an unauthenticated browser sees the secure sign-in boundary and cannot see the
  patient workspace;
- Search remains disabled until a controlled reason-for-access is selected;
- patient search and detail use POST with the reason in the JSON body and the
  access token in the Authorization header;
- search evidence and canonical person identifiers do not enter the browser URL;
- the initial, loading, empty-result, and bounded service-error states render;
- a result opens the canonical patient detail without a route containing patient
  data;
- CHS Medical ID, screening history, vitals, finalized Lifestyle, identity-review
  warning, acknowledgment state, and approved source provenance render from the
  validated detail response.

Failed CI runs retain traces, screenshots, and an HTML report as a short-lived
GitHub Actions artifact. Successful runs do not retain browser artifacts.

## Commands

Install the pinned browser once after installing repository dependencies:

```bash
pnpm --filter @chs/operations-web exec playwright install chromium
```

Run the workflow suite from the repository root:

```bash
pnpm test:e2e
```

Linux CI uses `playwright install --with-deps chromium` so the runner receives
the required system libraries as well as the pinned browser binary.

## Security and privacy constraints

- fixtures are explicitly synthetic and contain no real patient data;
- no test credential is valid outside the intercepted browser session;
- request and response bodies are not written to application logs;
- traces and screenshots are retained only after failure and expire after seven
  days;
- browser interception is test configuration and does not add a production
  bypass or test-only application route.

## Out of scope

This increment does not test a real identity-provider redirect, a live API or
database from the browser, cross-browser compatibility, visual regression,
accessibility conformance, desktop behavior, hospital/provider access, FHIR, or
LLM analysis.
