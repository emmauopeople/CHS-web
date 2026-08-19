import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import { canonicalJsonSha256 } from './canonical-json.js';
import type {
  InstallationContext,
  ScreeningEncounterRecordOutcome,
  ScreeningEncounterSyncRecord,
  SyncRecordError,
} from './types.js';

type EncounterDatabase = Pick<Pool, 'connect'>;

type BatchRow = Readonly<{
  location_id: string;
  source_location_id: string;
  status: string;
}>;

type BatchActorRow = Readonly<{
  id: string;
  practitioner_id: string;
  source_actor_local_id: string;
}>;

type ExistingSyncRecordRow = Readonly<{
  id: string;
  payload_hash: string;
  status:
    | ScreeningEncounterRecordOutcome['status']
    | 'PROCESSING'
    | 'REVIEW_REQUIRED';
  screening_encounter_id: string | null;
  errors: SyncRecordError[];
}>;

type PatientSourceRow = Readonly<{ person_id: string }>;

type SessionRow = Readonly<{
  id: string;
  organization_id: string;
  location_id: string;
  protocol_id: string;
  source_location_id: string;
  source_protocol_version_id: string;
  opened_at: Date;
  closed_at: Date | null;
}>;

type AmendmentTargetRow = Readonly<{
  id: string;
  person_id: string;
  status: 'DRAFT' | 'COMPLETED' | 'AMENDED' | 'VOID';
}>;

type ExistingEncounterRow = Readonly<{
  id: string;
  person_id: string;
  screening_session_id: string;
  organization_id: string;
  location_id: string;
  protocol_id: string;
  source_location_id: string;
  source_protocol_version_id: string;
  status: 'DRAFT' | 'COMPLETED' | 'AMENDED' | 'VOID';
  started_at: Date;
  completed_at: Date | null;
  recorded_by_practitioner_id: string;
  source_type: 'LOCAL';
  amendment_of_encounter_id: string | null;
  amendment_reason: string | null;
  void_reason: string | null;
  source_revision: number;
  source_created_at: Date;
}>;

export type ScreeningEncounterProcessingErrorCode =
  | 'BATCH_NOT_AVAILABLE'
  | 'SOURCE_ACTOR_NOT_AVAILABLE'
  | 'SCREENING_ENCOUNTER_INVARIANT';

export class ScreeningEncounterProcessingError extends Error {
  constructor(readonly code: ScreeningEncounterProcessingErrorCode) {
    super('Screening encounter synchronization processing failed');
    this.name = 'ScreeningEncounterProcessingError';
  }
}

type RejectionCode =
  | 'AMENDMENT_TARGET_INVALID'
  | 'ENCOUNTER_IDENTITY_CONFLICT'
  | 'ENCOUNTER_PERIOD_INVALID'
  | 'ENCOUNTER_STATE_INVALID'
  | 'ENCOUNTER_STATE_REGRESSION'
  | 'ENCOUNTER_TERMINAL_CONFLICT'
  | 'LOCATION_CONTEXT_MISMATCH'
  | 'RECORD_PAYLOAD_MISMATCH'
  | 'SESSION_CONTEXT_MISMATCH'
  | 'SOURCE_TIME_INVALID'
  | 'STALE_SOURCE_REVISION';

function outcomeBase(record: ScreeningEncounterSyncRecord) {
  return {
    recordId: record.recordId,
    resourceType: 'SCREENING_ENCOUNTER' as const,
    localResourceId: record.localResourceId,
    sourceRevision: record.sourceRevision,
    centralPersonId: null,
    chsMedicalId: null,
    medicalIdStatus: null,
  };
}

function acceptedOutcome(
  record: ScreeningEncounterSyncRecord,
  status: 'ACCEPTED' | 'UNCHANGED',
  encounterId: string,
): ScreeningEncounterRecordOutcome {
  return {
    ...outcomeBase(record),
    status,
    canonicalResourceId: encounterId,
    errors: [],
  };
}

