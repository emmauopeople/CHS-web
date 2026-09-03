# HSD-HARD-002D: Privileged operations browser acceptance

Status: Implemented

## Purpose

This increment closes the remaining CHS-web browser-evidence portion of R1-020.
The existing Playwright suite protects the sign-in and canonical patient-viewer
workflow. This increment adds deterministic Chromium coverage for the three
privileged operations workspaces: Medical ID recovery, synchronization
monitoring, and identity-review resolution.

## Evidence

The browser runs the real Vite/React application with a short-lived synthetic
session and mocks only the HTTP boundary. The additional workflows prove that:

- an existing CHS Medical ID remains hidden until an authorized user selects a
  reason, compares the masked recovery candidate, and explicitly confirms the
  one-time reveal;
- synchronization support receives grouped operational outcomes and stable
  error codes without patient values or raw synchronization content;
- an identity reviewer opens protected evidence, selects a masked candidate,
  supplies a bounded reviewer note, confirms the irreversible action, and sees
  the replay-safe resolution result;
- every request is a bearer-authenticated POST with its fixed or selected reason
  in the body; and
- patient search evidence, dates, recovery tokens, installation IDs, batch and
  case references, reviewer notes, candidate references, and Medical IDs remain
  absent from browser URLs.

Run the focused workflow with:

```bash
pnpm --filter @chs/operations-web test:e2e:privileged
```

Run the complete six-scenario browser gate with:

```bash
pnpm test:e2e
```

## Scope boundary

All fixtures are synthetic and no browser test contacts PostgreSQL, an identity
provider, or a live clinical service. API authorization, organization isolation,
audit writes, idempotency, and database behavior remain covered by the
PostgreSQL integration suite. This increment changes no runtime route, schema,
permission, clinical behavior, or synchronization contract.

The final Release 1 exit demonstration is still cross-repository work: the real
desktop sync worker must persist acknowledgments and CHS Medical IDs, retry
unknown outcomes, and prove the complete offline-to-central path against this
API. That gate must not be replaced by the synthetic browser evidence.
