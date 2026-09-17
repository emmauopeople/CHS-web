# HSW-019D: protected central patient-history retrieval

Status: implemented for coordinated review and Windows acceptance. HSW-019C upload
contracts are unchanged. Desktop history cache and retrieval UI remain HSW-019E;
FHIR remains deferred.

## Access boundary

The installation endpoint is `POST /api/v1/sync/patients/history`. Every page
requires a current installation credential, an active source-attributed `NURSE`
or `LOCAL_ADMIN`, an active organization/location, and an exact confirmed
`patient_source_links` binding between the requesting installation, local patient
and canonical person. Unresolved identity cases or newer rejected patient
identities block retrieval. The caller cannot supply sharing scope. Only records
owned by the installation's organization are returned, including other enrolled
installations in that organization. Cross-organization sharing requires a future
explicit server-side grant and is not enabled here.

`requesterLocalActorId` is an attribution asserted by the trusted installation,
not a second independent user authentication factor. The future desktop caller
must derive it from its authenticated local nurse/admin session. A Medical ID or
canonical person ID alone does not authorize retrieval.

The operations endpoint is `POST /api/v1/operations/patients/history`. It verifies
OIDC and current `PATIENT_READ` grants on every page, keeping organization/global
scope server-derived. Both audiences must provide a controlled access reason.
Only POST bodies carry patient identifiers and cursors. HTTP logs/metrics retain
route templates and stable error codes only. Read audit records identify the
canonical person and authenticated principal without duplicating clinical
content in metadata; audit failure prevents a successful response.

## Bounded read contract

The browser-safe public contract is
`packages/contracts/src/patient-history.mjs` with its TypeScript declaration.
Published JSON Schemas and representative fixtures are under
`packages/contracts/schemas/history/v1` and `fixtures/history/v1`.

Requests contain `contractVersion`, `personId`, `reasonCode`, `fromDate`, `toDate`,
and optionally `resourceTypes`, `limit`, and `cursor`. Installations also provide
`localPatientId` and `requesterLocalActorId`. Dates are inclusive UTC days, at most
366 days per traversal. Date filters apply to each record's occurrence or recording
time rather than requiring the original encounter to fall within that window.
Responses contain current canonical demographics and up to 50 resources (default
25), with a 512 KiB response budget and a five-second per-statement database budget.

Resources include encounter/session/protocol context, vitals/readings, complete
Lifestyle/baselines, Food, OTC, referral snapshots, referral status, follow-ups
with treatment/medication rows, addenda, review flags and independent review
status events. Each item includes canonical ID/parent, author, occurrence time,
central receipt time, source revision, source organization/location/installation,
and encounter void/amendment state. Data is projected from normalized columns;
source-local IDs, raw upload bodies, hashes and credentials are not returned.
Review flags retain revision 1 for their immutable opening; their derived current
state includes the latest lifecycle sequence, author and timestamp. Individual
status events remain immutable resources and are never collapsed into that state.

The opaque cursor is server-stored in migration `0016` and lasts fifteen minutes.
It is bound to caller, credential (installation), scope, patient, access reason,
date range, resource filters, page size and a canonical version digest. Keyset
ordering is descending occurrence time, resource type, then canonical ID. Each
page uses a repeatable-read transaction. If clinical content/provenance changes
within the date window, continuation returns `HISTORY_CURSOR_STALE` (409).
Clients must discard the incomplete traversal and begin again, retaining any
previous complete cache until a replacement is complete. Expired cursors are
removed in bounded batches; expiry is enforced independently of cleanup.

Repeated continuation requests return the same records/next cursor while data
and access remain unchanged. Revoking a token, suspending its installation or
actor, withdrawing an operations grant, or introducing an identity conflict is
rechecked before returning the next page. Cursors persist across API restarts.
The history path writes only cursor/audit metadata, never clinical tables or a
synchronization outbox.

## Patient Viewer

The existing patient, screening and referral views remain. A new section loads
addenda, review flags/status changes, Food and OTC with date/type filters,
Previous/Next pages, author/time/source attribution and explicit void/amendment
labels. It displays each accepted source value, including review resolution
reasons and Food/OTC row provenance. Old requests cannot overwrite a newly opened
patient or a changed filter. A changed/expired traversal offers refresh; no
clinical history is placed in browser local storage.

## Windows acceptance

Update the API/web branch first, install locked dependencies as needed, run
`pnpm db:migrate`, `pnpm db:test`, `pnpm test`, and `pnpm build`, then restart API
and web. Migration 0016 adds only protected cursor metadata (16 migrations,
60 tables in total). No desktop schema or application upgrade is required for
this server/viewer increment.

Open a synthetic patient in Patient Viewer, choose an access reason, and load
additional history over dates containing uploaded addenda/reviews/Food/OTC.
Compare text, dates, authors, source and review resolution with desktop. Change
types/dates and exercise Previous/Next with more than ten records. Add a late
note or change source encounter state while pages are open; a stale continuation
must require refresh and the refreshed history must preserve prior events.
Installation retrieval is covered by PostgreSQL integration tests using actual
sync ingestion from two same-organization installations plus an excluded
organization. Its desktop controls and read-only persistent cache follow in
HSW-019E.
