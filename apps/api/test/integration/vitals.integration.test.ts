import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import { beginSyncBatch } from '../../src/sync/batch-intake.js';
import type {
  InstallationContext,
  SyncBatchRequest,
  VitalsReadingPayload,
  VitalsSyncRecord,
} from '../../src/sync/types.js';
import { processVitalsRecord } from '../../src/sync/vitals.js';

const connectionString = process.env.DATABASE_TEST_URL;
const runIntegration = connectionString ? describe : describe.skip;
const now = new Date('2026-08-19T14:00:00.000Z');
const organizationId = '12000000-0000-4000-8000-000000000001';
const installationId = '22000000-0000-4000-8000-000000000001';
const canonicalLocationId = '33000000-0000-4000-8000-000000000001';
const sourceLocationId = '34000000-0000-4000-8000-000000000001';
const canonicalProtocolId = '83000000-0000-4000-8000-000000000001';
const sourceProtocolId = '84000000-0000-4000-8000-000000000001';
const personId = '53000000-0000-4000-8000-000000000001';
const canonicalSessionId = '73000000-0000-4000-8000-000000000001';
const localSessionId = '74000000-0000-4000-8000-000000000001';
const canonicalEncounterId = '93000000-0000-4000-8000-000000000001';
const localEncounterId = '94000000-0000-4000-8000-000000000001';
const voidEncounterId = '93000000-0000-4000-8000-000000000002';
const localVoidEncounterId = '94000000-0000-4000-8000-000000000002';
const mutationActorId = '63000000-0000-4000-8000-000000000001';
const performerActorId = '63000000-0000-4000-8000-000000000002';
const otherActorId = '63000000-0000-4000-8000-000000000003';
const performerPractitionerId = '64000000-0000-4000-8000-000000000001';
const context: InstallationContext = {
  installationId,
  organizationId,
  configuredLocationId: canonicalLocationId,
  timezone: 'Africa/Douala',
};

