# HSD-OPS-003B: React synchronization dashboard

Status: Draft for implementation review

## Purpose

This increment adds a synchronization workspace to the existing React
operations portal. It consumes the HSD-OPS-003A API so authorized operations
staff can recognize completed, attention-required, or stalled desktop batches
without reading raw submitted records or clinical data.

The dashboard is a read-only operational view. It does not retry, modify, or
delete synchronization work.

## Application boundary

The workspace remains inside `apps/operations-web`, the React 19, TypeScript,
and Vite application already used for canonical patient viewing and Medical ID
recovery. It reuses the same Authorization Code with PKCE session and same-
origin API client.

The browser calls only:

- `POST /api/v1/operations/sync/batches/search`; and
- `POST /api/v1/operations/sync/batches/detail`.

The controlled reason is always `OPERATIONS_SUPPORT`. The UI displays it as a
fixed audited value instead of allowing the operator to select a reason the
server will reject. The API remains authoritative for the `SYNC_MONITOR`
permission and organization scope.

## Monitoring workflow

The operator can filter the scoped batch list by:

- server batch status;
- installation UUID; and
- received-from and received-to local date/time values.

Date/time values are converted to timezone-aware ISO instants before being
sent. Filters are kept in component memory and POST bodies. They do not appear
in browser URLs, browser storage, logs, or analytics.

Loading is manual rather than continuously polled. This keeps the interface
predictable and limits traffic on low-bandwidth networks. An explicit Refresh
action reruns the last submitted page and filters.

The list shows:

- healthy, attention, or stalled operational state;
- durable server batch state;
- source batch UUID and contract version;
- deployment, organization, and location;
- received and completion timing; and
- accepted, unchanged, review-required, rejected, and retry counts.

Summary cards distinguish all matching batches from current-page health counts
so a page-limited result is never presented as a system-wide total.

## Redacted detail

The detail panel shows operational batch context, desktop/contract versions,
grouped resource outcomes, and grouped stable error-code counts. It never
renders:

- raw request or response payloads;
- payload hashes;
- source/local record identifiers;
- patient or canonical clinical identifiers;
- demographic or clinical values;
- error paths; or
- error messages.

The API client validates the complete success shape before rendering it.
Malformed pages, invalid UUIDs, invalid timestamps, unexpected outcome values,
and unsafe error codes fail closed as an invalid upstream response.

## Interaction and accessibility

The workspace provides:

- persistent top-level navigation with a clearly selected workspace;
- associated labels for every filter control;
- native keyboard-operable forms, tables, buttons, and pagination;
- live loading and result-count status text;
- explicit initial, no-results, permission, unavailable, and scoped-not-found
  states;
- horizontal table containment at narrow widths; and
- a responsive detail panel and summary layout.

No fabricated batch, clinical, or patient information is displayed.

## Authentication and error behavior

An API `401` clears the in-memory/session authentication state and returns the
operator to secure sign-in. A `403` explains that `SYNC_MONITOR` permission is
missing without claiming access scope. Missing and out-of-scope detail
references share the same safe message. Request IDs may be displayed for other
controlled failures, but raw server errors are never rendered.

## Verification

Automated coverage proves:

- filters and batch references stay out of URLs;
- Bearer tokens remain in authorization headers;
- search and detail requests use non-cacheable POST bodies;
- complete valid pages and grouped details are accepted;
- malformed or unsafe success bodies fail closed;
- synchronization durations use bounded display precision; and
- the strict TypeScript and production Vite builds complete.

Repository API, database, contract, integration, and build gates remain
required even though HSD-OPS-003B changes only the web application and
documentation.

## Out of scope

This increment does not add automatic retry controls, raw-record inspection,
patient data to monitoring, background polling, Prometheus/Grafana dashboards,
Fluent Bit/OpenSearch deployment, hospital/provider OAuth2, FHIR mapping or
publication, a FHIR server, or LLM analysis.
