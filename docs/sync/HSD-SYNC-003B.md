# HSD-SYNC-003B: Desktop credential rotation and revocation

Status: Implemented

## Purpose

This increment completes the controlled Release 1 lifecycle for desktop
synchronization credentials. Infrastructure operators can replace a current
credential or revoke a compromised, lost, or retired credential without a
public administration endpoint.

These commands manage desktop-to-web synchronization only. They do not create
hospital/provider OAuth2 credentials or grant access to patient information.

## Rotation

Rotation requires the ID of the credential the operator expects to replace:

```json
{
  "installationId": "20000000-0000-4000-8000-000000000001",
  "expectedCredentialId": "21000000-0000-4000-8000-000000000001",
  "credentialLabel": "Scheduled replacement 2026-08",
  "credentialExpiresAt": "2027-08-19T12:00:00Z",
  "operatorIdentifier": "platform-admin@example.org",
  "reasonCode": "SCHEDULED_ROTATION"
}
```

Run the command in a controlled terminal that is not captured by shared logs:

```bash
pnpm admin:installation:rotate -- --input ./rotation.json
```

The command succeeds only when the installation is active and the expected
credential is its sole active credential. This optimistic guard prevents a
stale or concurrent operator request from replacing a token issued by another
rotation.

Within one locked PostgreSQL transaction, the service revokes the expected
credential, creates a new 256-bit credential, and records a redacted audit
event. At commit, the old token stops authenticating and the new token becomes
active. The new raw `installationToken` appears once in standard output. Store
and transfer it using the same controlled process described by
[HSD-SYNC-003A](HSD-SYNC-003A.md).

## Revocation

Revocation can immediately stop a desktop from synchronizing. Its input
therefore requires an exact confirmation phrase:

```json
{
  "installationId": "20000000-0000-4000-8000-000000000001",
  "credentialId": "21000000-0000-4000-8000-000000000002",
  "operatorIdentifier": "platform-admin@example.org",
  "reasonCode": "DEVICE_RETIRED",
  "confirmation": "REVOKE_INSTALLATION_CREDENTIAL"
}
```

```bash
pnpm admin:installation:revoke -- --input ./revocation.json
```

The credential must belong to the specified installation. A first request
returns `REVOKED`; an exact retry returns `ALREADY_REVOKED` with the original
revocation time and creates no duplicate audit event. Revocation is allowed for
active, suspended, or retired installations so a credential can always be
invalidated during incident response.

## Security and concurrency controls

- Rotation and revocation are operator-only CLI commands with no HTTP route.
- Both commands take a transaction-scoped advisory lock on the installation.
- Rotation requires exactly one active credential and an expected credential
  ID, preventing lost concurrent updates.
- Revocation requires a credential ID, installation ID, reason, operator
  identifier, and destructive confirmation.
- The raw token is never passed as command input or written to PostgreSQL,
  logs, metrics, audit metadata, or errors.
- Audit events contain only credential IDs, non-secret token prefixes, operator
  identifiers, reasons, and timestamps.

## Operational recovery

Preserve the non-secret current credential ID in the deployment record. If a
new token is lost before reaching the desktop, determine the active credential
ID through the controlled database/audit process and rotate that credential
again. Do not re-run installation enrollment.

## Verification

Unit tests cover strict input parsing, expiry validation, optimistic-guard
fields, and destructive confirmation. PostgreSQL integration tests prove:

- atomic old-token revocation and new-token authentication;
- redacted rotation and revocation audit events;
- stale expected-credential rejection without state changes;
- active-installation enforcement for rotation;
- immediate authentication failure after revocation; and
- idempotent repeated revocation.

## Out of scope

Installation suspension/reactivation, organization/location onboarding, a
browser administration console, automatic secret-manager delivery,
hospital/provider OAuth2, and FHIR access remain separate increments.
