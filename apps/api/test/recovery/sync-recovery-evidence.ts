import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import pg from 'pg';

import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import { buildApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import { beginSyncBatch } from '../../src/sync/batch-intake.js';
import {
  authenticateInstallation,
  installationTokenHash,
} from '../../src/sync/installation-auth.js';
import { processPatientRecord } from '../../src/sync/patient-identity.js';
import type {
  PatientSyncRecord,
  SyncBatchRequest,
  SyncBatchResponse,
} from '../../src/sync/types.js';

const schemaPattern = /^chs_recovery_[0-9a-f]{32}$/;
const token = `chs_inst_v1_${'R'.repeat(43)}`;
const bearer = `Bearer ${token}`;
const requestTimeoutMs = 10_000;
const outputPath = new URL(
  process.env.RECOVERY_EVIDENCE_PATH ??
    '../../recovery-results/sync-recovery-evidence.json',
  import.meta.url,
);

const config = (connectionString: string): AppConfig => ({
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
  buildCommit: 'sync-recovery-evidence',
  buildTime: '2026-08-27T00:00:00.000Z',
  trustedProxyCidrs: [],
  operationsOidc: null,
});

type CanonicalCounts = Readonly<{
  batches: number;
  persons: number;
  sessions: number;
  encounters: number;
  vitalSets: number;
  readings: number;
}>;

export function assertSafeRecoverySchema(schema: string): void {
  if (!schemaPattern.test(schema)) {
    throw new Error('Unsafe synchronization recovery schema name');
  }
}

export function assertSafeRecoveryDatabaseUrl(connectionString: string): void {
  const url = new URL(connectionString);
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('Sync recovery evidence requires a PostgreSQL test URL');
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  const testNamedDatabase = /(?:^test_|_test$)/i.test(databaseName);
  const localComposeDatabase =
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
    (url.port === '' || url.port === '5432') &&
    decodeURIComponent(url.username) === 'chs' &&
    decodeURIComponent(url.password) === 'chs-local-only' &&
    databaseName === 'chs';
  if (!testNamedDatabase && !localComposeDatabase) {
    throw new Error(
      'Sync recovery evidence requires a test-named database or the exact local Compose database',
    );
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_TEST_URL;
  if (!connectionString) {
    throw new Error('DATABASE_TEST_URL is required for sync recovery evidence');
  }
  assertSafeRecoveryDatabaseUrl(connectionString);

  const schema = `chs_recovery_${randomUUID().replaceAll('-', '')}`;
  assertSafeRecoverySchema(schema);
  const startedAt = performance.now();
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
      max: 4,
      options: `-c search_path=${schema}`,
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 10_000,
    });
    await seedInstallation(servicePool);

    const request = JSON.parse(
      await readFile(
        new URL(
          '../../../../packages/contracts/fixtures/sync/v1/valid/batch-request.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as SyncBatchRequest;

    const interruptedAt = new Date('2026-08-27T00:00:00.000Z');
    const context = await authenticateInstallation(servicePool, bearer, interruptedAt);
    const intake = await beginSyncBatch(
      servicePool,
      context,
      request,
      interruptedAt,
    );
    assert.equal(intake.kind, 'NEW');
    if (intake.kind !== 'NEW') {
      throw new Error('Expected a new synthetic recovery batch');
    }
    const patient = request.records.find(
      (record): record is PatientSyncRecord => record.resourceType === 'PATIENT',
    );
    assert(patient, 'Synthetic fixture must contain a patient record');
    const interruptedOutcome = await processPatientRecord(
      servicePool,
      context,
      intake.batchInternalId,
      patient,
      interruptedAt,
    );
    assert.equal(interruptedOutcome.status, 'ACCEPTED');
    await assertInterruptedState(servicePool, intake.batchInternalId);

    app = await buildApp({
      config: config(connectionString),
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

    const requestBody = JSON.stringify(request);
    const resumed = await postBatch(baseUrl, requestBody);
    assert.equal(resumed.response.status, 200);
    const accepted = resumed.body as SyncBatchResponse;
    assert.equal(accepted.batchStatus, 'ACCEPTED');
    assert.deepEqual(countOutcomes(accepted), {
      accepted: 3,
      unchanged: 1,
      review: 0,
      rejected: 0,
      retry: 0,
    });
    const initialCanonicalCounts = await readCanonicalCounts(servicePool);
    assert.deepEqual(initialCanonicalCounts, expectedSingleBatchCounts);

    const replayed = await postBatch(baseUrl, requestBody);
    assert.equal(replayed.response.status, 200);
    assert.deepEqual(replayed.body, accepted);

    const recovered = await getBatch(baseUrl, request.batchId);
    assert.equal(recovered.response.status, 200);
    assert.deepEqual(recovered.body, accepted);

    const mismatch = await postBatch(
      baseUrl,
      JSON.stringify({
        ...request,
        desktopApplicationVersion: 'synthetic-conflicting-version',
      }),
    );
    assert.equal(mismatch.response.status, 409);
    assert.equal(problemCode(mismatch.body), 'BATCH_PAYLOAD_MISMATCH');
    assert.deepEqual(await readCanonicalCounts(servicePool), expectedSingleBatchCounts);

    const failedRequest: SyncBatchRequest = {
      ...request,
      batchId: '10000000-0000-4000-8000-000000000042',
    };
    const failedIntake = await beginSyncBatch(
      servicePool,
      context,
      failedRequest,
      interruptedAt,
    );
    assert.equal(failedIntake.kind, 'NEW');
    if (failedIntake.kind !== 'NEW') {
      throw new Error('Expected a new synthetic failed batch');
    }
    await markBatchFailedForRecoveryDrill(
      servicePool,
      failedIntake.batchInternalId,
      new Date(interruptedAt.getTime() + 1_000),
    );
    const failedRecovery = await postBatch(
      baseUrl,
      JSON.stringify(failedRequest),
    );
    assert.equal(failedRecovery.response.status, 200);
    const recoveredFailedBatch = failedRecovery.body as SyncBatchResponse;
    assert.equal(recoveredFailedBatch.batchStatus, 'ACCEPTED');
    assert.deepEqual(countOutcomes(recoveredFailedBatch), {
      accepted: 0,
      unchanged: 4,
      review: 0,
      rejected: 0,
      retry: 0,
    });
    const canonicalCounts = await readCanonicalCounts(servicePool);
    assert.deepEqual(canonicalCounts, expectedTwoBatchCounts);

    const evidence = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      durationMs: roundMilliseconds(performance.now() - startedAt),
      runtime: process.version,
      transport: 'HTTP/1.1 loopback',
      syntheticFixture: true,
      scenarios: [
        {
          name: 'interrupted-batch-resume',
          status: 'passed',
          recordsPresentBeforeResume: 1,
          finalBatchStatus: accepted.batchStatus,
          outcomes: countOutcomes(accepted),
        },
        {
          name: 'exact-post-replay',
          status: 'passed',
          identicalStoredResponse: true,
        },
        {
          name: 'stored-response-get-recovery',
          status: 'passed',
          identicalStoredResponse: true,
        },
        {
          name: 'changed-payload-rejection',
          status: 'passed',
          httpStatus: mismatch.response.status,
          errorCode: problemCode(mismatch.body),
        },
        {
          name: 'controlled-failed-batch-resume',
          status: 'passed',
          finalBatchStatus: recoveredFailedBatch.batchStatus,
          outcomes: countOutcomes(recoveredFailedBatch),
        },
      ],
      canonicalCounts,
      duplicateRowsCreated: false,
    };
    const serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
    assertEvidenceExcludesSourceData(serializedEvidence, [request, failedRequest]);
    await mkdir(new URL('.', outputPath), { recursive: true });
    await writeFile(outputPath, serializedEvidence, 'utf8');
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } finally {
    if (app) {
      await app.close();
    } else if (servicePool) {
      await servicePool.end();
    }
    assertSafeRecoverySchema(schema);
    await administrationPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrationPool.end();
  }
}

async function postBatch(baseUrl: string, body: string) {
  const response = await fetch(`${baseUrl}/api/v1/sync/batches`, {
    method: 'POST',
    headers: {
      authorization: bearer,
      'content-type': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  return { response, body: (await response.json()) as unknown };
}

async function getBatch(baseUrl: string, batchId: string) {
  const response = await fetch(`${baseUrl}/api/v1/sync/batches/${batchId}`, {
    headers: { authorization: bearer },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  return { response, body: (await response.json()) as unknown };
}

function problemCode(body: unknown): unknown {
  return typeof body === 'object' && body !== null && 'code' in body
    ? body.code
    : undefined;
}

function countOutcomes(response: SyncBatchResponse) {
  return response.outcomes.reduce(
    (counts, outcome) => {
      if (outcome.status === 'ACCEPTED') counts.accepted += 1;
      else if (outcome.status === 'UNCHANGED') counts.unchanged += 1;
      else if (outcome.status === 'REVIEW_REQUIRED') counts.review += 1;
      else if (outcome.status === 'REJECTED') counts.rejected += 1;
      else counts.retry += 1;
      return counts;
    },
    { accepted: 0, unchanged: 0, review: 0, rejected: 0, retry: 0 },
  );
}

async function assertInterruptedState(
  pool: pg.Pool,
  batchInternalId: string,
): Promise<void> {
  const result = await pool.query(
    `SELECT status,
       (SELECT count(*)::integer FROM sync_records) AS records,
       (SELECT count(*)::integer FROM persons) AS persons
     FROM sync_batches
     WHERE id = $1`,
    [batchInternalId],
  );
  assert.deepEqual(result.rows[0], {
    status: 'PROCESSING',
    records: 1,
    persons: 1,
  });
}

export async function markBatchFailedForRecoveryDrill(
  pool: Pick<pg.Pool, 'query'>,
  batchInternalId: string,
  failedAt: Date,
): Promise<void> {
  const result = await pool.query(
    `UPDATE sync_batches
     SET status = 'FAILED',
         completed_at = $2
     WHERE id = $1
       AND status = 'PROCESSING'
       AND response_body IS NULL
     RETURNING status,
       completed_at AS "completedAt",
       response_body AS "responseBody"`,
    [batchInternalId, failedAt],
  );
  assert.equal(result.rowCount, 1, 'Expected one controlled failed batch');
  assert.deepEqual(result.rows[0], {
    status: 'FAILED',
    completedAt: failedAt,
    responseBody: null,
  });
}

const expectedSingleBatchCounts: CanonicalCounts = {
  batches: 1,
  persons: 1,
  sessions: 1,
  encounters: 1,
  vitalSets: 1,
  readings: 1,
};

const expectedTwoBatchCounts: CanonicalCounts = {
  ...expectedSingleBatchCounts,
  batches: 2,
};

async function readCanonicalCounts(pool: pg.Pool): Promise<CanonicalCounts> {
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM sync_batches) AS batches,
       (SELECT count(*)::integer FROM persons) AS persons,
       (SELECT count(*)::integer FROM screening_sessions) AS sessions,
       (SELECT count(*)::integer FROM screening_encounters) AS encounters,
       (SELECT count(*)::integer FROM screening_vital_sets) AS "vitalSets",
       (SELECT count(*)::integer FROM vital_readings) AS readings`,
  );
  return result.rows[0] as CanonicalCounts;
}

function assertEvidenceExcludesSourceData(
  serializedEvidence: string,
  requests: readonly SyncBatchRequest[],
): void {
  const forbiddenValues = [
    token,
    ...requests.flatMap((request) => [
      request.batchId,
      request.installationId,
      request.locationId,
      ...request.records.flatMap((record) => [
        record.recordId,
        record.localResourceId,
      ]),
    ]),
  ];
  for (const value of forbiddenValues) {
    assert(!serializedEvidence.includes(value), 'Recovery evidence contains source data');
  }
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

async function seedInstallation(pool: pg.Pool): Promise<void> {
  const timestamp = '2026-08-27T00:00:00.000Z';
  await pool.query(
    `INSERT INTO organizations (
       id, identifier_system, identifier_value, name, organization_type_code,
       created_at, updated_at
     ) VALUES ($1, 'https://chs.example/id/organization', 'ORG-RECOVERY-001',
       'Synthetic Recovery Program', 'PROGRAM', $2, $2)`,
    ['10000000-0000-4000-8000-000000000001', timestamp],
  );
  await pool.query(
    `INSERT INTO locations (
       id, organization_id, identifier_system, identifier_value, name,
       location_type_code, physical_type_code, created_at, updated_at
     ) VALUES ($1, $2, 'https://chs.example/id/location', 'LOC-RECOVERY-001',
       'Synthetic Recovery Site', 'SCREENING_SITE', 'MOBILE', $3, $3)`,
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
     ) VALUES ($1, $2, $3, 'Synthetic Recovery Desktop', 'Africa/Douala',
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
     ) VALUES ($1, $2, 'chs_inst_v1_RRRRRRRR', $3, 'Synthetic recovery token',
       'ACTIVE', $4, $4, $4)`,
    [
      '21000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      installationTokenHash(token),
      timestamp,
    ],
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
