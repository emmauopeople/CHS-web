import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const issuer = 'http://127.0.0.1:8080/realms/chs-local';
export const settings = {
  OPERATIONS_OIDC_ISSUER: issuer,
  OPERATIONS_OIDC_AUDIENCE: 'chs-operations-api',
  OPERATIONS_OIDC_JWKS_URL: `${issuer}/protocol/openid-connect/certs`,
  VITE_CHS_API_BASE_URL: '',
  VITE_OPERATIONS_OIDC_AUTHORIZATION_ENDPOINT: `${issuer}/protocol/openid-connect/auth`,
  VITE_OPERATIONS_OIDC_TOKEN_ENDPOINT: `${issuer}/protocol/openid-connect/token`,
  VITE_OPERATIONS_OIDC_END_SESSION_ENDPOINT: `${issuer}/protocol/openid-connect/logout`,
  VITE_OPERATIONS_OIDC_CLIENT_ID: 'chs-operations-web',
  VITE_OPERATIONS_OIDC_SCOPE: 'openid profile',
};

export function realm(subject, password) {
  return {
    realm: 'chs-local',
    enabled: true,
    sslRequired: 'none',
    registrationAllowed: false,
    resetPasswordAllowed: false,
    accessTokenLifespan: 300,
    clients: [
      {
        clientId: 'chs-operations-web',
        protocol: 'openid-connect',
        enabled: true,
        publicClient: true,
        standardFlowEnabled: true,
        implicitFlowEnabled: false,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: false,
        redirectUris: ['http://127.0.0.1:4173/'],
        webOrigins: ['http://127.0.0.1:4173'],
        attributes: {
          'pkce.code.challenge.method': 'S256',
          'post.logout.redirect.uris': 'http://127.0.0.1:4173/',
        },
        defaultClientScopes: ['web-origins', 'profile', 'email'],
        protocolMappers: [
          {
            name: 'chs-api-audience',
            protocol: 'openid-connect',
            protocolMapper: 'oidc-audience-mapper',
            config: {
              'included.custom.audience': 'chs-operations-api',
              'access.token.claim': 'true',
              'id.token.claim': 'false',
            },
          },
        ],
      },
    ],
    users: [
      {
        id: subject,
        username: 'chs-reviewer',
        enabled: true,
        firstName: 'Local',
        lastName: 'Reviewer',
        email: 'chs-reviewer@localhost.invalid',
        emailVerified: true,
        credentials: [{ type: 'password', value: password, temporary: true }],
        requiredActions: ['UPDATE_PASSWORD'],
      },
    ],
  };
}

export function configureEnv(source) {
  const lines = source.split(/\r?\n/);
  const seen = new Set();
  const result = lines.map((line) => {
    const match = /^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) return line;
    const [, key, raw] = match;
    const value = raw.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (key === 'NODE_ENV' && value !== 'development')
      throw new Error('Local sign-in requires NODE_ENV=development.');
    if (!(key in settings)) return line;
    if (seen.has(key)) throw new Error(`Duplicate configuration key: ${key}`);
    seen.add(key);
    if (
      (key.includes('ENDPOINT') ||
        key.endsWith('ISSUER') ||
        key.endsWith('JWKS_URL') ||
        key === 'VITE_CHS_API_BASE_URL') &&
      value &&
      value !== settings[key] &&
      !value.startsWith('https://identity.example.invalid/')
    ) {
      throw new Error(
        'Existing identity/API URL configuration found; review it before enabling local sign-in.',
      );
    }
    return `${key}=${settings[key]}`;
  });
  if (!lines.some((line) => /^(?:export\s+)?NODE_ENV\s*=/.test(line)))
    throw new Error('Set NODE_ENV=development in .env first.');
  for (const [key, value] of Object.entries(settings))
    if (!seen.has(key)) result.push(`${key}=${value}`);
  return result.join('\n');
}

export function setup(root) {
  const envPath = resolve(root, '.env');
  if (!existsSync(envPath))
    throw new Error(
      'Create .env from .env.example and configure the local database first.',
    );
  const before = readFileSync(envPath, 'utf8');
  const after = configureEnv(before);
  const directory = resolve(root, '.local-auth');
  const realmPath = resolve(directory, 'import/chs-local-realm.json');
  const credentialsPath = resolve(directory, 'credentials.txt');
  const dockerEnv = resolve(root, '.env.local-auth');
  const existing = [realmPath, credentialsPath, dockerEnv].map(existsSync);
  if (existing.some(Boolean) && !existing.every(Boolean))
    throw new Error(
      'Local sign-in files are incomplete; restore them before continuing.',
    );
  if (!existing.every(Boolean)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // The container reads this directory as its unprivileged Keycloak user.
    // Its parent remains private on the host; no password is embedded in JSON.
    mkdirSync(resolve(directory, 'import'), { mode: 0o755 });
    const adminPassword = randomBytes(24).toString('base64url');
    const reviewerPassword = randomBytes(24).toString('base64url');
    writeFileSync(
      realmPath,
      JSON.stringify(
        realm(randomUUID(), '${CHS_LOCAL_REVIEWER_INITIAL_PASSWORD}'),
        null,
        2,
      ),
      { mode: 0o644, flag: 'wx' },
    );
    writeFileSync(
      dockerEnv,
      `KC_BOOTSTRAP_ADMIN_USERNAME=chs-local-admin\nKC_BOOTSTRAP_ADMIN_PASSWORD=${adminPassword}\nCHS_LOCAL_REVIEWER_INITIAL_PASSWORD=${reviewerPassword}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    writeFileSync(
      credentialsPath,
      `LOCAL DEVELOPMENT ONLY\n\nPortal: http://127.0.0.1:4173/\nUsername: chs-reviewer\nInitial password: ${reviewerPassword}\nChange this password at first login.\n\nKeycloak administration: http://127.0.0.1:8080/admin/\nUsername: chs-local-admin\nInitial password: ${adminPassword}\n\nThese initial passwords are not updated after a password change.\n`,
      { mode: 0o600, flag: 'wx' },
    );
  }
  const backup = resolve(root, '.env.before-local-auth');
  if (!existsSync(backup)) writeFileSync(backup, before, { mode: 0o600, flag: 'wx' });
  writeFileSync(envPath, after, { mode: 0o600 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.env.NODE_ENV && process.env.NODE_ENV !== 'development')
      throw new Error('Local sign-in requires development mode.');
    setup(fileURLToPath(new URL('../../', import.meta.url)));
    console.log(
      'Local sign-in configured. Credentials are in .local-auth/credentials.txt; keep that file private. Restart API and web after starting Keycloak.',
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
