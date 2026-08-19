import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import { beginSyncBatch } from '../../src/sync/batch-intake.js';
import { processScreeningEncounterRecord } from '../../src/sync/screening-encounter.js';
import type {
  InstallationContext,
  ScreeningEncounterPayload,
  ScreeningEncounterSyncRecord,
  SyncBatchRequest,
} from '../../src/sync/types.js';

const connectionString = process.env.DATABASE_TEST_URL;
const runIntegration = connectionString ? describe : describe.skip;
const now = new Date('2026-08-19T14:00:00.000Z');
const organizationId = '11000000-0000-4000-8000-000000000001';
const installationId = '21000000-0000-4000-8000-000000000001';
const canonicalLocationId = '31000000-0000-4000-8000-000000000001';
const sourceLocationId = '32000000-0000-4000-8000-000000000001';
const canonicalProtocolId = '81000000-0000-4000-8000-000000000001';
const sourceProtocolId = '82000000-0000-4000-8000-000000000001';
const personId = '51000000-0000-4000-8000-000000000001';
const localPatientId = '52000000-0000-4000-8000-000000000001';
const canonicalSessionId = '71000000-0000-4000-8000-000000000001';
const localSessionId = '72000000-0000-4000-8000-000000000001';
const mutationActorId = '61000000-0000-4000-8000-000000000001';
const recorderActorId = '61000000-0000-4000-8000-000000000002';
const context: InstallationContext = {
  installationId,
  organizationId,
  configuredLocationId: canonicalLocationId,
  timezone: 'Africa/Douala',
};

