# HSD-ADMIN-001A: Canonical screening context provisioning

Status: Implemented

## Purpose

This increment provides the controlled Release 1 process for creating the
canonical organization and location records required before a desktop can be
enrolled. It generates central UUIDs, stores stable business identifiers, and
returns the organization and location IDs consumed by HSD-SYNC-003A.

This is screening-program infrastructure provisioning. It is not hospital
account onboarding, provider registration, OAuth2 client creation, or access to
patient information.

## Input

Create a non-secret JSON input file:

```json
{
  "organizationIdentifierSystem": "https://chs.example/id/organization",
  "organizationIdentifierValue": "ORG-NORTHWEST-001",
  "organizationName": "Northwest Screening Program",
  "organizationTypeCode": "SCREENING_PROGRAM",
  "locationIdentifierSystem": "urn:chs:screening-location",
  "locationIdentifierValue": "LOC-BAFOUSSAM-001",
  "locationName": "Bafoussam Community Site",
  "locationTypeCode": "SCREENING_SITE",
  "physicalTypeCode": "MOBILE",
  "village": "Bafoussam",
  "subdivision": null,
  "region": "West",
  "directions": null,
  "operatorIdentifier": "platform-admin@example.org",
  "reasonCode": "INITIAL_PROVISIONING"
}
```

Identifier systems must be absolute HTTPS URLs or URNs. Type and reason codes
use upper snake case. Optional location fields may be `null`; blank strings are
rejected so missing and present data remain unambiguous.

## Operator command

Apply database migrations, then run:

```bash
pnpm admin:screening-context:provision -- --input ./screening-context.json
```

A new pair returns `PROVISIONED` with generated `organizationId` and
`locationId`. Preserve those non-secret IDs in the deployment record and use
them in the HSD-SYNC-003A desktop enrollment input.

The same command can add a location to an existing organization by supplying
the exact existing organization identifier, name, and type with a new location
identifier. The organization ID is reused and only a new location ID is
created.

## Idempotency and conflict rules

Provisioning takes a transaction-scoped advisory lock on the organization
business identifier and creates the organization, location, and redacted audit
event atomically.

- An exact retry returns `ALREADY_PROVISIONED` with the existing UUIDs.
- An exact retry creates no new rows and no duplicate audit event.
- Reusing an organization identifier with a changed name, type, or inactive
  record returns `ORGANIZATION_IDENTIFIER_CONFLICT`.
- Reusing a location identifier within the organization with changed canonical
  data or an inactive record returns `LOCATION_IDENTIFIER_CONFLICT`.
- A failure rolls back every row created by that attempt.

The command never silently edits or reactivates canonical records. Those state
changes require separate, explicit administration operations.

## Audit and security boundary

Successful state changes create `SCREENING_CONTEXT_PROVISION` audit events.
Audit metadata contains the generated IDs, stable business identifiers,
operator identifier, and which records were created. The input contains no
credentials or patient information.

No HTTP route is registered. The command requires direct controlled access to
`DATABASE_URL`, and its result contains no secret.

## Verification

Unit tests cover strict fields, identifier-system validation, code
normalization, bounded text, and control-character rejection. PostgreSQL
integration tests cover:

- atomic organization/location creation and audit;
- exact-retry UUID recovery without duplicates;
- adding another location to an existing organization; and
- organization and location conflict rollback.

## Out of scope

Hospital/provider onboarding, OAuth2, organization or location editing,
deactivation/reactivation, desktop installation state management, operations
user provisioning, FHIR publication, and browser administration remain
separate increments.
