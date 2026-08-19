import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import { beginSyncBatch } from '../../src/sync/batch-intake.js';
import { processScreeningSessionRecord } from '../../src/sync/screening-session.js';
import type {
  InstallationContext,
  ScreeningSessionPayload,
  ScreeningSessionSyncRecord,
  SyncBatchRequest,
} from '../../src/sync/types.js';

const connectionString = process.env.DATABASE_TEST_URL;
const runIntegration = connectionString ? describe : describe.skip;
const now = new Date('2026-08-19T14:00:00.000Z');
const organizationId = '10000000-0000-4000-8000-000000000001';
const installationId = '20000000-0000-4000-8000-000000000001';
const canonicalLocationId = '30000000-0000-4000-8000-000000000001';
const sourceLocationId = '32000000-0000-4000-8000-000000000001';
const openerActorId = '60000000-0000-4000-8000-000000000001';
const closerActorId = '60000000-0000-4000-8000-000000000002';
const context: InstallationContext = {
  installationId,
  organizationId,
  configuredLocationId: canonicalLocationId,
  timezone: 'Africa/Douala',
};

runIntegration('screening session processing with PostgreSQL', () => {
  const schema = `chs_session_${randomUUID().replaceAll('-', '')}`;
  let administrationPool: pg.Pool;
  let servicePool: pg.Pool;

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
  });

  afterAll(async () => {
    await servicePool.end();
    await administrationPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrationPool.end();
  });

  it('creates a canonical protocol and open session with separate clinical attribution', async () => {
    const record = sessionRecord({
      localResourceId: '70000000-0000-4000-8000-000000000101',
      recordId: '40000000-0000-4000-8000-000000000201',
      localProtocolVersionId: '80000000-0000-4000-8000-000000000101',
      protocolKey: 'community-screening-101',
      protocolChecksum: `sha256:${'a'.repeat(64)}`,
    });
    const batchInternalId = await startBatch(servicePool, record);

    const first = await processScreeningSessionRecord(
      servicePool,
      context,
      batchInternalId,
      record,
      now,
    );
    expect(first).toMatchObject({
      status: 'ACCEPTED',
      centralPersonId: null,
      medicalIdStatus: null,
    });

    const stored = await servicePool.query(
      `SELECT
         session.status,
         session.session_date::text,
         session.source_revision,
         protocol.protocol_key,
         protocol.checksum,
         opener.source_actor_local_id AS opener_actor,
         mutation.source_actor_local_id AS mutation_actor,
         sync.status AS sync_status
       FROM screening_sessions AS session
       JOIN screening_protocols AS protocol ON protocol.id = session.protocol_id
       JOIN practitioner_source_links AS opener
         ON opener.practitioner_id = session.opened_by_practitioner_id
       JOIN sync_records AS sync ON sync.screening_session_id = session.id
       JOIN sync_batch_actors AS mutation ON mutation.id = sync.sync_batch_actor_id
       WHERE session.id = $1`,
      [first.canonicalResourceId],
    );
    expect(stored.rows[0]).toEqual({
      status: 'OPEN',
      session_date: '2026-08-19',
      source_revision: 1,
      protocol_key: 'community-screening-101',
      checksum: `sha256:${'a'.repeat(64)}`,
      opener_actor: openerActorId,
      mutation_actor: closerActorId,
      sync_status: 'ACCEPTED',
    });

    await expect(
      processScreeningSessionRecord(
        servicePool,
        context,
        batchInternalId,
        record,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'UNCHANGED',
      canonicalResourceId: first.canonicalResourceId,
    });
  });

  it('allows OPEN to CLOSED and rejects reopening or changing closure attribution', async () => {
    const open = sessionRecord({
      localResourceId: '70000000-0000-4000-8000-000000000102',
      recordId: '40000000-0000-4000-8000-000000000202',
      localProtocolVersionId: '80000000-0000-4000-8000-000000000102',
      protocolKey: 'community-screening-102',
      protocolChecksum: `sha256:${'b'.repeat(64)}`,
    });
    const openBatch = await startBatch(servicePool, open);
    const first = await processScreeningSessionRecord(
      servicePool,
      context,
      openBatch,
      open,
      now,
    );

    const closed = sessionRecord({
      ...identityFrom(open),
      recordId: '40000000-0000-4000-8000-000000000203',
      sourceRevision: 2,
      status: 'CLOSED',
      closedByLocalActorId: closerActorId,
      closedAt: '2026-08-19T17:00:00.000Z',
    });
    const closedBatch = await startBatch(servicePool, closed);
    await expect(
      processScreeningSessionRecord(servicePool, context, closedBatch, closed, now),
    ).resolves.toMatchObject({
      status: 'ACCEPTED',
      canonicalResourceId: first.canonicalResourceId,
    });

    const reopened = sessionRecord({
      ...identityFrom(open),
      recordId: '40000000-0000-4000-8000-000000000204',
      sourceRevision: 3,
    });
    const reopenedBatch = await startBatch(servicePool, reopened);
    await expect(
      processScreeningSessionRecord(servicePool, context, reopenedBatch, reopened, now),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'SESSION_STATE_REGRESSION', path: '/payload/status' }],
    });

    const changedClosure = sessionRecord({
      ...identityFrom(open),
      recordId: '40000000-0000-4000-8000-000000000205',
      sourceRevision: 4,
      status: 'CLOSED',
      closedByLocalActorId: openerActorId,
      closedAt: '2026-08-19T17:30:00.000Z',
    });
    const changedClosureBatch = await startBatch(servicePool, changedClosure);
    await expect(
      processScreeningSessionRecord(
        servicePool,
        context,
        changedClosureBatch,
        changedClosure,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'SESSION_CLOSURE_CONFLICT' }],
    });
  });

  it('rejects stale revisions and changed content under the same snapshot key', async () => {
    const original = sessionRecord({
      localResourceId: '70000000-0000-4000-8000-000000000103',
      recordId: '40000000-0000-4000-8000-000000000206',
      sourceRevision: 3,
      localProtocolVersionId: '80000000-0000-4000-8000-000000000103',
      protocolKey: 'community-screening-103',
      protocolChecksum: `sha256:${'c'.repeat(64)}`,
    });
    const originalBatch = await startBatch(servicePool, original);
    await processScreeningSessionRecord(
      servicePool,
      context,
      originalBatch,
      original,
      now,
    );

    const stale = sessionRecord({
      ...identityFrom(original),
      recordId: '40000000-0000-4000-8000-000000000207',
      sourceRevision: 2,
    });
    const staleBatch = await startBatch(servicePool, stale);
    await expect(
      processScreeningSessionRecord(servicePool, context, staleBatch, stale, now),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'STALE_SOURCE_REVISION' }],
    });

    const changedSnapshot = sessionRecord({
      ...identityFrom(original),
      recordId: original.recordId,
      sourceRevision: original.sourceRevision,
      notes: 'Changed content under an existing key',
    });
    const changedBatch = await startBatch(servicePool, changedSnapshot);
    await expect(
      processScreeningSessionRecord(
        servicePool,
        context,
        changedBatch,
        changedSnapshot,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'RECORD_PAYLOAD_MISMATCH' }],
    });
  });

  it('rejects location, local-date, and protocol-source conflicts without a session target', async () => {
    const wrongLocation = sessionRecord({
      localResourceId: '70000000-0000-4000-8000-000000000104',
      recordId: '40000000-0000-4000-8000-000000000208',
      localLocationId: '32000000-0000-4000-8000-000000000099',
      localProtocolVersionId: '80000000-0000-4000-8000-000000000104',
      protocolKey: 'community-screening-104',
      protocolChecksum: `sha256:${'d'.repeat(64)}`,
    });
    const wrongLocationBatch = await startBatch(servicePool, wrongLocation);
    await expect(
      processScreeningSessionRecord(
        servicePool,
        context,
        wrongLocationBatch,
        wrongLocation,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'LOCATION_CONTEXT_MISMATCH' }],
    });

    const wrongDate = sessionRecord({
      localResourceId: '70000000-0000-4000-8000-000000000105',
      recordId: '40000000-0000-4000-8000-000000000209',
      localProtocolVersionId: '80000000-0000-4000-8000-000000000105',
      protocolKey: 'community-screening-105',
      protocolChecksum: `sha256:${'e'.repeat(64)}`,
      sessionDate: '2026-08-18',
    });
    const wrongDateBatch = await startBatch(servicePool, wrongDate);
    await expect(
      processScreeningSessionRecord(servicePool, context, wrongDateBatch, wrongDate, now),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'SESSION_DATE_MISMATCH' }],
    });

    const protocolSource = sessionRecord({
      localResourceId: '70000000-0000-4000-8000-000000000106',
      recordId: '40000000-0000-4000-8000-000000000210',
      localProtocolVersionId: '80000000-0000-4000-8000-000000000106',
      protocolKey: 'community-screening-106',
      protocolChecksum: `sha256:${'f'.repeat(64)}`,
    });
    const protocolSourceBatch = await startBatch(servicePool, protocolSource);
    await processScreeningSessionRecord(
      servicePool,
      context,
      protocolSourceBatch,
      protocolSource,
      now,
    );

    const conflictingProtocol = sessionRecord({
      localResourceId: '70000000-0000-4000-8000-000000000107',
      recordId: '40000000-0000-4000-8000-000000000211',
      localProtocolVersionId: protocolSource.payload.localProtocolVersionId,
      protocolKey: protocolSource.payload.protocolKey,
      protocolChecksum: `sha256:${'0'.repeat(64)}`,
    });
    const conflictingBatch = await startBatch(servicePool, conflictingProtocol);
    await expect(
      processScreeningSessionRecord(
        servicePool,
        context,
        conflictingBatch,
        conflictingProtocol,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'PROTOCOL_SOURCE_CONFLICT' }],
    });
  });

  it('reuses one canonical protocol for equivalent source versions', async () => {
    const first = sessionRecord({
      localResourceId: '70000000-0000-4000-8000-000000000108',
      recordId: '40000000-0000-4000-8000-000000000212',
      localProtocolVersionId: '80000000-0000-4000-8000-000000000108',
      protocolKey: 'community-screening-shared',
      protocolChecksum: `sha256:${'1'.repeat(64)}`,
    });
    const second = sessionRecord({
      localResourceId: '70000000-0000-4000-8000-000000000109',
      recordId: '40000000-0000-4000-8000-000000000213',
      localProtocolVersionId: '80000000-0000-4000-8000-000000000109',
      protocolKey: first.payload.protocolKey,
      protocolChecksum: first.payload.protocolChecksum,
    });
    const firstBatch = await startBatch(servicePool, first);
    const secondBatch = await startBatch(servicePool, second);
    await processScreeningSessionRecord(servicePool, context, firstBatch, first, now);
    await processScreeningSessionRecord(servicePool, context, secondBatch, second, now);

    const result = await servicePool.query(
      `SELECT
         count(DISTINCT protocol_id)::integer AS protocols,
         count(*)::integer AS links
       FROM protocol_source_links
       WHERE local_protocol_version_id IN ($1, $2)`,
      [first.payload.localProtocolVersionId, second.payload.localProtocolVersionId],
    );
    expect(result.rows[0]).toEqual({ protocols: 1, links: 2 });
  });
});

