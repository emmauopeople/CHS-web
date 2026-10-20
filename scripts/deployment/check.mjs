import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';

const envPath = new URL('../../.deployment/deploy.env', import.meta.url);
const environment = Object.fromEntries(readFileSync(envPath, 'utf8').split(/\r?\n/)
  .filter(line => line && !line.startsWith('#')).map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
const base = `http://127.0.0.1:${environment.CHS_LOCAL_PORT || '8090'}`;
const portal = `https://${environment.CHS_PORTAL_HOST}`;
function request(host, path, options = {}) {
  // node:http preserves the explicit Host header needed for local virtual hosts.
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}${path}`, {
      method: options.method || 'GET',
      headers: { host, ...options.headers },
      signal: AbortSignal.timeout(10_000),
    }, response => {
      const chunks = [];
      let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > 1_048_576) { response.destroy(new Error('Response too large')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode,
          headers: { get: name => response.headers[name.toLowerCase()] ?? null },
          text: async () => body,
          json: async () => JSON.parse(body),
        });
      });
    });
    request.on('error', reject);
    request.end(options.body);
  });
}

assert.equal((await request('unknown.invalid', '/')).status, 404);
const page = await request(environment.CHS_PORTAL_HOST, '/');
assert.equal(page.status, 200);
assert.match(await page.text(), /CHS Patient Viewer/);
assert.equal((await request(environment.CHS_API_HOST, '/health/ready')).status, 200);
for (const path of ['/metrics', '/docs', '/version']) {
  assert.equal((await request(environment.CHS_API_HOST, path)).status, 404);
}
for (const origin of [portal, 'https://untrusted.invalid']) {
  const response = await request(environment.CHS_API_HOST, '/api/v1/sync/batches', {
    method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), origin === portal ? portal : null);
}
const sync = await request(environment.CHS_API_HOST, '/api/v1/sync/identity-resolutions/pull', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({contractVersion: '1.0', limit: 1}),
});
assert.equal(sync.status, 401, 'Sync must require an enrolled installation credential');
const discovery = await request(environment.CHS_AUTH_HOST, '/realms/chs/.well-known/openid-configuration');
assert.equal(discovery.status, 200);
const identity = await discovery.json();
assert.equal(identity.issuer, environment.OPERATIONS_OIDC_ISSUER);
assert.equal(identity.authorization_endpoint, environment.VITE_OPERATIONS_OIDC_AUTHORIZATION_ENDPOINT);
assert.equal(identity.token_endpoint, environment.VITE_OPERATIONS_OIDC_TOKEN_ENDPOINT);
const authorization = new URL(identity.authorization_endpoint);
authorization.search = new URLSearchParams({
  client_id: environment.VITE_OPERATIONS_OIDC_CLIENT_ID,
  redirect_uri: `${portal}/`, response_type: 'code', scope: 'openid profile',
  state: 'chs-deployment-check', code_challenge_method: 'S256',
  code_challenge: 'CJR5kVxd49B31J9oWoO3QFZfq0cqSgBDhIeGDRHnt3A',
}).toString();
const signIn = await request(environment.CHS_AUTH_HOST, `${authorization.pathname}${authorization.search}`);
assert.equal(signIn.status, 200, 'Configured PKCE client and exact portal callback must be accepted');
assert.match(await signIn.text(), /name="username"/, 'Sign-in must render a username form');
assert.equal((await request(environment.CHS_AUTH_HOST, '/admin/')).status, 404);
console.info('PASS: portal, API readiness, exact-origin CORS, mandatory sync authentication, OIDC discovery, PKCE sign-in form, and private administration.');
