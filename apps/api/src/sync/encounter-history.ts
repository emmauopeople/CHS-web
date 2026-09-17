import {
  encounterHistoryActorReferences,
  encounterHistorySemanticIssues,
} from '../../../../packages/contracts/src/encounter-history-validation.mjs';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { canonicalJsonSha256 } from './canonical-json.js';
import type {
  InstallationContext,
  EncounterHistoryRecord,
  EncounterHistoryOutcome,
  SyncRecordError,
} from './types.js';

/** Every source note, flag definition and lifecycle event is immutable. */
export async function processEncounterHistoryRecord(
  database: Pick<Pool, 'connect'>,
  context: InstallationContext,
  batchInternalId: string,
  record: EncounterHistoryRecord,
  now = new Date(),
): Promise<EncounterHistoryOutcome> {
  const client = await database.connect();
  const recordHash = canonicalJsonSha256(record);
  const contentHash = canonicalJsonSha256(record.payload);
  const outcome = (
    status: EncounterHistoryOutcome['status'],
    canonicalResourceId: string | null = null,
    errors: readonly SyncRecordError[] = [],
  ): EncounterHistoryOutcome => ({
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
    // Serialize a source installation's immutable identities and event sequences.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`chs.encounter-history.v1:${context.installationId}`],
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
    if (
      !mutationActor ||
      encounterHistoryActorReferences(record).some(
        ([, id]) => id !== null && !actors.has(id),
      )
    ) {
      throw new Error('SOURCE_ACTOR_NOT_AVAILABLE');
    }
    const priorRows = (
      await client.query<{
        id: string;
        payload_hash: string;
        status: EncounterHistoryOutcome['status'];
        encounter_history_resource_id: string | null;
        errors: SyncRecordError[];
      }>(
        `SELECT id, payload_hash, status, encounter_history_resource_id, errors FROM sync_records
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
        !prior.encounter_history_resource_id
      ) {
        throw new Error('ENCOUNTER_HISTORY_INVARIANT');
      }
      await client.query('COMMIT');
      return outcome(
        prior.status === 'ACCEPTED' ? 'UNCHANGED' : prior.status,
        prior.encounter_history_resource_id,
        prior.errors,
      );
    }
    const finish = async (
      result: EncounterHistoryOutcome,
    ): Promise<EncounterHistoryOutcome> => {
      if (prior) {
        await client.query(
          `UPDATE sync_records SET status = $1, encounter_history_resource_id = $2,
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
          payload_hash, status, encounter_history_resource_id, errors, processed_at, created_at
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
          { code, path: '/payload', retryable },
        ]),
      );
    const issues = encounterHistorySemanticIssues(record);
    if (issues.length)
      return await finish(
        outcome(
          'REJECTED',
          null,
          issues.map((issue) => ({ ...issue, retryable: false })),
        ),
      );
    const existing = (
      await client.query<{ id: string; source_content_hash: string }>(
        `SELECT id, source_content_hash FROM encounter_history_resources
       WHERE installation_id=$1 AND resource_type=$2 AND local_resource_id=$3`,
        [context.installationId, record.resourceType, record.localResourceId],
      )
    ).rows[0];
    if (existing) {
      if (existing.source_content_hash !== contentHash)
        return await fail('ENCOUNTER_HISTORY_IMMUTABLE');
      return await finish(outcome('UNCHANGED', existing.id));
    }
    const author = mutationActor.practitioner_id;
    let encounter:
      | {
          id: string;
          person_id: string;
          completed_at: Date | null;
          organization_id: string;
          location_id: string;
        }
      | undefined;
    let flag:
      | { id: string; opened_at: Date; opened_by_practitioner_id: string }
      | undefined;
    if (record.resourceType === 'ENCOUNTER_REVIEW_STATUS') {
      const p = record.payload;
      const parent = (
        await client.query<{
          id: string;
          opened_at: Date;
          opened_by_practitioner_id: string;
          organization_id: string;
          location_id: string;
        }>(
          `SELECT f.id,f.opened_at,f.opened_by_practitioner_id,e.organization_id,e.location_id
        FROM encounter_history_resources r JOIN encounter_review_flags f ON f.id=r.id
        JOIN screening_encounters e ON e.id=f.encounter_id
        WHERE r.installation_id=$1 AND r.resource_type='ENCOUNTER_REVIEW_FLAG' AND r.local_resource_id=$2`,
          [context.installationId, p.localFlagId],
        )
      ).rows[0];
      if (!parent) return await fail('DEPENDENCY_NOT_AVAILABLE', true);
      if (
        parent.organization_id !== context.organizationId ||
        parent.location_id !== batch.location_id
      )
        return await fail('ENCOUNTER_HISTORY_CONTEXT_MISMATCH');
      flag = parent;
      if (p.sequenceNumber === 1) {
        if (
          Date.parse(p.changedAt) !== parent.opened_at.getTime() ||
          author !== parent.opened_by_practitioner_id
        )
          return await fail('REVIEW_OPENING_PROVENANCE_MISMATCH');
      } else {
        const previous = (
          await client.query<{ to_status: string; changed_at: Date }>(
            'SELECT to_status,changed_at FROM encounter_review_status_events WHERE flag_id=$1 AND sequence_number=$2',
            [parent.id, p.sequenceNumber - 1],
          )
        ).rows[0];
        if (!previous) return await fail('DEPENDENCY_NOT_AVAILABLE', true);
        if (
          previous.to_status !== p.fromStatus ||
          Date.parse(p.changedAt) < previous.changed_at.getTime()
        )
          return await fail('REVIEW_HISTORY_ORDER_INVALID');
      }
      const occupied = await client.query(
        'SELECT id FROM encounter_review_status_events WHERE flag_id=$1 AND sequence_number=$2',
        [parent.id, p.sequenceNumber],
      );
      if (occupied.rowCount) return await fail('REVIEW_SEQUENCE_CONFLICT');
    } else {
      encounter = (
        await client.query<NonNullable<typeof encounter>>(
          `SELECT id,person_id,completed_at,organization_id,location_id FROM screening_encounters
         WHERE installation_id=$1 AND local_encounter_id=$2`,
          [context.installationId, record.payload.localEncounterId],
        )
      ).rows[0];
      if (!encounter || !encounter.completed_at)
        return await fail('DEPENDENCY_NOT_AVAILABLE', true);
      if (
        encounter.organization_id !== context.organizationId ||
        encounter.location_id !== batch.location_id
      )
        return await fail('ENCOUNTER_HISTORY_CONTEXT_MISMATCH');
      // Completed encounters retain their annotations even after a later void.
      if (Date.parse(record.capturedAt) < encounter.completed_at.getTime())
        return await fail('ENCOUNTER_HISTORY_TIME_INVALID');
    }
    const id = randomUUID();
    await client.query(
      `INSERT INTO encounter_history_resources
      (id,installation_id,resource_type,local_resource_id,source_revision,source_content_hash,received_at)
      VALUES ($1,$2,$3,$4,1,$5,$6)`,
      [
        id,
        context.installationId,
        record.resourceType,
        record.localResourceId,
        contentHash,
        now,
      ],
    );
    if (record.resourceType === 'ENCOUNTER_ADDENDUM') {
      if (!encounter) throw new Error('ENCOUNTER_HISTORY_INVARIANT');
      const p = record.payload;
      await client.query(
        `INSERT INTO encounter_addenda
        (id,installation_id,encounter_id,person_id,note_text,created_by_practitioner_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          context.installationId,
          encounter.id,
          encounter.person_id,
          p.noteText,
          author,
          p.createdAt,
        ],
      );
    } else if (record.resourceType === 'ENCOUNTER_REVIEW_FLAG') {
      if (!encounter) throw new Error('ENCOUNTER_HISTORY_INVARIANT');
      const p = record.payload;
      await client.query(
        `INSERT INTO encounter_review_flags
        (id,installation_id,encounter_id,person_id,category,description,opened_by_practitioner_id,opened_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          context.installationId,
          encounter.id,
          encounter.person_id,
          p.category,
          p.description,
          author,
          p.openedAt,
        ],
      );
    } else {
      if (!flag) throw new Error('ENCOUNTER_HISTORY_INVARIANT');
      const p = record.payload;
      await client.query(
        `INSERT INTO encounter_review_status_events
        (id,installation_id,flag_id,sequence_number,from_status,to_status,change_reason,changed_by_practitioner_id,changed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          context.installationId,
          flag.id,
          p.sequenceNumber,
          p.fromStatus,
          p.toStatus,
          p.changeReason,
          author,
          p.changedAt,
        ],
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
