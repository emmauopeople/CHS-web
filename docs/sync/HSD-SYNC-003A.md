# HSD-SYNC-003A: Controlled desktop installation enrollment

Status: Implemented

## Purpose

This increment provides the controlled Release 1 process that makes a desktop
installation eligible to call the synchronization API. It binds an existing
canonical organization and location to the UUIDs configured by the desktop,
then creates the installation's first bearer credential.

This is an infrastructure-operator command. It is not a public API and it is
not the hospital/provider OAuth2 flow planned for a later release.

## Preconditions

The canonical organization and location must already exist and be active. The
location must belong to the organization. The operator obtains the stable
installation and source-location UUIDs from the desktop deployment package.

Create an input file containing only non-secret enrollment data:

```json
{
  "installationId": "20000000-0000-4000-8000-000000000001",
  "organizationId": "10000000-0000-4000-8000-000000000001",
  "configuredLocationId": "30000000-0000-4000-8000-000000000001",
  "sourceLocationId": "32000000-0000-4000-8000-000000000001",
  "deploymentName": "Bafoussam screening desktop",
  "timezone": "Africa/Douala",
  "credentialLabel": "Initial enrollment",
  "credentialExpiresAt": "2027-08-19T12:00:00Z",
  "operatorIdentifier": "platform-admin@example.org",
  "reasonCode": "INITIAL_ENROLLMENT"
}
```

`credentialExpiresAt` may be `null`. Production credentials should normally
have an expiry selected by the security policy.

## Operator command

Apply migrations first. Run the command in a controlled terminal that is not
captured by shared logs:

```bash
pnpm admin:installation:enroll -- --input ./enrollment.json
```

The command writes one JSON result to standard output. Its
`installationToken` is sensitive and is revealed only by this successful
command. Transfer it through an approved secret channel and configure it in the
matching desktop installation. Delete any temporary output file after the
desktop has stored the credential securely.

The server persists only the token's SHA-256 digest and a non-secret prefix.
The raw token is never written to PostgreSQL, application logs, audit metadata,
metrics, or error responses.

## Transaction and retry behavior

Enrollment holds a transaction-scoped advisory lock for the installation UUID,
then atomically creates:

1. the active desktop installation;
2. its canonical-to-source location binding;
3. its first active credential; and
4. a redacted `DESKTOP_INSTALLATION_ENROLL` audit event.

The command validates UUIDs, bounded labels, an IANA timezone, a future expiry,
and an upper-snake-case reason code. It rejects missing, inactive, or
cross-organization canonical records.

Reusing an installation UUID never creates a second credential implicitly. An
exact retry returns `INSTALLATION_ALREADY_ENROLLED`; a changed binding returns
`INSTALLATION_CONFLICT`. If the one-time token is lost, use the explicit
credential-rotation process delivered by the next increment rather than
re-running enrollment.

## Security boundary

- No enrollment HTTP route is registered.
- `DATABASE_URL` is the only secret consumed by the command.
- The operator identity and reason are required and recorded without the token.
- The credential authenticates desktop synchronization only.
- It does not grant operations-portal, hospital, provider, patient, or FHIR
  access.

## Verification

Unit tests cover cryptographic token shape and input validation. PostgreSQL
integration tests cover atomic persistence, immediate authentication, redacted
auditing, exact-retry refusal, conflict rejection, and transaction rollback.

## Out of scope

Credential rotation/revocation, installation suspension, organization/location
onboarding, a browser-based administration console, hospital/provider OAuth2,
FHIR access, and cloud secret-manager delivery remain separate increments.
