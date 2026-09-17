import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import { beginSyncBatch } from '../../src/sync/batch-intake.js';
import { processEncounterHistoryRecord } from '../../src/sync/encounter-history.js';
import { submitSyncBatch } from '../../src/sync/batch-orchestrator.js';
import type {
  InstallationContext,
  EncounterHistoryRecord,
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

runIntegration('Encounter history PostgreSQL ingestion', () => {
  const schema = `chs_encounter_history_${randomUUID().replaceAll('-', '')}`;
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
          '../../../../packages/contracts/fixtures/sync/v1/valid/encounter-history-batch-request.json',
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
    const records = structuredClone(
      fixture.records,
    ) as EncounterHistoryRecord[];
    const flag = randomUUID();
    return records.map((r) => ({
      ...r,
      recordId: randomUUID(),
      localResourceId:
        r.resourceType === 'ENCOUNTER_REVIEW_FLAG' ? flag : randomUUID(),
      payload:
        r.resourceType === 'ENCOUNTER_REVIEW_STATUS'
          ? { ...r.payload, localFlagId: flag }
          : r.payload,
    })) as EncounterHistoryRecord[];
  };
  const begin = async (records: readonly EncounterHistoryRecord[]) => {
    const batch = await beginSyncBatch(
      pool,
      context,
      { ...fixture, batchId: randomUUID(), records },
      now,
    );
    if (batch.kind !== 'NEW') throw new Error('Expected new batch');
    return batch.batchInternalId;
  };
  const send = async (records: readonly EncounterHistoryRecord[]) => {
    const batch = await begin(records);
    const outcomes = [];
    for (const r of records)
      outcomes.push(
        await processEncounterHistoryRecord(pool, context, batch, r, now),
      );
    return outcomes;
  };
  it('persists original authors and late dates, orders dependencies and replays an exact batch without duplicates', async () => {
    const records = fresh();
    // Force the closing event to sort before the opening event.
    records[2] = {
      ...records[2]!,
      localResourceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    };
    records[3] = {
      ...records[3]!,
      localResourceId: '00000000-0000-4000-8000-000000000001',
    };
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
      'ACCEPTED',
    ]);
    expect(
      await submitSyncBatch(pool, context, request, { clock: () => now }),
    ).toEqual({ ...first, replayed: true });
    const flag = first.response.outcomes.find(
      (o) => o.resourceType === 'ENCOUNTER_REVIEW_FLAG',
    )!.canonicalResourceId;
    const events = await pool.query(
      'SELECT sequence_number,from_status,to_status,changed_by_practitioner_id,changed_at FROM encounter_review_status_events WHERE flag_id=$1 ORDER BY sequence_number',
      [flag],
    );
    expect(events.rows).toEqual([
      {
        sequence_number: 1,
        from_status: null,
        to_status: 'OPEN',
        changed_by_practitioner_id: nursePractitionerId,
        changed_at: new Date('2026-08-21T10:00:00.000Z'),
      },
      {
        sequence_number: 2,
        from_status: 'OPEN',
        to_status: 'RESOLVED',
        changed_by_practitioner_id: administratorPractitionerId,
        changed_at: new Date('2026-08-27T10:30:00.000Z'),
      },
    ]);
    const note = first.response.outcomes.find(
      (o) => o.resourceType === 'ENCOUNTER_ADDENDUM',
    )!.canonicalResourceId;
    expect(
      (
        await pool.query(
          'SELECT encounter_id,note_text,created_by_practitioner_id,created_at FROM encounter_addenda WHERE id=$1',
          [note],
        )
      ).rows[0],
    ).toEqual({
      encounter_id: canonicalEncounterId,
      note_text: 'Synthetic late clarification',
      created_by_practitioner_id: nursePractitionerId,
      created_at: new Date('2026-08-21T10:00:00.000Z'),
    });
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM encounter_history_resources',
        )
      ).rows[0].n,
    ).toBe(4);
  });
  it('retries a late closure until its flag and opening arrive across batches', async () => {
    const [, flag, open, close] = fresh();
    expect((await send([close!]))[0]).toMatchObject({
      status: 'RETRY',
      errors: [{ code: 'DEPENDENCY_NOT_AVAILABLE' }],
    });
    expect((await send([flag!, close!])).map((o) => o.status)).toEqual([
      'ACCEPTED',
      'RETRY',
    ]);
    expect((await send([open!, close!])).map((o) => o.status)).toEqual([
      'ACCEPTED',
      'ACCEPTED',
    ]);
    expect((await send([close!]))[0]!.status).toBe('UNCHANGED');
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM sync_records WHERE record_id=$1',
          [close!.recordId],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it('keeps closure and reopening as distinct events and rejects forks or reversed time', async () => {
    const [, flag, open, close] = fresh();
    const accepted = await send([flag!, open!, close!]);
    if (close!.resourceType !== 'ENCOUNTER_REVIEW_STATUS')
      throw new Error('fixture');
    const reopen: EncounterHistoryRecord = {
      ...close!,
      recordId: randomUUID(),
      localResourceId: randomUUID(),
      payload: {
        ...close!.payload,
        sequenceNumber: 3,
        fromStatus: 'RESOLVED',
        toStatus: 'OPEN',
        changeReason: 'Further review requested',
      },
    };
    expect((await send([reopen]))[0]!.status).toBe('ACCEPTED');
    const dismiss: EncounterHistoryRecord = {
      ...reopen,
      recordId: randomUUID(),
      localResourceId: randomUUID(),
      payload: {
        ...reopen.payload,
        sequenceNumber: 4,
        fromStatus: 'OPEN',
        toStatus: 'DISMISSED',
        changeReason: 'Review completed',
      },
    };
    expect((await send([dismiss]))[0]!.status).toBe('ACCEPTED');
    expect(
      (
        await send([
          { ...dismiss, recordId: randomUUID(), localResourceId: randomUUID() },
        ])
      )[0],
    ).toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'REVIEW_SEQUENCE_CONFLICT' }],
    });
    const earlier = '2026-08-27T10:29:00.000Z';
    expect(
      (
        await send([
          {
            ...reopen,
            recordId: randomUUID(),
            localResourceId: randomUUID(),
            capturedAt: earlier,
            payload: {
              ...reopen.payload,
              sequenceNumber: 5,
              fromStatus: 'DISMISSED',
              changedAt: earlier,
            },
          },
        ])
      )[0],
    ).toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'REVIEW_HISTORY_ORDER_INVALID' }],
    });
    expect(
      (
        await pool.query(
          'SELECT to_status FROM encounter_review_status_events WHERE flag_id=$1 ORDER BY sequence_number',
          [accepted[0]!.canonicalResourceId],
        )
      ).rows.map((r) => r.to_status),
    ).toEqual(['OPEN', 'RESOLVED', 'OPEN', 'DISMISSED']);
  });
  it('rejects altered immutable deliveries, revisions and direct database edits', async () => {
    const records = fresh();
    const outcomes = await send(records);
    const note = records[0]!;
    if (note.resourceType !== 'ENCOUNTER_ADDENDUM') throw new Error('fixture');
    expect(
      (
        await send([
          { ...note, payload: { ...note.payload, noteText: 'Rewritten' } },
        ])
      )[0],
    ).toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'RECORD_PAYLOAD_MISMATCH' }],
    });
    const revision = { ...note, recordId: randomUUID(), sourceRevision: 2 };
    const batch = await begin([note]);
    expect(
      await processEncounterHistoryRecord(pool, context, batch, revision, now),
    ).toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'ENCOUNTER_HISTORY_PROVENANCE_INVALID' }],
    });
    for (const [table, id] of [
      ['encounter_addenda', outcomes[0]!.canonicalResourceId],
      ['encounter_review_flags', outcomes[1]!.canonicalResourceId],
      ['encounter_review_status_events', outcomes[2]!.canonicalResourceId],
      ['encounter_history_resources', outcomes[0]!.canonicalResourceId],
    ]) {
      await expect(
        pool.query(`UPDATE ${table} SET id=id WHERE id=$1`, [id]),
      ).rejects.toThrow('immutable');
      await expect(
        pool.query(`DELETE FROM ${table} WHERE id=$1`, [id]),
      ).rejects.toThrow('immutable');
    }
  });
  it('retains original encounter links when a completed encounter is voided', async () => {
    const local = randomUUID();
    await insertCompletedEncounter(pool, randomUUID(), local);
    await pool.query(
      "UPDATE screening_encounters SET status='VOID',void_reason='Synthetic correction' WHERE local_encounter_id=$1",
      [local],
    );
    const records = fresh().map((r) =>
      r.resourceType === 'ENCOUNTER_REVIEW_STATUS'
        ? r
        : { ...r, payload: { ...r.payload, localEncounterId: local } },
    ) as EncounterHistoryRecord[];
    expect((await send(records)).map((o) => o.status)).toEqual([
      'ACCEPTED',
      'ACCEPTED',
      'ACCEPTED',
      'ACCEPTED',
    ]);
  });
  it('fails closed on missing source authors, foreign contexts and missing or incomplete encounters', async () => {
    const note = fresh()[0]!;
    const batch = await begin([note]);
    await expect(
      processEncounterHistoryRecord(
        pool,
        { ...context, installationId: randomUUID() },
        batch,
        note,
        now,
      ),
    ).rejects.toThrow('BATCH_NOT_AVAILABLE');
    await expect(
      processEncounterHistoryRecord(
        pool,
        { ...context, organizationId: randomUUID() },
        batch,
        note,
        now,
      ),
    ).rejects.toThrow('BATCH_NOT_AVAILABLE');
    await expect(
      processEncounterHistoryRecord(
        pool,
        context,
        batch,
        { ...note, sourceActorLocalId: randomUUID() },
        now,
      ),
    ).rejects.toThrow('SOURCE_ACTOR_NOT_AVAILABLE');
    if (note.resourceType !== 'ENCOUNTER_ADDENDUM') throw new Error('fixture');
    const absent = {
      ...note,
      recordId: randomUUID(),
      localResourceId: randomUUID(),
      payload: { ...note.payload, localEncounterId: randomUUID() },
    };
    expect((await send([absent]))[0]).toMatchObject({
      status: 'RETRY',
      errors: [{ code: 'DEPENDENCY_NOT_AVAILABLE' }],
    });
    const local = randomUUID();
    await insertEncounter(pool, randomUUID(), local, 'DRAFT');
    expect(
      (
        await send([
          {
            ...absent,
            recordId: randomUUID(),
            localResourceId: randomUUID(),
            payload: { ...absent.payload, localEncounterId: local },
          },
        ])
      )[0]!.status,
    ).toBe('RETRY');
    const time = '2026-08-20T15:39:00.000Z';
    expect(
      (
        await send([
          {
            ...note,
            capturedAt: time,
            payload: { ...note.payload, createdAt: time },
          },
        ])
      )[0],
    ).toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'ENCOUNTER_HISTORY_TIME_INVALID' }],
    });
  });
  it('rejects opening provenance inconsistent with the immutable flag', async () => {
    const [, flag, open] = fresh();
    await send([flag!]);
    if (open!.resourceType !== 'ENCOUNTER_REVIEW_STATUS')
      throw new Error('fixture');
    const changed = {
      ...open!,
      sourceActorLocalId: administratorActorId,
      payload: {
        ...open!.payload,
        changedByLocalActorId: administratorActorId,
      },
    };
    expect((await send([changed]))[0]).toMatchObject({
      status: 'REJECTED',
      errors: [{ code: 'REVIEW_OPENING_PROVENANCE_MISMATCH' }],
    });
  });
  it('rolls back resource and outcome together when the clinical write fails', async () => {
    const note = fresh()[0]!;
    const batch = await begin([note]);
    await pool.query(`CREATE FUNCTION reject_test_addendum() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic annotation failure'; END; $$;
      CREATE TRIGGER tr_test_addendum BEFORE INSERT ON encounter_addenda FOR EACH ROW EXECUTE FUNCTION reject_test_addendum()`);
    try {
      await expect(
        processEncounterHistoryRecord(pool, context, batch, note, now),
      ).rejects.toThrow('synthetic annotation failure');
      expect(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM encounter_history_resources WHERE local_resource_id=$1',
            [note.localResourceId],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM sync_records WHERE record_id=$1',
            [note.recordId],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await pool.query(
        'DROP TRIGGER tr_test_addendum ON encounter_addenda; DROP FUNCTION reject_test_addendum()',
      );
    }
    expect(
      (await processEncounterHistoryRecord(pool, context, batch, note, now))
        .status,
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
