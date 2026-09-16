import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import { beginSyncBatch } from '../../src/sync/batch-intake.js';
import { processReferralRecord } from '../../src/sync/referrals.js';
import { submitSyncBatch } from '../../src/sync/batch-orchestrator.js';
import type {
  InstallationContext,
  ReferralRecord,
  SyncBatchRequest,
} from '../../src/sync/types.js';
const connectionString = process.env.DATABASE_TEST_URL;
const runIntegration = connectionString ? describe : describe.skip;
const now = new Date('2026-08-27T11:00:00.000Z');
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

runIntegration('Referral PostgreSQL ingestion', () => {
  const schema = `chs_referral_${randomUUID().replaceAll('-', '')}`;
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
          '../../../../packages/contracts/fixtures/sync/v1/valid/referral-batch-request.json',
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

  const fresh = () => {
    const records = structuredClone(fixture.records) as ReferralRecord[];
    const parent = randomUUID();
    return records.map((r) => ({
      ...r,
      recordId: randomUUID(),
      localResourceId: r.resourceType === 'REFERRAL' ? parent : randomUUID(),
      payload:
        r.resourceType === 'REFERRAL'
          ? r.payload
          : { ...r.payload, localReferralId: parent },
    })) as ReferralRecord[];
  };
  const begin = async (records: readonly ReferralRecord[]) => {
    const request = { ...fixture, batchId: randomUUID(), records };
    const batch = await beginSyncBatch(pool, context, request, now);
    if (batch.kind !== 'NEW') throw new Error('Expected new batch');
    return batch.batchInternalId;
  };
  it('persists normalized referrals, late follow-ups and medication rows with exact batch replay', async () => {
    const records = fresh();
    const request = {
      ...fixture,
      batchId: randomUUID(),
      records: [...records].reverse(),
    };
    const first = await submitSyncBatch(pool, context, request, {
      clock: () => now,
    });
    expect(first.response.outcomes.map((o) => o.status)).toEqual([
      'ACCEPTED',
      'ACCEPTED',
      'ACCEPTED',
    ]);
    const replay = await submitSyncBatch(pool, context, request, {
      clock: () => now,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.response).toEqual(first.response);
    const followupOutcome = first.response.outcomes.find(
      (outcome) => outcome.resourceType === 'REFERRAL_FOLLOWUP',
    )!;
    const row = (
      await pool.query(
        `SELECT f.contact_date::text,f.recorded_at,f.recorded_by_practitioner_id,m.medication_name,m.dosage,m.frequency
      FROM referral_followups f JOIN referral_medication_changes m ON m.followup_id=f.id WHERE f.id=$1`,
        [followupOutcome.canonicalResourceId],
      )
    ).rows[0];
    expect(row).toEqual({
      contact_date: '2026-08-26',
      recorded_at: new Date('2026-08-27T10:30:00.000Z'),
      recorded_by_practitioner_id: nursePractitionerId,
      medication_name: 'Reported medicine',
      dosage: null,
      frequency: null,
    });
    const counts = (
      await pool.query('SELECT count(*)::int AS n FROM referral_resources')
    ).rows[0];
    expect(counts.n).toBe(3);
  });
  it('accepts newer referral state, preserves prior event authors, and rejects stale/closed regression', async () => {
    const [parent, event] = fresh();
    const batch = await begin([parent!, event!]);
    const first = await processReferralRecord(
      pool,
      context,
      batch,
      parent!,
      now,
    );
    expect(first.status).toBe('ACCEPTED');
    expect(
      (await processReferralRecord(pool, context, batch, event!, now)).status,
    ).toBe('ACCEPTED');
    if (parent!.resourceType !== 'REFERRAL') throw new Error('fixture');
    const changed: ReferralRecord = {
      ...parent!,
      recordId: randomUUID(),
      sourceRevision: 2,
      capturedAt: now.toISOString(),
      sourceActorLocalId: administratorActorId,
      payload: {
        ...parent!.payload,
        status: 'CLOSED',
        updatedAt: now.toISOString(),
        updatedByLocalActorId: administratorActorId,
        closedAt: now.toISOString(),
        closedByLocalActorId: administratorActorId,
        closureReason: 'Follow-up complete',
      },
    };
    expect(
      (
        await processReferralRecord(
          pool,
          context,
          await begin([changed]),
          changed,
          now,
        )
      ).status,
    ).toBe('ACCEPTED');
    const close: ReferralRecord = {
      ...event!,
      recordId: randomUUID(),
      localResourceId: randomUUID(),
      resourceType: 'REFERRAL_STATUS',
      sourceActorLocalId: administratorActorId,
      capturedAt: now.toISOString(),
      payload: {
        localReferralId: parent!.localResourceId,
        sequenceNumber: 2,
        fromStatus: 'OPEN',
        toStatus: 'CLOSED',
        changeReason: 'Follow-up complete',
        changedByLocalActorId: administratorActorId,
        changedAt: now.toISOString(),
      },
    };
    expect(
      (
        await processReferralRecord(
          pool,
          context,
          await begin([close]),
          close,
          now,
        )
      ).status,
    ).toBe('ACCEPTED');
    const authors = await pool.query(
      'SELECT changed_by_practitioner_id FROM referral_status_events WHERE referral_id=$1 ORDER BY sequence_number',
      [first.canonicalResourceId],
    );
    expect(authors.rows.map((r) => r.changed_by_practitioner_id)).toEqual([
      nursePractitionerId,
      administratorPractitionerId,
    ]);
    const regression: ReferralRecord = {
      ...changed,
      recordId: randomUUID(),
      sourceRevision: 3,
      payload: {
        ...changed.payload,
        status: 'SEEN',
        closedAt: null,
        closedByLocalActorId: null,
        closureReason: null,
      },
    };
    expect(
      await processReferralRecord(
        pool,
        context,
        await begin([regression]),
        regression,
        now,
      ),
    ).toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'REFERRAL_STATE_REGRESSION' }],
    });
  });
  it('retries a child delivered before its parent and processes it once when the dependency arrives', async () => {
    const [parent, , followup] = fresh();
    const batch = await begin([parent!, followup!]);
    expect(
      (await processReferralRecord(pool, context, batch, followup!, now))
        .status,
    ).toBe('RETRY');
    expect(
      (await processReferralRecord(pool, context, batch, parent!, now)).status,
    ).toBe('ACCEPTED');
    const accepted = await processReferralRecord(
      pool,
      context,
      batch,
      followup!,
      now,
    );
    expect(accepted.status).toBe('ACCEPTED');
    expect(
      await processReferralRecord(pool, context, batch, followup!, now),
    ).toEqual({ ...accepted, status: 'UNCHANGED' });
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM sync_records WHERE record_id=$1',
          [followup!.recordId],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it('rejects changed delivery content and makes clinical history immutable in PostgreSQL', async () => {
    const [parent, event, followup] = fresh();
    const batch = await begin([parent!, event!, followup!]);
    await processReferralRecord(pool, context, batch, parent!, now);
    await processReferralRecord(pool, context, batch, event!, now);
    const accepted = await processReferralRecord(
      pool,
      context,
      batch,
      followup!,
      now,
    );
    if (followup!.resourceType !== 'REFERRAL_FOLLOWUP')
      throw new Error('fixture');
    const changed = {
      ...followup!,
      payload: { ...followup!.payload, reportedOutcome: 'Altered' },
    };
    expect(
      await processReferralRecord(pool, context, batch, changed, now),
    ).toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'RECORD_PAYLOAD_MISMATCH' }],
    });
    await expect(
      pool.query(
        'UPDATE referral_followups SET reported_outcome=$1 WHERE id=$2',
        ['Altered', accepted.canonicalResourceId],
      ),
    ).rejects.toThrow('immutable');
    await expect(
      pool.query(
        'DELETE FROM referral_medication_changes WHERE followup_id=$1',
        [accepted.canonicalResourceId],
      ),
    ).rejects.toThrow('immutable');
  });
  it('rolls back the resource, children and outcome when a child write fails', async () => {
    const [parent, , followup] = fresh();
    const batch = await begin([parent!, followup!]);
    await processReferralRecord(pool, context, batch, parent!, now);
    await pool.query(`CREATE FUNCTION reject_test_medication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test child failure'; END; $$;
      CREATE TRIGGER tr_test_medication BEFORE INSERT ON referral_medication_changes FOR EACH ROW EXECUTE FUNCTION reject_test_medication()`);
    try {
      await expect(
        processReferralRecord(pool, context, batch, followup!, now),
      ).rejects.toThrow('test child failure');
      expect(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM referral_resources WHERE local_resource_id=$1',
            [followup!.localResourceId],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM sync_records WHERE record_id=$1',
            [followup!.recordId],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await pool.query(
        'DROP TRIGGER tr_test_medication ON referral_medication_changes; DROP FUNCTION reject_test_medication()',
      );
    }
    expect(
      (await processReferralRecord(pool, context, batch, followup!, now))
        .status,
    ).toBe('ACCEPTED');
  });
  it('rejects a foreign installation, unknown actors and a mismatched source protocol', async () => {
    const [parent] = fresh();
    const batch = await begin([parent!]);
    await expect(
      processReferralRecord(
        pool,
        { ...context, installationId: randomUUID() },
        batch,
        parent!,
        now,
      ),
    ).rejects.toThrow('BATCH_NOT_AVAILABLE');
    await expect(
      processReferralRecord(
        pool,
        context,
        batch,
        { ...parent!, sourceActorLocalId: randomUUID() },
        now,
      ),
    ).rejects.toThrow('SOURCE_ACTOR_NOT_AVAILABLE');
    if (parent!.resourceType !== 'REFERRAL') throw new Error('fixture');
    const mismatch = {
      ...parent!,
      payload: { ...parent!.payload, localProtocolVersionId: randomUUID() },
    };
    expect(
      await processReferralRecord(pool, context, batch, mismatch, now),
    ).toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'REFERRAL_CONTEXT_MISMATCH' }],
    });
  });
  it('retains historical referral records after an encounter is voided', async () => {
    const local = randomUUID();
    await insertCompletedEncounter(pool, randomUUID(), local);
    await pool.query(
      "UPDATE screening_encounters SET status='VOID',void_reason='Synthetic correction' WHERE local_encounter_id=$1",
      [local],
    );
    const [parent] = fresh();
    if (parent!.resourceType !== 'REFERRAL') throw new Error('fixture');
    const record = {
      ...parent!,
      payload: { ...parent!.payload, localEncounterId: local },
    };
    expect(
      (
        await processReferralRecord(
          pool,
          context,
          await begin([record]),
          record,
          now,
        )
      ).status,
    ).toBe('ACCEPTED');
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
