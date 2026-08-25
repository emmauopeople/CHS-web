import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import { beginSyncBatch } from '../../src/sync/batch-intake.js';
import { processLifestyleRecord } from '../../src/sync/lifestyle.js';
import type {
  InstallationContext,
  LifestyleSyncRecord,
  SyncBatchRequest,
} from '../../src/sync/types.js';

const connectionString = process.env.DATABASE_TEST_URL;
const runIntegration = connectionString ? describe : describe.skip;
const now = new Date('2026-08-20T16:30:00.000Z');
const organizationId = '12000000-0000-4000-8000-000000000001';
const installationId = '22000000-0000-4000-8000-000000000001';
const sourceLocationId = '32000000-0000-4000-8000-000000000001';
const canonicalLocationId = '33000000-0000-4000-8000-000000000001';
const personId = '53000000-0000-4000-8000-000000000001';
const localPatientId = '52000000-0000-4000-8000-000000000001';
const canonicalProtocolId = '83000000-0000-4000-8000-000000000001';
const sourceProtocolId = '82000000-0000-4000-8000-000000000001';
const canonicalSessionId = '73000000-0000-4000-8000-000000000001';
const localSessionId = '72000000-0000-4000-8000-000000000001';
const canonicalEncounterId = '93000000-0000-4000-8000-000000000001';
const localEncounterId = '92000000-0000-4000-8000-000000000001';
const nurseActorId = '62000000-0000-4000-8000-000000000001';
const administratorActorId = '62000000-0000-4000-8000-000000000002';
const nursePractitionerId = '63000000-0000-4000-8000-000000000001';
const administratorPractitionerId = '63000000-0000-4000-8000-000000000002';
const context: InstallationContext = {
  installationId,
  organizationId,
  configuredLocationId: canonicalLocationId,
  timezone: 'Africa/Douala',
};

