# CHS portal account administration

The Accounts workspace manages CHS-web accounts. Desktop local users remain separate.

| Role | Access | Can create/manage |
| --- | --- | --- |
| Staff | Selected permissions for one organization | No portal accounts |
| Admin | Patient viewing, Medical ID recovery, identity review/resolution, sync monitoring, desktop installations and account management for one organization | Staff within that organization |
| Super admin | The same permissions globally | Staff, admins and additional super admins |

Identity authentication is supplied by Keycloak. Role and permission authorization comes from PostgreSQL on every request; a Keycloak role claim does not confer CHS administration. Existing accounts remain Staff after migration until deliberately bootstrapped. No automatic elevation occurs for existing readers or installation managers.

Container shell scripts and SQL migrations use LF endings on every platform. The migration runner accepts the exact LF or CRLF representation of unchanged SQL so existing Windows-created checksum ledgers remain portable. It neither rewrites stored hashes nor accepts other SQL changes.

Operators run `node scripts/deployment/setup.mjs` to generate a private service client secret. Build the deployment, apply migrations, then initialize the existing first super admin:

```powershell
docker compose --env-file .deployment/deploy.env -f compose.deploy.yaml --profile tools run --rm account-bootstrap
```

The default existing username is `chs-reviewer`. To select another existing enabled CHS identity, override the command with `node scripts/deployment/bootstrap-accounts.mjs USERNAME`. This controlled operator bootstrap is refused when another active super admin already exists. It never resets the user's current password. It grants global CHS permissions to that designated first super admin and records an audit event.

The bootstrap service alone receives the Keycloak master administrator secret. It configures `chs-account-admin` with realm user management permissions. Only the API receives this client's secret. Neither the portal nor ordinary administrators receive identity service credentials or Keycloak administrator roles. Keycloak's public admin paths remain blocked at the gateway. The service account requires `manage-users`, `query-users`, and `view-users` in the CHS realm. The adapter uses the [Keycloak Admin REST API](https://www.keycloak.org/docs-api/26.7.3/rest-api/index.html).

Create accounts from Accounts → Load accounts. Staff permissions are explicitly selected; admins receive the complete organization bundle. New and reset passwords appear once, in memory only, and clear on navigation, page hiding, dismissal or after five minutes. Copy/share them directly with the account owner. No automatic email is sent. Email/password-reset delivery can be added when SMTP is configured.

Suspension updates Keycloak, terminates identity sessions and blocks subsequent CHS requests. Password resets terminate identity sessions and require password change. A distributed provider/database failure can require retry: the provider might have completed a change before a database failure. Creating an identity starts disabled and removes it on provisioning failure; without committed CHS grants it cannot access application data. All requests use bounded provider timeouts. Self-suspension and self-reset are blocked here; use the sign-in account flow for your own password, or another super admin for account changes.

Account lists are limited to 50 per page and organization selectors to 500. Administrators cannot manage a staff account that also has grants outside their own scope, including inactive grants. Permission or role changes for an existing account are currently controlled provisioning operations; the initial workspace supports account creation, suspension, activation and password reset.

## FHIR demonstration accounts

A super admin can choose **FHIR viewer (read only)** in Accounts, select the organization and create the account. The API assigns exactly `FHIR_READ` regardless of other requested permissions. First sign-in requires a password change. The portal opens directly in FHIR Resources and hides other workspaces. API authorization also rejects other operational permissions for this role, even if an incorrect grant is later inserted. Admins cannot create or manage this role.

Existing administrators receive FHIR read permission within their management scope through migration 0021; staff may be delegated FHIR read explicitly. No public FHIR server access or write capability is granted.
