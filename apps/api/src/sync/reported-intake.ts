import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { canonicalJsonSha256 } from './canonical-json.js';
import type {
  FoodRow,
  OtcRow,
  InstallationContext,
  ReportedIntakeRecord,
  ReportedIntakeOutcome,
  SyncRecordError,
} from './types.js';

/** Completed Food/OTC are immutable snapshots, owned by the originating encounter. */
export async function processReportedIntakeRecord(
  database: Pick<Pool, 'connect'>,
  context: InstallationContext,
  batchInternalId: string,
  record: ReportedIntakeRecord,
  now = new Date(),
): Promise<ReportedIntakeOutcome> {
  const client = await database.connect();
  const recordHash = canonicalJsonSha256(record);
  const contentHash = canonicalJsonSha256(record.payload);
  const outcome = (
    status: ReportedIntakeOutcome['status'],
    canonicalResourceId: string | null = null,
    errors: readonly SyncRecordError[] = [],
  ): ReportedIntakeOutcome => ({
    recordId: record.recordId,
    resourceType: record.resourceType,
    localResourceId: record.localResourceId,
    sourceRevision: record.sourceRevision,
    status,
    canonicalResourceId,
    centralPersonId: null,
    chsMedicalId: null,
    medicalIdStatus: null,
    errors,
  });
  try {
    await client.query('BEGIN');
    // Shared with every Food/OTC invocation, including direct processor retries.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('chs.reported-intake.v1'))",
    );
    const batch = (
      await client.query<{ location_id: string }>(
        `SELECT location_id FROM sync_batches WHERE id = $1 AND installation_id = $2
       AND organization_id = $3 AND status = 'PROCESSING' FOR UPDATE`,
        [batchInternalId, context.installationId, context.organizationId],
      )
    ).rows[0];
    if (!batch) throw new Error('BATCH_NOT_AVAILABLE');

    const actors = new Map(
      (
        await client.query<{
          id: string;
          source_actor_local_id: string;
          practitioner_id: string;
        }>(
          `SELECT id, source_actor_local_id, practitioner_id FROM sync_batch_actors
        WHERE batch_internal_id = $1`,
          [batchInternalId],
        )
      ).rows.map((a) => [a.source_actor_local_id, a]),
    );
    const mutationActor = actors.get(record.sourceActorLocalId);
    const recorder = actors.get(record.payload.recordedByLocalActorId);
    if (
      !mutationActor ||
      !recorder ||
      record.payload.rows.some((row) => !actors.has(row.recordedByLocalActorId))
    ) {
      throw new Error('SOURCE_ACTOR_NOT_AVAILABLE');
    }
    const priorRows = (
      await client.query<{
        id: string;
        payload_hash: string;
        status: ReportedIntakeOutcome['status'];
        reported_intake_assessment_id: string | null;
        errors: SyncRecordError[];
      }>(
        `SELECT id, payload_hash, status, reported_intake_assessment_id, errors FROM sync_records
        WHERE installation_id = $1 AND (record_id = $2 OR
          (resource_type = $3 AND local_resource_id = $4 AND source_revision = $5)) FOR UPDATE`,
        [
          context.installationId,
          record.recordId,
          record.resourceType,
          record.localResourceId,
          record.sourceRevision,
        ],
      )
    ).rows;
    const prior = priorRows[0];
    if (
      priorRows.length > 1 ||
      priorRows.some((row) => row.payload_hash !== recordHash)
    ) {
      await client.query('COMMIT');
      return outcome('REJECTED', null, [
        { code: 'RECORD_PAYLOAD_MISMATCH', path: '', retryable: false },
      ]);
    }
    if (prior && prior.status !== 'RETRY') {
      if (
        (prior.status === 'ACCEPTED' || prior.status === 'UNCHANGED') &&
        !prior.reported_intake_assessment_id
      ) {
        throw new Error('REPORTED_INTAKE_INVARIANT');
      }
      await client.query('COMMIT');
      return outcome(
        prior.status === 'ACCEPTED' ? 'UNCHANGED' : prior.status,
        prior.reported_intake_assessment_id,
        prior.errors,
      );
    }
    const finish = async (
      result: ReportedIntakeOutcome,
    ): Promise<ReportedIntakeOutcome> => {
      if (prior) {
        await client.query(
          `UPDATE sync_records SET status = $1, reported_intake_assessment_id = $2,
          errors = $3::jsonb, processed_at = $4 WHERE id = $5 AND status = 'RETRY'`,
          [
            result.status,
            result.canonicalResourceId,
            JSON.stringify(result.errors),
            now,
            prior.id,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO sync_records (
          id, batch_internal_id, installation_id, record_id, resource_type, local_resource_id,
          source_revision, schema_version, operation, captured_at, sync_batch_actor_id,
          payload_hash, status, reported_intake_assessment_id, errors, processed_at, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$16)`,
          [
            randomUUID(),
            batchInternalId,
            context.installationId,
            record.recordId,
            record.resourceType,
            record.localResourceId,
            record.sourceRevision,
            record.schemaVersion,
            record.operation,
            record.capturedAt,
            mutationActor.id,
            recordHash,
            result.status,
            result.canonicalResourceId,
            JSON.stringify(result.errors),
            now,
          ],
        );
      }
      await client.query('COMMIT');
      return result;
    };
    const fail = (code: string, retryable = false) =>
      finish(
        outcome(retryable ? 'RETRY' : 'REJECTED', null, [
          { code, path: '/payload/localEncounterId', retryable },
        ]),
      );
    const p = record.payload;
    if (
      record.sourceRevision !== 1 ||
      record.localResourceId !== p.localEncounterId ||
      record.capturedAt !== p.completedAt
    ) {
      return await fail('REPORTED_SNAPSHOT_IDENTITY_INVALID');
    }
    const encounter = (
      await client.query<{
        id: string;
        person_id: string;
        organization_id: string;
        location_id: string;
        status: string;
        completed_at: Date | null;
        recorded_by_practitioner_id: string;
      }>(
        `SELECT id, person_id, organization_id, location_id, status, completed_at,
         recorded_by_practitioner_id FROM screening_encounters
        WHERE installation_id = $1 AND local_encounter_id = $2 FOR SHARE`,
        [context.installationId, p.localEncounterId],
      )
    ).rows[0];
    if (!encounter) return await fail('DEPENDENCY_NOT_AVAILABLE', true);
    if (
      encounter.organization_id !== context.organizationId ||
      encounter.location_id !== batch.location_id
    ) {
      return await fail('ENCOUNTER_CONTEXT_MISMATCH');
    }
    // Retain historically completed records even if their encounter was subsequently voided.
    // Readers must use the authoritative encounter status when displaying them.
    if (encounter.status === 'DRAFT' || !encounter.completed_at)
      return await fail('DEPENDENCY_NOT_AVAILABLE', true);
    if (
      encounter.completed_at.toISOString() !== p.completedAt ||
      p.rows.some((row) => row.recordedAt !== p.completedAt)
    ) {
      return await fail('REPORTED_PROVENANCE_MISMATCH');
    }
    const existing = (
      await client.query<{ id: string; source_content_hash: string }>(
        `SELECT id, source_content_hash FROM reported_intake_assessments
       WHERE installation_id = $1 AND resource_type = $2 AND local_encounter_id = $3`,
        [context.installationId, record.resourceType, p.localEncounterId],
      )
    ).rows[0];
    if (existing) {
      if (existing.source_content_hash !== contentHash)
        return await fail('REPORTED_TERMINAL_CONFLICT');
      return await finish(outcome('UNCHANGED', existing.id));
    }
    const id = randomUUID();
    await client.query(
      `INSERT INTO reported_intake_assessments (
      id, resource_type, encounter_id, installation_id, person_id, local_encounter_id,
      source_revision, response, period_start, period_end, completed_at,
      recorded_by_practitioner_id, source_content_hash, received_at
    ) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13)`,
      [
        id,
        record.resourceType,
        encounter.id,
        context.installationId,
        encounter.person_id,
        p.localEncounterId,
        p.response,
        p.periodStart,
        p.periodEnd,
        p.completedAt,
        recorder.practitioner_id,
        contentHash,
        now,
      ],
    );
    for (const [index, row] of p.rows.entries()) {
      await insertRow(
        client,
        id,
        record.resourceType,
        row,
        index + 1,
        actors.get(row.recordedByLocalActorId)!.practitioner_id,
      );
    }
    return await finish(outcome('ACCEPTED', id));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function insertRow(
  client: PoolClient,
  id: string,
  type: 'FOOD' | 'OTC',
  row: FoodRow | OtcRow,
  sequence: number,
  practitionerId: string,
): Promise<void> {
  if (type === 'FOOD') {
    const food = row as FoodRow;
    await client.query(
      `INSERT INTO reported_food_rows (assessment_id, local_row_id, sequence_number,
      food_code, food_name, frequency_code, preparation_note, source_type, recorded_by_practitioner_id, recorded_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        food.localRowId,
        sequence,
        food.foodCode,
        food.foodName,
        food.frequencyCode,
        food.preparationNote,
        food.sourceType,
        practitionerId,
        food.recordedAt,
      ],
    );
  } else {
    const otc = row as OtcRow;
    await client.query(
      `INSERT INTO reported_otc_rows (assessment_id, local_row_id, sequence_number,
      product_name, reason_for_use, dose_text, frequency_text, duration_text, source_of_medication,
      currently_taking, source_type, recorded_by_practitioner_id, recorded_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        id,
        otc.localRowId,
        sequence,
        otc.productName,
        otc.reasonForUse,
        otc.doseText,
        otc.frequencyText,
        otc.durationText,
        otc.sourceOfMedication,
        otc.currentlyTaking,
        otc.sourceType,
        practitionerId,
        otc.recordedAt,
      ],
    );
  }
}
