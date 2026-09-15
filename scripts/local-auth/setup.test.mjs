import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureEnv, realm, settings, setup } from './setup.mjs';

test('updates only local auth settings and preserves database settings; rejects existing providers and production', () => {
  const source =
    '# keep\nNODE_ENV=development\nDATABASE_URL=postgresql://private-db\nCUSTOM=unchanged\n';
  const updated = configureEnv(source);
  assert.ok(updated.startsWith(source));
  for (const [key, value] of Object.entries(settings))
    assert.ok(updated.includes(`${key}=${value}`));
  assert.equal(configureEnv(updated), updated);
  assert.throws(() => configureEnv(source.replace('development', 'production')));
  assert.throws(() =>
    configureEnv(source + 'OPERATIONS_OIDC_ISSUER=https://real-provider.example/'),
  );
  assert.throws(() =>
    configureEnv(source + 'OPERATIONS_OIDC_ISSUER=\nOPERATIONS_OIDC_ISSUER=\n'),
  );
  assert.ok(
    configureEnv(
      source + 'OPERATIONS_OIDC_ISSUER=https://identity.example.invalid/',
    ).includes(settings.OPERATIONS_OIDC_ISSUER),
  );
});

test('realm uses a public PKCE client, exact redirect, API audience, and password update', () => {
  const config = realm('test-subject', 'test-password');
  const client = config.clients[0];
  assert.equal(client.publicClient, true);
  assert.equal(client.directAccessGrantsEnabled, false);
  assert.equal(client.implicitFlowEnabled, false);
  assert.equal(client.attributes['pkce.code.challenge.method'], 'S256');
  assert.deepEqual(client.redirectUris, ['http://127.0.0.1:4173/']);
  assert.equal(
    client.protocolMappers[0].config['included.custom.audience'],
    settings.OPERATIONS_OIDC_AUDIENCE,
  );
  assert.equal(config.users[0].id, 'test-subject');
  assert.equal(config.users[0].credentials[0].temporary, true);
  assert.equal('secret' in client, false);
});

test('repeated setup preserves initial credentials, subject, and original env backup', () => {
  const root = mkdtempSync(join(tmpdir(), 'chs-local-auth-'));
  try {
    const original = 'NODE_ENV=development\nDATABASE_URL=postgresql://local\n';
    writeFileSync(join(root, '.env'), original);
    setup(root);
    const paths = [
      '.env',
      '.env.before-local-auth',
      '.env.local-auth',
      '.local-auth/credentials.txt',
      '.local-auth/import/chs-local-realm.json',
    ];
    const before = paths.map((path) => readFileSync(join(root, path), 'utf8'));
    setup(root);
    assert.deepEqual(
      paths.map((path) => readFileSync(join(root, path), 'utf8')),
      before,
    );
    assert.equal(before[1], original);
    assert.equal(
      JSON.parse(before[4]).users[0].credentials[0].value,
      '${CHS_LOCAL_REVIEWER_INITIAL_PASSWORD}',
    );
    assert.ok(before[2].includes('CHS_LOCAL_REVIEWER_INITIAL_PASSWORD='));
    rmSync(join(root, '.local-auth/credentials.txt'));
    assert.throws(() => setup(root), /incomplete/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
