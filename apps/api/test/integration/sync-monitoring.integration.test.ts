import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import { buildApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import {
  OperationsAuthenticationError,
  type OperationsTokenVerifier,
} from '../../src/operations/authentication.js';

const connectionString = process.env.DATABASE_TEST_URL;
const runIntegration = connectionString ? describe : describe.skip;
const issuer = 'https://identity.example.test/';
const now = '2026-08-19T12:00:00.000Z';
const org1 = '13000000-0000-4000-8000-000000000001';
const org2 = '13000000-0000-4000-8000-000000000002';
const installation1 = '23000000-0000-4000-8000-000000000001';
const installation2 = '23000000-0000-4000-8000-000000000002';
const partialBatch = '53000000-0000-4000-8000-000000000002';
const hiddenBatch = '53000000-0000-4000-8000-000000000004';
const monitorUser = '93000000-0000-4000-8000-000000000001';
const deniedUser = '93000000-0000-4000-8000-000000000002';

const config: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
  databaseUrl: 'postgresql://unused',
  databasePoolMax: 4,
  buildCommit: 'sync-monitoring-test',
  buildTime: now,
  trustedProxyCidrs: [],
  operationsOidc: null,
};

const tokenVerifier: OperationsTokenVerifier = {
  async verify(header) {
    if (!header) throw new OperationsAuthenticationError('OPERATIONS_TOKEN_REQUIRED', 401);
    const token = /^Bearer ([^\s]+)$/.exec(header)?.[1];
    const subject = token
      ? { 'monitor-token': 'monitor-user', 'denied-token': 'denied-user' }[token]
      : undefined;
    if (!subject) throw new OperationsAuthenticationError('INVALID_OPERATIONS_TOKEN', 401);
    return {
      issuer,
      subject,
      sessionId: `session-${subject}`,
      authorizedParty: 'operations-web',
    };
  },
};