function identityFrom(record: ScreeningSessionSyncRecord) {
  return {
    localResourceId: record.localResourceId,
    localLocationId: record.payload.localLocationId,
    localProtocolVersionId: record.payload.localProtocolVersionId,
    protocolKey: record.payload.protocolKey,
    protocolVersionLabel: record.payload.protocolVersionLabel,
    protocolChecksum: record.payload.protocolChecksum,
    sessionDate: record.payload.sessionDate,
    openedAt: record.payload.openedAt,
  };
}

function sessionRecord(
  values: Readonly<{
    localResourceId: string;
    recordId: string;
    sourceRevision?: number;
    localLocationId?: string;
    localProtocolVersionId: string;
    protocolKey: string;
    protocolVersionLabel?: string;
    protocolChecksum: string;
    sessionDate?: string;
    status?: 'OPEN' | 'CLOSED';
    notes?: string | null;
    openedAt?: string;
    closedAt?: string | null;
    closedByLocalActorId?: string | null;
  }>,
): ScreeningSessionSyncRecord {
  const status = values.status ?? 'OPEN';
  const payload: ScreeningSessionPayload = {
    localLocationId: values.localLocationId ?? sourceLocationId,
    localProtocolVersionId: values.localProtocolVersionId,
    protocolKey: values.protocolKey,
    protocolVersionLabel: values.protocolVersionLabel ?? '2026.1',
    protocolChecksum: values.protocolChecksum,
    sessionDate: values.sessionDate ?? '2026-08-19',
    status,
    notes: values.notes ?? null,
    openedByLocalActorId: openerActorId,
    closedByLocalActorId:
      status === 'CLOSED' ? (values.closedByLocalActorId ?? closerActorId) : null,
    openedAt: values.openedAt ?? '2026-08-19T10:00:00.000Z',
    closedAt: status === 'CLOSED' ? (values.closedAt ?? '2026-08-19T17:00:00.000Z') : null,
    createdAt: '2026-08-19T10:00:00.000Z',
    updatedAt: status === 'CLOSED' ? '2026-08-19T17:00:00.000Z' : '2026-08-19T10:00:00.000Z',
  };
  return {
    recordId: values.recordId,
    resourceType: 'SCREENING_SESSION',
    localResourceId: values.localResourceId,
    sourceRevision: values.sourceRevision ?? 1,
    schemaVersion: 'screening-session.v1',
    operation: 'UPSERT',
    capturedAt: payload.updatedAt,
    sourceActorLocalId: closerActorId,
    payload,
  };
}

