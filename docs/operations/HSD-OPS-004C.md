# HSD-OPS-004C: React identity review workspace

Status: Implemented

## Purpose

This increment adds the operator-facing React workflow for investigating and
resolving open patient identity-review cases. It consumes the protected query
and resolution boundaries from HSD-OPS-004A and HSD-OPS-004B; it does not place
identity matching or mutation rules in the browser.

## Workflow

The Identity Review workspace uses the fixed, audited
`IDENTITY_RECONCILIATION` reason. It deliberately loads no protected data when
opened. An authorized reviewer can manually:

1. filter the scoped open-case queue by evidence state, installation, and
   opened period;
2. open one case to disclose its minimum submitted identity evidence;
3. compare that evidence with the case's masked canonical candidates;
4. select one listed candidate or choose to create a new canonical identity;
5. enter a 10–1,000 character decision note and explicitly confirm the
   irreversible decision; and
6. receive the resulting full CHS Medical ID after successful resolution.

New-identity creation is disabled when the case evidence is pending. Candidate
linking is restricted by the API to candidates attached to the case.

## Privacy and browser behavior

Queue data is masked and exact submitted demographics are requested only when
a reviewer opens a case. Filters, case references, identity evidence,
resolution notes, and Medical IDs remain in non-cacheable POST bodies or
in-memory React state; they are not placed in browser URLs or persisted by the
workspace.

The UI never displays raw sync payload JSON, payload hashes, credentials, or
clinical observations. The full Medical ID is shown only in the successful
resolution result so the reviewer can confirm what the desktop will receive on
a later patient synchronization.

## Concurrency and retry safety

Each decision sends the case `updatedAt` value as `expectedUpdatedAt`. Stale
cases, already-resolved cases, and unavailable candidates produce specific
instructions to refresh before another decision.

The browser creates a UUID for a normalized resolution command and retains it
for an identical retry after a network failure. Editing the action, candidate,
or note creates a different command UUID. This cooperates with the server's
durable idempotency record and prevents duplicate identity creation when a
response is lost.

## Authorization and accessibility

Queue and detail requests require `IDENTITY_REVIEW`; mutation separately
requires `IDENTITY_REVIEW_RESOLVE`. The browser handles an expired session by
clearing it and returning to sign-in, while the API remains the authority for
permission and organization scope.

Forms use explicit labels, native radio and checkbox controls, status and alert
regions, keyboard-operable actions, responsive tables, and a narrow-screen
review panel. Loading is manual to reduce low-bandwidth traffic and disclosure.

## Verification

Type-safe response validators fail closed on malformed identity-review data.
Automated tests verify that protected values remain outside URLs, responses are
validated, the initial workspace makes no request, and protected evidence is
not rendered before a case is opened. Existing API and PostgreSQL integration
tests continue to verify authorization, scoping, transactionality,
idempotency, and audit behavior.

## Out of scope

This workspace does not merge canonical persons, dismiss cases, edit submitted
or canonical demographics, choose arbitrary persons, or poll resolved IDs from
the desktop. Those require separate contracts and increments.