runIntegration('vitals processing with PostgreSQL', () => {
  const schema = `chs_vitals_${randomUUID().replaceAll('-', '')}`;
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

  it('creates a FHIR-ready completed vital set with timezone-derived reading instants', async () => {
    const record = vitalsRecord({
      localResourceId: 'a1000000-0000-4000-8000-000000000101',
      recordId: '42000000-0000-4000-8000-000000000201',
      status: 'VITALS_COMPLETE',
      weightKg: 68.5,
      waistCm: 82.2,
      readings: [reading('b1000000-0000-4000-8000-000000000101', 1, '11:05')],
    });
    const batchInternalId = await startBatch(servicePool, record);

    const first = await processVitalsRecord(
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

    const stored = await servicePool.query<{
      encounter_id: string;
      person_id: string;
      status: string;
      performer_actor: string;
      mutation_actor: string;
      measured_at: Date;
      systolic_mmhg: number;
      diastolic_mmhg: number;
      pulse_bpm: number;
      measurement_timezone: string;
    }>(
      `SELECT
         vital.encounter_id,
         vital.person_id,
         vital.status,
         performer.source_actor_local_id AS performer_actor,
         mutation.source_actor_local_id AS mutation_actor,
         reading.measured_at,
         reading.systolic_mmhg,
         reading.diastolic_mmhg,
         reading.pulse_bpm,
         reading.measurement_timezone
       FROM screening_vital_sets AS vital
       JOIN practitioner_source_links AS performer
         ON performer.practitioner_id = vital.recorded_by_practitioner_id
       JOIN vital_readings AS reading ON reading.vital_set_id = vital.id
       JOIN sync_records AS sync ON sync.screening_vital_set_id = vital.id
       JOIN sync_batch_actors AS mutation ON mutation.id = sync.sync_batch_actor_id
       WHERE vital.id = $1`,
      [first.canonicalResourceId],
    );
    expect(stored.rows[0]).toMatchObject({
      encounter_id: canonicalEncounterId,
      person_id: personId,
      status: 'VITALS_COMPLETE',
      performer_actor: performerActorId,
      mutation_actor: mutationActorId,
      systolic_mmhg: 122,
      diastolic_mmhg: 78,
      pulse_bpm: 72,
      measurement_timezone: 'Africa/Douala',
    });
    expect(stored.rows[0]!.measured_at.toISOString()).toBe(
      '2026-08-19T10:05:00.000Z',
    );

    await expect(
      processVitalsRecord(servicePool, context, batchInternalId, record, now),
    ).resolves.toMatchObject({
      status: 'UNCHANGED',
      canonicalResourceId: first.canonicalResourceId,
    });
  });

  it('diffs draft readings, preserves canonical IDs, and locks the completed set', async () => {
    const draftEncounterId = '93000000-0000-4000-8000-000000000003';
    const draftLocalEncounterId = '94000000-0000-4000-8000-000000000003';
    await insertEncounter(
      servicePool,
      draftEncounterId,
      draftLocalEncounterId,
      'DRAFT',
    );
    const firstReading = reading(
      'b1000000-0000-4000-8000-000000000102',
      1,
      '11:10',
    );
    const removedReading = reading(
      'b1000000-0000-4000-8000-000000000103',
      2,
      '11:15',
    );
    const retainedReading = reading(
      'b1000000-0000-4000-8000-000000000104',
      3,
      '11:20',
    );
    const draft = vitalsRecord({
      localResourceId: 'a1000000-0000-4000-8000-000000000102',
      recordId: '42000000-0000-4000-8000-000000000202',
      localEncounterId: draftLocalEncounterId,
      readings: [firstReading, removedReading, retainedReading],
    });
    const first = await processVitalsRecord(
      servicePool,
      context,
      await startBatch(servicePool, draft),
      draft,
      now,
    );
    const canonicalReadings = await servicePool.query<{
      id: string;
      local_reading_id: string;
    }>(
      `SELECT id, local_reading_id
       FROM vital_readings
       WHERE vital_set_id = $1`,
      [first.canonicalResourceId],
    );
    const retainedCanonicalId = canonicalReadings.rows.find(
      (row) => row.local_reading_id === retainedReading.localReadingId,
    )!.id;

    const addedReading = reading(
      'b1000000-0000-4000-8000-000000000105',
      3,
      '11:25',
    );
    const completed = vitalsRecord({
      localResourceId: draft.localResourceId,
      recordId: '42000000-0000-4000-8000-000000000203',
      sourceRevision: 2,
      localEncounterId: draftLocalEncounterId,
      status: 'VITALS_COMPLETE',
      readings: [
        firstReading,
        { ...retainedReading, sequenceNumber: 2 },
        addedReading,
      ],
    });
    await expect(
      processVitalsRecord(
        servicePool,
        context,
        await startBatch(servicePool, completed),
        completed,
        now,
      ),
    ).resolves.toMatchObject({ status: 'ACCEPTED' });

    const after = await servicePool.query<{
      id: string;
      local_reading_id: string;
      sequence_number: number;
    }>(
      `SELECT id, local_reading_id, sequence_number
       FROM vital_readings
       WHERE vital_set_id = $1
       ORDER BY sequence_number`,
      [first.canonicalResourceId],
    );
    expect(after.rows).toHaveLength(3);
    expect(after.rows.some((row) => row.local_reading_id === removedReading.localReadingId)).toBe(
      false,
    );
    expect(
      after.rows.find((row) => row.local_reading_id === retainedReading.localReadingId),
    ).toEqual({
      id: retainedCanonicalId,
      local_reading_id: retainedReading.localReadingId,
      sequence_number: 2,
    });

    const changedTerminal = vitalsRecord({
      localResourceId: draft.localResourceId,
      recordId: '42000000-0000-4000-8000-000000000204',
      sourceRevision: 3,
      localEncounterId: draftLocalEncounterId,
      status: 'VITALS_COMPLETE',
      weightKg: 99,
      readings: completed.payload.readings,
    });
    await expect(
      processVitalsRecord(
        servicePool,
        context,
        await startBatch(servicePool, changedTerminal),
        changedTerminal,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'VITALS_TERMINAL_CONFLICT', path: '/payload' }],
    });
  });

  it('reprocesses an identical retry after its encounter dependency arrives', async () => {
    const delayedLocalEncounterId = '94000000-0000-4000-8000-000000000099';
    const record = vitalsRecord({
      localResourceId: 'a1000000-0000-4000-8000-000000000103',
      recordId: '42000000-0000-4000-8000-000000000205',
      localEncounterId: delayedLocalEncounterId,
      readings: [reading('b1000000-0000-4000-8000-000000000106', 1, null)],
    });
    const batchInternalId = await startBatch(servicePool, record);

    await expect(
      processVitalsRecord(servicePool, context, batchInternalId, record, now),
    ).resolves.toMatchObject({
      status: 'RETRY',
      errors: [{ code: 'DEPENDENCY_NOT_AVAILABLE', retryable: true }],
    });

    await insertEncounter(
      servicePool,
      '93000000-0000-4000-8000-000000000099',
      delayedLocalEncounterId,
      'DRAFT',
    );
    await expect(
      processVitalsRecord(servicePool, context, batchInternalId, record, now),
    ).resolves.toMatchObject({ status: 'ACCEPTED' });

    const stored = await servicePool.query(
      `SELECT count(*)::integer AS count, min(status) AS status
       FROM sync_records
       WHERE installation_id = $1 AND record_id = $2`,
      [installationId, record.recordId],
    );
    expect(stored.rows[0]).toEqual({ count: 1, status: 'ACCEPTED' });
  });

  it('rejects invalid reading sets, measurement context, and performer attribution', async () => {
    const duplicateSequence = vitalsRecord({
      localResourceId: 'a1000000-0000-4000-8000-000000000104',
      recordId: '42000000-0000-4000-8000-000000000206',
      readings: [
        reading('b1000000-0000-4000-8000-000000000107', 1, null),
        reading('b1000000-0000-4000-8000-000000000108', 1, null),
      ],
    });
    await expect(
      processVitalsRecord(
        servicePool,
        context,
        await startBatch(servicePool, duplicateSequence),
        duplicateSequence,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'READING_SET_INVALID' }],
    });

    const wrongTimezone = vitalsRecord({
      localResourceId: 'a1000000-0000-4000-8000-000000000105',
      recordId: '42000000-0000-4000-8000-000000000207',
      readings: [
        {
          ...reading('b1000000-0000-4000-8000-000000000109', 1, '11:30'),
          measurementTimezone: 'America/Chicago',
        },
      ],
    });
    await expect(
      processVitalsRecord(
        servicePool,
        context,
        await startBatch(servicePool, wrongTimezone),
        wrongTimezone,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'MEASUREMENT_TIMEZONE_MISMATCH' }],
    });

    const wrongPerformer = vitalsRecord({
      localResourceId: 'a1000000-0000-4000-8000-000000000106',
      recordId: '42000000-0000-4000-8000-000000000208',
      performedByLocalActorId: otherActorId,
      readings: [reading('b1000000-0000-4000-8000-000000000110', 1, null)],
    });
    await expect(
      processVitalsRecord(
        servicePool,
        context,
        await startBatch(servicePool, wrongPerformer),
        wrongPerformer,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'PERFORMER_CONTEXT_MISMATCH' }],
    });

    const beforeEncounter = vitalsRecord({
      localResourceId: 'a1000000-0000-4000-8000-000000000107',
      recordId: '42000000-0000-4000-8000-000000000209',
      readings: [reading('b1000000-0000-4000-8000-000000000111', 1, '09:30')],
    });
    await expect(
      processVitalsRecord(
        servicePool,
        context,
        await startBatch(servicePool, beforeEncounter),
        beforeEncounter,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'MEASUREMENT_PERIOD_INVALID' }],
    });
  });

  it('rejects vitals for void encounters and a second vital set for one encounter', async () => {
    const voided = vitalsRecord({
      localResourceId: 'a1000000-0000-4000-8000-000000000108',
      recordId: '42000000-0000-4000-8000-000000000210',
      localEncounterId: localVoidEncounterId,
      readings: [reading('b1000000-0000-4000-8000-000000000112', 1, null)],
    });
    await expect(
      processVitalsRecord(
        servicePool,
        context,
        await startBatch(servicePool, voided),
        voided,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'ENCOUNTER_VOID' }],
    });

    const conflictEncounterId = '93000000-0000-4000-8000-000000000004';
    const conflictLocalEncounterId = '94000000-0000-4000-8000-000000000004';
    await insertEncounter(
      servicePool,
      conflictEncounterId,
      conflictLocalEncounterId,
      'DRAFT',
    );
    const first = vitalsRecord({
      localResourceId: 'a1000000-0000-4000-8000-000000000109',
      recordId: '42000000-0000-4000-8000-000000000211',
      localEncounterId: conflictLocalEncounterId,
      readings: [reading('b1000000-0000-4000-8000-000000000113', 1, null)],
    });
    await processVitalsRecord(
      servicePool,
      context,
      await startBatch(servicePool, first),
      first,
      now,
    );
    const second = vitalsRecord({
      localResourceId: 'a1000000-0000-4000-8000-000000000110',
      recordId: '42000000-0000-4000-8000-000000000212',
      localEncounterId: conflictLocalEncounterId,
      readings: [reading('b1000000-0000-4000-8000-000000000114', 1, null)],
    });
    await expect(
      processVitalsRecord(
        servicePool,
        context,
        await startBatch(servicePool, second),
        second,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'VITAL_SET_ENCOUNTER_CONFLICT' }],
    });
  });
});

