import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import pg from 'pg';

import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import { buildApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import { installationTokenHash } from '../../src/sync/installation-auth.js';
import type { SyncBatchRequest, SyncBatchResponse } from '../../src/sync/types.js';

const connectionString = process.env.DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error('DATABASE_TEST_URL is required for API load evidence');
}

const token = `chs_inst_v1_${'L'.repeat(43)}`;
const bearer = `Bearer ${token}`;
const requestTimeoutMs = 10_000;
const outputPath = new URL(
  process.env.LOAD_EVIDENCE_PATH ?? '../../load-results/api-load-evidence.json',
  import.meta.url,
);

const config: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
  databaseUrl: connectionString,
  databasePoolMax: 4,
  http: {
    bodyLimitBytes: 1_048_576,
    requestTimeoutMs: 120_000,
    connectionTimeoutMs: 30_000,
    keepAliveTimeoutMs: 5_000,
  },
  buildCommit: 'load-evidence',
  buildTime: '2026-08-27T00:00:00.000Z',
  trustedProxyCidrs: [],
  operationsOidc: null,
};

type LoadProfile = Readonly<{
  name: string;
  requests: number;
  concurrency: number;
  successes: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  budgetP95Ms: number;
}>;

async function main() {
  const schema = `chs_load_${randomUUID().replaceAll('-', '')}`;
  const administrationPool = new pg.Pool({ connectionString });
  let servicePool: pg.Pool | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  try {
    const migrationClient = await administrationPool.connect();
    try {
      await migrationClient.query(`CREATE SCHEMA "${schema}"`);
      await migrationClient.query(`SET search_path TO "${schema}"`);
      await migrateWithClient({ client: migrationClient, logger: { info() {} } });
    } finally {
      migrationClient.release();
    }

    servicePool = new pg.Pool({
      connectionString,
      max: config.databasePoolMax,
      options: `-c search_path=${schema}`,
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 10_000,
    });
    await seedInstallation(servicePool);

    app = await buildApp({
      config,
      database: {
        pool: servicePool,
        check: async () => {
          await servicePool?.query('SELECT 1');
        },
        close: async () => {
          await servicePool?.end();
        },
      },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert(address && typeof address !== 'string', 'Expected a TCP server address');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const request = JSON.parse(
      await readFile(
        new URL(
          '../../../../packages/contracts/fixtures/sync/v1/valid/batch-request.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as SyncBatchRequest;
    const requestBody = JSON.stringify(request);
    const acceptedResponse = await submitInitialBatch(baseUrl, requestBody);

    await assertCanonicalCounts(servicePool);

    const profiles = [
      await measureProfile({
        name: 'postgres-readiness',
        requests: 80,
        concurrency: 16,
        budgetP95Ms: 2_000,
        operation: async () => {
          const response = await fetch(`${baseUrl}/health/ready`, {
            signal: AbortSignal.timeout(requestTimeoutMs),
          });
          assert.equal(response.status, 200);
          const body = (await response.json()) as {
            status?: unknown;
            checks?: { postgres?: unknown };
          };
          assert.equal(body.status, 'ready');
          assert.equal(body.checks?.postgres, 'pass');
        },
      }),
      await measureProfile({
        name: 'accepted-sync-replay',
        requests: 48,
        concurrency: 8,
        budgetP95Ms: 5_000,
        operation: async () => {
          const response = await fetch(`${baseUrl}/api/v1/sync/batches`, {
            method: 'POST',
            headers: {
              authorization: bearer,
              'content-type': 'application/json',
            },
            body: requestBody,
            signal: AbortSignal.timeout(requestTimeoutMs),
          });
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), acceptedResponse);
        },
      }),
    ];

    await assertCanonicalCounts(servicePool);
    const evidence = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      runtime: process.version,
      transport: 'HTTP/1.1 loopback',
      databasePoolMax: config.databasePoolMax,
      syntheticFixture: true,
      profiles,
    };
    await mkdir(new URL('.', outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } finally {
    if (app) {
      await app.close();
    } else if (servicePool) {
      await servicePool.end();
    }
    await administrationPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrationPool.end();
  }
}

async function submitInitialBatch(
  baseUrl: string,
  requestBody: string,
): Promise<SyncBatchResponse> {
  const response = await fetch(`${baseUrl}/api/v1/sync/batches`, {
    method: 'POST',
    headers: { authorization: bearer, 'content-type': 'application/json' },
    body: requestBody,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  assert.equal(response.status, 200, 'Synthetic sync fixture must be accepted');
  const body = (await response.json()) as SyncBatchResponse;
  assert.equal(body.batchStatus, 'ACCEPTED');
  assert.equal(body.outcomes.length, 4);
  return body;
}

async function assertCanonicalCounts(pool: pg.Pool) {
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM sync_batches) AS batches,
       (SELECT count(*)::integer FROM persons) AS persons,
       (SELECT count(*)::integer FROM screening_sessions) AS sessions,
       (SELECT count(*)::integer FROM screening_encounters) AS encounters,
       (SELECT count(*)::integer FROM screening_vital_sets) AS vital_sets,
       (SELECT count(*)::integer FROM vital_readings) AS readings`,
  );
  assert.deepEqual(result.rows[0], {
    batches: 1,
    persons: 1,
    sessions: 1,
    encounters: 1,
    vital_sets: 1,
    readings: 1,
  });
}

async function measureProfile(options: {
  name: string;
  requests: number;
  concurrency: number;
  budgetP95Ms: number;
  operation: () => Promise<void>;
}): Promise<LoadProfile> {
  let nextRequest = 0;
  let successes = 0;
  const durations: number[] = [];

  async function worker() {
    while (nextRequest < options.requests) {
      nextRequest += 1;
      const startedAt = performance.now();
      await options.operation();
      durations.push(performance.now() - startedAt);
      successes += 1;
    }
  }

  await Promise.all(
    Array.from({ length: options.concurrency }, async () => worker()),
  );
  assert.equal(successes, options.requests);

  const sorted = [...durations].sort((left, right) => left - right);
  const p50Ms = percentile(sorted, 0.5);
  const p95Ms = percentile(sorted, 0.95);
  const maxMs = sorted.at(-1) ?? 0;
  assert(
    p95Ms <= options.budgetP95Ms,
    `${options.name} p95 ${p95Ms.toFixed(2)}ms exceeded ${options.budgetP95Ms}ms`,
  );

  return {
    name: options.name,
    requests: options.requests,
    concurrency: options.concurrency,
    successes,
    p50Ms: roundMilliseconds(p50Ms),
    p95Ms: roundMilliseconds(p95Ms),
    maxMs: roundMilliseconds(maxMs),
    budgetP95Ms: options.budgetP95Ms,
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  assert(sorted.length > 0);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

async function seedInstallation(pool: pg.Pool) {
  const timestamp = '2026-08-27T00:00:00.000Z';
  await pool.query(
    `INSERT INTO organizations (
       id, identifier_system, identifier_value, name, organization_type_code,
       created_at, updated_at
     ) VALUES ($1, 'https://chs.example/id/organization', 'ORG-LOAD-001',
       'Synthetic Load Program', 'PROGRAM', $2, $2)`,
    ['10000000-0000-4000-8000-000000000001', timestamp],
  );
  await pool.query(
    `INSERT INTO locations (
       id, organization_id, identifier_system, identifier_value, name,
       location_type_code, physical_type_code, created_at, updated_at
     ) VALUES ($1, $2, 'https://chs.example/id/location', 'LOC-LOAD-001',
       'Synthetic Load Site', 'SCREENING_SITE', 'MOBILE', $3, $3)`,
    [
      '30000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      timestamp,
    ],
  );
  await pool.query(
    `INSERT INTO desktop_installations (
       id, organization_id, configured_location_id, deployment_name, timezone,
       status, enrolled_at, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Synthetic Load Desktop', 'Africa/Douala',
       'ACTIVE', $4, $4, $4)`,
    [
      '20000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      timestamp,
    ],
  );
  await pool.query(
    `INSERT INTO location_source_links (
       id, location_id, installation_id, organization_id, source_location_id,
       first_observed_at, last_observed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [
      '31000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      timestamp,
    ],
  );
  await pool.query(
    `INSERT INTO desktop_installation_credentials (
       id, installation_id, token_prefix, token_hash, label, status,
       issued_at, created_at, updated_at
     ) VALUES ($1, $2, 'chs_inst_v1_LLLLLLLL', $3, 'Synthetic load token',
       'ACTIVE', $4, $4, $4)`,
    [
      '21000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      installationTokenHash(token),
      timestamp,
    ],
  );
}

await main();
