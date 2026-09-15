import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const origin = 'http://127.0.0.1:18080';

export async function repairSubjectScope(credentials, request = fetch) {
  async function jsonRequest(path, init) {
    const response = await request(`${origin}${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Local Keycloak request failed.');
    return response.status === 204 ? null : response.json();
  }
  const token = await jsonRequest('/realms/master/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'admin-cli', grant_type: 'password',
      username: credentials.username, password: credentials.password,
    }),
  });
  if (typeof token?.access_token !== 'string' || !token.access_token || token.access_token.length > 16384) {
    throw new Error('Local administrator sign-in failed.');
  }
  const headers = { authorization: `Bearer ${token.access_token}` };
  const clients = await jsonRequest('/admin/realms/chs-local/clients?clientId=chs-operations-web', { headers });
  const matches = Array.isArray(clients) ? clients.filter((client) => client.clientId === 'chs-operations-web') : [];
  if (matches.length !== 1 || typeof matches[0].id !== 'string') throw new Error('Local portal client not found.');
  const clientPath = `/admin/realms/chs-local/clients/${encodeURIComponent(matches[0].id)}/default-client-scopes`;
  const scopes = await jsonRequest('/admin/realms/chs-local/client-scopes', { headers });
  const basics = Array.isArray(scopes) ? scopes.filter((scope) => scope.name === 'basic' && scope.protocol === 'openid-connect') : [];
  if (basics.length !== 1 || typeof basics[0].id !== 'string') throw new Error('Keycloak basic scope not found.');
  const scopeId = basics[0].id;
  const current = await jsonRequest(clientPath, { headers });
  if (!Array.isArray(current)) throw new Error('Invalid client scopes.');
  if (current.some((scope) => scope.id === scopeId)) return 'ALREADY_CONFIGURED';
  await jsonRequest(`${clientPath}/${encodeURIComponent(scopeId)}`, { method: 'PUT', headers });
  const confirmed = await jsonRequest(clientPath, { headers });
  if (!Array.isArray(confirmed) || !confirmed.some((scope) => scope.id === scopeId)) {
    throw new Error('Client scope repair could not be confirmed.');
  }
  return 'REPAIRED';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const env = readFileSync(resolve(root, '.env'), 'utf8');
    if ((process.env.NODE_ENV && process.env.NODE_ENV !== 'development') ||
        !/^NODE_ENV\s*=\s*["']?development["']?\s*$/m.test(env)) {
      throw new Error('Development configuration required.');
    }
    const contents = readFileSync(resolve(root, '.env.local-auth'), 'utf8');
    const values = Object.fromEntries(contents.split(/\r?\n/).filter((line) => line.includes('=')).map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1).trim()];
    }));
    const username = values.KC_BOOTSTRAP_ADMIN_USERNAME;
    const password = values.KC_BOOTSTRAP_ADMIN_PASSWORD;
    if (!username || !password) throw new Error('Local administrator credentials missing.');
    const kind = await repairSubjectScope({ username, password });
    console.log(JSON.stringify({ kind, clientScope: 'basic', nextStep: 'Sign out of the portal and sign in again to obtain a new token.' }, null, 2));
  } catch {
    console.error('Local sign-in repair failed. Confirm Keycloak is running on port 18080 and the original local admin credentials are still valid. Alternatively, add basic as a Default client scope for chs-operations-web in the chs-local realm through the Keycloak Admin Console. No credentials are printed.');
    process.exitCode = 1;
  }
}
