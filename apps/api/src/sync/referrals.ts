import {
  referralActorReferences,
  referralSemanticIssues,
} from '../../../../packages/contracts/src/referral-validation.mjs';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { canonicalJsonSha256 } from './canonical-json.js';
import type {
  InstallationContext,
  ReferralRecord,
  ReferralOutcome,
  SyncRecordError,
} from './types.js';

/** Referral state is versioned; status events and follow-ups are immutable. */
export async function processReferralRecord(
  database: Pick<Pool, 'connect'>,
  context: InstallationContext,
  batchInternalId: string,
  record: ReferralRecord,
  now = new Date(),
): Promise<ReferralOutcome> {
  const client = await database.connect();
  const recordHash = canonicalJsonSha256(record);
  const contentHash = canonicalJsonSha256(record.payload);
  const outcome = (
    status: ReferralOutcome['status'],
    canonicalResourceId: string | null = null,
    errors: readonly SyncRecordError[] = [],
  ): ReferralOutcome => ({
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
    // Serializes snapshot revisions and immutable child identities across batches.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('chs.referral.v1'))",
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
      referralActorReferences(record).some(
        ([, id]) => id !== null && !actors.has(id),
      )
    ) {
      throw new Error('SOURCE_ACTOR_NOT_AVAILABLE');
    }
    const priorRows = (
      await client.query<{
        id: string;
        payload_hash: string;
        status: ReferralOutcome['status'];
        referral_resource_id: string | null;
        errors: SyncRecordError[];
      }>(
        `SELECT id, payload_hash, status, referral_resource_id, errors FROM sync_records
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
        !prior.referral_resource_id
      ) {
        throw new Error('REFERRAL_INVARIANT');
      }
      await client.query('COMMIT');
      return outcome(
        prior.status === 'ACCEPTED' ? 'UNCHANGED' : prior.status,
        prior.referral_resource_id,
        prior.errors,
      );
    }
    const finish = async (
      result: ReferralOutcome,
    ): Promise<ReferralOutcome> => {
      if (prior) {
        await client.query(
          `UPDATE sync_records SET status = $1, referral_resource_id = $2,
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
          payload_hash, status, referral_resource_id, errors, processed_at, created_at
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
    const issues = referralSemanticIssues(record);
    if (issues.length)
      return await finish(
        outcome(
          'REJECTED',
          null,
          issues.map((issue) => ({ ...issue, retryable: false })),
        ),
      );
    const existing = (
      await client.query<{
        id: string;
        source_revision: number;
        source_content_hash: string;
      }>(
        `SELECT id, source_revision, source_content_hash FROM referral_resources
      WHERE installation_id = $1 AND resource_type = $2 AND local_resource_id = $3 FOR UPDATE`,
        [context.installationId, record.resourceType, record.localResourceId],
      )
    ).rows[0];
    if (existing) {
      if (record.sourceRevision < existing.source_revision)
        return await fail('STALE_SOURCE_REVISION');
      if (record.sourceRevision === existing.source_revision) {
        if (existing.source_content_hash !== contentHash)
          return await fail('REFERRAL_REVISION_CONFLICT');
        return await finish(outcome('UNCHANGED', existing.id));
      }
      if (record.resourceType !== 'REFERRAL')
        return await fail('REFERRAL_HISTORY_IMMUTABLE');
    }
    const practitioner = (id: string | null): string | null =>
      id === null ? null : actors.get(id)!.practitioner_id;
    const id = existing?.id ?? randomUUID();
    if (record.resourceType === 'REFERRAL') {
      const p = record.payload;
      const encounter = (
        await client.query<{
          id: string;
          person_id: string;
          organization_id: string;
          location_id: string;
          source_protocol_version_id: string;
          local_patient_id: string;
          completed_at: Date | null;
        }>(
          `SELECT e.id, e.person_id, e.organization_id, e.location_id, e.source_protocol_version_id,
        e.completed_at, l.local_patient_id FROM screening_encounters e
        JOIN patient_source_links l ON l.installation_id = e.installation_id AND l.person_id = e.person_id
          AND l.local_patient_id = $3
        WHERE e.installation_id = $1 AND e.local_encounter_id = $2 FOR SHARE OF e`,
          [context.installationId, p.localEncounterId, p.localPatientId],
        )
      ).rows[0];
      if (!encounter || !encounter.completed_at)
        return await fail('DEPENDENCY_NOT_AVAILABLE', true);
      if (
        encounter.organization_id !== context.organizationId ||
        encounter.location_id !== batch.location_id ||
        encounter.source_protocol_version_id !== p.localProtocolVersionId
      )
        return await fail('REFERRAL_CONTEXT_MISMATCH');
      // Historical referrals remain uploadable after an encounter is voided. Readers show its state.
      if (existing) {
        const current = (
          await client.query<{
            encounter_id: string;
            created_at: Date;
            created_by_practitioner_id: string;
            status: string;
            updated_at: Date;
          }>(
            'SELECT encounter_id, created_at, created_by_practitioner_id, status, updated_at FROM referral_snapshots WHERE id=$1',
            [id],
          )
        ).rows[0]!;
        if (
          current.encounter_id !== encounter.id ||
          current.created_at.toISOString() !== p.createdAt ||
          current.created_by_practitioner_id !==
            practitioner(p.createdByLocalActorId)
        )
          return await fail('REFERRAL_IDENTITY_IMMUTABLE');
        if (
          current.status === 'CLOSED' ||
          (current.status !== 'OPEN' && p.status === 'OPEN') ||
          current.updated_at.getTime() > Date.parse(p.updatedAt)
        )
          return await fail('REFERRAL_STATE_REGRESSION');
      }
      await saveResource(
        client,
        context,
        record,
        id,
        contentHash,
        now,
        !!existing,
      );
      const values = [
        id,
        context.installationId,
        encounter.id,
        encounter.person_id,
        practitioner(p.createdByLocalActorId),
        practitioner(p.updatedByLocalActorId),
        practitioner(p.closedByLocalActorId),
        p.reasonCodes,
        p.reasonText,
        p.urgency,
        p.destinationName,
        p.dueDate,
        p.status,
        p.createdAt,
        p.updatedAt,
        p.closedAt,
        p.closureReason,
      ];
      await client.query(
        `INSERT INTO referral_snapshots (id, installation_id, encounter_id, person_id,
        created_by_practitioner_id, updated_by_practitioner_id, closed_by_practitioner_id, reason_codes,
        reason_text, urgency, destination_name, due_date, status, created_at, updated_at, closed_at, closure_reason)
        VALUES (${values.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (id) DO UPDATE SET
        updated_by_practitioner_id=EXCLUDED.updated_by_practitioner_id, closed_by_practitioner_id=EXCLUDED.closed_by_practitioner_id,
        reason_codes=EXCLUDED.reason_codes, reason_text=EXCLUDED.reason_text, urgency=EXCLUDED.urgency,
        destination_name=EXCLUDED.destination_name, due_date=EXCLUDED.due_date, status=EXCLUDED.status,
        updated_at=EXCLUDED.updated_at, closed_at=EXCLUDED.closed_at, closure_reason=EXCLUDED.closure_reason`,
        values,
      );
    } else {
      const p = record.payload;
      const parent = (
        await client.query<{
          id: string;
          organization_id: string;
          location_id: string;
          created_at: Date;
        }>(
          `SELECT s.id, e.organization_id, e.location_id, s.created_at FROM referral_resources r
         JOIN referral_snapshots s ON s.id=r.id JOIN screening_encounters e ON e.id=s.encounter_id
         WHERE r.installation_id=$1 AND r.resource_type='REFERRAL' AND r.local_resource_id=$2 FOR SHARE OF s`,
          [context.installationId, p.localReferralId],
        )
      ).rows[0];
      if (!parent) return await fail('DEPENDENCY_NOT_AVAILABLE', true);
      if (
        parent.organization_id !== context.organizationId ||
        parent.location_id !== batch.location_id
      )
        return await fail('REFERRAL_CONTEXT_MISMATCH');
      if (Date.parse(record.capturedAt) < parent.created_at.getTime())
        return await fail('REFERRAL_PERIOD_INVALID');
      if (record.resourceType === 'REFERRAL_STATUS') {
        const p = record.payload;
        const neighbors = (
          await client.query<{
            sequence_number: number;
            from_status: string | null;
            to_status: string;
          }>(
            `SELECT sequence_number, from_status, to_status FROM referral_status_events WHERE referral_id=$1 AND sequence_number BETWEEN $2 AND $3`,
            [parent.id, p.sequenceNumber - 1, p.sequenceNumber + 1],
          )
        ).rows;
        if (
          neighbors.some(
            (n) =>
              n.sequence_number === p.sequenceNumber ||
              (n.sequence_number === p.sequenceNumber - 1 &&
                n.to_status !== p.fromStatus) ||
              (n.sequence_number === p.sequenceNumber + 1 &&
                n.from_status !== p.toStatus),
          )
        )
          return await fail('REFERRAL_HISTORY_CONFLICT');
      }
      await saveResource(client, context, record, id, contentHash, now, false);
      if (record.resourceType === 'REFERRAL_STATUS') {
        const p = record.payload;
        await client.query(
          `INSERT INTO referral_status_events (id, installation_id, referral_id, sequence_number,
          from_status, to_status, change_reason, changed_by_practitioner_id, changed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            context.installationId,
            parent.id,
            p.sequenceNumber,
            p.fromStatus,
            p.toStatus,
            p.changeReason,
            practitioner(p.changedByLocalActorId),
            p.changedAt,
          ],
        );
      } else {
        const p = record.payload;
        const values = [
          id,
          context.installationId,
          parent.id,
          p.contactDate,
          p.contactMethod,
          p.informationSource,
          p.providerSeen,
          p.facilityName,
          p.dateSeen,
          p.reportedOutcome,
          p.reportedMedicationsOrAdvice,
          p.nextAction,
          p.nextFollowupDate,
          p.sourceType,
          practitioner(p.recordedByLocalActorId),
          p.recordedAt,
        ];
        await client.query(
          `INSERT INTO referral_followups (id, installation_id, referral_id, contact_date, contact_method,
          information_source, provider_seen, facility_name, date_seen, reported_outcome, reported_medications_or_advice,
          next_action, next_followup_date, source_type, recorded_by_practitioner_id, recorded_at)
          VALUES (${values.map((_, i) => `$${i + 1}`).join(',')})`,
          values,
        );
        for (const action of p.treatmentActions)
          await client.query(
            'INSERT INTO referral_treatment_actions (followup_id,local_action_id,sequence_number,action_code) VALUES ($1,$2,$3,$4)',
            [
              id,
              action.localActionId,
              action.sequenceNumber,
              action.actionCode,
            ],
          );
        for (const med of p.medicationChanges)
          await client.query(
            `INSERT INTO referral_medication_changes (followup_id,local_medication_change_id,sequence_number,change_type,medication_name,dosage,frequency)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              id,
              med.localMedicationChangeId,
              med.sequenceNumber,
              med.changeType,
              med.medicationName,
              med.dosage,
              med.frequency,
            ],
          );
      }
    }
    return await finish(outcome('ACCEPTED', id));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function saveResource(
  client: PoolClient,
  context: InstallationContext,
  record: ReferralRecord,
  id: string,
  hash: string,
  now: Date,
  existing: boolean,
): Promise<void> {
  if (existing)
    await client.query(
      'UPDATE referral_resources SET source_revision=$1,source_content_hash=$2,received_at=$3 WHERE id=$4',
      [record.sourceRevision, hash, now, id],
    );
  else
    await client.query(
      `INSERT INTO referral_resources (id,installation_id,resource_type,local_resource_id,source_revision,source_content_hash,received_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        context.installationId,
        record.resourceType,
        record.localResourceId,
        record.sourceRevision,
        hash,
        now,
      ],
    );
}
