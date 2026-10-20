import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { realm } from '../local-auth/setup.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = resolve(root, '.deployment');
for (const name of ['secrets', 'inputs', 'backups', 'identity-import']) {
  mkdirSync(resolve(directory, name), { recursive: true });
}
for (const name of ['postgres_password', 'identity_database_password', 'identity_admin_password', 'reviewer_password', 'account_identity_client_secret', 'provider_identity_client_secret', 'fhir_database_password']) {
  const path = resolve(directory, 'secrets', name);
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
}
const env = resolve(directory, 'deploy.env');
if (!existsSync(env)) copyFileSync(resolve(root, 'infra/deploy.env.example'), env);
const identityPath = resolve(directory, 'identity.json');
if (!existsSync(identityPath)) {
  writeFileSync(identityPath, JSON.stringify({ subject: randomUUID(), username: 'chs-reviewer' }, null, 2), { flag: 'wx' });
}
const importPath = resolve(directory, 'identity-import/chs-realm.json');
if (!existsSync(importPath)) {
  const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
  const config = realm(identity.subject, '${CHS_REVIEWER_INITIAL_PASSWORD}');
  config.realm = 'chs';
  config.sslRequired = 'external';
  config.bruteForceProtected = true;
  config.clients[0].redirectUris = ['https://chsweb.servicecam.org/'];
  config.clients[0].webOrigins = ['https://chsweb.servicecam.org'];
  config.clients[0].attributes['post.logout.redirect.uris'] = 'https://chsweb.servicecam.org/';
  config.users[0].firstName = 'CHS';
  config.users[0].lastName = 'Reviewer';
  delete config.users[0].email;
  config.users[0].emailVerified = false;
  writeFileSync(importPath, JSON.stringify(config, null, 2), { flag: 'wx' });
}
console.info('Deployment directories ready. Existing settings and database password preserved.');
console.info('Identity realm ready; reviewer requires a password change and separate organization-scoped CHS grants.');
