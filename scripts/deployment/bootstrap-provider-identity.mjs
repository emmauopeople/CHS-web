import { readFileSync } from 'node:fs';
const base = 'http://identity:8080';
const secret = readFileSync(
  '/run/secrets/provider_identity_client_secret',
  'utf8',
).trim();
const password = readFileSync(
  '/run/secrets/identity_admin_password',
  'utf8',
).trim();
const r = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
  method: 'POST',
  signal: AbortSignal.timeout(10000),
  body: new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username: 'chs-admin',
    password,
  }),
});
if (!r.ok) throw new Error('Provider bootstrap authentication failed');
const { access_token: token } = await r.json();
async function call(path, method = 'GET', body) {
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
    throw new Error(`Provider bootstrap failed (${response.status})`);
  return response.status === 204 || response.status === 201
    ? null
    : response.json();
}
const config = {
  clientId: 'chs-provider-admin',
  protocol: 'openid-connect',
  enabled: true,
  publicClient: false,
  standardFlowEnabled: false,
  implicitFlowEnabled: false,
  directAccessGrantsEnabled: false,
  serviceAccountsEnabled: true,
  fullScopeAllowed: true,
  secret,
};
let clients = await call('clients?clientId=chs-provider-admin');
if (clients.length) await call(`clients/${clients[0].id}`, 'PUT', config);
else {
  await call('clients', 'POST', config);
  clients = await call('clients?clientId=chs-provider-admin');
}
const user = await call(`clients/${clients[0].id}/service-account-user`);
const [management] = await call('clients?clientId=realm-management');
const roles = [];
for (const name of ['manage-clients', 'view-clients'])
  roles.push(await call(`clients/${management.id}/roles/${name}`));
await call(
  `users/${user.id}/role-mappings/clients/${management.id}`,
  'POST',
  roles,
);
console.info(
  'Private CHS provider-client administration configured. No hospital credentials created.',
);
