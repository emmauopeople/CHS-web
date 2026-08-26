# HSD-OPS-005A: Canonical Lifestyle patient query

Status: Implemented

## Purpose

This increment extends the existing authorized, audited patient-detail boundary
with finalized canonical Lifestyle assessments. It is the first query consumer
of HSD-SYNC-005C and completes the Lifestyle portion of HSW-014 / R1-014.

The browser continues to call only
`POST /api/v1/operations/patients/detail`. PostgreSQL remains behind the API,
and the existing OIDC authentication, `PATIENT_READ` authorization,
organization scope, reason-for-access, no-store response headers, and durable
sensitive-read audit apply without a second access path.

## Response model

Each visible, non-void screening encounter now contains `lifestyle`, which is
either null or one completed canonical assessment containing:

- the canonical assessment UUID, `COMPLETE` status, seven-day period,
  completion time, and recording practitioner;
- exact canonical alcohol, tobacco, and work baseline UUIDs and source version
  numbers, with the baseline values needed to interpret the week;
- weekly alcohol response and quantitative values;
- weekly tobacco response and ordered normalized product rows;
- weekly physical-activity and sedentary responses with ordered activity rows;
- weekly work response;
- weekly other-activity response with ordered activity rows.

Numeric PostgreSQL values are returned as JSON numbers, local dates retain
`YYYY-MM-DD`, and completion time is returned as an ISO-8601 instant.

## Data-safety boundary

Only normalized canonical rows are returned. The query does not expose:

- desktop-local Lifestyle, baseline, weekly, or child UUIDs;
- installation-local patient codes or source entity IDs;
- sync record IDs, source revisions, payload/content hashes, or error records;
- raw request JSON;
- rejected, retrying, or unresolved sync items;
- a draft/in-progress Lifestyle aggregate;
- Lifestyle attached to a void encounter.

The response includes the exact immutable baseline versions referenced by the
assessment. It never substitutes the patient's newest baseline.

## Scope and consistency

The patient and encounter page are resolved first under the server-derived
global or organization scope. Lifestyle loading is then restricted to those
already scoped encounter UUIDs and the same canonical person UUID. A caller
cannot supply organization or installation identifiers.

All reads remain inside the existing repeatable-read, read-only transaction.
Loading is bounded rather than per-encounter: one assessment query uses the
unique encounter index, and three batched child queries load tobacco products,
physical activities, and other activities for every assessment on the current
history page. Baseline and weekly beverage/product enumerations are loaded in
the assessment query.

## Verification

- TypeScript proves the response enum and value shapes remain aligned with the
  approved `lifestyle.v1` contract.
- PostgreSQL integration coverage verifies exact baseline references, all five
  weekly domains, normalized child ordering, numeric serialization, completion
  provenance, a null response when no assessment exists, and organization
  isolation inherited from the encounter page.
- Leakage assertions verify desktop-local Lifestyle/baseline UUIDs, source
  hashes, and raw payload fields do not enter the patient response.
- Existing operations-route integration coverage continues to prove
  authentication, `PATIENT_READ`, server-derived scope, reason-for-access,
  no-store responses, and redacted success/not-found audit records.
- Repository lint, type-check, test, build, diff, and PostgreSQL integration
  gates are required before merge.

## Out of scope

This task does not render Lifestyle in React, add clinical editing, expose
drafts, implement amendment/replacement/void semantics, add Food/OTC/referral
domains, map FHIR resources, or change hospital/provider access. The React
Lifestyle panel is HSD-OPS-005B.
