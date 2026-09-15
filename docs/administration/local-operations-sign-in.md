# Local operations sign-in with Docker

This development setup runs Keycloak 26.7.3 on `127.0.0.1:18080`. The operations
portal remains at `http://127.0.0.1:4173/`, the API at port 3000, and CHS PostgreSQL
at port 5432. Keycloak uses its own persistent development database volume;
clinical records stay in the existing CHS PostgreSQL database.

Port 18080 avoids the common port 8080 used by local Kubernetes labs. The
container still listens internally on 8080. If you ran setup before this port
change but have not signed in or provisioned the reviewer yet, pull the update
and rerun `pnpm local:auth:setup` and `pnpm local:auth:up`. Setup upgrades only the
recognized previous local URLs and preserves generated passwords and the subject.
Restart the API and web afterward. Existing grants under the old issuer are not
rewritten; they require separate reviewed provisioning if previously created.

## Start on Windows / Git Bash

Keep your existing `.env` with its working database settings. Do not copy
`.env.example` over it. Stop the API and Vite terminals before setup.

```bash
cd /e/health-app/CHS-web
pnpm install --frozen-lockfile
pnpm local:auth:setup
pnpm local:auth:up
```

Setup requires `NODE_ENV=development`. It preserves database settings, saves the
original environment as `.env.before-local-auth`, and replaces only operations
sign-in settings. An existing non-example provider/API URL blocks the change.
Both generated files and credentials are ignored by Git. Existing files and
passwords are preserved on a repeated setup.

Wait until this command succeeds (initial image download/startup can take a few minutes):

```bash
curl --fail --max-time 10 http://127.0.0.1:18080/realms/chs-local/.well-known/openid-configuration
```

If it does not respond, inspect startup logs:

```bash
docker compose -f compose.yaml -f compose.local-auth.yaml logs --tail=60 keycloak
```

Provision the reviewer for the organization of your already enrolled desktop:

```bash
pnpm local:auth:grant --installation 0fa09f2b-9a79-4c7f-a874-031de2cd16df
```

Use the relevant installation UUID for another deployment. The command checks
local development mode, a loopback database, and realm readiness. It uses the
imported reviewer's stable subject and the existing audited provisioning service.
It grants organization-scoped patient reading, identity review, identity review
resolution, and sync monitoring. It never creates a patient or resolves a case.
An exact repeat is idempotent. No global permission is granted.

Restart the API and portal in separate terminals:

```bash
pnpm dev:api
```

```bash
pnpm dev:web
```

Open `.local-auth/credentials.txt` locally, for example:

```bash
notepad .local-auth/credentials.txt
```

Visit `http://127.0.0.1:4173/` (use this exact host and port), choose Sign in,
and use the `chs-reviewer` initial password from the file. Keycloak requires a
new password on first login. The file retains the initial password afterward;
it is not a record of later password changes. Do not paste this file into chat.
Vite now fails if port 4173 is occupied instead of silently selecting another
port. Stop the older portal terminal and start it again. Opening localhost, a
different port, or `/index.html` shows a link to the registered local address
before any sign-in transaction is created. Keep the client redirect allowlist
exact; do not add wildcard redirects to work around this error.

The development server permits its injected styles and the local Keycloak token
connection through a development-only HTML policy. Production builds retain the
original stricter policy. If the portal appears unstyled or shows a redirect
error after pulling this change, stop and restart Vite and open the exact portal
URL again with a hard refresh. There is no need to recreate Keycloak or grants.

The separate Keycloak admin credentials in that file are for managing local
sign-in accounts at `http://127.0.0.1:18080/admin/`; they do not grant CHS access.
The reviewer identity must be preserved. Deleting/recreating that user changes
its subject and requires reviewed provisioning rather than assuming the same
username is the same identity.

## Verify locally before merging

1. Discovery succeeds and returns the exact local issuer above.
2. Sign-in redirects to Keycloak, requires the initial password change, and
   returns to the portal with an authenticated organization-scoped session.
3. Open Identity Review and load the open case. Review its evidence before making
   an explicit decision; do not create/link an identity just to test access.
4. Sync Monitoring and patient search are available within the same organization.
5. Restart the Keycloak container; the changed password and user persist.
6. Re-run the grant command; it reports `ALREADY_PROVISIONED`.

Automated checks:

```bash
pnpm local:auth:test
pnpm --filter @chs/api exec vitest run test/operations-access-provisioning.test.ts test/operations-authentication.test.ts
pnpm typecheck
```

Docker and interactive browser verification must run on the developer's PC when
the coding environment has no Docker daemon. Unit tests alone do not prove the
container import or browser redirect flow.

## Login succeeds but API actions return to sign-in

The original local client import omitted Keycloak's `basic` default client scope.
That scope supplies the access token's `sub` claim. The browser could complete
login, but the API correctly rejected a token without a subject with HTTP 401.
The setup template now includes `basic`. Existing realms skip startup imports,
so changing the JSON and restarting Keycloak alone does not repair a running realm.

After pulling the fix, run:

```bash
pnpm local:auth:setup
pnpm local:auth:repair
```

Setup preserves the imported subject and password while updating the saved
client scopes. Repair signs in to the fixed loopback Keycloak admin endpoint
using the original generated admin credentials, adds only `basic` to the existing
portal client's default scopes, and verifies it is attached. It does not change
users, passwords, CHS grants, patient identities, or token validation. It reports
`REPAIRED` or `ALREADY_CONFIGURED`. Credentials and tokens are not printed.

Sign out of the portal and sign in again immediately, then search. Previously
issued tokens are not repaired retroactively. If the admin password was changed,
use the Keycloak Admin Console instead: choose `chs-local`, Clients,
`chs-operations-web`, Client scopes, Add client scope, select `basic`, and add it
as **Default**. Do not recreate the user or realm.

If fresh sessions still fail after this repair, inspect the failed request's HTTP
status and controlled response code in browser Network tools and verify the API
was restarted with the local issuer configuration. Do not share the bearer token.

Reference: [Keycloak's basic scope and subject mapper](https://www.keycloak.org/docs/latest/upgrading/index.html#_new_default_client_scope_basic).

## Boundaries and recovery

This is local development only: Keycloak's development mode uses HTTP on a
loopback-bound port. Provisioning permits only this exact HTTP issuer when
`NODE_ENV=development`; its default and production validation still require
HTTPS. Token signature, issuer, audience, expiration, PKCE, and database
permission checks remain active. No installation token or client secret is used
as a portal password.

The first start imports `.local-auth/import/chs-local-realm.json`. Keycloak skips
an already existing realm on subsequent starts. Preserve `.local-auth`,
`.env.local-auth`, and the `chs-keycloak-data` volume together. Running setup again
is not a password reset. To stop only local sign-in:

```bash
docker compose -f compose.yaml -f compose.local-auth.yaml stop keycloak
```

Do not run `docker compose down -v` as part of this workflow: it can delete the
CHS database volume as well as local identity data. Restoring the previous `.env`
and restarting the API and web restores the previous configuration; keep the
identity volume if you intend to resume local sign-in.

Provider references: [Keycloak Docker setup](https://www.keycloak.org/getting-started/getting-started-docker),
[realm import and restart behavior](https://www.keycloak.org/server/importExport).