runIntegration('audited synchronization monitoring routes', () => {
  const schema = `chs_sync_monitoring_${randomUUID().replaceAll('-', '')}`;
  let administrationPool: pg.Pool;
  let servicePool: pg.Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;

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
    await seed(servicePool);
    app = await buildApp({
      config,
      database: {
        pool: servicePool,
        check: async () => undefined,
        close: async () => undefined,
      },
      operationsTokenVerifier: tokenVerifier,
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (servicePool) await servicePool.end();
    await administrationPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrationPool.end();
  });

  it('requires the controlled operations reason and a valid bearer token', async () => {
    const invalidReason = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/sync/batches/search',
      headers: { authorization: 'Bearer monitor-token' },
      payload: { reasonCode: 'CARE_DELIVERY' },
    });
    expect(invalidReason.statusCode).toBe(400);
    expect(invalidReason.headers['cache-control']).toBe('no-store');

    const missingToken = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/sync/batches/search',
      payload: { reasonCode: 'OPERATIONS_SUPPORT' },
    });
    expect(missingToken.statusCode).toBe(401);
    expect(missingToken.headers['www-authenticate']).toBe('Bearer');

    const getAttempt = await app.inject({
      method: 'GET',
      url: '/api/v1/operations/sync/batches/search?status=FAILED',
    });
    expect(getAttempt.statusCode).toBe(404);
  });

  it('requires a dedicated SYNC_MONITOR grant and durably audits denial', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/sync/batches/search',
      headers: { authorization: 'Bearer denied-token' },
      payload: { reasonCode: 'OPERATIONS_SUPPORT' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'SYNC_MONITORING_ACCESS_DENIED' });

    const audit = await servicePool.query(
      `SELECT operations_user_id, action_code, outcome_code, reason_code, metadata
       FROM audit_events WHERE request_id = $1`,
      [response.headers['x-request-id']],
    );
    expect(audit.rows[0]).toMatchObject({
      operations_user_id: deniedUser,
      action_code: 'SYNC_BATCH_LIST_VIEW',
      outcome_code: 'DENIED',
      reason_code: 'OPERATIONS_SUPPORT',
      metadata: { authorizationCode: 'SYNC_MONITOR_NOT_PERMITTED' },
    });
  });

  it('lists only scoped batches and supports safe status and installation filters', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/sync/batches/search',
      headers: { authorization: 'Bearer monitor-token' },
      payload: {
        reasonCode: 'OPERATIONS_SUPPORT',
        installationId: installation1,
        page: 1,
        pageSize: 25,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json();
    expect(body.totalItems).toBe(3);
    expect(body.items).toHaveLength(3);
    expect(body.items.map((item: { attentionState: string }) => item.attentionState)).toEqual(
      expect.arrayContaining(['HEALTHY', 'ATTENTION', 'STALLED']),
    );
    expect(response.body).not.toContain(hiddenBatch);
    expect(response.body).not.toContain('Sensitive Alpha Example');
    expect(response.body).not.toContain('payload_hash');
    expect(response.body).not.toContain('response_body');

    const filtered = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/sync/batches/search',
      headers: { authorization: 'Bearer monitor-token' },
      payload: {
        reasonCode: 'OPERATIONS_SUPPORT',
        status: 'PARTIAL',
      },
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toMatchObject({
      totalItems: 1,
      items: [{ batchReference: partialBatch, status: 'PARTIAL' }],
    });
  });

  it('returns grouped outcomes and redacted error codes, then audits the read', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/sync/batches/detail',
      headers: { authorization: 'Bearer monitor-token' },
      payload: {
        reasonCode: 'OPERATIONS_SUPPORT',
        batchReference: partialBatch,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      batchReference: partialBatch,
      status: 'PARTIAL',
      outcomeCounts: expect.arrayContaining([
        { resourceType: 'PATIENT', status: 'REJECTED', count: 1 },
        { resourceType: 'VITALS', status: 'RETRY', count: 1 },
      ]),
      errorCodeCounts: expect.arrayContaining([
        { code: 'INVALID_PATIENT', retryable: false, count: 1 },
        { code: 'DEPENDENCY_NOT_AVAILABLE', retryable: true, count: 1 },
      ]),
    });
    expect(response.body).not.toContain('Sensitive Alpha Example');
    expect(response.body).not.toContain('payload.name');

    const audit = await servicePool.query(
      `SELECT action_code, entity_type, entity_id, outcome_code, metadata
       FROM audit_events WHERE request_id = $1`,
      [response.headers['x-request-id']],
    );
    expect(audit.rows[0]).toMatchObject({
      action_code: 'SYNC_BATCH_DETAIL_VIEW',
      entity_type: 'SYNC_BATCH',
      entity_id: partialBatch,
      outcome_code: 'SUCCESS',
      metadata: { outcomeGroupCount: 2, errorCodeGroupCount: 2 },
    });
    expect(JSON.stringify(audit.rows[0])).not.toContain('Sensitive Alpha Example');
  });

  it('does not disclose an out-of-scope batch and audits not found', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/sync/batches/detail',
      headers: { authorization: 'Bearer monitor-token' },
      payload: {
        reasonCode: 'OPERATIONS_SUPPORT',
        batchReference: hiddenBatch,
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'SYNC_BATCH_NOT_FOUND' });
    expect(response.body).not.toContain('Program Two');

    const audit = await servicePool.query(
      `SELECT outcome_code FROM audit_events WHERE request_id = $1`,
      [response.headers['x-request-id']],
    );
    expect(audit.rows[0]).toMatchObject({ outcome_code: 'NOT_FOUND' });
  });
});