runIntegration('Lifestyle processing with PostgreSQL', () => {
  const schema = `chs_lifestyle_${randomUUID().replaceAll('-', '')}`;
  let administrationPool: pg.Pool;
  let servicePool: pg.Pool;
  let fixture: SyncBatchRequest;
  let baseRecord: LifestyleSyncRecord;

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
    fixture = JSON.parse(
      await readFile(
        new URL(
          '../../../../packages/contracts/fixtures/sync/v1/valid/lifestyle-batch-request.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as SyncBatchRequest;
    baseRecord = fixture.records.find(
      (record) => record.resourceType === 'LIFESTYLE',
    ) as LifestyleSyncRecord;
    await seedDependencies(servicePool);
  });

  afterAll(async () => {
    await servicePool.end();
    await administrationPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrationPool.end();
  });

  it('stores the completed aggregate in normalized canonical tables and replays unchanged', async () => {
    const batchInternalId = await startBatch(servicePool, fixture, baseRecord);
    const first = await processLifestyleRecord(
      servicePool,
      context,
      batchInternalId,
      baseRecord,
      now,
    );
    expect(first).toMatchObject({
      resourceType: 'LIFESTYLE',
      status: 'ACCEPTED',
      centralPersonId: null,
      medicalIdStatus: null,
    });

    const stored = await servicePool.query<{
      encounter_id: string;
      person_id: string;
      status: string;
      period_start: string;
      period_end: string;
      created_actor: string;
      updated_actor: string;
      mutation_actor: string;
      tobacco_products: number;
      physical_activities: number;
      other_activities: number;
    }>(
      `SELECT
         lifestyle.encounter_id,
         lifestyle.person_id,
         lifestyle.status,
         lifestyle.period_start::text AS period_start,
         lifestyle.period_end::text AS period_end,
         created_source.source_actor_local_id AS created_actor,
         updated_source.source_actor_local_id AS updated_actor,
         mutation.source_actor_local_id AS mutation_actor,
         (SELECT count(*)::integer FROM lifestyle_tobacco_products
           WHERE lifestyle_assessment_id = lifestyle.id) AS tobacco_products,
         (SELECT count(*)::integer FROM lifestyle_physical_activities
           WHERE lifestyle_assessment_id = lifestyle.id) AS physical_activities,
         (SELECT count(*)::integer FROM lifestyle_other_activities
           WHERE lifestyle_assessment_id = lifestyle.id) AS other_activities
       FROM lifestyle_assessments AS lifestyle
       JOIN practitioner_source_links AS created_source
         ON created_source.practitioner_id = lifestyle.created_by_practitioner_id
        AND created_source.installation_id = lifestyle.installation_id
       JOIN practitioner_source_links AS updated_source
         ON updated_source.practitioner_id = lifestyle.updated_by_practitioner_id
        AND updated_source.installation_id = lifestyle.installation_id
       JOIN sync_records AS sync ON sync.lifestyle_assessment_id = lifestyle.id
       JOIN sync_batch_actors AS mutation ON mutation.id = sync.sync_batch_actor_id
       WHERE lifestyle.id = $1`,
      [first.canonicalResourceId],
    );
    expect(stored.rows[0]).toEqual({
      encounter_id: canonicalEncounterId,
      person_id: personId,
      status: 'COMPLETE',
      period_start: '2026-08-14',
      period_end: '2026-08-20',
      created_actor: administratorActorId,
      updated_actor: nurseActorId,
      mutation_actor: nurseActorId,
      tobacco_products: 2,
      physical_activities: 2,
      other_activities: 1,
    });

    const baselineCounts = await servicePool.query(
      `SELECT
         (SELECT count(*)::integer FROM lifestyle_alcohol_baselines) AS alcohol,
         (SELECT count(*)::integer FROM lifestyle_tobacco_baselines) AS tobacco,
         (SELECT count(*)::integer FROM lifestyle_work_baselines) AS work`,
    );
    expect(baselineCounts.rows[0]).toEqual({ alcohol: 1, tobacco: 1, work: 1 });

    await expect(
      processLifestyleRecord(
        servicePool,
        context,
        batchInternalId,
        baseRecord,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'UNCHANGED',
      canonicalResourceId: first.canonicalResourceId,
    });
  });

  it('reprocesses an identical retry after its completed encounter arrives', async () => {
    const delayedLocalEncounterId = '92000000-0000-4000-8000-000000000099';
    const delayed = reidentifiedRecord(baseRecord, {
      localResourceId: 'e2000000-0000-4000-8000-000000000099',
      recordId: '42000000-0000-4000-8000-000000000099',
      localEncounterId: delayedLocalEncounterId,
      idSuffix: '99',
    });
    const batchInternalId = await startBatch(servicePool, fixture, delayed);

    await expect(
      processLifestyleRecord(
        servicePool,
        context,
        batchInternalId,
        delayed,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'RETRY',
      errors: [{ code: 'DEPENDENCY_NOT_AVAILABLE', retryable: true }],
    });

    await insertCompletedEncounter(
      servicePool,
      '93000000-0000-4000-8000-000000000099',
      delayedLocalEncounterId,
    );
    await expect(
      processLifestyleRecord(
        servicePool,
        context,
        batchInternalId,
        delayed,
        now,
      ),
    ).resolves.toMatchObject({ status: 'ACCEPTED' });

    const stored = await servicePool.query(
      `SELECT count(*)::integer AS count, min(status) AS status
       FROM sync_records
       WHERE installation_id = $1 AND record_id = $2`,
      [installationId, delayed.recordId],
    );
    expect(stored.rows[0]).toEqual({ count: 1, status: 'ACCEPTED' });
  });

  it('rejects changed immutable baselines and changed completed Lifestyle snapshots', async () => {
    const changedTerminal: LifestyleSyncRecord = {
      ...baseRecord,
      recordId: '42000000-0000-4000-8000-000000000201',
      sourceRevision: baseRecord.sourceRevision + 1,
      payload: {
        ...baseRecord.payload,
        alcohol: {
          ...baseRecord.payload.alcohol,
          totalStandardizedDrinks: 4,
        },
      },
    };
    await expect(
      processLifestyleRecord(
        servicePool,
        context,
        await startBatch(servicePool, fixture, changedTerminal),
        changedTerminal,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'LIFESTYLE_TERMINAL_CONFLICT', path: '/payload' }],
    });

    const conflictLocalEncounterId = '92000000-0000-4000-8000-000000000098';
    await insertCompletedEncounter(
      servicePool,
      '93000000-0000-4000-8000-000000000098',
      conflictLocalEncounterId,
    );
    const changedBaselineBase = reidentifiedRecord(baseRecord, {
      localResourceId: 'e2000000-0000-4000-8000-000000000098',
      recordId: '42000000-0000-4000-8000-000000000202',
      localEncounterId: conflictLocalEncounterId,
      idSuffix: '98',
    });
    const changedBaseline: LifestyleSyncRecord = {
      ...changedBaselineBase,
      payload: {
        ...changedBaselineBase.payload,
        baselines: {
          ...changedBaselineBase.payload.baselines,
          alcohol: {
            ...changedBaselineBase.payload.baselines.alcohol,
            status: 'FORMER',
          },
        },
      },
    };
    await expect(
      processLifestyleRecord(
        servicePool,
        context,
        await startBatch(servicePool, fixture, changedBaseline),
        changedBaseline,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'BASELINE_IDENTITY_CONFLICT' }],
    });
  });

  it('rejects noncanonical encounter state and a period not ending on the session date', async () => {
    const draftLocalEncounterId = '92000000-0000-4000-8000-000000000097';
    await insertEncounter(
      servicePool,
      '93000000-0000-4000-8000-000000000097',
      draftLocalEncounterId,
      'DRAFT',
    );
    const draftEncounter = reidentifiedRecord(baseRecord, {
      localResourceId: 'e2000000-0000-4000-8000-000000000097',
      recordId: '42000000-0000-4000-8000-000000000203',
      localEncounterId: draftLocalEncounterId,
      idSuffix: '97',
    });
    await expect(
      processLifestyleRecord(
        servicePool,
        context,
        await startBatch(servicePool, fixture, draftEncounter),
        draftEncounter,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'LIFESTYLE_ENCOUNTER_STATE_INVALID' }],
    });

    const wrongPeriod = reidentifiedRecord(baseRecord, {
      localResourceId: 'e2000000-0000-4000-8000-000000000096',
      recordId: '42000000-0000-4000-8000-000000000204',
      localEncounterId: '92000000-0000-4000-8000-000000000096',
      idSuffix: '96',
    });
    await insertCompletedEncounter(
      servicePool,
      '93000000-0000-4000-8000-000000000096',
      wrongPeriod.payload.localEncounterId,
    );
    const invalidPeriod: LifestyleSyncRecord = {
      ...wrongPeriod,
      payload: {
        ...wrongPeriod.payload,
        periodStart: '2026-08-13',
        periodEnd: '2026-08-19',
      },
    };
    await expect(
      processLifestyleRecord(
        servicePool,
        context,
        await startBatch(servicePool, fixture, invalidPeriod),
        invalidPeriod,
        now,
      ),
    ).resolves.toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'LIFESTYLE_PERIOD_INVALID', path: '/payload/periodEnd' }],
    });
  });
});

