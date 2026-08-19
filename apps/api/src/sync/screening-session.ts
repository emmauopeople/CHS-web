import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import { canonicalJsonSha256 } from './canonical-json.js';
import { localDateAtInstant } from './local-date.js';
import type {
  InstallationContext,
  ScreeningSessionRecordOutcome,
  ScreeningSessionSyncRecord,
  SyncRecordError,
} from './types.js';

type SessionDatabase = Pick<Pool, 'connect'>;

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
  status: ScreeningSessionRecordOutcome['status'] | 'PROCESSING' | 'REVIEW_REQUIRED';
  screening_session_id: string | null;
  errors: SyncRecordError[];
}>;

type ProtocolSourceRow = Readonly<{
  protocol_id: string;
  protocol_key: string;
  version_label: string;
  checksum: string;
}>;

type ExistingSessionRow = Readonly<{
  id: string;
  location_id: string;
  protocol_id: string;
  source_location_id: string;
  source_protocol_version_id: string;
  session_date: string;
  status: 'OPEN' | 'CLOSED';
  opened_by_practitioner_id: string;
  closed_by_practitioner_id: string | null;
  opened_at: Date;
  closed_at: Date | null;
  source_revision: number;
  source_content_hash: string;
}>;

export type ScreeningSessionProcessingErrorCode =
  | 'BATCH_NOT_AVAILABLE'
  | 'SOURCE_ACTOR_NOT_AVAILABLE'
  | 'SCREENING_SESSION_INVARIANT';

export class ScreeningSessionProcessingError extends Error {
  constructor(readonly code: ScreeningSessionProcessingErrorCode) {
    super('Screening session synchronization processing failed');
    this.name = 'ScreeningSessionProcessingError';
  }
}

type RejectionCode =
  | 'LOCATION_CONTEXT_MISMATCH'
  | 'PROTOCOL_SOURCE_CONFLICT'
  | 'RECORD_PAYLOAD_MISMATCH'
  | 'SESSION_CLOSURE_CONFLICT'
  | 'SESSION_DATE_MISMATCH'
  | 'SESSION_IDENTITY_CONFLICT'
  | 'SESSION_PERIOD_INVALID'
  | 'SESSION_STATE_REGRESSION'
  | 'SOURCE_TIME_INVALID'
  | 'STALE_SOURCE_REVISION';

function outcomeBase(record: ScreeningSessionSyncRecord) {
  return {
    recordId: record.recordId,
    resourceType: 'SCREENING_SESSION' as const,
    localResourceId: record.localResourceId,
    sourceRevision: record.sourceRevision,
    centralPersonId: null,
    chsMedicalId: null,
    medicalIdStatus: null,
  };
}

function acceptedOutcome(
  record: ScreeningSessionSyncRecord,
  status: 'ACCEPTED' | 'UNCHANGED',
  sessionId: string,
): ScreeningSessionRecordOutcome {
  return {
    ...outcomeBase(record),
    status,
    canonicalResourceId: sessionId,
    errors: [],
  };
}

function rejectedOutcome(
  record: ScreeningSessionSyncRecord,
  code: RejectionCode,
  path: string,
): ScreeningSessionRecordOutcome {
  return {
    ...outcomeBase(record),
    status: 'REJECTED',
    canonicalResourceId: null,
    errors: [{ code, path, retryable: false }],
  };
}

function retryOutcome(
  record: ScreeningSessionSyncRecord,
): ScreeningSessionRecordOutcome {
  return {
    ...outcomeBase(record),
    status: 'RETRY',
    canonicalResourceId: null,
    errors: [{ code: 'RECORD_IN_PROGRESS', path: '', retryable: true }],
  };
}

async function existingOutcome(
  record: ScreeningSessionSyncRecord,
  existing: ExistingSyncRecordRow,
): Promise<ScreeningSessionRecordOutcome> {
  if (existing.status === 'ACCEPTED' || existing.status === 'UNCHANGED') {
    if (!existing.screening_session_id) {
      throw new ScreeningSessionProcessingError('SCREENING_SESSION_INVARIANT');
    }
    return acceptedOutcome(record, 'UNCHANGED', existing.screening_session_id);
  }
  if (existing.status === 'REJECTED') {
    return {
      ...outcomeBase(record),
      status: 'REJECTED',
      canonicalResourceId: null,
      errors: existing.errors,
    };
  }
  return retryOutcome(record);
}

