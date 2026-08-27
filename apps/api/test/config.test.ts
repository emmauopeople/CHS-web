import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

describe('configuration', () => {
  it('loads explicit values', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '8080',
      LOG_LEVEL: 'warn',
      DATABASE_URL: 'postgresql://example.invalid/chs',
      DATABASE_POOL_MAX: '20',
      API_BODY_LIMIT_BYTES: '2097152',
      API_REQUEST_TIMEOUT_MS: '180000',
      API_CONNECTION_TIMEOUT_MS: '45000',
      API_KEEP_ALIVE_TIMEOUT_MS: '10000',
      BUILD_COMMIT: 'abc123',
      BUILD_TIME: '2026-08-18T00:00:00.000Z',
      TRUSTED_PROXY_CIDRS: 'loopback,10.0.0.0/8',
      OPERATIONS_OIDC_ISSUER: 'https://identity.example.test/',
      OPERATIONS_OIDC_AUDIENCE: 'chs-operations-api',
      OPERATIONS_OIDC_JWKS_URL:
        'https://identity.example.test/.well-known/jwks.json',
    });

    expect(config).toMatchObject({
      nodeEnv: 'production',
      host: '127.0.0.1',
      port: 8080,
      databasePoolMax: 20,
      http: {
        bodyLimitBytes: 2_097_152,
        requestTimeoutMs: 180_000,
        connectionTimeoutMs: 45_000,
        keepAliveTimeoutMs: 10_000,
      },
      buildCommit: 'abc123',
      trustedProxyCidrs: ['loopback', '10.0.0.0/8'],
      operationsOidc: {
        issuer: 'https://identity.example.test/',
        audience: 'chs-operations-api',
        clockToleranceSeconds: 30,
      },
    });
  });

  it('requires a database URL', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' })).toThrow(
      'Missing required environment variable: DATABASE_URL',
    );
  });

  it('rejects partially numeric values', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgresql://example.invalid/chs', PORT: '3000x' }),
    ).toThrow('PORT must be a positive integer');
  });

  it('uses bounded HTTP hardening defaults', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://example.invalid/chs',
    });

    expect(config.http).toEqual({
      bodyLimitBytes: 1_048_576,
      requestTimeoutMs: 120_000,
      connectionTimeoutMs: 30_000,
      keepAliveTimeoutMs: 5_000,
    });
  });

  it('rejects disabled or unbounded HTTP limits', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgresql://example.invalid/chs',
        API_REQUEST_TIMEOUT_MS: '0',
      }),
    ).toThrow('API_REQUEST_TIMEOUT_MS must be a positive integer');

    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgresql://example.invalid/chs',
        API_BODY_LIMIT_BYTES: '8388609',
      }),
    ).toThrow('API_BODY_LIMIT_BYTES must be no greater than 8388608');

    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgresql://example.invalid/chs',
        DATABASE_POOL_MAX: '101',
      }),
    ).toThrow('DATABASE_POOL_MAX must be no greater than 100');
  });

  it('requires complete OIDC configuration and HTTPS JWKS in production', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgresql://example.invalid/chs',
        OPERATIONS_OIDC_ISSUER: 'https://identity.example.test/',
      }),
    ).toThrow('must be configured together');

    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://example.invalid/chs',
        OPERATIONS_OIDC_ISSUER: 'https://identity.example.test/',
        OPERATIONS_OIDC_AUDIENCE: 'chs-operations-api',
        OPERATIONS_OIDC_JWKS_URL: 'http://identity.example.test/jwks.json',
      }),
    ).toThrow('must use HTTPS');
  });
});
