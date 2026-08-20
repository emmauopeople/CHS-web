# HSD-ADMIN-001B: Operations access provisioning

Status: Implemented

## Purpose

This increment provides the controlled Release 1 process for pre-enrolling an
internal operations user and assigning the PostgreSQL grants required by the
React operations portal.

The identity provider continues to handle passwords, multifactor
authentication, account recovery, and OAuth2/OIDC token issuance. This command
does not create an identity-provider account. It binds an existing OIDC issuer
and subject to a deny-by-default CHS operations account.

This is not hospital/provider onboarding. Hospital and provider access to
patient information remains deferred to a later release.

## Supported permissions

Only permissions with implemented protected workflows can be provisioned:

- `PATIENT_READ` — canonical patient search and clinical detail;
- `MEDICAL_ID_RECOVER` — controlled Medical ID recovery;
- `IDENTITY_REVIEW` — scoped, read-only identity-review investigation;
- `IDENTITY_REVIEW_RESOLVE` — irreversible link-or-create identity decisions; and
- `SYNC_MONITOR` — redacted synchronization monitoring.

`AUDIT_READ` remains reserved in the database schema but cannot be provisioned
until its protected workflow is implemented.

Every permission is independently granted. In particular, `IDENTITY_REVIEW`
does not imply resolution authority, and `PATIENT_READ` does not imply Medical
ID recovery or sync monitoring.

## Input

Obtain the exact OIDC issuer and stable subject from the configured identity
provider. Do not guess the subject from an email address, and do not put an
access token in this file.

```json
{
  "oidcIssuer": "https://identity.example.org/",
  "oidcSubject": "00u-stable-subject-123",
  "displayName": "Operations Nurse",
  "email": "operations.nurse@example.org",
  "grants": [
    {
      "permissionCode": "PATIENT_READ",
      "scopeKind": "ORGANIZATION",
      "organizationId": "10000000-0000-4000-8000-000000000001",
      "expiresAt": null
    },
    {
      "permissionCode": "MEDICAL_ID_RECOVER",
      "scopeKind": "ORGANIZATION",
      "organizationId": "10000000-0000-4000-8000-000000000001",
      "expiresAt": "2027-08-20T12:00:00Z"
    }
  ],
  "operatorIdentifier": "platform-admin@example.org",
  "reasonCode": "INITIAL_ACCESS"
}
```

An organization-scoped grant requires an active canonical organization ID from
HSD-ADMIN-001A. A global grant requires `organizationId: null` and should be
reserved for personnel whose duties genuinely cover every screening program.
One request cannot mix global and organization scopes for the same permission.

`email` and `expiresAt` may be `null`. Production access should use an expiry
when organizational policy requires periodic access recertification.

## Operator command

Apply database migrations, then run:

```bash
pnpm admin:operations-access:provision -- --input ./operations-access.json
```

The result returns the non-secret operations-user and grant UUIDs. Preserve
them in the access-management record. After the configured identity provider
issues a valid access token for the exact issuer/subject, the API applies these
grants without trusting any scope supplied by the browser.

## Idempotency and conflict rules

Provisioning takes a transaction-scoped advisory lock on the OIDC principal and
atomically creates the operations user, requested grants, and redacted audit
event.

- An exact retry returns `ALREADY_PROVISIONED` with the existing UUIDs.
- An exact retry creates no rows and no duplicate audit event.
- New organization grants may be added to an exact existing active user.
- Changed display name, email, or a suspended existing user returns
  `OPERATIONS_PRINCIPAL_CONFLICT`; provisioning never silently edits or
  reactivates a user.
- Missing or inactive organizations are rejected.
- Existing inactive, expired, or differently expiring grants are rejected
  rather than silently replaced.
- An effective global grant and organization grant cannot coexist for the same
  permission through this command.

User editing, suspension/reactivation, grant replacement, and grant revocation
require a separate explicit lifecycle operation.

## Audit and privacy boundary

Successful changes create an `OPERATIONS_ACCESS_PROVISION` audit event. The
event records the target operations-user ID, created grant IDs and scopes,
operator identifier, reason, and a SHA-256 fingerprint of the OIDC principal.

Audit metadata does not contain the OIDC subject, issuer, email, display name,
access token, patient information, or clinical data. The audit
`operations_user_id` remains null because the target account is not necessarily
the infrastructure operator performing the provisioning.

No HTTP route is registered. The command requires controlled direct access to
`DATABASE_URL`, and its output contains no credential or token.

## Verification

Unit tests cover strict fields, HTTPS issuer normalization, bounded identity
data, supported permissions, scope consistency, duplicate detection, UUIDs,
and future expiries. PostgreSQL integration tests cover:

- atomic user, grant, and audit creation;
- immediate authorization through the implemented permission paths;
- exact retry without duplicate state;
- adding another organization scope;
- rejection of changed principals, incompatible scopes, and inactive
  organizations; and
- exclusion of raw OIDC identity values from audit metadata.

## Out of scope

Identity-provider account creation, passwords, MFA, OIDC client registration,
operations-user lifecycle changes, access recertification UI, hospital/provider
OAuth2, FHIR access, and browser administration remain separate increments.
