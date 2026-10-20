# CHS pilot deployment

This Compose project runs independently of One Community. It contains CHS
PostgreSQL 18, a migration job, the Fastify API, a built React portal, an Nginx
gateway, and production-mode Keycloak with a separate PostgreSQL database.
FHIR publication and a FHIR server are not included in this release.

Run commands from the CHS-web checkout in PowerShell:

```powershell
./scripts/deployment/chs.ps1 setup
./scripts/deployment/chs.ps1 up
./scripts/deployment/chs.ps1 check
./scripts/deployment/chs.ps1 status
./scripts/deployment/chs.ps1 backup
```

The only default host binding is 127.0.0.1:8090. Host-based routing requires
the configured public hostnames in the Host header, even for local checks.
Real sign-in requires the HTTPS tunnel routes below. OIDC browser settings are
build arguments; rebuild the gateway after changing them. Changing provider
issuer also requires deliberate grant migration, not just a frontend rebuild.

## Local credentials and storage

Setup preserves existing settings and generates independent random passwords in
`.deployment/secrets/`. This directory is excluded from Git and Docker builds.
Treat the directory and backups as sensitive; keep encrypted offline copies.
Docker Compose file secrets are local files, not an encrypted secrets vault.

Keycloak's bootstrap administrator is `chs-admin`; the initial password is in
`.deployment/secrets/identity_admin_password`. The initial portal user is
`chs-reviewer`; its initial password is in `.deployment/secrets/reviewer_password`.
It must change that password on first sign-in. The initial password file is not
a record of subsequent password changes. No CHS data permissions are granted
until the actual screening organization is provisioned.

The stable reviewer subject is recorded in `.deployment/identity.json`. Keycloak
imports `.deployment/identity-import/chs-realm.json` only when the realm does
not exist. Do not recreate users/realm to reset passwords; database grants bind
to the exact issuer and subject. Preserve identity data during migration.

The identity admin console is not exposed by the public gateway. Controlled
local administration can use `docker compose --env-file .deployment/deploy.env
-f compose.deploy.yaml exec identity /opt/keycloak/bin/kcadm.sh` inside the
container. Do not put passwords in shell arguments or terminal transcripts.

The optional `compose.identity-admin.yaml` binds Keycloak to loopback port 18090
for diagnostics. The canonical frontend URL remains the public HTTPS hostname.

## Cloudflare Tunnel

Create a dedicated named CHS tunnel in the existing Cloudflare account. Configure
these three published application routes, preserving their original Host headers:

| Public hostname | Tunnel service |
| --- | --- |
| chsweb.servicecam.org | http://gateway:80 |
| api-chs.servicecam.org | http://gateway:80 |
| auth-chs.servicecam.org | http://gateway:80 |

Save only the new tunnel token in `.deployment/secrets/tunnel_token` through a
local secure input. Never reuse or overwrite One Community's token. Then run:

```powershell
./scripts/deployment/chs.ps1 public
```

Do not add an interactive Cloudflare Access challenge to the desktop sync paths.
The current desktop supplies its installation Bearer credential and rejects
redirects. Exclude clinical API responses from edge caching. Do not enable
request-body capture for clinical routes. The gateway blocks metrics, API docs,
and Keycloak administration externally.

Verify public API readiness, OIDC discovery, portal sign-in and password change,
then organization-scoped portal access. Test sync with synthetic records before
using actual screening data. Successful local checks do not prove public DNS,
TLS, OIDC callback handling or a completed desktop round trip.

## Organization and desktop enrollment

Obtain the existing desktop installation UUID and source location UUID without
resetting or recreating its local database. Prepare non-secret input files under
`.deployment/inputs/` following the existing administration runbooks. Start the
stack first, then provision the canonical screening organization and location:

```powershell
docker compose --env-file .deployment/deploy.env -f compose.deploy.yaml run --rm --build admin pnpm --filter @chs/api exec node --import tsx src/commands/provision-screening-context.ts --input /inputs/context.json
docker compose --env-file .deployment/deploy.env -f compose.deploy.yaml run --rm --build admin pnpm --filter @chs/api exec node --import tsx src/commands/provision-operations-access.ts --input /inputs/access.json
```

Use the real organization ID for organization-scoped grants, the issuer from
`deploy.env`, and the stable reviewer subject from `identity.json`. Grant only
the required permissions. See `docs/administration/HSD-ADMIN-001B.md`.

Enroll the desktop with the returned canonical IDs, its original installation
and location IDs, and the documented operator/reason/expiry fields:

```powershell
docker compose --env-file .deployment/deploy.env -f compose.deploy.yaml run --rm --build admin pnpm --filter @chs/api exec node --import tsx src/commands/enroll-installation.ts --input /inputs/enrollment.json
```

Enrollment prints a one-time installation token. Run it only in a private
terminal without shared output capture; transfer the token directly to the
desktop's protected LOCAL_ADMIN Sync Center. Set the API origin to
`https://api-chs.servicecam.org`, without `/api`. Each desktop requires its own
credential. Rotate a lost token through the existing guarded rotation command.
Do not use a portal password, tunnel token or database password for sync.

## Backups and OVHcloud migration

The backup command writes separate binary PostgreSQL custom-format dumps for
CHS and Keycloak. It avoids PowerShell binary-output redirection. Store encrypted
copies off this PC and test restoration to an isolated database. The local
backup directory is not an offsite backup and no recurring backup is scheduled.

For migration, quiesce writes, take fresh backups, preserve `.deployment`
configuration/secrets and image digests, restore each database into its matching
PostgreSQL major version on OVHcloud, then switch the tunnel connector after
validation. Keep the hostnames and identity subjects stable so desktop origins
and CHS grants continue to match. Never run `down -v` against retained data.