async function seed(pool: pg.Pool): Promise<void> {
  const organizations = [
    {
      organizationId: org1,
      locationId: '33000000-0000-4000-8000-000000000001',
      installationId: installation1,
      sourceLocationId: '34000000-0000-4000-8000-000000000001',
      suffix: 'One',
    },
    {
      organizationId: org2,
      locationId: '33000000-0000-4000-8000-000000000002',
      installationId: installation2,
      sourceLocationId: '34000000-0000-4000-8000-000000000002',
      suffix: 'Two',
    },
  ] as const;
  for (const item of organizations) {
    await pool.query(
      `INSERT INTO organizations (
         id, identifier_system, identifier_value, name, organization_type_code,
         created_at, updated_at
       ) VALUES ($1, 'urn:synthetic:organization', $2, $3, 'PROGRAM', $4, $4)`,
      [item.organizationId, `ORG-${item.suffix}`, `Program ${item.suffix}`, now],
    );
    await pool.query(
      `INSERT INTO locations (
         id, organization_id, identifier_system, identifier_value, name,
         location_type_code, created_at, updated_at
       ) VALUES ($1, $2, 'urn:synthetic:location', $3, $4,
         'SCREENING_SITE', $5, $5)`,
      [
        item.locationId,
        item.organizationId,
        `LOC-${item.suffix}`,
        `Site ${item.suffix}`,
        now,
      ],
    );
    await pool.query(
      `INSERT INTO desktop_installations (
         id, organization_id, configured_location_id, deployment_name, timezone,
         status, enrolled_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'Africa/Douala', 'ACTIVE', $5, $5, $5)`,
      [
        item.installationId,
        item.organizationId,
        item.locationId,
        `Desktop ${item.suffix}`,
        now,
      ],
    );
    await pool.query(
      `INSERT INTO location_source_links (
         id, location_id, installation_id, organization_id, source_location_id,
         first_observed_at, last_observed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [
        randomUUID(),
        item.locationId,
        item.installationId,
        item.organizationId,
        item.sourceLocationId,
        now,
      ],
    );
  }

  const batches = [
    {
      id: '53000000-0000-4000-8000-000000000001',
      batchId: '54000000-0000-4000-8000-000000000001',
      organizationId: org1,
      installationId: installation1,
      locationId: organizations[0].locationId,
      sourceLocationId: organizations[0].sourceLocationId,
      receivedAt: '2026-08-19T11:55:00.000Z',
      completedAt: '2026-08-19T11:55:01.000Z',
      status: 'ACCEPTED',
      counts: [1, 0, 0, 0, 0],
    },
    {
      id: partialBatch,
      batchId: '54000000-0000-4000-8000-000000000002',
      organizationId: org1,
      installationId: installation1,
      locationId: organizations[0].locationId,
      sourceLocationId: organizations[0].sourceLocationId,
      receivedAt: '2026-08-19T11:40:00.000Z',
      completedAt: '2026-08-19T11:40:02.000Z',
      status: 'PARTIAL',
      counts: [0, 0, 0, 1, 1],
    },
    {
      id: '53000000-0000-4000-8000-000000000003',
      batchId: '54000000-0000-4000-8000-000000000003',
      organizationId: org1,
      installationId: installation1,
      locationId: organizations[0].locationId,
      sourceLocationId: organizations[0].sourceLocationId,
      receivedAt: '2026-08-19T11:00:00.000Z',
      completedAt: null,
      status: 'PROCESSING',
      counts: [0, 0, 0, 0, 0],
    },
    {
      id: hiddenBatch,
      batchId: '54000000-0000-4000-8000-000000000004',
      organizationId: org2,
      installationId: installation2,
      locationId: organizations[1].locationId,
      sourceLocationId: organizations[1].sourceLocationId,
      receivedAt: '2026-08-19T11:50:00.000Z',
      completedAt: '2026-08-19T11:50:01.000Z',
      status: 'ACCEPTED',
      counts: [1, 0, 0, 0, 0],
    },
  ] as const;
  for (const batch of batches) {
    await pool.query(
      `INSERT INTO sync_batches (
         id, installation_id, organization_id, batch_id, location_id,
         source_location_id, contract_version, desktop_application_version,
         desktop_schema_version, source_created_at, received_at, completed_at,
         payload_hash, status, accepted_count, unchanged_count, review_count,
         rejected_count, retry_count
       ) VALUES ($1, $2, $3, $4, $5, $6, '1.0', '0.1.0', 14, $7, $8, $9,
         $10, $11, $12, $13, $14, $15, $16)`,
      [
        batch.id,
        batch.installationId,
        batch.organizationId,
        batch.batchId,
        batch.locationId,
        batch.sourceLocationId,
        batch.receivedAt,
        batch.receivedAt,
        batch.completedAt,
        'a'.repeat(64),
        batch.status,
        ...batch.counts,
      ],
    );
  }

  const practitionerId = '63000000-0000-4000-8000-000000000001';
  const practitionerLinkId = '64000000-0000-4000-8000-000000000001';
  const sourceActorId = '65000000-0000-4000-8000-000000000001';
  const batchActorId = '66000000-0000-4000-8000-000000000001';
  await pool.query(
    `INSERT INTO practitioners (id, display_name, created_at, updated_at)
     VALUES ($1, 'Synthetic Screener', $2, $2)`,
    [practitionerId, now],
  );
  await pool.query(
    `INSERT INTO practitioner_source_links (
       id, practitioner_id, installation_id, source_actor_local_id,
       source_display_name, source_role_code, source_active, source_updated_at,
       first_observed_at, last_observed_at
     ) VALUES ($1, $2, $3, $4, 'Synthetic Screener', 'NURSE', true,
       $5, $5, $5)`,
    [practitionerLinkId, practitionerId, installation1, sourceActorId, now],
  );
  await pool.query(
    `INSERT INTO sync_batch_actors (
       id, batch_internal_id, installation_id, source_actor_local_id,
       practitioner_source_link_id, practitioner_id, source_display_name,
       source_role_code, source_active, source_updated_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'Synthetic Screener', 'NURSE', true,
       $7, $7)`,
    [
      batchActorId,
      partialBatch,
      installation1,
      sourceActorId,
      practitionerLinkId,
      practitionerId,
      now,
    ],
  );

  const syncRecords = [
    {
      resourceType: 'PATIENT',
      status: 'REJECTED',
      errors: [
        {
          code: 'INVALID_PATIENT',
          path: 'payload.name',
          retryable: false,
          message: 'Sensitive Alpha Example',
        },
      ],
    },
    {
      resourceType: 'VITALS',
      status: 'RETRY',
      errors: [
        {
          code: 'DEPENDENCY_NOT_AVAILABLE',
          path: 'payload.encounterId',
          retryable: true,
          message: 'Sensitive dependency detail',
        },
      ],
    },
  ] as const;
  for (const record of syncRecords) {
    await pool.query(
      `INSERT INTO sync_records (
         id, batch_internal_id, installation_id, record_id, resource_type,
         local_resource_id, source_revision, schema_version, operation,
         captured_at, sync_batch_actor_id, payload_hash, status, errors,
         processed_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, '1.0', 'UPSERT', $7, $8, $9,
         $10, $11::jsonb, $7, $7)`,
      [
        randomUUID(),
        partialBatch,
        installation1,
        randomUUID(),
        record.resourceType,
        randomUUID(),
        now,
        batchActorId,
        'b'.repeat(64),
        record.status,
        JSON.stringify(record.errors),
      ],
    );
  }

  for (const [userId, subject, name] of [
    [monitorUser, 'monitor-user', 'Sync Monitor'],
    [deniedUser, 'denied-user', 'Patient Viewer'],
  ]) {
    await pool.query(
      `INSERT INTO operations_users (
         id, oidc_issuer, oidc_subject, display_name, status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $5)`,
      [userId, issuer, subject, name, now],
    );
  }
  await pool.query(
    `INSERT INTO operations_access_grants (
       id, operations_user_id, permission_code, scope_kind, organization_id,
       granted_at, created_at, updated_at
     ) VALUES
       ($1, $2, 'SYNC_MONITOR', 'ORGANIZATION', $3, $4, $4, $4),
       ($5, $6, 'PATIENT_READ', 'ORGANIZATION', $3, $4, $4, $4)`,
    [randomUUID(), monitorUser, org1, now, randomUUID(), deniedUser],
  );
}
