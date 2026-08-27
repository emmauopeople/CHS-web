import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import { createShutdownHandler } from '../src/shutdown.js';

const config: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
  databaseUrl: 'postgresql://unused',
  databasePoolMax: 1,
  http: {
    bodyLimitBytes: 1_024,
    requestTimeoutMs: 120_000,
    connectionTimeoutMs: 30_000,
    keepAliveTimeoutMs: 5_000,
  },
  buildCommit: 'runtime-hardening-test',
  buildTime: '2026-08-26T00:00:00.000Z',
  trustedProxyCidrs: [],
  operationsOidc: null,
};

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

async function createTestApp(close: () => Promise<void> = async () => undefined) {
  const app = await buildApp({
    config,
    database: {
      pool: {} as Database['pool'],
      check: async () => undefined,
      close,
    },
  });
  apps.push(app);
  return app;
}

describe('API runtime hardening', () => {
  it('applies bounded HTTP server settings and rejects oversized bodies', async () => {
    const app = await createTestApp();
    app.post('/test/body-limit', async () => ({ accepted: true }));

    expect(app.initialConfig.bodyLimit).toBe(1_024);
    expect(app.server.requestTimeout).toBe(120_000);
    expect(app.server.timeout).toBe(30_000);
    expect(app.server.keepAliveTimeout).toBe(5_000);

    const response = await app.inject({
      method: 'POST',
      url: '/test/body-limit',
      payload: { value: 'x'.repeat(1_024) },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: 'REQUEST_REJECTED' });
  });

  it('lets an in-flight request finish before closing the database', async () => {
    let releaseRequest!: () => void;
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const requestReleased = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const closeDatabase = vi.fn(async () => undefined);
    const app = await createTestApp(closeDatabase);
    app.get('/test/in-flight', async () => {
      markRequestStarted();
      await requestReleased;
      return { completed: true };
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected the test API to listen on a TCP port');
    }

    const responsePromise = fetch(
      `http://127.0.0.1:${address.port}/test/in-flight`,
    );
    await requestStarted;
    const closePromise = app.close();
    await new Promise((resolve) => setImmediate(resolve));

    expect(closeDatabase).not.toHaveBeenCalled();
    releaseRequest();
    const response = await responsePromise;
    await closePromise;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ completed: true });
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it('coalesces repeated shutdown signals and reports close failures', async () => {
    let rejectClose!: (error: Error) => void;
    const close = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectClose = reject;
        }),
    );
    const logStart = vi.fn();
    const logFailure = vi.fn();
    const setExitCode = vi.fn();
    const shutdown = createShutdownHandler({
      close,
      logStart,
      logFailure,
      setExitCode,
    });

    const first = shutdown('SIGTERM');
    const second = shutdown('SIGINT');
    const error = new Error('close failed');
    rejectClose(error);
    await Promise.all([first, second]);

    expect(first).toBe(second);
    expect(close).toHaveBeenCalledOnce();
    expect(logStart).toHaveBeenCalledWith('SIGTERM');
    expect(logFailure).toHaveBeenCalledWith('SIGTERM', error);
    expect(setExitCode).toHaveBeenCalledOnce();
    expect(setExitCode).toHaveBeenCalledWith(1);
  });

  it('sets a successful exit code after shutdown completes', async () => {
    const close = vi.fn(async () => undefined);
    const setExitCode = vi.fn();
    const shutdown = createShutdownHandler({
      close,
      logStart: vi.fn(),
      logFailure: vi.fn(),
      setExitCode,
    });

    await shutdown('SIGTERM');

    expect(close).toHaveBeenCalledOnce();
    expect(setExitCode).toHaveBeenCalledWith(0);
  });
});
