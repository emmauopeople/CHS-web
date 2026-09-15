import { readFile } from 'node:fs/promises';
import pg from 'pg';
import {
  parseOperationsAccessProvisioningInput,
  provisionOperationsAccess,
} from '../administration/operations-access-provisioning.js';

const issuer = 'http://127.0.0.1:8080/realms/chs-local';

async function main(): Promise<void> {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.OPERATIONS_OIDC_ISSUER !== issuer
  ) {
    throw new Error(
      'Run local:auth:setup first; this command requires the local development issuer.',
    );
  }
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  if (
    args.length !== 2 ||
    args[0] !== '--installation' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      args[1] ?? '',
    )
  ) {
    throw new Error('Usage: pnpm local:auth:grant --installation <installation UUID>');
  }
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
  if (
    !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname)
  ) {
    throw new Error(
      'Local reviewer provisioning requires a loopback PostgreSQL connection.',
    );
  }
  // Verify the running realm before granting access. This also detects a missing import.
  const discovery = await fetch(`${issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(5_000),
    redirect: 'error',
  });
  const metadata = (await discovery.json()) as { issuer?: unknown };
  if (!discovery.ok || metadata.issuer !== issuer)
    throw new Error('Local Keycloak realm is not ready.');
  const imported = JSON.parse(
    await readFile(
      new URL('../../../../.local-auth/import/chs-local-realm.json', import.meta.url),
      'utf8',
    ),
  ) as {
    realm: string;
    users: { id: string; username: string }[];
  };
  const reviewer = imported.users.find((user) => user.username === 'chs-reviewer');
  if (imported.realm !== 'chs-local' || !reviewer?.id)
    throw new Error('Local reviewer import is missing.');
  const pool = new pg.Pool({
    connectionString: databaseUrl.href,
    max: 1,
    connectionTimeoutMillis: 3_000,
    statement_timeout: 10_000,
    application_name: 'chs-local-reviewer-provisioning',
  });
  try {
    const installation = await pool.query<{ organization_id: string }>(
      'SELECT organization_id FROM desktop_installations WHERE id = $1',
      [args[1]],
    );
    const organizationId = installation.rows[0]?.organization_id;
    if (!organizationId) throw new Error('Installation not found in the local database.');
    const input = parseOperationsAccessProvisioningInput(
      {
        oidcIssuer: issuer,
        oidcSubject: reviewer.id,
        displayName: 'Local Reviewer',
        email: null,
        grants: [
          'PATIENT_READ',
          'IDENTITY_REVIEW',
          'IDENTITY_REVIEW_RESOLVE',
          'SYNC_MONITOR',
        ].map((permissionCode) => ({
          permissionCode,
          scopeKind: 'ORGANIZATION',
          organizationId,
          expiresAt: null,
        })),
        operatorIdentifier: 'local-development-setup',
        reasonCode: 'INITIAL_ACCESS',
      },
      new Date(),
      process.env.NODE_ENV,
    );
    const result = await provisionOperationsAccess(pool, input);
    console.log(
      JSON.stringify(
        {
          kind: result.kind,
          permissions: result.grants.map((grant) => grant.permissionCode),
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error(
    'Local reviewer provisioning failed. Check development configuration, Keycloak readiness, the original import files, and the installation UUID. No credentials are printed.',
  );
  process.exitCode = 1;
});