async function startBatch(
  pool: pg.Pool,
  record: ScreeningSessionSyncRecord,
): Promise<string> {
  const request: SyncBatchRequest = {
    contractVersion: '1.0',
    batchId: randomUUID(),
    installationId,
    locationId: sourceLocationId,
    installationTimezone: context.timezone,
    desktopApplicationVersion: '0.13.0',
    desktopSchemaVersion: 13,
    createdAt: '2026-08-19T13:30:00.000Z',
    actors: [
      {
        localActorId: openerActorId,
        displayName: 'Synthetic Nurse',
        role: 'NURSE',
        active: true,
        updatedAt: '2026-08-19T12:00:00.000Z',
      },
      {
        localActorId: closerActorId,
        displayName: 'Synthetic Local Administrator',
        role: 'LOCAL_ADMIN',
        active: true,
        updatedAt: '2026-08-19T12:00:00.000Z',
      },
    ],
    records: [record],
  };
  const intake = await beginSyncBatch(pool, context, request, now);
  if (intake.kind !== 'NEW') throw new Error('Expected a new synthetic batch');
  return intake.batchInternalId;
}

async function seedInstallation(pool: pg.Pool) {
  const timestamp = now.toISOString();
  await pool.query(
    `INSERT INTO organizations (
       id, identifier_system, identifier_value, name, organization_type_code,
       created_at, updated_at
     ) VALUES ($1, 'https://chs.example/id/organization', 'ORG-SESSION-001',
       'Synthetic Session Program', 'PROGRAM', $2, $2)`,
    [organizationId, timestamp],
  );
  await pool.query(
    `INSERT INTO locations (
       id, organization_id, identifier_system, identifier_value, name,
       location_type_code, physical_type_code, created_at, updated_at
     ) VALUES ($1, $2, 'https://chs.example/id/location', 'LOC-SESSION-001',
       'Synthetic Session Site', 'SCREENING_SITE', 'MOBILE', $3, $3)`,
    [canonicalLocationId, organizationId, timestamp],
  );
  await pool.query(
    `INSERT INTO desktop_installations (
       id, organization_id, configured_location_id, deployment_name, timezone,
       status, enrolled_at, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Synthetic Session Desktop', 'Africa/Douala',
       'ACTIVE', $4, $4, $4)`,
    [installationId, organizationId, canonicalLocationId, timestamp],
  );
  await pool.query(
    `INSERT INTO location_source_links (
       id, location_id, installation_id, organization_id, source_location_id,
       first_observed_at, last_observed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [
      '31000000-0000-4000-8000-000000000001',
      canonicalLocationId,
      installationId,
      organizationId,
      sourceLocationId,
      timestamp,
    ],
  );
}
