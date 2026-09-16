# HSW-019D referral Patient Viewer slice

Status: Implemented browser slice; the full HSW-019D installation retrieval
contract remains pending.

## Purpose

This increment exposes accepted referral data in the existing protected
operations Patient Viewer. It does not change desktop capture, synchronization
payloads, PostgreSQL ingestion, or referral ownership.

## Retrieval boundary

`POST /api/v1/operations/patients/detail` returns a separately paginated set of
referral summaries for the selected canonical person. A summary includes the
current referral state, encounter lifecycle state, canonical organization and
location, practitioner attribution, counts, source revision, and central receipt
time. It does not include source-local identifiers, hashes, raw payloads, or
rejected records.

`POST /api/v1/operations/patients/referrals/detail` returns one referral with
two independent bounded histories:

- immutable status events ordered by descending sequence number;
- immutable follow-ups ordered by descending recording time and canonical ID.

Treatment actions are limited to three rows per follow-up and medication changes
to twenty by PostgreSQL constraints. Status events and follow-ups are paginated
instead of being returned as unbounded nested arrays.

## Authorization and audit

Both routes require a verified OIDC bearer, an active `PATIENT_READ` grant, a
controlled reason for access, and server-derived organization scope. Patient and
referral identifiers travel only in POST bodies. Responses use `no-store` and
each targeted referral read records a `PATIENT_REFERRAL_DETAIL_VIEW` audit event
without putting patient identity in audit metadata.

Referrals linked to a voided encounter remain visible because referral follow-up
and audit obligations survive encounter voiding. The response and viewer label
the encounter `VOID`; the voided encounter is not restored to the screening
timeline.

## Verification

- query integration coverage verifies organization isolation, independent
  pagination, voided-encounter visibility, practitioner attribution, treatment
  actions, medication changes, and exclusion of source-local IDs;
- route integration coverage verifies POST-only access, no-store responses,
  stable not-found behavior, and audit evidence;
- API-client tests fail closed on malformed nested referral data;
- Playwright covers the reason-gated patient workflow and renders referral
  summary, status, follow-up, and medication information.

FHIR, addenda/review flags, desktop history caching, and the all-domain
installation retrieval contract remain outside this slice.