runIntegration('screening encounter processing with PostgreSQL', () => {
  const schema = `chs_encounter_${randomUUID().replaceAll('-', '')}`;
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
    await seedDependencies(servicePool);
  });

  afterAll(async () => {
    await servicePool.end();
    await administrationPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrationPool.end();
  });

  it('creates an encounter with patient, session, protocol, location, and clinical attribution', async () => {
    const record = encounterRecord({
      localResourceId: '91000000-0000-4000-8000-000000000101',
      recordId: '41000000-0000-4000-8000-000000000201',
    });
    const batchInternalId = await startBatch(servicePool, record);

    const first = await processScreeningEncounterRecord(
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
         encounter.person_id,
         encounter.screening_session_id,
         encounter.location_id,
         encounter.protocol_id,
         encounter.status,
         recorder.source_actor_local_id AS recorder_actor,
         mutation.source_actor_local_id AS mutation_actor,
         sync.status AS sync_status
       FROM screening_encounters AS encounter
       JOIN practitioner_source_links AS recorder
         ON recorder.practitioner_id = encounter.recorded_by_practitioner_id
       JOIN sync_records AS sync ON sync.screening_encounter_id = encounter.id
       JOIN sync_batch_actors AS mutation ON mutation.id = sync.sync_batch_actor_id
       WHERE encounter.id = $1`,
      [first.canonicalResourceId],
    );
    expect(stored.rows[0]).toEqual({
      person_id: personId,
      screening_session_id: canonicalSessionId,
      location_id: canonicalLocationId,
      protocol_id: canonicalProtocolId,
      status: 'DRAFT',
      recorder_actor: recorderActorId,
      mutation_actor: mutationActorId,
      sync_status: 'ACCEPTED',
    });

    await expect(
      processScreeningEncounterRecord(
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

  it('allows DRAFT to COMPLETED to VOID and prevents terminal regression', async () => {
    const draft = encounterRecord({
      localResourceId: '91000000-0000-4000-8000-000000000102',
      recordId: '41000000-0000-4000-8000-000000000202',
    });
    const first = await processScreeningEncounterRecord(
      servicePool,
      context,
      await startBatch(servicePool, draft),
      draft,
      now,
    );

    const completed = encounterRecord({
      localResourceId: draft.localResourceId,
      recordId: '41000000-0000-4000-8000-000000000203',
      sourceRevision: 2,
      status: 'COMPLETED',
      completedAt: '2026-08-19T12:00:00.000Z',
    });
    await expect(
      processScreeningEncounterRecord(
        servicePool,
        context,
        await startBatch(servicePool, completed),
        completed,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'ACCEPTED',
      canonicalResourceId: first.canonicalResourceId,
    });

    const voided = encounterRecord({
      localResourceId: draft.localResourceId,
      recordId: '41000000-0000-4000-8000-000000000204',
      sourceRevision: 3,
      status: 'VOID',
      completedAt: completed.payload.completedAt,
      voidReason: 'Entered for the wrong patient',
    });
    await expect(
      processScreeningEncounterRecord(
        servicePool,
        context,
        await startBatch(servicePool, voided),
        voided,
        now,
      ),
    ).resolves.toMatchObject({ status: 'ACCEPTED' });

    const regression = encounterRecord({
      localResourceId: draft.localResourceId,
      recordId: '41000000-0000-4000-8000-000000000205',
      sourceRevision: 4,
      status: 'COMPLETED',
      completedAt: completed.payload.completedAt,
    });
    await expect(
      processScreeningEncounterRecord(
        servicePool,
        context,
        await startBatch(servicePool, regression),
        regression,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'ENCOUNTER_STATE_REGRESSION', path: '/payload/status' }],
    });
  });

  it('reprocesses an identical retry after its patient dependency becomes available', async () => {
    const delayedPatientId = '52000000-0000-4000-8000-000000000099';
    const record = encounterRecord({
      localResourceId: '91000000-0000-4000-8000-000000000103',
      recordId: '41000000-0000-4000-8000-000000000206',
      localPatientId: delayedPatientId,
    });
    const batchInternalId = await startBatch(servicePool, record);

    await expect(
      processScreeningEncounterRecord(
        servicePool,
        context,
        batchInternalId,
        record,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'RETRY',
      errors: [
        {
          code: 'DEPENDENCY_NOT_AVAILABLE',
          path: '/payload/localPatientId',
          retryable: true,
        },
      ],
    });

    await servicePool.query(
      `INSERT INTO patient_source_links (
         id, person_id, installation_id, local_patient_id, local_patient_code,
         last_source_revision, last_content_hash, source_created_at,
         source_updated_at, first_observed_at, last_observed_at
       ) VALUES ($1, $2, $3, $4, 'PT-999999', 1, $5, $6, $6, $6, $6)`,
      [randomUUID(), personId, installationId, delayedPatientId, 'f'.repeat(64), now],
    );

    await expect(
      processScreeningEncounterRecord(
        servicePool,
        context,
        batchInternalId,
        record,
        now,
      ),
    ).resolves.toMatchObject({ status: 'ACCEPTED' });

    const stored = await servicePool.query(
      `SELECT count(*)::integer AS count, min(status) AS status
       FROM sync_records
       WHERE installation_id = $1 AND record_id = $2`,
      [installationId, record.recordId],
    );
    expect(stored.rows[0]).toEqual({ count: 1, status: 'ACCEPTED' });
  });

  it('creates a separate amendment linked to a completed encounter', async () => {
    const original = encounterRecord({
      localResourceId: '91000000-0000-4000-8000-000000000104',
      recordId: '41000000-0000-4000-8000-000000000207',
      status: 'COMPLETED',
      completedAt: '2026-08-19T12:00:00.000Z',
    });
    const originalOutcome = await processScreeningEncounterRecord(
      servicePool,
      context,
      await startBatch(servicePool, original),
      original,
      now,
    );

    const amendment = encounterRecord({
      localResourceId: '91000000-0000-4000-8000-000000000105',
      recordId: '41000000-0000-4000-8000-000000000208',
      status: 'AMENDED',
      completedAt: '2026-08-19T12:15:00.000Z',
      amendmentOfLocalEncounterId: original.localResourceId,
      amendmentReason: 'Corrected screening documentation',
    });
    const amendmentOutcome = await processScreeningEncounterRecord(
      servicePool,
      context,
      await startBatch(servicePool, amendment),
      amendment,
      now,
    );
    expect(amendmentOutcome).toMatchObject({ status: 'ACCEPTED' });

    const stored = await servicePool.query(
      `SELECT status, amendment_of_encounter_id, amendment_reason
       FROM screening_encounters
       WHERE id = $1`,
      [amendmentOutcome.canonicalResourceId],
    );
    expect(stored.rows[0]).toEqual({
      status: 'AMENDED',
      amendment_of_encounter_id: originalOutcome.canonicalResourceId,
      amendment_reason: 'Corrected screening documentation',
    });
  });

  it('rejects invalid state, session context, stale revisions, and changed delivery content', async () => {
    const invalidState = encounterRecord({
      localResourceId: '91000000-0000-4000-8000-000000000106',
      recordId: '41000000-0000-4000-8000-000000000209',
      status: 'COMPLETED',
      completedAt: null,
    });
    await expect(
      processScreeningEncounterRecord(
        servicePool,
        context,
        await startBatch(servicePool, invalidState),
        invalidState,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'ENCOUNTER_STATE_INVALID' }],
    });

    const wrongProtocol = encounterRecord({
      localResourceId: '91000000-0000-4000-8000-000000000107',
      recordId: '41000000-0000-4000-8000-000000000210',
      localProtocolVersionId: '82000000-0000-4000-8000-000000000099',
    });
    await expect(
      processScreeningEncounterRecord(
        servicePool,
        context,
        await startBatch(servicePool, wrongProtocol),
        wrongProtocol,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'SESSION_CONTEXT_MISMATCH' }],
    });

    const current = encounterRecord({
      localResourceId: '91000000-0000-4000-8000-000000000108',
      recordId: '41000000-0000-4000-8000-000000000211',
      sourceRevision: 3,
    });
    await processScreeningEncounterRecord(
      servicePool,
      context,
      await startBatch(servicePool, current),
      current,
      now,
    );
    const stale = encounterRecord({
      localResourceId: current.localResourceId,
      recordId: '41000000-0000-4000-8000-000000000212',
      sourceRevision: 2,
    });
    await expect(
      processScreeningEncounterRecord(
        servicePool,
        context,
        await startBatch(servicePool, stale),
        stale,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'STALE_SOURCE_REVISION' }],
    });

    const changedDelivery = encounterRecord({
      localResourceId: current.localResourceId,
      recordId: current.recordId,
      sourceRevision: current.sourceRevision,
      startedAt: '2026-08-19T11:30:00.000Z',
    });
    await expect(
      processScreeningEncounterRecord(
        servicePool,
        context,
        await startBatch(servicePool, changedDelivery),
        changedDelivery,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'RECORD_PAYLOAD_MISMATCH' }],
    });
  });
});

function encounterRecord(
  values: Readonly<{
    localResourceId: string;
    recordId: string;
    sourceRevision?: number;
    localPatientId?: string;
    localScreeningSessionId?: string;
    localLocationId?: string;
    localProtocolVersionId?: string;
    status?: ScreeningEncounterPayload['status'];
    startedAt?: string;
    completedAt?: string | null;
    amendmentOfLocalEncounterId?: string | null;
    amendmentReason?: string | null;
    voidReason?: string | null;
  }>,
): ScreeningEncounterSyncRecord {
  const status = values.status ?? 'DRAFT';
  const startedAt = values.startedAt ?? '2026-08-19T11:00:00.000Z';
  const completedAt =
    values.completedAt !== undefined
      ? values.completedAt
      : status === 'COMPLETED' || status === 'AMENDED'
        ? '2026-08-19T12:00:00.000Z'
        : null;
  const payload: ScreeningEncounterPayload = {
    localPatientId: values.localPatientId ?? localPatientId,
    localScreeningSessionId: values.localScreeningSessionId ?? localSessionId,
    localLocationId: values.localLocationId ?? sourceLocationId,
    localProtocolVersionId: values.localProtocolVersionId ?? sourceProtocolId,
    recordedByLocalActorId: recorderActorId,
    status,
    startedAt,
    completedAt,
    sourceType: 'LOCAL',
    amendmentOfLocalEncounterId: values.amendmentOfLocalEncounterId ?? null,
    amendmentReason: values.amendmentReason ?? null,
    voidReason:
      values.voidReason !== undefined
        ? values.voidReason
        : status === 'VOID'
          ? 'Voided by synthetic test'
          : null,
    createdAt: startedAt,
    updatedAt: completedAt ?? startedAt,
  };
  return {
    recordId: values.recordId,
    resourceType: 'SCREENING_ENCOUNTER',
    localResourceId: values.localResourceId,
    sourceRevision: values.sourceRevision ?? 1,
    schemaVersion: 'screening-encounter.v1',
    operation: 'UPSERT',
    capturedAt: payload.updatedAt,
    sourceActorLocalId: mutationActorId,
    payload,
  };
}

async function startBatch(
  pool: pg.Pool,
  record: ScreeningEncounterSyncRecord,
): Promise<string> {
  const request: SyncBatchRequest = {
    contractVersion: '1.0',
    batchId: randomUUID(),
    installationId,
    locationId: sourceLocationId,
    installationTimezone: context.timezone,
    desktopApplicationVersion: '0.14.0',
    desktopSchemaVersion: 14,
    createdAt: '2026-08-19T13:30:00.000Z',
    actors: [
      {
        localActorId: mutationActorId,
        displayName: 'Synthetic Local Administrator',
        role: 'LOCAL_ADMIN',
        active: true,
        updatedAt: '2026-08-19T12:00:00.000Z',
      },
      {
        localActorId: recorderActorId,
        displayName: 'Synthetic Screening Nurse',
        role: 'NURSE',
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

async function seedDependencies(pool: pg.Pool) {
  const timestamp = now.toISOString();
  const seedPractitionerId = '62000000-0000-4000-8000-000000000001';
  await pool.query(
    `INSERT INTO organizations (
       id, identifier_system, identifier_value, name, organization_type_code,
       created_at, updated_at
     ) VALUES ($1, 'https://chs.example/id/organization', 'ORG-ENCOUNTER-001',
       'Synthetic Encounter Program', 'PROGRAM', $2, $2)`,
    [organizationId, timestamp],
  );
  await pool.query(
    `INSERT INTO locations (
       id, organization_id, identifier_system, identifier_value, name,
       location_type_code, physical_type_code, created_at, updated_at
     ) VALUES ($1, $2, 'https://chs.example/id/location', 'LOC-ENCOUNTER-001',
       'Synthetic Encounter Site', 'SCREENING_SITE', 'MOBILE', $3, $3)`,
    [canonicalLocationId, organizationId, timestamp],
  );
  await pool.query(
    `INSERT INTO desktop_installations (
       id, organization_id, configured_location_id, deployment_name, timezone,
       status, enrolled_at, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Synthetic Encounter Desktop', 'Africa/Douala',
       'ACTIVE', $4, $4, $4)`,
    [installationId, organizationId, canonicalLocationId, timestamp],
  );
  await pool.query(
    `INSERT INTO location_source_links (
       id, location_id, installation_id, organization_id, source_location_id,
       first_observed_at, last_observed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [randomUUID(), canonicalLocationId, installationId, organizationId, sourceLocationId, timestamp],
  );
  await pool.query(
    `INSERT INTO screening_protocols (
       id, organization_id, protocol_key, version_label, checksum, status,
       effective_at, created_at, updated_at
     ) VALUES ($1, $2, 'community-screening', '2026.1', $3, 'ACTIVE', $4, $4, $4)`,
    [canonicalProtocolId, organizationId, `sha256:${'a'.repeat(64)}`, timestamp],
  );
  await pool.query(
    `INSERT INTO protocol_source_links (
       id, protocol_id, installation_id, organization_id,
       local_protocol_version_id, first_observed_at, last_observed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [randomUUID(), canonicalProtocolId, installationId, organizationId, sourceProtocolId, timestamp],
  );
  await pool.query(
    `INSERT INTO persons (
       id, display_name, name_normalized, sex, acknowledgment_status,
       date_of_birth, status, created_at, updated_at
     ) VALUES ($1, 'Synthetic Patient', 'synthetic patient', 'UNKNOWN',
       'ACKNOWLEDGED', '1980-01-01', 'ACTIVE', $2, $2)`,
    [personId, timestamp],
  );
  await pool.query(
    `INSERT INTO patient_source_links (
       id, person_id, installation_id, local_patient_id, local_patient_code,
       last_source_revision, last_content_hash, source_created_at,
       source_updated_at, first_observed_at, last_observed_at
     ) VALUES ($1, $2, $3, $4, 'PT-000001', 1, $5, $6, $6, $6, $6)`,
    [randomUUID(), personId, installationId, localPatientId, 'b'.repeat(64), timestamp],
  );
  await pool.query(
    `INSERT INTO practitioners (id, display_name, active, created_at, updated_at)
     VALUES ($1, 'Synthetic Session Owner', true, $2, $2)`,
    [seedPractitionerId, timestamp],
  );
  await pool.query(
    `INSERT INTO screening_sessions (
       id, installation_id, organization_id, location_id, protocol_id,
       local_session_id, source_location_id, source_protocol_version_id,
       session_date, status, notes, opened_by_practitioner_id,
       closed_by_practitioner_id, opened_at, closed_at, source_revision,
       source_content_hash, source_created_at, source_updated_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, '2026-08-19', 'CLOSED', NULL,
       $9, $9, '2026-08-19T10:00:00.000Z', '2026-08-19T18:00:00.000Z',
       1, $10, '2026-08-19T10:00:00.000Z', '2026-08-19T18:00:00.000Z', $11, $11
     )`,
    [
      canonicalSessionId,
      installationId,
      organizationId,
      canonicalLocationId,
      canonicalProtocolId,
      localSessionId,
      sourceLocationId,
      sourceProtocolId,
      seedPractitionerId,
      'c'.repeat(64),
      timestamp,
    ],
  );
}
