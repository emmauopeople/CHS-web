import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import { beginSyncBatch } from '../../src/sync/batch-intake.js';
import { processReportedIntakeRecord } from '../../src/sync/reported-intake.js';
import { submitSyncBatch } from '../../src/sync/batch-orchestrator.js';
import type {
  InstallationContext,
  ReportedIntakeRecord,
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

runIntegration('Food/OTC PostgreSQL ingestion', () => {
  const schema = `chs_reported_intake_${randomUUID().replaceAll('-', '')}`;
  let administrationPool: pg.Pool;
  let pool: pg.Pool;
  let fixture: SyncBatchRequest;
  beforeAll(async () => {
    administrationPool = new pg.Pool({ connectionString });
    const client = await administrationPool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await migrateWithClient({ client, logger: { info() {} } });
    } finally {
      client.release();
    }
    pool = new pg.Pool({
      connectionString,
      options: `-c search_path=${schema}`,
    });
    fixture = JSON.parse(
      await readFile(
        new URL(
          '../../../../packages/contracts/fixtures/sync/v1/valid/food-otc-batch-request.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as SyncBatchRequest;
    await seedDependencies(pool);
  });
  afterAll(async () => {
    await pool?.end();
    await administrationPool?.query(
      `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
    );
    await administrationPool?.end();
  });
  const begin = async (record: ReportedIntakeRecord) => {
    const intake = await beginSyncBatch(
      pool,
      context,
      { ...fixture, batchId: randomUUID(), records: [record] },
      now,
    );
    if (intake.kind !== 'NEW') throw new Error('Expected new batch');
    return intake.batchInternalId;
  };
  const fresh = (
    type: 'FOOD' | 'OTC',
    encounter = localEncounterId,
  ): ReportedIntakeRecord => {
    const record = structuredClone(
      fixture.records.find((row) => row.resourceType === type),
    ) as ReportedIntakeRecord;
    return {
      ...record,
      recordId: randomUUID(),
      localResourceId: encounter,
      payload: { ...record.payload, localEncounterId: encounter },
    };
  };
  it('persists normalized rows with exact optional values and returns identical batch replay', async () => {
    const request = { ...fixture, batchId: randomUUID() };
    const first = await submitSyncBatch(pool, context, request, {
      clock: () => now,
    });
    expect(first.response.outcomes.map((row) => row.status)).toEqual([
      'ACCEPTED',
      'ACCEPTED',
    ]);
    await expect(
      pool.query(`UPDATE sync_records
      SET reported_intake_assessment_id = (
        SELECT id FROM reported_intake_assessments WHERE resource_type = 'OTC'
      ) WHERE resource_type = 'FOOD'`),
    ).rejects.toMatchObject({ code: '23503' });
    const replay = await submitSyncBatch(pool, context, request, {
      clock: () => now,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.response).toEqual(first.response);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM reported_intake_assessments',
        )
      ).rows[0].n,
    ).toBe(2);
    expect(
      (
        await pool.query(
          'SELECT food_name, frequency_code, preparation_note FROM reported_food_rows',
        )
      ).rows,
    ).toEqual([
      { food_name: 'Beans', frequency_code: null, preparation_note: null },
    ]);
    expect(
      (
        await pool.query(
          'SELECT product_name, reason_for_use, dose_text, currently_taking FROM reported_otc_rows',
        )
      ).rows,
    ).toEqual([
      {
        product_name: 'Synthetic product',
        reason_for_use: 'Patient-reported reason',
        dose_text: 'Reported dose',
        currently_taking: null,
      },
    ]);
  });
  it('rejects changed payloads under the same revision and never modifies finalized rows', async () => {
    const record = fresh('FOOD');
    const changed = {
      ...record,
      payload: { ...record.payload, periodStart: '2026-08-13' },
    };
    expect(
      await processReportedIntakeRecord(
        pool,
        context,
        await begin(changed),
        changed,
        now,
      ),
    ).toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'RECORD_PAYLOAD_MISMATCH' }],
    });
    await expect(
      pool.query("UPDATE reported_food_rows SET food_name = 'Changed'"),
    ).rejects.toThrow('immutable');
    await expect(pool.query('DELETE FROM reported_otc_rows')).rejects.toThrow(
      'immutable',
    );
  });
  it('retries missing encounter dependencies then succeeds without duplicate outcome rows', async () => {
    const local = randomUUID();
    const record = fresh('FOOD', local);
    const batch = await begin(record);
    expect(
      await processReportedIntakeRecord(pool, context, batch, record, now),
    ).toMatchObject({ status: 'RETRY' });
    await insertCompletedEncounter(pool, randomUUID(), local);
    expect(
      await processReportedIntakeRecord(pool, context, batch, record, now),
    ).toMatchObject({ status: 'ACCEPTED' });
    expect(
      await processReportedIntakeRecord(pool, context, batch, record, now),
    ).toMatchObject({ status: 'UNCHANGED' });
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM sync_records WHERE record_id = $1',
          [record.recordId],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it('keeps draft encounters retryable and rejects incorrect completion attribution', async () => {
    const local = randomUUID();
    await insertEncounter(pool, randomUUID(), local, 'DRAFT');
    const record = fresh('OTC', local);
    expect(
      await processReportedIntakeRecord(
        pool,
        context,
        await begin(record),
        record,
        now,
      ),
    ).toMatchObject({ status: 'RETRY' });
    const other = randomUUID();
    await insertCompletedEncounter(pool, randomUUID(), other);
    const wrong = fresh('OTC', other);
    const changed = {
      ...wrong,
      capturedAt: '2026-08-20T15:41:00.000Z',
      payload: { ...wrong.payload, completedAt: '2026-08-20T15:41:00.000Z' },
    };
    expect(
      await processReportedIntakeRecord(
        pool,
        context,
        await begin(changed),
        changed,
        now,
      ),
    ).toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'REPORTED_PROVENANCE_MISMATCH' }],
    });
  });
  it('rolls back the entire aggregate and outcome if any child insertion fails', async () => {
    const local = randomUUID();
    await insertCompletedEncounter(pool, randomUUID(), local);
    const base = fresh('FOOD', local);
    const record = {
      ...base,
      payload: {
        ...base.payload,
        rows: [base.payload.rows[0]!, base.payload.rows[0]!],
      },
    };
    const batch = await begin(record);
    await expect(
      processReportedIntakeRecord(pool, context, batch, record, now),
    ).rejects.toThrow();
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM reported_intake_assessments WHERE local_encounter_id = $1',
          [local],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM sync_records WHERE record_id = $1',
          [record.recordId],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it('rejects a batch requested through another installation context', async () => {
    const record = fresh('FOOD', randomUUID());
    const batch = await begin(record);
    await expect(
      processReportedIntakeRecord(
        pool,
        { ...context, installationId: randomUUID() },
        batch,
        record,
        now,
      ),
    ).rejects.toThrow('BATCH_NOT_AVAILABLE');
  });
});
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
    [
      randomUUID(),
      canonicalLocationId,
      installationId,
      organizationId,
      sourceLocationId,
      timestamp,
    ],
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
    [
      randomUUID(),
      personId,
      installationId,
      localPatientId,
      'a'.repeat(64),
      timestamp,
    ],
  );
  await pool.query(
    `INSERT INTO screening_protocols (
       id, organization_id, protocol_key, version_label, checksum, status,
       effective_at, created_at, updated_at
     ) VALUES ($1, $2, 'community-screening', '2026.1', $3, 'ACTIVE', $4, $4, $4)`,
    [
      canonicalProtocolId,
      organizationId,
      `sha256:${'b'.repeat(64)}`,
      timestamp,
    ],
  );
  await pool.query(
    `INSERT INTO protocol_source_links (
       id, protocol_id, installation_id, organization_id,
       local_protocol_version_id, first_observed_at, last_observed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [
      randomUUID(),
      canonicalProtocolId,
      installationId,
      organizationId,
      sourceProtocolId,
      timestamp,
    ],
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
