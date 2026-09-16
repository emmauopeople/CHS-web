import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairSubjectScope } from './repair.mjs';

function provider(configured = false, rejected = false) {
  const calls = [];
  let attached = configured;
  async function request(url, init) {
    calls.push({ url, init });
    assert.equal(new URL(url).origin, 'http://127.0.0.1:18080');
    assert.equal(init.redirect, 'error');
    if (url.endsWith('/token')) return Response.json({ access_token: 'private-admin-token' });
    assert.equal(init.headers.authorization, 'Bearer private-admin-token');
    if (url.includes('?clientId=')) return Response.json([{ id: 'portal-id', clientId: 'chs-operations-web' }]);
    if (url.endsWith('/client-scopes')) return Response.json([{ id: 'basic-id', name: 'basic', protocol: 'openid-connect' }]);
    if (init.method === 'PUT') {
      assert.ok(url.endsWith('/clients/portal-id/default-client-scopes/basic-id'));
      if (rejected) return new Response('', { status: 403 });
      attached = true;
      return new Response(null, { status: 204 });
    }
    return Response.json(attached ? [{ id: 'basic-id', name: 'basic' }] : []);
  }
  return { calls, request };
}

test('repairs only the existing client scope and confirms the mutation', async () => {
  const mock = provider();
  assert.equal(await repairSubjectScope({ username: 'local-admin', password: 'private-password' }, mock.request), 'REPAIRED');
  assert.equal(mock.calls.filter((call) => call.init.method === 'PUT').length, 1);
  assert.equal(mock.calls.filter((call) => call.init.method === 'POST').length, 1);
  assert.ok(mock.calls.every((call) => !call.url.includes('private')));
  assert.equal(mock.calls.at(-1).init.method, undefined);
});

test('does not mutate an already configured client or bypass a denied repair', async () => {
  const current = provider(true);
  assert.equal(await repairSubjectScope({ username: 'local-admin', password: 'private-password' }, current.request), 'ALREADY_CONFIGURED');
  assert.ok(current.calls.every((call) => call.init.method !== 'PUT'));
  const denied = provider(false, true);
  await assert.rejects(repairSubjectScope({ username: 'local-admin', password: 'private-password' }, denied.request), /request failed/);
});
