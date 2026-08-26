# HSD-OPS-006B: React patient assurance and source provenance

Status: Implemented

## Purpose

This increment renders the HSD-OPS-006A identity-assurance and source-provenance
response in the existing authorized React patient detail panel. It completes the
remaining patient-header context required by HSW-015 / R1-015 without adding a
route, browser request, permission, or database access path.

The fields arrive with
`POST /api/v1/operations/patients/detail`, so the existing OIDC authentication,
`PATIENT_READ` authorization, server-derived organization scope,
reason-for-access, no-store handling, and durable sensitive-read audit remain
the security boundary.

## Viewer behavior

The patient detail panel displays:

- canonical acknowledgment status;
- a prominent, bounded warning when one or more in-scope open identity-review
  cases list the patient as a possible match;
- an explicit clear state when no in-scope warning exists;
- visible source count and the latest patient-source observation time; and
- an accessible disclosure containing each visible desktop deployment,
  organization, configured location, accepted revision, source-update time,
  first central receipt, and last central receipt.

The warning states that unresolved submissions are not clinical truth. It does
not display candidate demographics, scores, evidence, review-case references,
or a resolution action. Source details are collapsed by default to keep the
patient header compact on narrow screens and low-bandwidth operations devices.

The interface labels desktop-asserted `sourceUpdatedAt` as **Source updated**
and central observation timestamps as **First received** and **Last received**.
The summary says **Last patient update received**, avoiding a claim that every
record or clinical domain on the installation synchronized at that time.

## Runtime response boundary

The API client fails closed unless:

- acknowledgment and review states use the approved enums;
- `CLEAR` has zero open cases and `REVIEW_REQUIRED` has at least one;
- counts are non-negative safe integers;
- source count equals the number of source items;
- source labels are bounded, non-blank strings;
- revisions are positive safe integers; and
- every source/server timestamp is a valid bounded instant, with a null latest
  observation allowed only for an empty source list.

React renders only the approved presentation fields. Desktop patient UUIDs and
codes, installation/source-link UUIDs, hashes, raw payloads, rejected data,
review-case IDs, candidate evidence, and synchronization errors are absent.

## Accessibility and responsive behavior

The assurance region has a semantic heading, textual warning/clear states, and
a native `details`/`summary` disclosure usable by keyboard and assistive
technology. Meaning is not conveyed by color alone. Source timestamps stack on
small screens, and long labels wrap without requiring a second data request.

## Verification

- API-client coverage accepts a consistent assurance/provenance response and
  rejects contradictory review counts and mismatched source counts.
- Server-rendered component coverage verifies warning, clear, populated-source,
  and empty-source states, approved labels, revisions, timestamps, and absence
  of protected source/review field names.
- Existing patient, Lifestyle, recovery, monitoring, and identity-review web
  tests remain green.
- Repository lint, type-check, unit, build, PostgreSQL integration, and diff
  gates remain required before merge.

## Out of scope

This task does not resolve identity cases, add navigation to the identity-review
workspace, edit canonical data, add Food/OTC/referral domains, change desktop
synchronization, create browser end-to-end infrastructure, map FHIR resources,
or create hospital/provider access.
