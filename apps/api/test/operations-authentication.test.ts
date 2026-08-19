import { generateKeyPairSync, sign as signValue } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  createDisabledOperationsTokenVerifier,
  createOidcOperationsTokenVerifier,
} from '../src/operations/authentication.js';

const now = new Date('2026-08-20T12:00:00.000Z');
const issuer = 'https://identity.example.test/';
const audience = 'chs-operations-api';
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const publicJwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'test-key-1',
  alg: 'RS256',
  use: 'sig',
};

function token(
  overrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
) {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', kid: 'test-key-1', ...headerOverrides }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      aud: audience,
      sub: 'operations-user-1',
      sid: 'session-1',
      azp: 'operations-web',
      iat: Math.floor(now.getTime() / 1_000) - 60,
      exp: Math.floor(now.getTime() / 1_000) + 300,
      ...overrides,
    }),
  ).toString('base64url');
  const signature = signValue(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    privateKey,
  ).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function verifier(fetchImplementation?: typeof fetch) {
  return createOidcOperationsTokenVerifier(
    {
      issuer,
      audience,
      jwksUrl: 'https://identity.example.test/.well-known/jwks.json',
      clockToleranceSeconds: 30,
    },
    {
      fetch:
        fetchImplementation ??
        (vi.fn(async () =>
          new Response(JSON.stringify({ keys: [publicJwk] }), {
            status: 200,
            headers: { 'cache-control': 'max-age=300' },
          })) as unknown as typeof fetch),
      now: () => now,
    },
  );
}

describe('operations OIDC authentication', () => {
  it('verifies a signed RS256 access token and caches the JWKS', async () => {
    const fetchJwks = vi.fn(async () =>
      new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { 'cache-control': 'max-age=300' },
      }),
    ) as unknown as typeof fetch;
    const operationsVerifier = verifier(fetchJwks);

    await expect(
      operationsVerifier.verify(`Bearer ${token()}`),
    ).resolves.toEqual({
      issuer,
      subject: 'operations-user-1',
      sessionId: 'session-1',
      authorizedParty: 'operations-web',
    });
    await operationsVerifier.verify(`Bearer ${token()}`);
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it('rejects missing, expired, wrong-audience, and non-RS256 tokens', async () => {
    const operationsVerifier = verifier();
    await expect(operationsVerifier.verify(undefined)).rejects.toMatchObject({
      code: 'OPERATIONS_TOKEN_REQUIRED',
      statusCode: 401,
    });
    await expect(
      operationsVerifier.verify(
        `Bearer ${token({ exp: Math.floor(now.getTime() / 1_000) - 31 })}`,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_OPERATIONS_TOKEN' });
    await expect(
      operationsVerifier.verify(`Bearer ${token({ aud: 'wrong-api' })}`),
    ).rejects.toMatchObject({ code: 'INVALID_OPERATIONS_TOKEN' });
    await expect(
      operationsVerifier.verify(
        `Bearer ${token({}, { alg: 'none' })}`,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_OPERATIONS_TOKEN' });
  });

  it('fails closed when authentication is unconfigured or JWKS is unavailable', async () => {
    await expect(
      createDisabledOperationsTokenVerifier().verify('Bearer any-token'),
    ).rejects.toMatchObject({
      code: 'OPERATIONS_AUTH_NOT_CONFIGURED',
      statusCode: 503,
    });

    const unavailableFetch = vi.fn(async () =>
      new Response('unavailable', { status: 503 }),
    ) as unknown as typeof fetch;
    await expect(
      verifier(unavailableFetch).verify(`Bearer ${token()}`),
    ).rejects.toMatchObject({
      code: 'OPERATIONS_IDENTITY_PROVIDER_UNAVAILABLE',
      statusCode: 503,
    });
  });
});