function rejectedOutcome(
  record: ScreeningEncounterSyncRecord,
  code: RejectionCode,
  path: string,
): ScreeningEncounterRecordOutcome {
  return {
    ...outcomeBase(record),
    status: 'REJECTED',
    canonicalResourceId: null,
    errors: [{ code, path, retryable: false }],
  };
}

function retryOutcome(
  record: ScreeningEncounterSyncRecord,
  path: string,
): ScreeningEncounterRecordOutcome {
  return {
    ...outcomeBase(record),
    status: 'RETRY',
    canonicalResourceId: null,
    errors: [{ code: 'DEPENDENCY_NOT_AVAILABLE', path, retryable: true }],
  };
}

function inProgressOutcome(
  record: ScreeningEncounterSyncRecord,
): ScreeningEncounterRecordOutcome {
  return {
    ...outcomeBase(record),
    status: 'RETRY',
    canonicalResourceId: null,
    errors: [{ code: 'RECORD_IN_PROGRESS', path: '', retryable: true }],
  };
}

function outcomeFromExisting(
  record: ScreeningEncounterSyncRecord,
  existing: ExistingSyncRecordRow,
): ScreeningEncounterRecordOutcome {
  if (existing.status === 'ACCEPTED' || existing.status === 'UNCHANGED') {
    if (!existing.screening_encounter_id) {
      throw new ScreeningEncounterProcessingError('SCREENING_ENCOUNTER_INVARIANT');
    }
    return acceptedOutcome(record, 'UNCHANGED', existing.screening_encounter_id);
  }
  if (existing.status === 'REJECTED') {
    return {
      ...outcomeBase(record),
      status: 'REJECTED',
      canonicalResourceId: null,
      errors: existing.errors,
    };
  }
  return inProgressOutcome(record);
}

async function persistOutcome(
  client: PoolClient,
  context: InstallationContext,
  batchInternalId: string,
  mutationActorId: string,
  record: ScreeningEncounterSyncRecord,
  recordHash: string,
  outcome: ScreeningEncounterRecordOutcome,
  processedAt: string,
  retryRecordId: string | null,
) {
  if (retryRecordId) {
    const result = await client.query(
      `UPDATE sync_records
       SET status = $1,
           screening_encounter_id = $2,
           errors = $3::jsonb,
           processed_at = $4
       WHERE id = $5 AND status = 'RETRY'`,
      [
        outcome.status,
        outcome.canonicalResourceId,
        JSON.stringify(outcome.errors),
        processedAt,
        retryRecordId,
      ],
    );
    if (result.rowCount !== 1) {
      throw new ScreeningEncounterProcessingError('SCREENING_ENCOUNTER_INVARIANT');
    }
    return;
  }

  await client.query(
    `INSERT INTO sync_records (
       id, batch_internal_id, installation_id, record_id, resource_type,
       local_resource_id, source_revision, schema_version, operation,
       captured_at, sync_batch_actor_id, payload_hash, status,
       screening_encounter_id, errors, processed_at, created_at
     ) VALUES (
       $1, $2, $3, $4, 'SCREENING_ENCOUNTER', $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14::jsonb, $15, $15
     )`,
    [
      randomUUID(),
      batchInternalId,
      context.installationId,
      record.recordId,
      record.localResourceId,
      record.sourceRevision,
      record.schemaVersion,
      record.operation,
      record.capturedAt,
      mutationActorId,
      recordHash,
      outcome.status,
      outcome.canonicalResourceId,
      JSON.stringify(outcome.errors),
      processedAt,
    ],
  );
}

function sameInstant(left: Date | null, right: string | null): boolean {
  if (left === null || right === null) return left === null && right === null;
  return left.toISOString() === new Date(right).toISOString();
}