async function persistOutcome(
  client: PoolClient,
  context: InstallationContext,
  batchInternalId: string,
  mutationActorId: string,
  record: ScreeningSessionSyncRecord,
  recordHash: string,
  outcome: ScreeningSessionRecordOutcome,
  processedAt: string,
) {
  await client.query(
    `INSERT INTO sync_records (
       id, batch_internal_id, installation_id, record_id, resource_type,
       local_resource_id, source_revision, schema_version, operation,
       captured_at, sync_batch_actor_id, payload_hash, status,
       screening_session_id, errors, processed_at, created_at
     ) VALUES (
       $1, $2, $3, $4, 'SCREENING_SESSION', $5, $6, $7, $8, $9, $10,
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

async function resolveProtocol(
  client: PoolClient,
  context: InstallationContext,
  record: ScreeningSessionSyncRecord,
  observedAt: string,
): Promise<string | null> {
  const payload = record.payload;
  const sourceResult = await client.query<ProtocolSourceRow>(
    `SELECT
       link.protocol_id,
       protocol.protocol_key,
       protocol.version_label,
       protocol.checksum
     FROM protocol_source_links AS link
     JOIN screening_protocols AS protocol
       ON protocol.id = link.protocol_id
      AND protocol.organization_id = link.organization_id
     WHERE link.installation_id = $1
       AND link.organization_id = $2
       AND link.local_protocol_version_id = $3
     FOR UPDATE OF link, protocol`,
    [context.installationId, context.organizationId, payload.localProtocolVersionId],
  );
  const source = sourceResult.rows[0];
  if (source) {
    if (
      source.protocol_key !== payload.protocolKey ||
      source.version_label !== payload.protocolVersionLabel ||
      source.checksum !== payload.protocolChecksum
    ) {
      return null;
    }
    await client.query(
      `UPDATE protocol_source_links
       SET last_observed_at = GREATEST(last_observed_at, $1::timestamptz)
       WHERE installation_id = $2 AND local_protocol_version_id = $3`,
      [observedAt, context.installationId, payload.localProtocolVersionId],
    );
    return source.protocol_id;
  }

  const protocolId = randomUUID();
  const protocolResult = await client.query<{ id: string }>(
    `INSERT INTO screening_protocols (
       id, organization_id, protocol_key, version_label, checksum, status,
       effective_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7, $7)
     ON CONFLICT (organization_id, protocol_key, version_label, checksum)
     DO UPDATE SET updated_at = GREATEST(screening_protocols.updated_at, EXCLUDED.updated_at)
     RETURNING id`,
    [
      protocolId,
      context.organizationId,
      payload.protocolKey,
      payload.protocolVersionLabel,
      payload.protocolChecksum,
      payload.openedAt,
      observedAt,
    ],
  );
  const canonicalProtocolId = protocolResult.rows[0]?.id;
  if (!canonicalProtocolId) {
    throw new ScreeningSessionProcessingError('SCREENING_SESSION_INVARIANT');
  }

  await client.query(
    `INSERT INTO protocol_source_links (
       id, protocol_id, installation_id, organization_id,
       local_protocol_version_id, first_observed_at, last_observed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [
      randomUUID(),
      canonicalProtocolId,
      context.installationId,
      context.organizationId,
      payload.localProtocolVersionId,
      observedAt,
    ],
  );
  return canonicalProtocolId;
}

function sameInstant(left: Date | null, right: string | null): boolean {
  if (left === null || right === null) return left === null && right === null;
  return left.toISOString() === new Date(right).toISOString();
}

function identityConflict(
  existing: ExistingSessionRow,
  batch: BatchRow,
  record: ScreeningSessionSyncRecord,
  protocolId: string,
  openedByPractitionerId: string,
): boolean {
  const payload = record.payload;
  return (
    existing.location_id !== batch.location_id ||
    existing.protocol_id !== protocolId ||
    existing.source_location_id !== payload.localLocationId ||
    existing.source_protocol_version_id !== payload.localProtocolVersionId ||
    existing.session_date !== payload.sessionDate ||
    existing.opened_by_practitioner_id !== openedByPractitionerId ||
    !sameInstant(existing.opened_at, payload.openedAt)
  );
}

async function finishRejected(
  client: PoolClient,
  context: InstallationContext,
  batchInternalId: string,
  mutationActorId: string,
  record: ScreeningSessionSyncRecord,
  recordHash: string,
  code: RejectionCode,
  path: string,
  processedAt: string,
): Promise<ScreeningSessionRecordOutcome> {
  const outcome = rejectedOutcome(record, code, path);
  await persistOutcome(
    client,
    context,
    batchInternalId,
    mutationActorId,
    record,
    recordHash,
    outcome,
    processedAt,
  );
  return outcome;
}

export async function processScreeningSessionRecord(
  database: SessionDatabase,
  context: InstallationContext,
  batchInternalId: string,
  record: ScreeningSessionSyncRecord,
  now: Date = new Date(),
): Promise<ScreeningSessionRecordOutcome> {
  const processedAt = now.toISOString();
  const recordHash = canonicalJsonSha256(record);
  const contentHash = canonicalJsonSha256(record.payload);
  const client = await database.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('chs.screening-session.v1'))`);

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
      throw new ScreeningSessionProcessingError('BATCH_NOT_AVAILABLE');
    }

    const actorIds = [
      record.sourceActorLocalId,
      record.payload.openedByLocalActorId,
      ...(record.payload.closedByLocalActorId
        ? [record.payload.closedByLocalActorId]
        : []),
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
    const openedBy = actors.get(record.payload.openedByLocalActorId);
    const closedBy = record.payload.closedByLocalActorId
      ? actors.get(record.payload.closedByLocalActorId)
      : undefined;
    if (!mutationActor || !openedBy || (record.payload.closedByLocalActorId && !closedBy)) {
      throw new ScreeningSessionProcessingError('SOURCE_ACTOR_NOT_AVAILABLE');
    }

    const priorResult = await client.query<ExistingSyncRecordRow>(
      `SELECT
         id, payload_hash, status, screening_session_id, errors
       FROM sync_records
       WHERE installation_id = $1
         AND (
           record_id = $2
           OR (
             resource_type = 'SCREENING_SESSION'
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
    if (priorResult.rows.length > 0) {
      const mismatch =
        new Set(priorResult.rows.map((prior) => prior.id)).size > 1 ||
        priorResult.rows.some((prior) => prior.payload_hash !== recordHash);
      const outcome = mismatch
        ? rejectedOutcome(record, 'RECORD_PAYLOAD_MISMATCH', '')
        : await existingOutcome(record, priorResult.rows[0]!);
      await client.query('COMMIT');
      return outcome;
    }

    if (record.payload.localLocationId !== batch.source_location_id) {
      const outcome = await finishRejected(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        'LOCATION_CONTEXT_MISMATCH',
        '/payload/localLocationId',
        processedAt,
      );
      await client.query('COMMIT');
      return outcome;
    }
    if (
      new Date(record.payload.updatedAt) < new Date(record.payload.createdAt)
    ) {
      const outcome = await finishRejected(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        'SOURCE_TIME_INVALID',
        '/payload/updatedAt',
        processedAt,
      );
      await client.query('COMMIT');
      return outcome;
    }
    if (
      record.payload.closedAt !== null &&
      new Date(record.payload.closedAt) < new Date(record.payload.openedAt)
    ) {
      const outcome = await finishRejected(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        'SESSION_PERIOD_INVALID',
        '/payload/closedAt',
        processedAt,
      );
      await client.query('COMMIT');
      return outcome;
    }
    if (
      localDateAtInstant(record.payload.openedAt, context.timezone) !==
      record.payload.sessionDate
    ) {
      const outcome = await finishRejected(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        'SESSION_DATE_MISMATCH',
        '/payload/sessionDate',
        processedAt,
      );
      await client.query('COMMIT');
      return outcome;
    }

    const existingResult = await client.query<ExistingSessionRow>(
      `SELECT
         id, location_id, protocol_id, source_location_id,
         source_protocol_version_id, session_date::text AS session_date,
         status, opened_by_practitioner_id, closed_by_practitioner_id,
         opened_at, closed_at, source_revision, source_content_hash
       FROM screening_sessions
       WHERE installation_id = $1 AND local_session_id = $2
       FOR UPDATE`,
      [context.installationId, record.localResourceId],
    );
    const existing = existingResult.rows[0];
    if (existing) {
      if (record.sourceRevision < existing.source_revision) {
        const outcome = await finishRejected(
          client,
          context,
          batchInternalId,
          mutationActor.id,
          record,
          recordHash,
          'STALE_SOURCE_REVISION',
          '/sourceRevision',
          processedAt,
        );
        await client.query('COMMIT');
        return outcome;
      }
      if (
        record.sourceRevision === existing.source_revision &&
        contentHash !== existing.source_content_hash
      ) {
        const outcome = await finishRejected(
          client,
          context,
          batchInternalId,
          mutationActor.id,
          record,
          recordHash,
          'RECORD_PAYLOAD_MISMATCH',
          '/payload',
          processedAt,
        );
        await client.query('COMMIT');
        return outcome;
      }
      if (record.sourceRevision === existing.source_revision) {
        const outcome = acceptedOutcome(record, 'UNCHANGED', existing.id);
        await persistOutcome(
          client,
          context,
          batchInternalId,
          mutationActor.id,
          record,
          recordHash,
          outcome,
          processedAt,
        );
        await client.query('COMMIT');
        return outcome;
      }
      if (
        existing.source_location_id !== record.payload.localLocationId ||
        existing.source_protocol_version_id !== record.payload.localProtocolVersionId
      ) {
        const outcome = await finishRejected(
          client,
          context,
          batchInternalId,
          mutationActor.id,
          record,
          recordHash,
          'SESSION_IDENTITY_CONFLICT',
          '/payload',
          processedAt,
        );
        await client.query('COMMIT');
        return outcome;
      }
    }

    const protocolId = await resolveProtocol(client, context, record, processedAt);
    if (!protocolId) {
      const outcome = await finishRejected(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        'PROTOCOL_SOURCE_CONFLICT',
        '/payload/protocolChecksum',
        processedAt,
      );
      await client.query('COMMIT');
      return outcome;
    }

    if (existing) {
      if (
        identityConflict(
          existing,
          batch,
          record,
          protocolId,
          openedBy.practitioner_id,
        )
      ) {
        const outcome = await finishRejected(
          client,
          context,
          batchInternalId,
          mutationActor.id,
          record,
          recordHash,
          'SESSION_IDENTITY_CONFLICT',
          '/payload',
          processedAt,
        );
        await client.query('COMMIT');
        return outcome;
      }
      if (existing.status === 'CLOSED' && record.payload.status === 'OPEN') {
        const outcome = await finishRejected(
          client,
          context,
          batchInternalId,
          mutationActor.id,
          record,
          recordHash,
          'SESSION_STATE_REGRESSION',
          '/payload/status',
          processedAt,
        );
        await client.query('COMMIT');
        return outcome;
      }
      if (
        existing.status === 'CLOSED' &&
        record.payload.status === 'CLOSED' &&
        (existing.closed_by_practitioner_id !== closedBy?.practitioner_id ||
          !sameInstant(existing.closed_at, record.payload.closedAt))
      ) {
        const outcome = await finishRejected(
          client,
          context,
          batchInternalId,
          mutationActor.id,
          record,
          recordHash,
          'SESSION_CLOSURE_CONFLICT',
          '/payload/closedAt',
          processedAt,
        );
        await client.query('COMMIT');
        return outcome;
      }

      await client.query(
        `UPDATE screening_sessions
         SET status = $1,
             notes = $2,
             closed_by_practitioner_id = $3,
             closed_at = $4,
             source_revision = $5,
             source_content_hash = $6,
             source_created_at = $7,
             source_updated_at = $8,
             updated_at = $9
         WHERE id = $10`,
        [
          record.payload.status,
          record.payload.notes,
          closedBy?.practitioner_id ?? null,
          record.payload.closedAt,
          record.sourceRevision,
          contentHash,
          record.payload.createdAt,
          record.payload.updatedAt,
          processedAt,
          existing.id,
        ],
      );
      const outcome = acceptedOutcome(record, 'ACCEPTED', existing.id);
      await persistOutcome(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        outcome,
        processedAt,
      );
      await client.query('COMMIT');
      return outcome;
    }

    const sessionId = randomUUID();
    await client.query(
      `INSERT INTO screening_sessions (
         id, installation_id, organization_id, location_id, protocol_id,
         local_session_id, source_location_id, source_protocol_version_id,
         session_date, status, notes, opened_by_practitioner_id,
         closed_by_practitioner_id, opened_at, closed_at, source_revision,
         source_content_hash, source_created_at, source_updated_at, created_at,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20, $20
       )`,
      [
        sessionId,
        context.installationId,
        context.organizationId,
        batch.location_id,
        protocolId,
        record.localResourceId,
        record.payload.localLocationId,
        record.payload.localProtocolVersionId,
        record.payload.sessionDate,
        record.payload.status,
        record.payload.notes,
        openedBy.practitioner_id,
        closedBy?.practitioner_id ?? null,
        record.payload.openedAt,
        record.payload.closedAt,
        record.sourceRevision,
        contentHash,
        record.payload.createdAt,
        record.payload.updatedAt,
        processedAt,
      ],
    );
    const outcome = acceptedOutcome(record, 'ACCEPTED', sessionId);
    await persistOutcome(
      client,
      context,
      batchInternalId,
      mutationActor.id,
      record,
      recordHash,
      outcome,
      processedAt,
    );
    await client.query('COMMIT');
    return outcome;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