async function startBatch(
  pool: pg.Pool,
  fixture: SyncBatchRequest,
  record: LifestyleSyncRecord,
): Promise<string> {
  const request: SyncBatchRequest = {
    ...fixture,
    batchId: randomUUID(),
    records: [record],
  };
  const intake = await beginSyncBatch(pool, context, request, now);
  if (intake.kind !== 'NEW') throw new Error('Expected a new synthetic batch');
  return intake.batchInternalId;
}

function reidentifiedRecord(
  record: LifestyleSyncRecord,
  values: Readonly<{
    localResourceId: string;
    recordId: string;
    localEncounterId: string;
    idSuffix: string;
  }>,
): LifestyleSyncRecord {
  const uuid = (prefix: string) =>
    `${prefix}000000-0000-4000-8000-0000000000${values.idSuffix}`;
  return {
    ...structuredClone(record),
    recordId: values.recordId,
    localResourceId: values.localResourceId,
    payload: {
      ...structuredClone(record.payload),
      localEncounterId: values.localEncounterId,
      alcohol: {
        ...record.payload.alcohol,
        localWeeklyRecordId: uuid('a6'),
      },
      tobacco: {
        ...record.payload.tobacco,
        localWeeklyRecordId: uuid('a7'),
        products: record.payload.tobacco.products.map((product, index) => ({
          ...product,
          localProductRowId: uuid(index === 0 ? 'a8' : 'a9'),
        })),
      },
      physicalActivity: {
        ...record.payload.physicalActivity,
        localWeeklyRecordId: uuid('aa'),
        activities: record.payload.physicalActivity.activities.map((activity, index) => ({
          ...activity,
          localActivityRowId: uuid(index === 0 ? 'ab' : 'ac'),
        })),
      },
      work: {
        ...record.payload.work,
        localWeeklyRecordId: uuid('ad'),
      },
      otherActivity: {
        ...record.payload.otherActivity,
        activities: record.payload.otherActivity.activities.map((activity) => ({
          ...activity,
          localActivityRowId: uuid('ae'),
        })),
      },
    },
  };
}

