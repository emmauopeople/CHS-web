import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import { beginSyncBatch } from '../../src/sync/batch-intake.js';
import {
  authenticateInstallation,
  installationTokenHash,
} from '../../src/sync/installation-auth.js';
import type { SyncBatchRequest } from '../../src/sync/types.js';

const connectionString = process.env.DATABASE_TEST_URL;
const runIntegration = connectionString ? describe : describe.skip;
const token = `chs_inst_v1_${'A'.repeat(43)}`;
const now = new Date('2026-08-19T12:00:00.000Z');

runIntegration('sync batch intake with PostgreSQL', () => {
  const schema = `chs_sync_${randomUUID().replaceAll('-', '')}`;
  let administrationPool: pg.Pool;
  let servicePool: pg.Pool;
  let request: SyncBatchRequest;

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

    const fixture = JSON.parse(
      await readFile(
        new URL(
          '../../../../packages/contracts/fixtures/sync/v1/valid/batch-request.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as SyncBatchRequest;
    request = { ...fixture, locationId: '32000000-0000-4000-8000-000000000001' };
  });

  afterAll(async () => {
    await servicePool.end();
    await administrationPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrationPool.end();
  });

  it('authenticates, persists once, detects conflicts, and replays a response', async () => {
    const context = await authenticateInstallation(
      servicePool,
      `Bearer ${token}`,
      now,
    );
    const first = await beginSyncBatch(servicePool, context, request, now);

    expect(first).toMatchObject({ kind: 'NEW' });
    const batchInternalId = first.batchInternalId;

    const counts = await servicePool.query(
      `SELECT
         (SELECT count(*)::integer FROM sync_batches) AS batches,
         (SELECT count(*)::integer FROM sync_batch_actors) AS actors,
         (SELECT count(*)::integer FROM sync_records) AS records,
         (SELECT count(*)::integer FROM practitioners) AS practitioners`,
    );
    expect(counts.rows[0]).toEqual({
      batches: 1,
      actors: 2,
      records: 0,
      practitioners: 2,
    });

    await expect(beginSyncBatch(servicePool, context, request, now)).resolves.toEqual({
      kind: 'IN_PROGRESS',
      batchInternalId,
    });

    const reorderedRequest = {
      ...request,
      actors: [...request.actors].reverse(),
      records: [...request.records].reverse(),
    };
    await expect(
      beginSyncBatch(servicePool, context, reorderedRequest, now),
    ).resolves.toEqual({ kind: 'IN_PROGRESS', batchInternalId });

    const changedRequest = {
      ...request,
      desktopApplicationVersion: 'changed-with-same-batch-id',
    };
    await expect(
      beginSyncBatch(servicePool, context, changedRequest, now),
    ).rejects.toMatchObject({ code: 'BATCH_PAYLOAD_MISMATCH' });

    const completedAt = '2026-08-19T12:00:01.000Z';
    const response = {
      contractVersion: '1.0',
      batchId: request.batchId,
      batchStatus: 'REJECTED',
      receivedAt: now.toISOString(),
      completedAt,
      outcomes: request.records.map((record) => ({
        recordId: record.recordId,
        resourceType: record.resourceType,
        localResourceId: record.localResourceId,
        sourceRevision: record.sourceRevision,
        status: 'RETRY',
        canonicalResourceId: null,
        centralPersonId: null,
        chsMedicalId: null,
        medicalIdStatus: null,
        errors: [{ code: 'PROCESSOR_UNAVAILABLE', path: '', retryable: true }],
      })),
    };
    await servicePool.query(
      `UPDATE sync_batches
       SET status = 'REJECTED',
           completed_at = $1,
           retry_count = $2,
           response_body = $3::jsonb
       WHERE id = $4`,
      [completedAt, request.records.length, JSON.stringify(response), batchInternalId],
    );

    await expect(beginSyncBatch(servicePool, context, request, now)).resolves.toEqual({
      kind: 'REPLAY',
      batchInternalId,
      response,
    });
  });

  it('rejects an envelope from a location not enrolled to the installation', async () => {
    const context = await authenticateInstallation(
      servicePool,
      `Bearer ${token}`,
      now,
    );
    const unknownLocationRequest = {
      ...request,
      batchId: '10000000-0000-4000-8000-000000000099',
      locationId: '32000000-0000-4000-8000-000000000099',
    };
    const before = await servicePool.query(
      'SELECT count(*)::integer AS count FROM sync_batches',
    );

    await expect(
      beginSyncBatch(servicePool, context, unknownLocationRequest, now),
    ).rejects.toMatchObject({ code: 'LOCATION_NOT_ENROLLED' });
    const result = await servicePool.query(
      'SELECT count(*)::integer AS count FROM sync_batches',
    );
    expect(result.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});

async function seedInstallation(pool: pg.Pool) {
  const timestamp = now.toISOString();
  await pool.query(
    `INSERT INTO organizations (
       id, identifier_system, identifier_value, name, organization_type_code,
       created_at, updated_at
     ) VALUES ($1, 'https://chs.example/id/organization', 'ORG-SYNC-001',
       'Synthetic Sync Program', 'PROGRAM', $2, $2)`,
    ['10000000-0000-4000-8000-000000000001', timestamp],
  );
  await pool.query(
    `INSERT INTO locations (
       id, organization_id, identifier_system, identifier_value, name,
       location_type_code, physical_type_code, created_at, updated_at
     ) VALUES ($1, $2, 'https://chs.example/id/location', 'LOC-SYNC-001',
       'Synthetic Sync Site', 'SCREENING_SITE', 'MOBILE', $3, $3)`,
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
     ) VALUES ($1, $2, $3, 'Synthetic Sync Desktop', 'Africa/Douala',
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
      '32000000-0000-4000-8000-000000000001',
      timestamp,
    ],
  );
  await pool.query(
    `INSERT INTO desktop_installation_credentials (
       id, installation_id, token_prefix, token_hash, label, status,
       issued_at, created_at, updated_at
     ) VALUES ($1, $2, 'chs_inst_v1_AAAAAAAA', $3, 'Synthetic sync test token',
       'ACTIVE', $4, $4, $4)`,
    [
      '21000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      installationTokenHash(token),
      timestamp,
    ],
  );
}
