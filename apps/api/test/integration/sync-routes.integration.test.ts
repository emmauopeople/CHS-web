import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  LifestyleSyncRecord,
  PatientSyncRecord,
  ScreeningEncounterSyncRecord,
  ScreeningSessionSyncRecord,
  SyncBatchRequest,
  SyncBatchResponse,
} from '../../src/sync/types.js';

const connectionString = process.env.DATABASE_TEST_URL;
const runIntegration = connectionString ? describe : describe.skip;
const token = `chs_inst_v1_${'B'.repeat(43)}`;
const bearer = `Bearer ${token}`;
const receivedAt = new Date('2026-08-19T00:00:00.000Z');

const config: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
  databaseUrl: 'postgresql://unused',
  databasePoolMax: 4,
  http: {
    bodyLimitBytes: 1_048_576,
    requestTimeoutMs: 120_000,
    connectionTimeoutMs: 30_000,
    keepAliveTimeoutMs: 5_000,
  },
  buildCommit: 'sync-route-test',
  buildTime: '2026-08-19T00:00:00.000Z',
  trustedProxyCidrs: [],
  operationsOidc: null,
};

runIntegration('desktop synchronization HTTP routes', () => {
  const schema = `chs_sync_routes_${randomUUID().replaceAll('-', '')}`;
  let administrationPool: pg.Pool;
  let servicePool: pg.Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let request: SyncBatchRequest;
  let lifestyleRequest: SyncBatchRequest;

  beforeAll(async () => {
    administrationPool = new pg.Pool({ connectionString });
    const migrationClient = await administrationPool.connect();
    await migrationClient.query(`CREATE SCHEMA "${schema}"`);
    await migrationClient.query(`SET search_path TO "${schema}"`);
    await migrateWithClient({ client: migrationClient, logger: { info() {} } });
    migrationClient.release();

    servicePool = new pg.Pool({
      connectionString,
      options: `-c search_path=${schema}`,
    });
    await seedInstallation(servicePool);
    request = JSON.parse(
      await readFile(
        new URL(
          '../../../../packages/contracts/fixtures/sync/v1/valid/batch-request.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as SyncBatchRequest;
    const lifestyleFixture = JSON.parse(
      await readFile(
        new URL(
          '../../../../packages/contracts/fixtures/sync/v1/valid/lifestyle-batch-request.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as SyncBatchRequest;
    lifestyleRequest = alignLifestyleFixture(lifestyleFixture, request);
    app = await buildApp({
      config,
      database: {
        pool: servicePool,
        check: async () => {
          await servicePool.query('SELECT 1');
        },
        close: async () => {
          await servicePool.end();
        },
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await administrationPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrationPool.end();
  });

  it('resumes an interrupted batch, preserves request outcome order, and replays exactly', async () => {
    const context = await authenticateInstallation(servicePool, bearer, receivedAt);
    const reversedRequest = {
      ...request,
      records: [...request.records].reverse(),
    };
    const intake = await beginSyncBatch(
      servicePool,
      context,
      reversedRequest,
      receivedAt,
    );
    if (intake.kind !== 'NEW') throw new Error('Expected synthetic batch intake');

    const patient = request.records.find(
      (record) => record.resourceType === 'PATIENT',
    ) as PatientSyncRecord;
    await expect(
      processPatientRecord(
        servicePool,
        context,
        intake.batchInternalId,
        patient,
        receivedAt,
      ),
    ).resolves.toMatchObject({ status: 'ACCEPTED' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/batches',
      headers: { authorization: bearer },
      payload: reversedRequest,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<SyncBatchResponse>();
    expect(body.batchStatus).toBe('ACCEPTED');
    expect(body.outcomes.map((outcome) => outcome.recordId)).toEqual(
      reversedRequest.records.map((record) => record.recordId),
    );
    expect(body.outcomes.map((outcome) => outcome.resourceType)).toEqual([
      'VITALS',
      'SCREENING_ENCOUNTER',
      'SCREENING_SESSION',
      'PATIENT',
    ]);
    expect(body.outcomes.at(-1)).toMatchObject({
      resourceType: 'PATIENT',
      status: 'UNCHANGED',
      medicalIdStatus: 'CONFIRMED',
    });
    expect(body.outcomes.at(-1)?.chsMedicalId).toMatch(
      /^CHS-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/,
    );

    const stored = await servicePool.query(
      `SELECT status, accepted_count, unchanged_count, response_body
       FROM sync_batches WHERE id = $1`,
      [intake.batchInternalId],
    );
    expect(stored.rows[0]).toMatchObject({
      status: 'ACCEPTED',
      accepted_count: 3,
      unchanged_count: 1,
      response_body: body,
    });
    const canonicalCounts = await servicePool.query(
      `SELECT
         (SELECT count(*)::integer FROM persons) AS persons,
         (SELECT count(*)::integer FROM screening_sessions) AS sessions,
         (SELECT count(*)::integer FROM screening_encounters) AS encounters,
         (SELECT count(*)::integer FROM screening_vital_sets) AS vital_sets,
         (SELECT count(*)::integer FROM vital_readings) AS readings`,
    );
    expect(canonicalCounts.rows[0]).toEqual({
      persons: 1,
      sessions: 1,
      encounters: 1,
      vital_sets: 1,
      readings: 1,
    });

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/batches',
      headers: { authorization: bearer },
      payload: reversedRequest,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(body);

    const recovery = await app.inject({
      method: 'GET',
      url: `/api/v1/sync/batches/${request.batchId}`,
      headers: { authorization: bearer },
    });
    expect(recovery.statusCode).toBe(200);
    expect(recovery.json()).toEqual(body);

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('chs_api_sync_batches_total');
    expect(metrics.body).toContain('batch_status="ACCEPTED",replayed="false"');
    expect(metrics.body).toContain('resource_type="VITALS",status="ACCEPTED"');
  });

  it('rejects unauthenticated, invalid, conflicting, and concurrently claimed requests safely', async () => {
    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/batches',
      payload: request,
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(unauthenticated.json()).toMatchObject({
      code: 'INVALID_INSTALLATION_TOKEN',
    });

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/batches',
      headers: { authorization: bearer },
      payload: { ...request, unexpected: true },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'INVALID_SYNC_BATCH' });

    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/batches',
      headers: { authorization: bearer },
      payload: { ...request, desktopApplicationVersion: 'conflicting-version' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'BATCH_PAYLOAD_MISMATCH' });

    const concurrentRequest = {
      ...request,
      batchId: '10000000-0000-4000-8000-000000000009',
    };
    const context = await authenticateInstallation(servicePool, bearer, receivedAt);
    const intake = await beginSyncBatch(
      servicePool,
      context,
      concurrentRequest,
      receivedAt,
    );
    if (intake.kind !== 'NEW') throw new Error('Expected concurrent test batch');
    const lockClient = await servicePool.connect();
    const lockName = `chs.sync-batch.v1:${intake.batchInternalId}`;
    await lockClient.query(
      'SELECT pg_advisory_lock(hashtextextended($1, 0))',
      [lockName],
    );
    try {
      const concurrent = await app.inject({
        method: 'POST',
        url: '/api/v1/sync/batches',
        headers: { authorization: bearer },
        payload: concurrentRequest,
      });
      expect(concurrent.statusCode).toBe(409);
      expect(concurrent.json()).toMatchObject({ code: 'BATCH_IN_PROGRESS' });
    } finally {
      await lockClient.query(
        'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
        [lockName],
      );
      lockClient.release();
    }

    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/sync/batches/10000000-0000-4000-8000-000000000099',
      headers: { authorization: bearer },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'BATCH_NOT_AVAILABLE' });
  });

  it('ingests a completed Lifestyle snapshot after its same-batch dependencies', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/batches',
      headers: { authorization: bearer },
      payload: lifestyleRequest,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<SyncBatchResponse>();
    expect(body.batchStatus).toBe('ACCEPTED');
    expect(body.outcomes.map((outcome) => outcome.resourceType)).toEqual([
      'PATIENT',
      'SCREENING_SESSION',
      'SCREENING_ENCOUNTER',
      'LIFESTYLE',
    ]);
    expect(body.outcomes.at(-1)).toMatchObject({
      resourceType: 'LIFESTYLE',
      status: 'ACCEPTED',
    });

    const counts = await servicePool.query(
      `SELECT
         (SELECT count(*)::integer FROM lifestyle_assessments) AS assessments,
         (SELECT count(*)::integer FROM lifestyle_alcohol_baselines) AS alcohol_baselines,
         (SELECT count(*)::integer FROM lifestyle_tobacco_products) AS tobacco_products,
         (SELECT count(*)::integer FROM lifestyle_physical_activities) AS physical_activities`,
    );
    expect(counts.rows[0]).toEqual({
      assessments: 1,
      alcohol_baselines: 1,
      tobacco_products: 2,
      physical_activities: 2,
    });
  });
});

function alignLifestyleFixture(
  fixture: SyncBatchRequest,
  existingFixture: SyncBatchRequest,
): SyncBatchRequest {
  const existingSession = existingFixture.records.find(
    (record) => record.resourceType === 'SCREENING_SESSION',
  ) as ScreeningSessionSyncRecord;
  return {
    ...fixture,
    batchId: '10000000-0000-4000-8000-000000000027',
    installationId: existingFixture.installationId,
    locationId: existingFixture.locationId,
    records: fixture.records.map((record) => {
      if (record.resourceType === 'PATIENT') {
        const patient = record as PatientSyncRecord;
        return {
          ...patient,
          payload: { ...patient.payload, knownChsMedicalId: null },
        };
      }
      if (record.resourceType === 'SCREENING_SESSION') {
        const session = record as ScreeningSessionSyncRecord;
        return {
          ...session,
          payload: {
            ...session.payload,
            localLocationId: existingFixture.locationId,
            localProtocolVersionId: existingSession.payload.localProtocolVersionId,
            protocolChecksum: existingSession.payload.protocolChecksum,
          },
        };
      }
      if (record.resourceType === 'SCREENING_ENCOUNTER') {
        const encounter = record as ScreeningEncounterSyncRecord;
        return {
          ...encounter,
          payload: {
            ...encounter.payload,
            localLocationId: existingFixture.locationId,
            localProtocolVersionId: existingSession.payload.localProtocolVersionId,
          },
        };
      }
      const lifestyle = record as LifestyleSyncRecord;
      return {
        ...lifestyle,
        payload: {
          ...lifestyle.payload,
          localLocationId: existingFixture.locationId,
        },
      };
    }),
  };
}

async function seedInstallation(pool: pg.Pool) {
  const timestamp = '2026-08-18T00:00:00.000Z';
  await pool.query(
    `INSERT INTO organizations (
       id, identifier_system, identifier_value, name, organization_type_code,
       created_at, updated_at
     ) VALUES ($1, 'https://chs.example/id/organization', 'ORG-ROUTES-001',
       'Synthetic Route Program', 'PROGRAM', $2, $2)`,
    ['10000000-0000-4000-8000-000000000001', timestamp],
  );
  await pool.query(
    `INSERT INTO locations (
       id, organization_id, identifier_system, identifier_value, name,
       location_type_code, physical_type_code, created_at, updated_at
     ) VALUES ($1, $2, 'https://chs.example/id/location', 'LOC-ROUTES-001',
       'Synthetic Route Site', 'SCREENING_SITE', 'MOBILE', $3, $3)`,
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
     ) VALUES ($1, $2, $3, 'Synthetic Route Desktop', 'Africa/Douala',
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
     ) VALUES ($1, $2, 'chs_inst_v1_BBBBBBBB', $3, 'Synthetic route token',
       'ACTIVE', $4, $4, $4)`,
    [
      '21000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      installationTokenHash(token),
      timestamp,
    ],
  );
}