function reading(
  localReadingId: string,
  sequenceNumber: number,
  measurementLocalTime: string | null,
): VitalsReadingPayload {
  return {
    localReadingId,
    sequenceNumber,
    systolic: measurementLocalTime === null ? null : 122,
    diastolic: measurementLocalTime === null ? null : 78,
    pulse: measurementLocalTime === null ? null : 72,
    measurementSite: measurementLocalTime === null ? null : 'RIGHT_ARM',
    patientPosition: measurementLocalTime === null ? null : 'SITTING',
    measurementLocalDate: '2026-08-19',
    measurementLocalTime,
    measurementTimezone: 'Africa/Douala',
    createdAt: '2026-08-19T10:00:00.000Z',
    updatedAt: '2026-08-19T10:00:00.000Z',
  };
}

function vitalsRecord(
  values: Readonly<{
    localResourceId: string;
    recordId: string;
    sourceRevision?: number;
    localEncounterId?: string;
    performedByLocalActorId?: string;
    status?: 'DRAFT' | 'VITALS_COMPLETE';
    weightKg?: number | null;
    waistCm?: number | null;
    readings: readonly VitalsReadingPayload[];
  }>,
): VitalsSyncRecord {
  return {
    recordId: values.recordId,
    resourceType: 'VITALS',
    localResourceId: values.localResourceId,
    sourceRevision: values.sourceRevision ?? 1,
    schemaVersion: 'vitals.v1',
    operation: 'UPSERT',
    capturedAt: '2026-08-19T11:30:00.000Z',
    sourceActorLocalId: mutationActorId,
    payload: {
      localEncounterId: values.localEncounterId ?? localEncounterId,
      performedByLocalActorId:
        values.performedByLocalActorId ?? performerActorId,
      status: values.status ?? 'DRAFT',
      weightKg: values.weightKg ?? null,
      waistCm: values.waistCm ?? null,
      notes: null,
      createdAt: '2026-08-19T10:00:00.000Z',
      updatedAt: '2026-08-19T11:30:00.000Z',
      readings: values.readings,
    },
  };
}

