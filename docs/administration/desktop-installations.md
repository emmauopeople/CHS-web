# Desktop installations in the operations portal

The Desktop Installations workspace lets authorized operators enroll additional
screening PCs and replace or revoke their individual synchronization tokens.
It uses the existing audited enrollment and credential lifecycle services.
Migration 0017 introduces the separate `DESKTOP_INSTALLATION_MANAGE` permission;
patient reading and sync monitoring never imply this permission.

Grant this permission through the controlled operations-access provisioning
command, scoped to the operator's screening organization. The web API derives
the actor from OIDC and organization scope from PostgreSQL. The browser cannot
supply an operator identity or broaden its grant.

## Enroll a PC

Install the desktop, complete its deployment and location setup, and obtain its
stable installation UUID and local location UUID. These are deployment metadata,
not a patient identifier or the central location UUID. Preserve each PC's local
identity; never clone a configured SQLite database onto a second PC.

Open Desktop Installations and select Load installations. Select an authorized
central organization/location matching the physical screening site. Enter the
desktop deployment name, installation UUID, local location UUID, IANA time zone,
credential label, and a future expiry in UTC. The initial expiry is 90 days away.
Missing central sites must first be provisioned through the controlled screening
context command; this screen does not create or modify organizations/locations.

Choose Enroll desktop and generate token. Copy the one-time token into that PC's
LOCAL_ADMIN Sync Center alongside `https://api-chs.servicecam.org`. Save the
configuration. The portal clears the displayed token after five minutes, on
navigation away, or when dismissed. It never stores it in browser persistent
storage. Clipboard contents are not automatically erased; replace them after use.

Enrollment cannot silently reissue a credential for an existing installation.
If a response is lost, reload the installation list and choose Replace token.

## Replace or revoke credentials

Replace token requires explicit confirmation, the expected credential ID from
the current list, and a new future expiry. The old credential is revoked and
the new credential is issued atomically. Update the affected desktop immediately.
Concurrent or stale replacements fail without creating a second active token.

Revoke token immediately stops that credential from authenticating. It does not
delete clinical records or desktop data. A revoked token is never reactivated.
Replace token can issue a new token for a revoked installation using the latest
revoked credential as a stale-state guard. The command-line rotation behavior
continues to require a sole active credential unless the portal's explicitly
guarded recovery option is enabled by the server.

## Exposure and audit boundaries

Lists contain scoped installation metadata and credential prefixes only. They
are paginated in groups of 50. Active location choices are bounded at 500 and
the portal explicitly reports truncation. Enrollment and replacement alone
return the raw token, once, with no-store response headers. Revoked or expired
credentials remain visible as operational metadata; the server never retrieves
the original token from its hash. Mutation success audits commit with the
credential transaction and include the authenticated operations-user ID and
request ID, without the token. Authorization denials are separately audited.

The portal requires HTTPS, the existing public PKCE client, and a dedicated
organization-scoped management grant. No database password, tunnel credential,
client secret or installation token grants portal administration access.

## Validation

Database integration tests use a separate schema and synthetic organizations to
cover enrollment, scope isolation, concurrent rotation, stale IDs, revocation,
revoked-credential recovery, hash-only persistence, and actor-linked audits.
The Chromium workflow test exercises enrollment, one-time display/dismissal,
navigation clearing, and explicit rotation/revocation confirmations with mocked
synthetic API responses. Existing API, contract, and UI suites remain applicable.