async function seedDependencies(pool: pg.Pool) {
  const timestamp = now.toISOString();
  await pool.query(
    `INSERT INTO organizations (
       id, identifier_system, identifier_value, name, organization_type_code,
       created_at, updated_at
     ) VALUES ($1, 'https://chs.example/id/organization', 'ORG-LIFESTYLE-001',
       'Synthetic Lifestyle Program', 'PROGRAM', $2, $2)`,
    [organizationId, timestamp],
  );
  await pool.query(
    `INSERT INTO locations (
       id, organization_id, identifier_system, identifier_value, name,
       location_type_code, physical_type_code, created_at, updated_at
     ) VALUES ($1, $2, 'https://chs.example/id/location', 'LOC-LIFESTYLE-001',
       'Synthetic Lifestyle Site', 'SCREENING_SITE', 'MOBILE', $3, $3)`,
    [canonicalLocationId, organizationId, timestamp],
  );
  await pool.query(
    `INSERT INTO desktop_installations (
       id, organization_id, configured_location_id, deployment_name, timezone,
       status, enrolled_at, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Synthetic Lifestyle Desktop', 'Africa/Douala',
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

  for (const [id, actorId, displayName, role] of [
    [nursePractitionerId, nurseActorId, 'Synthetic Nurse', 'NURSE'],
    [
      administratorPractitionerId,
      administratorActorId,
      'Synthetic Local Administrator',
      'LOCAL_ADMIN',
    ],
  ]) {
    await pool.query(
      `INSERT INTO practitioners (id, display_name, active, created_at, updated_at)
       VALUES ($1, $2, true, $3, $3)`,
      [id, displayName, timestamp],
    );
    await pool.query(
      `INSERT INTO practitioner_source_links (
         id, practitioner_id, installation_id, source_actor_local_id,
         source_display_name, source_role_code, source_active, source_updated_at,
         first_observed_at, last_observed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, true, $7, $7, $7)`,
      [randomUUID(), id, installationId, actorId, displayName, role, timestamp],
    );
  }

  await pool.query(
    `INSERT INTO persons (
       id, display_name, name_normalized, sex, acknowledgment_status,
       date_of_birth, status, created_at, updated_at
     ) VALUES ($1, 'Synthetic Lifestyle Patient', 'synthetic lifestyle patient',
       'FEMALE', 'ACKNOWLEDGED', '1985-04-12', 'ACTIVE', $2, $2)`,
    [personId, timestamp],
  );
  await pool.query(
    `INSERT INTO patient_source_links (
       id, person_id, installation_id, local_patient_id, local_patient_code,
       last_source_revision, last_content_hash, source_created_at,
       source_updated_at, first_observed_at, last_observed_at
     ) VALUES ($1, $2, $3, $4, 'PT-000051', 3, $5, $6, $6, $6, $6)`,
    [randomUUID(), personId, installationId, localPatientId, 'a'.repeat(64), timestamp],
  );
  await pool.query(
    `INSERT INTO screening_protocols (
       id, organization_id, protocol_key, version_label, checksum, status,
       effective_at, created_at, updated_at
     ) VALUES ($1, $2, 'community-screening', '2026.1', $3, 'ACTIVE', $4, $4, $4)`,
    [canonicalProtocolId, organizationId, `sha256:${'b'.repeat(64)}`, timestamp],
  );
  await pool.query(
    `INSERT INTO protocol_source_links (
       id, protocol_id, installation_id, organization_id,
       local_protocol_version_id, first_observed_at, last_observed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [randomUUID(), canonicalProtocolId, installationId, organizationId, sourceProtocolId, timestamp],
  );
  await pool.query(
    `INSERT INTO screening_sessions (
       id, installation_id, organization_id, location_id, protocol_id,
       local_session_id, source_location_id, source_protocol_version_id,
       session_date, status, notes, opened_by_practitioner_id,
       closed_by_practitioner_id, opened_at, closed_at, source_revision,
       source_content_hash, source_created_at, source_updated_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, '2026-08-20', 'OPEN', NULL,
       $9, NULL, '2026-08-20T14:15:00.000Z', NULL, 1, $10,
       '2026-08-20T14:15:00.000Z', '2026-08-20T14:15:00.000Z', $11, $11
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
      nursePractitionerId,
      'c'.repeat(64),
      timestamp,
    ],
  );
  await insertCompletedEncounter(pool, canonicalEncounterId, localEncounterId);
}

function insertCompletedEncounter(
  pool: pg.Pool,
  encounterId: string,
  sourceEncounterId: string,
) {
  return insertEncounter(pool, encounterId, sourceEncounterId, 'COMPLETED');
}

async function insertEncounter(
  pool: pg.Pool,
  encounterId: string,
  sourceEncounterId: string,
  status: 'DRAFT' | 'COMPLETED',
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
       '2026-08-20T14:20:00.000Z', $12, $13, NULL, 'LOCAL', NULL, NULL,
       NULL, 2, $14, '2026-08-20T14:20:00.000Z',
       '2026-08-20T15:40:00.000Z', $15, $15
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
      status === 'COMPLETED' ? '2026-08-20T15:40:00.000Z' : null,
      nursePractitionerId,
      'd'.repeat(64),
      timestamp,
    ],
  );
}