async function startBatch(
  pool: pg.Pool,
  record: VitalsSyncRecord,
): Promise<string> {
  const request: SyncBatchRequest = {
    contractVersion: '1.0',
    batchId: randomUUID(),
    installationId,
    locationId: sourceLocationId,
    installationTimezone: context.timezone,
    desktopApplicationVersion: '0.15.0',
    desktopSchemaVersion: 15,
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
        localActorId: performerActorId,
        displayName: 'Synthetic Screening Nurse',
        role: 'NURSE',
        active: true,
        updatedAt: '2026-08-19T12:00:00.000Z',
      },
      {
        localActorId: otherActorId,
        displayName: 'Synthetic Other Screener',
        role: 'TRAINED_SCREENER',
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
  await pool.query(
    `INSERT INTO organizations (
       id, identifier_system, identifier_value, name, organization_type_code,
       created_at, updated_at
     ) VALUES ($1, 'https://chs.example/id/organization', 'ORG-VITALS-001',
       'Synthetic Vitals Program', 'PROGRAM', $2, $2)`,
    [organizationId, timestamp],
  );
  await pool.query(
    `INSERT INTO locations (
       id, organization_id, identifier_system, identifier_value, name,
       location_type_code, physical_type_code, created_at, updated_at
     ) VALUES ($1, $2, 'https://chs.example/id/location', 'LOC-VITALS-001',
       'Synthetic Vitals Site', 'SCREENING_SITE', 'MOBILE', $3, $3)`,
    [canonicalLocationId, organizationId, timestamp],
  );
  await pool.query(
    `INSERT INTO desktop_installations (
       id, organization_id, configured_location_id, deployment_name, timezone,
       status, enrolled_at, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Synthetic Vitals Desktop', 'Africa/Douala',
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
     ) VALUES ($1, 'Synthetic Vitals Patient', 'synthetic vitals patient',
       'UNKNOWN', 'ACKNOWLEDGED', '1980-01-01', 'ACTIVE', $2, $2)`,
    [personId, timestamp],
  );
  await pool.query(
    `INSERT INTO practitioners (id, display_name, active, created_at, updated_at)
     VALUES ($1, 'Synthetic Screening Nurse', true, $2, $2)`,
    [performerPractitionerId, timestamp],
  );
  await pool.query(
    `INSERT INTO practitioner_source_links (
       id, practitioner_id, installation_id, source_actor_local_id,
       source_display_name, source_role_code, source_active, source_updated_at,
       first_observed_at, last_observed_at
     ) VALUES ($1, $2, $3, $4, 'Synthetic Screening Nurse', 'NURSE', true,
       $5, $5, $5)`,
    [randomUUID(), performerPractitionerId, installationId, performerActorId, timestamp],
  );
  await pool.query(
    `INSERT INTO screening_sessions (
       id, installation_id, organization_id, location_id, protocol_id,
       local_session_id, source_location_id, source_protocol_version_id,
       session_date, status, notes, opened_by_practitioner_id,
       closed_by_practitioner_id, opened_at, closed_at, source_revision,
       source_content_hash, source_created_at, source_updated_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, '2026-08-19', 'OPEN', NULL,
       $9, NULL, '2026-08-19T09:00:00.000Z', NULL, 1, $10,
       '2026-08-19T09:00:00.000Z', '2026-08-19T09:00:00.000Z', $11, $11
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
      performerPractitionerId,
      'b'.repeat(64),
      timestamp,
    ],
  );
  await insertEncounter(pool, canonicalEncounterId, localEncounterId, 'DRAFT');
  await insertEncounter(pool, voidEncounterId, localVoidEncounterId, 'VOID');
}

async function insertEncounter(
  pool: pg.Pool,
  encounterId: string,
  sourceEncounterId: string,
  status: 'DRAFT' | 'VOID',
) {
  const timestamp = now.toISOString();
  await pool.query(
    `INSERT INTO screening_encounters (
       id, person_id, screening_session_id, installation_id, organization_id,
       location_id, protocol_id, local_encounter_id, source_location_id,
       source_protocol_version_id, status, started_at, completed_at,
       recorded_by_practitioner_id, practitioner_role_id, source_type,
       amendment_of_encounter_id, amendment_reason, void_reason,
       source_revision, source_content_hash, source_created_at,
       source_updated_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       '2026-08-19T10:00:00.000Z', NULL, $12, NULL, 'LOCAL', NULL, NULL,
       $13, 1, $14, '2026-08-19T10:00:00.000Z',
       '2026-08-19T10:00:00.000Z', $15, $15
     )`,
    [
      encounterId,
      personId,
      canonicalSessionId,
      installationId,
      organizationId,
      canonicalLocationId,
      canonicalProtocolId,
      sourceEncounterId,
      sourceLocationId,
      sourceProtocolId,
      status,
      performerPractitionerId,
      status === 'VOID' ? 'Synthetic void' : null,
      'c'.repeat(64),
      timestamp,
    ],
  );
}
