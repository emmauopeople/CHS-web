# HSD-OPS-006A: Patient identity assurance and source provenance query

Status: Implemented

## Purpose

This increment extends the existing authenticated, authorized, audited patient
detail response with the minimum identity-assurance and source-provenance context
needed by the temporary operations viewer. It does not add a route or a browser
request: the fields are returned by
`POST /api/v1/operations/patients/detail` under the existing `PATIENT_READ`
boundary.

## Identity assurance

Each patient detail contains:

- the canonical person's acknowledgment status;
- `CLEAR` or `REVIEW_REQUIRED` as a bounded review state; and
- the number of open review cases in which the person is a candidate and which
  fall inside the caller's organization scope.

`REVIEW_REQUIRED` is a warning for operations staff. It does not mean that the
canonical patient is duplicated or that an unresolved submission has been
accepted. Candidate demographics, matching scores, evidence, review-case IDs,
and submitted source identifiers remain available only through the separately
authorized identity-review workflow.

## Source provenance

The response reports the number of visible source registrations, the most
recent server observation time, and one bounded item per visible registration:

- desktop deployment, organization, and configured location names;
- latest accepted source revision;
- desktop source-update time; and
- first and last server-observation times.

The distinction between source-update and server-observation time is explicit:
the former is asserted by the desktop record, while the latter records central
receipt. `lastSynchronizedAt` is the newest visible `lastObservedAt`; it does not
claim that every record or domain on an installation synchronized at that time.

Desktop patient UUIDs and codes, content hashes, installation/source-link UUIDs,
raw payloads, rejected data, and synchronization error details are excluded.

## Authorization and consistency

Source registrations are filtered through the enrolled installation's
organization. Open identity-review warnings are independently filtered through
the review case's installation organization. This prevents a patient visible in
multiple organizations from leaking another organization's sources or review
work.

The additions execute inside the existing repeatable-read, read-only detail
transaction. They use one bounded source query and one aggregate review query;
no per-source or per-case query is issued. Existing OIDC authentication,
server-derived scope, reason-for-access, no-store response handling, and durable
sensitive-read auditing are unchanged.

## Verification

- PostgreSQL integration coverage verifies acknowledgment state, open-review
  warnings, source labels, revisions, timestamp semantics, and global results.
- A patient linked to two organizations proves that organization-scoped callers
  receive only their own source and review context.
- Serialized-response assertions reject desktop patient UUIDs/codes, content
  hashes, review-case IDs, and previously protected Lifestyle source fields.
- Repository lint, type-check, test, build, PostgreSQL integration, and diff
  gates remain required before merge.

## Out of scope

This task does not render the new fields in React, expose identity-review
evidence, resolve cases, modify canonical data, change desktop synchronization,
add Food/OTC/referral domains, map FHIR resources, or create hospital/provider
access.
