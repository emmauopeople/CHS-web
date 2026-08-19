import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { Database } from '../src/database.js';

const config: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
  databaseUrl: 'postgresql://unused',
  databasePoolMax: 1,
  buildCommit: 'test-commit',
  buildTime: '2026-08-18T00:00:00.000Z',
  trustedProxyCidrs: [],
  operationsOidc: null,
};

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

async function createTestApp(check: () => Promise<void> = async () => undefined) {
  const app = await buildApp({
    config,
    database: {
      pool: {} as Database['pool'],
      check,
      close: async () => undefined,
    },
  });
  apps.push(app);
  return app;
}

describe('diagnostic routes', () => {
  it('reports liveness without checking dependencies', async () => {
    let databaseChecks = 0;
    const app = await createTestApp(async () => {
      databaseChecks += 1;
    });
    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(databaseChecks).toBe(0);
    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.json()).toMatchObject({ service: 'chs-api', status: 'alive' });
  });

  it('does not expose API documentation outside development', async () => {
    const app = await createTestApp();
    const response = await app.inject({ method: 'GET', url: '/docs' });

    expect(response.statusCode).toBe(404);
  });

  it('reports readiness when PostgreSQL is reachable', async () => {
    const app = await createTestApp();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ready',
      checks: { postgres: 'pass' },
    });
  });

  it('reports not ready without leaking dependency errors', async () => {
    const app = await createTestApp(async () => {
      throw new Error('connection details that must not leak');
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('connection details');
    expect(response.json()).toMatchObject({
      status: 'not-ready',
      checks: { postgres: 'fail' },
    });
  });

  it('exposes Prometheus metrics without patient labels', async () => {
    const app = await createTestApp();
    await app.inject({ method: 'GET', url: '/health/live' });
    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('chs_api_process_cpu_user_seconds_total');
    expect(response.body).toContain('chs_api_http_requests_total');
    expect(response.body).toContain('route="/health/live"');
  });

  it('exposes version provenance', async () => {
    const app = await createTestApp();
    const response = await app.inject({ method: 'GET', url: '/version' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: 'chs-api',
      version: '0.1.0',
      commit: 'test-commit',
    });
  });
});
