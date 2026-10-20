import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

// Operator-only bootstrap. The application never receives the master administrator password.
const { Pool } = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
)('pg');
const base = 'http://identity:8080';
const username = process.argv[2];
if (!username || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/.test(username))
  throw new Error('Provide the existing first super admin username.');
const issuer = process.env.OPERATIONS_OIDC_ISSUER;
if (!issuer || new URL(issuer).pathname !== '/realms/chs')
  throw new Error('Expected the configured CHS realm issuer.');
const secret = readFileSync(
  '/run/secrets/account_identity_client_secret',
  'utf8',
).trim();
const password = readFileSync(
  '/run/secrets/identity_admin_password',
  'utf8',
).trim();
const tokenResponse = await fetch(
  `${base}/realms/master/protocol/openid-connect/token`,
  {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: 'chs-admin',
      password,
    }),
  },
);
if (!tokenResponse.ok)
  throw new Error('Identity bootstrap authentication failed.');
const { access_token: token } = await tokenResponse.json();
async function request(path, method = 'GET', body) {
  const response = await fetch(`${base}/admin/realms/chs/${path}`, {
    method,
    signal: AbortSignal.timeout(10000),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw new Error(
      `Identity bootstrap operation failed (${response.status}).`,
    );
  return response.status === 204 || response.status === 201
    ? null
    : response.json();
}
const clientId = 'chs-account-admin';
let clients = await request(`clients?clientId=${clientId}`);
const clientConfig = {
  clientId,
  enabled: true,
  protocol: 'openid-connect',
  publicClient: false,
  standardFlowEnabled: false,
  directAccessGrantsEnabled: false,
  implicitFlowEnabled: false,
  serviceAccountsEnabled: true,
  secret,
  fullScopeAllowed: true,
};
if (!clients.length) {
  await request('clients', 'POST', clientConfig);
  clients = await request(`clients?clientId=${clientId}`);
} else await request(`clients/${clients[0].id}`, 'PUT', clientConfig);
const serviceAccount = await request(
  `clients/${clients[0].id}/service-account-user`,
);
const [management] = await request('clients?clientId=realm-management');
const roles = [];
for (const name of ['manage-users', 'query-users', 'view-users'])
  roles.push(await request(`clients/${management.id}/roles/${name}`));
await request(
  `users/${serviceAccount.id}/role-mappings/clients/${management.id}`,
  'POST',
  roles,
);
const users = await request(
  `users?username=${encodeURIComponent(username)}&exact=true`,
);
if (users.length !== 1 || !users[0].enabled)
  throw new Error(
    'Bootstrap requires exactly one enabled existing CHS identity.',
  );
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = await pool.connect();
try {
  await db.query('BEGIN');
  await db.query(
    "SELECT pg_advisory_xact_lock(hashtext('chs-account-administration'))",
  );
  const existing = await db.query(
    `SELECT id FROM operations_users WHERE account_role='SUPER_ADMIN' AND status='ACTIVE'
    AND oidc_issuer=$1 AND oidc_subject<>$2`,
    [issuer, users[0].id],
  );
  if (existing.rowCount)
    throw new Error(
      'Super admin already exists. Use portal account administration for additional administrators.',
    );
  const {
    rows: [user],
  } = await db.query(
    `INSERT INTO operations_users(id,oidc_issuer,oidc_subject,display_name,status,account_role,username,created_at,updated_at)
    VALUES($1,$2,$3,$4,'ACTIVE','SUPER_ADMIN',$5,now(),now())
    ON CONFLICT(oidc_issuer,oidc_subject) DO UPDATE SET account_role='SUPER_ADMIN',username=EXCLUDED.username,updated_at=now()
    RETURNING id`,
    [
      randomUUID(),
      issuer,
      users[0].id,
      [users[0].firstName, users[0].lastName].filter(Boolean).join(' ') ||
        username,
      username,
    ],
  );
  for (const permission of [
    'PATIENT_READ',
    'MEDICAL_ID_RECOVER',
    'IDENTITY_REVIEW',
    'IDENTITY_REVIEW_RESOLVE',
    'SYNC_MONITOR',
    'DESKTOP_INSTALLATION_MANAGE',
    'USER_MANAGE',
  ])
    await db.query(
      `INSERT INTO operations_access_grants(id,operations_user_id,permission_code,scope_kind,organization_id,active,granted_at,created_at,updated_at)
      VALUES($1,$2,$3,'GLOBAL',NULL,true,now(),now(),now())
      ON CONFLICT(operations_user_id,permission_code,scope_kind,organization_id) DO UPDATE SET active=true,expires_at=NULL,updated_at=now()`,
      [randomUUID(), user.id, permission],
    );
  await db.query(
    `INSERT INTO audit_events(id,operations_user_id,action_code,entity_type,entity_id,reason_code,occurred_at,outcome_code,metadata)
    VALUES($1,$2,'ACCOUNT_SUPER_ADMIN_BOOTSTRAP','OPERATIONS_USER',$2,'CONTROLLED_BOOTSTRAP',now(),'SUCCESS','{}')`,
    [randomUUID(), user.id],
  );
  await db.query('COMMIT');
  console.info(
    'CHS account service configured. Existing bootstrap account now has super admin access.',
  );
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally {
  db.release();
  await pool.end();
}
