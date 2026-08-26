# HSD-OPS-005B: React Lifestyle patient panel

Status: Implemented

## Purpose

This increment completes the read-only Lifestyle portion of HSW-014 / R1-014
by rendering the HSD-OPS-005A canonical response inside each screening encounter
in the existing authorized patient viewer.

The browser makes no additional request. Lifestyle arrives with
`POST /api/v1/operations/patients/detail`, so the existing OIDC authentication,
`PATIENT_READ` authorization, server-derived organization scope,
reason-for-access, no-store response handling, and durable sensitive-read audit
continue to define the access boundary.

## Viewer behavior

An encounter with a completed canonical assessment displays:

- an explicit **Finalized canonical assessment** label, seven-day period,
  completion time, and recording practitioner;
- weekly alcohol response, quantities, and beverage types;
- weekly tobacco response and ordered product rows;
- weekly physical-activity and sedentary responses with ordered activity rows;
- weekly work response with the referenced work context;
- weekly other-activity response and ordered activity rows;
- a collapsed baseline section containing the exact alcohol, tobacco, and work
  version numbers and canonical references used by that completed assessment.

An encounter without a canonical Lifestyle assessment displays a bounded empty
state. Draft desktop Lifestyle data is never implied to be complete and is not
rendered.

The panel is responsive, keyboard-readable, and uses semantic headings,
definition lists, ordered domain rows, and a native disclosure control for
baseline provenance. It reuses the existing patient-history pagination and does
not introduce background loading.

## Runtime response boundary

The operations API client validates the complete nested Lifestyle shape before
making it available to React. The validator checks canonical UUIDs, completion
status, local dates and instants, baseline versions, enumerated responses,
numeric fields, normalized child rows, and nullable fields. A malformed nested
response fails closed as `INVALID_API_RESPONSE`; React does not partially render
untrusted Lifestyle data.

The browser type mirrors the approved `lifestyle.v1` machine contract and the
HSD-OPS-005A response. No desktop-local identifiers, source hashes, raw payloads,
sync errors, rejected records, or unresolved identity evidence are added.

## Verification

- Server-rendered component coverage verifies all five weekly domains,
  completion context, exact baseline version labels, canonical references, and
  absence of source-only fields.
- API-client coverage accepts a valid canonical Lifestyle response and rejects a
  malformed nested product reference.
- Existing operations web tests continue to cover request privacy, protected
  workspace initial states, and malformed response handling.
- Repository lint, type-check, unit, build, PostgreSQL integration, and diff
  gates remain required before merge.

## Out of scope

This task does not edit clinical data, display drafts, add recommendations,
implement amendment/replacement/void semantics, add Food/OTC/referral domains,
change desktop synchronization, map FHIR resources, or create the future
hospital/provider portal.