function isNonBlank(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

function stateIsValid(record: ScreeningEncounterSyncRecord): boolean {
  const payload = record.payload;
  if (payload.status === 'DRAFT') {
    return (
      payload.completedAt === null &&
      payload.amendmentOfLocalEncounterId === null &&
      payload.amendmentReason === null &&
      payload.voidReason === null
    );
  }
  if (payload.status === 'COMPLETED') {
    return (
      payload.completedAt !== null &&
      payload.amendmentOfLocalEncounterId === null &&
      payload.amendmentReason === null &&
      payload.voidReason === null
    );
  }
  if (payload.status === 'AMENDED') {
    return (
      payload.completedAt !== null &&
      payload.amendmentOfLocalEncounterId !== null &&
      isNonBlank(payload.amendmentReason) &&
      payload.voidReason === null
    );
  }
  return (
    payload.amendmentOfLocalEncounterId === null &&
    payload.amendmentReason === null &&
    isNonBlank(payload.voidReason)
  );
}

function identityConflict(
  existing: ExistingEncounterRow,
  personId: string,
  session: SessionRow,
  recordedByPractitionerId: string,
  amendmentTargetId: string | null,
  record: ScreeningEncounterSyncRecord,
): boolean {
  const payload = record.payload;
  return (
    existing.person_id !== personId ||
    existing.screening_session_id !== session.id ||
    existing.organization_id !== session.organization_id ||
    existing.location_id !== session.location_id ||
    existing.protocol_id !== session.protocol_id ||
    existing.source_location_id !== payload.localLocationId ||
    existing.source_protocol_version_id !== payload.localProtocolVersionId ||
    existing.recorded_by_practitioner_id !== recordedByPractitionerId ||
    existing.source_type !== payload.sourceType ||
    existing.amendment_of_encounter_id !== amendmentTargetId ||
    !sameInstant(existing.started_at, payload.startedAt) ||
    !sameInstant(existing.source_created_at, payload.createdAt)
  );
}

function transitionError(
  existing: ExistingEncounterRow,
  record: ScreeningEncounterSyncRecord,
): Readonly<{ code: RejectionCode; path: string }> | null {
  const payload = record.payload;
  const allowed: Record<
    ExistingEncounterRow['status'],
    readonly ScreeningEncounterSyncRecord['payload']['status'][]
  > = {
    DRAFT: ['DRAFT', 'COMPLETED', 'VOID'],
    COMPLETED: ['COMPLETED', 'VOID'],
    AMENDED: ['AMENDED'],
    VOID: ['VOID'],
  };
  if (!allowed[existing.status].includes(payload.status)) {
    return { code: 'ENCOUNTER_STATE_REGRESSION', path: '/payload/status' };
  }
  if (
    existing.status === 'COMPLETED' &&
    !sameInstant(existing.completed_at, payload.completedAt)
  ) {
    return { code: 'ENCOUNTER_TERMINAL_CONFLICT', path: '/payload/completedAt' };
  }
  if (
    existing.status === 'AMENDED' &&
    (!sameInstant(existing.completed_at, payload.completedAt) ||
      existing.amendment_reason !== payload.amendmentReason)
  ) {
    return { code: 'ENCOUNTER_TERMINAL_CONFLICT', path: '/payload' };
  }
  if (
    existing.status === 'VOID' &&
    (!sameInstant(existing.completed_at, payload.completedAt) ||
      existing.void_reason !== payload.voidReason)
  ) {
    return { code: 'ENCOUNTER_TERMINAL_CONFLICT', path: '/payload' };
  }
  return null;
}

async function finish(
  client: PoolClient,
  context: InstallationContext,
  batchInternalId: string,
  mutationActorId: string,
  record: ScreeningEncounterSyncRecord,
  recordHash: string,
  outcome: ScreeningEncounterRecordOutcome,
  processedAt: string,
  retryRecordId: string | null,
): Promise<ScreeningEncounterRecordOutcome> {
  await persistOutcome(
    client,
    context,
    batchInternalId,
    mutationActorId,
    record,
    recordHash,
    outcome,
    processedAt,
    retryRecordId,
  );
  await client.query('COMMIT');
  return outcome;
}

export async function processScreeningEncounterRecord(
  database: EncounterDatabase,
  context: InstallationContext,
  batchInternalId: string,
  record: ScreeningEncounterSyncRecord,
  now: Date = new Date(),
): Promise<ScreeningEncounterRecordOutcome> {
  const processedAt = now.toISOString();
  const recordHash = canonicalJsonSha256(record);
  const contentHash = canonicalJsonSha256(record.payload);
  const client = await database.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('chs.screening-encounter.v1'))`,
    );

    const batchResult = await client.query<BatchRow>(
      `SELECT location_id, source_location_id, status
       FROM sync_batches
       WHERE id = $1
         AND installation_id = $2
         AND organization_id = $3
       FOR UPDATE`,
      [batchInternalId, context.installationId, context.organizationId],
    );
    const batch = batchResult.rows[0];
    if (!batch || batch.status !== 'PROCESSING') {
      throw new ScreeningEncounterProcessingError('BATCH_NOT_AVAILABLE');
    }

    const actorIds = [
      record.sourceActorLocalId,
      record.payload.recordedByLocalActorId,
    ];
    const actorsResult = await client.query<BatchActorRow>(
      `SELECT id, practitioner_id, source_actor_local_id
       FROM sync_batch_actors
       WHERE batch_internal_id = $1
         AND source_actor_local_id = ANY($2::uuid[])`,
      [batchInternalId, actorIds],
    );
    const actors = new Map(
      actorsResult.rows.map((actor) => [actor.source_actor_local_id, actor]),
    );
    const mutationActor = actors.get(record.sourceActorLocalId);
    const recordedBy = actors.get(record.payload.recordedByLocalActorId);
    if (!mutationActor || !recordedBy) {
      throw new ScreeningEncounterProcessingError('SOURCE_ACTOR_NOT_AVAILABLE');
    }

    const priorResult = await client.query<ExistingSyncRecordRow>(
      `SELECT id, payload_hash, status, screening_encounter_id, errors
       FROM sync_records
       WHERE installation_id = $1
         AND (
           record_id = $2
           OR (
             resource_type = 'SCREENING_ENCOUNTER'
             AND local_resource_id = $3
             AND source_revision = $4
           )
         )
       FOR UPDATE`,
      [
        context.installationId,
        record.recordId,
        record.localResourceId,
        record.sourceRevision,
      ],
    );
    let retryRecordId: string | null = null;
    if (priorResult.rows.length > 0) {
      const mismatch =
        new Set(priorResult.rows.map((prior) => prior.id)).size > 1 ||
        priorResult.rows.some((prior) => prior.payload_hash !== recordHash);
      if (mismatch) {
        await client.query('COMMIT');
        return rejectedOutcome(record, 'RECORD_PAYLOAD_MISMATCH', '');
      }
      const prior = priorResult.rows[0]!;
      if (prior.status !== 'RETRY') {
        const outcome = outcomeFromExisting(record, prior);
        await client.query('COMMIT');
        return outcome;
      }
      retryRecordId = prior.id;
    }

    if (!stateIsValid(record)) {
      return finish(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        rejectedOutcome(record, 'ENCOUNTER_STATE_INVALID', '/payload'),
        processedAt,
        retryRecordId,
      );
    }
    if (new Date(record.payload.updatedAt) < new Date(record.payload.createdAt)) {
      return finish(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        rejectedOutcome(record, 'SOURCE_TIME_INVALID', '/payload/updatedAt'),
        processedAt,
        retryRecordId,
      );
    }
    if (
      record.payload.completedAt !== null &&
      new Date(record.payload.completedAt) < new Date(record.payload.startedAt)
    ) {
      return finish(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        rejectedOutcome(record, 'ENCOUNTER_PERIOD_INVALID', '/payload/completedAt'),
        processedAt,
        retryRecordId,
      );
    }
    if (
      record.payload.localLocationId !== batch.source_location_id ||
      batch.location_id !== context.configuredLocationId
    ) {
      return finish(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        rejectedOutcome(
          record,
          'LOCATION_CONTEXT_MISMATCH',
          '/payload/localLocationId',
        ),
        processedAt,
        retryRecordId,
      );
    }

    const patientResult = await client.query<PatientSourceRow>(
      `SELECT person_id
       FROM patient_source_links
       WHERE installation_id = $1 AND local_patient_id = $2
       FOR SHARE`,
      [context.installationId, record.payload.localPatientId],
    );
    const personId = patientResult.rows[0]?.person_id;
    if (!personId) {
      return finish(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        retryOutcome(record, '/payload/localPatientId'),
        processedAt,
        retryRecordId,
      );
    }

    const sessionResult = await client.query<SessionRow>(
      `SELECT
         id, organization_id, location_id, protocol_id, source_location_id,
         source_protocol_version_id, opened_at, closed_at
       FROM screening_sessions
       WHERE installation_id = $1 AND local_session_id = $2
       FOR SHARE`,
      [context.installationId, record.payload.localScreeningSessionId],
    );
    const session = sessionResult.rows[0];
    if (!session) {
      return finish(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        retryOutcome(record, '/payload/localScreeningSessionId'),
        processedAt,
        retryRecordId,
      );
    }
    if (
      session.organization_id !== context.organizationId ||
      session.location_id !== batch.location_id ||
      session.source_location_id !== record.payload.localLocationId ||
      session.source_protocol_version_id !== record.payload.localProtocolVersionId
    ) {
      return finish(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        rejectedOutcome(record, 'SESSION_CONTEXT_MISMATCH', '/payload'),
        processedAt,
        retryRecordId,
      );
    }
    if (
      new Date(record.payload.startedAt) < session.opened_at ||
      (session.closed_at !== null &&
        (new Date(record.payload.startedAt) > session.closed_at ||
          (record.payload.completedAt !== null &&
            new Date(record.payload.completedAt) > session.closed_at)))
    ) {
      return finish(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        rejectedOutcome(record, 'ENCOUNTER_PERIOD_INVALID', '/payload'),
        processedAt,
        retryRecordId,
      );
    }

    let amendmentTargetId: string | null = null;
    if (record.payload.amendmentOfLocalEncounterId !== null) {
      if (record.payload.amendmentOfLocalEncounterId === record.localResourceId) {
        return finish(
          client,
          context,
          batchInternalId,
          mutationActor.id,
          record,
          recordHash,
          rejectedOutcome(
            record,
            'AMENDMENT_TARGET_INVALID',
            '/payload/amendmentOfLocalEncounterId',
          ),
          processedAt,
          retryRecordId,
        );
      }
      const amendmentResult = await client.query<AmendmentTargetRow>(
        `SELECT id, person_id, status
         FROM screening_encounters
         WHERE installation_id = $1 AND local_encounter_id = $2
         FOR SHARE`,
        [context.installationId, record.payload.amendmentOfLocalEncounterId],
      );
      const amendment = amendmentResult.rows[0];
      if (!amendment) {
        return finish(
          client,
          context,
          batchInternalId,
          mutationActor.id,
          record,
          recordHash,
          retryOutcome(record, '/payload/amendmentOfLocalEncounterId'),
          processedAt,
          retryRecordId,
        );
      }
      if (
        amendment.person_id !== personId ||
        (amendment.status !== 'COMPLETED' && amendment.status !== 'AMENDED')
      ) {
        return finish(
          client,
          context,
          batchInternalId,
          mutationActor.id,
          record,
          recordHash,
          rejectedOutcome(
            record,
            'AMENDMENT_TARGET_INVALID',
            '/payload/amendmentOfLocalEncounterId',
          ),
          processedAt,
          retryRecordId,
        );
      }
      amendmentTargetId = amendment.id;
    }

    const existingResult = await client.query<ExistingEncounterRow>(
      `SELECT
         id, person_id, screening_session_id, organization_id, location_id,
         protocol_id, source_location_id, source_protocol_version_id, status,
         started_at, completed_at, recorded_by_practitioner_id, source_type,
         amendment_of_encounter_id, amendment_reason, void_reason,
         source_revision, source_created_at
       FROM screening_encounters
       WHERE installation_id = $1 AND local_encounter_id = $2
       FOR UPDATE`,
      [context.installationId, record.localResourceId],
    );
    const existing = existingResult.rows[0];
    if (existing) {
      if (record.sourceRevision < existing.source_revision) {
        return finish(
          client,
          context,
          batchInternalId,
          mutationActor.id,
          record,
          recordHash,
          rejectedOutcome(record, 'STALE_SOURCE_REVISION', '/sourceRevision'),
          processedAt,
          retryRecordId,
        );
      }
      if (
        identityConflict(
          existing,
          personId,
          session,
          recordedBy.practitioner_id,
          amendmentTargetId,
          record,
        )
      ) {
        return finish(
          client,
          context,
          batchInternalId,
          mutationActor.id,
          record,
          recordHash,
          rejectedOutcome(record, 'ENCOUNTER_IDENTITY_CONFLICT', '/payload'),
          processedAt,
          retryRecordId,
        );
      }
      const error = transitionError(existing, record);
      if (error) {
        return finish(
          client,
          context,
          batchInternalId,
          mutationActor.id,
          record,
          recordHash,
          rejectedOutcome(record, error.code, error.path),
          processedAt,
          retryRecordId,
        );
      }

      await client.query(
        `UPDATE screening_encounters
         SET status = $1,
             completed_at = $2,
             amendment_reason = $3,
             void_reason = $4,
             source_revision = $5,
             source_content_hash = $6,
             source_updated_at = $7,
             updated_at = $8
         WHERE id = $9`,
        [
          record.payload.status,
          record.payload.completedAt,
          record.payload.amendmentReason,
          record.payload.voidReason,
          record.sourceRevision,
          contentHash,
          record.payload.updatedAt,
          processedAt,
          existing.id,
        ],
      );
      return finish(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        acceptedOutcome(record, 'ACCEPTED', existing.id),
        processedAt,
        retryRecordId,
      );
    }

    const encounterId = randomUUID();
    await client.query(
      `INSERT INTO screening_encounters (
         id, person_id, screening_session_id, installation_id, organization_id,
         location_id, protocol_id, local_encounter_id, source_location_id,
         source_protocol_version_id, status, started_at, completed_at,
         recorded_by_practitioner_id, practitioner_role_id, source_type,
         amendment_of_encounter_id, amendment_reason, void_reason,
         source_revision, source_content_hash, source_created_at,
         source_updated_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, NULL, $15, $16, $17, $18, $19, $20, $21, $22, $23, $23
       )`,
      [
        encounterId,
        personId,
        session.id,
        context.installationId,
        context.organizationId,
        session.location_id,
        session.protocol_id,
        record.localResourceId,
        record.payload.localLocationId,
        record.payload.localProtocolVersionId,
        record.payload.status,
        record.payload.startedAt,
        record.payload.completedAt,
        recordedBy.practitioner_id,
        record.payload.sourceType,
        amendmentTargetId,
        record.payload.amendmentReason,
        record.payload.voidReason,
        record.sourceRevision,
        contentHash,
        record.payload.createdAt,
        record.payload.updatedAt,
        processedAt,
      ],
    );
    return finish(
      client,
      context,
      batchInternalId,
      mutationActor.id,
      record,
      recordHash,
      acceptedOutcome(record, 'ACCEPTED', encounterId),
      processedAt,
      retryRecordId,
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
