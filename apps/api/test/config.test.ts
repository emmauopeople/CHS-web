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
      BUILD_COMMIT: 'abc123',
      BUILD_TIME: '2026-08-18T00:00:00.000Z',
    });

    expect(config).toMatchObject({
      nodeEnv: 'production',
      host: '127.0.0.1',
      port: 8080,
      databasePoolMax: 20,
      buildCommit: 'abc123',
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
});
