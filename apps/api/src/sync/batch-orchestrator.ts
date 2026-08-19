import type { Pool, PoolClient } from 'pg';

import { validateSyncBatchResponse } from '../../../../packages/contracts/src/sync-validation.mjs';

import { beginSyncBatch } from './batch-intake.js';
import { processPatientRecord } from './patient-identity.js';
import { processScreeningEncounterRecord } from './screening-encounter.js';
import { processScreeningSessionRecord } from './screening-session.js';
import type {
  InstallationContext,
  PatientSyncRecord,
  ScreeningEncounterSyncRecord,
  ScreeningSessionSyncRecord,
  SyncBatchRequest,
  SyncBatchResponse,
  SyncBatchStatus,
  SyncRecordOutcome,
  SyncRecordSnapshot,
  VitalsSyncRecord,
} from './types.js';
import { processVitalsRecord } from './vitals.js';

type OrchestrationDatabase = Pick<Pool, 'connect'>;

type StoredBatchRow = Readonly<{
  status: 'PROCESSING' | 'ACCEPTED' | 'PARTIAL' | 'REJECTED' | 'FAILED';
  received_at: Date;
  response_body: SyncBatchResponse | null;
}>;

type LockResultRow = Readonly<{ locked: boolean }>;

export type BatchOrchestrationErrorCode =
  | 'BATCH_IN_PROGRESS'
  | 'BATCH_NOT_AVAILABLE'
  | 'BATCH_RESPONSE_INVALID';

export class BatchOrchestrationError extends Error {
  constructor(readonly code: BatchOrchestrationErrorCode) {
    super('Synchronization batch orchestration failed');
    this.name = 'BatchOrchestrationError';
  }
}

export type SyncBatchSubmission = Readonly<{
  response: SyncBatchResponse;
  replayed: boolean;
}>;

type Processor = (
  database: OrchestrationDatabase,
  context: InstallationContext,
  batchInternalId: string,
  record: never,
  now: Date,
) => Promise<SyncRecordOutcome>;

export type BatchOrchestratorOptions = Readonly<{
  clock?: () => Date;
  processors?: Partial<Record<SyncRecordSnapshot['resourceType'], Processor>>;
}>;

const resourcePriority: Readonly<Record<SyncRecordSnapshot['resourceType'], number>> = {
  PATIENT: 0,
  SCREENING_SESSION: 1,
  SCREENING_ENCOUNTER: 2,
  VITALS: 3,
};

export function orderSyncRecords(
  records: readonly SyncRecordSnapshot[],
): readonly SyncRecordSnapshot[] {
  return [...records].sort((left, right) => {
    const resourceOrder =
      resourcePriority[left.resourceType] - resourcePriority[right.resourceType];
    if (resourceOrder !== 0) return resourceOrder;

    const localOrder = left.localResourceId.localeCompare(right.localResourceId);
    if (localOrder !== 0) return localOrder;

    const revisionOrder = left.sourceRevision - right.sourceRevision;
    return revisionOrder !== 0
      ? revisionOrder
      : left.recordId.localeCompare(right.recordId);
  });
}

export function deriveBatchStatus(
  outcomes: readonly SyncRecordOutcome[],
): SyncBatchStatus {
  if (
    outcomes.every(
      (outcome) => outcome.status === 'ACCEPTED' || outcome.status === 'UNCHANGED',
    )
  ) {
    return 'ACCEPTED';
  }
  if (
    outcomes.every(
      (outcome) => outcome.status === 'REJECTED' || outcome.status === 'RETRY',
    )
  ) {
    return 'REJECTED';
  }
  return 'PARTIAL';
}

function processorFor(
  record: SyncRecordSnapshot,
  overrides: BatchOrchestratorOptions['processors'],
): Processor {
  const override = overrides?.[record.resourceType];
  if (override) return override;

  switch (record.resourceType) {
    case 'PATIENT':
      return processPatientRecord as Processor;
    case 'SCREENING_SESSION':
      return processScreeningSessionRecord as Processor;
    case 'SCREENING_ENCOUNTER':
      return processScreeningEncounterRecord as Processor;
    case 'VITALS':
      return processVitalsRecord as Processor;
  }
}

function typedRecord(record: SyncRecordSnapshot): never {
  switch (record.resourceType) {
    case 'PATIENT':
      return record as PatientSyncRecord as never;
    case 'SCREENING_SESSION':
      return record as ScreeningSessionSyncRecord as never;
    case 'SCREENING_ENCOUNTER':
      return record as ScreeningEncounterSyncRecord as never;
    case 'VITALS':
      return record as VitalsSyncRecord as never;
  }
}

function isDependencyRetry(outcome: SyncRecordOutcome): boolean {
  return (
    outcome.status === 'RETRY' &&
    outcome.errors.some((error) => error.code === 'DEPENDENCY_NOT_AVAILABLE')
  );
}

async function processRecords(
  database: OrchestrationDatabase,
  context: InstallationContext,
  batchInternalId: string,
  request: SyncBatchRequest,
  options: BatchOrchestratorOptions,
): Promise<readonly SyncRecordOutcome[]> {
  const clock = options.clock ?? (() => new Date());
  const ordered = orderSyncRecords(request.records);
  const outcomes = new Map<string, SyncRecordOutcome>();

  for (const record of ordered) {
    const processor = processorFor(record, options.processors);
    outcomes.set(
      record.recordId,
      await processor(
        database,
        context,
        batchInternalId,
        typedRecord(record),
        clock(),
      ),
    );
  }

  for (let pass = 0; pass < ordered.length; pass += 1) {
    const pending = ordered.filter((record) => {
      const outcome = outcomes.get(record.recordId);
      return outcome ? isDependencyRetry(outcome) : false;
    });
    if (pending.length === 0) break;

    let resolved = 0;
    for (const record of pending) {
      const processor = processorFor(record, options.processors);
      const next = await processor(
        database,
        context,
        batchInternalId,
        typedRecord(record),
        clock(),
      );
      outcomes.set(record.recordId, next);
      if (!isDependencyRetry(next)) resolved += 1;
    }
    if (resolved === 0) break;
  }

  return request.records.map((record) => {
    const outcome = outcomes.get(record.recordId);
    if (!outcome) throw new BatchOrchestrationError('BATCH_RESPONSE_INVALID');
    return outcome;
  });
}

function countOutcomes(outcomes: readonly SyncRecordOutcome[]) {
  return outcomes.reduce(
    (counts, outcome) => {
      if (outcome.status === 'ACCEPTED') counts.accepted += 1;
      else if (outcome.status === 'UNCHANGED') counts.unchanged += 1;
      else if (outcome.status === 'REVIEW_REQUIRED') counts.review += 1;
      else if (outcome.status === 'REJECTED') counts.rejected += 1;
      else counts.retry += 1;
      return counts;
    },
    { accepted: 0, unchanged: 0, review: 0, rejected: 0, retry: 0 },
  );
}

async function prepareClaimedBatch(
  client: PoolClient,
  context: InstallationContext,
  batchInternalId: string,
): Promise<StoredBatchRow> {
  await client.query('BEGIN');
  try {
    const result = await client.query<StoredBatchRow>(
      `SELECT status, received_at, response_body
       FROM sync_batches
       WHERE id = $1
         AND installation_id = $2
         AND organization_id = $3
       FOR UPDATE`,
      [batchInternalId, context.installationId, context.organizationId],
    );
    const row = result.rows[0];
    if (!row) throw new BatchOrchestrationError('BATCH_NOT_AVAILABLE');

    if (row.response_body === null && row.status === 'FAILED') {
      await client.query(
        `UPDATE sync_batches
         SET status = 'PROCESSING',
             completed_at = NULL,
             accepted_count = 0,
             unchanged_count = 0,
             review_count = 0,
             rejected_count = 0,
             retry_count = 0,
             response_body = NULL
         WHERE id = $1`,
        [batchInternalId],
      );
      await client.query('COMMIT');
      return { ...row, status: 'PROCESSING' };
    }

    if (row.response_body === null && row.status !== 'PROCESSING') {
      throw new BatchOrchestrationError('BATCH_NOT_AVAILABLE');
    }
    await client.query('COMMIT');
    return row;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function completeBatch(
  client: PoolClient,
  context: InstallationContext,
  batchInternalId: string,
  request: SyncBatchRequest,
  receivedAt: Date,
  outcomes: readonly SyncRecordOutcome[],
  completedAt: Date,
): Promise<SyncBatchResponse> {
  const response: SyncBatchResponse = {
    contractVersion: '1.0',
    batchId: request.batchId,
    batchStatus: deriveBatchStatus(outcomes),
    receivedAt: receivedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    outcomes,
  };
  if (!validateSyncBatchResponse(response).valid) {
    throw new BatchOrchestrationError('BATCH_RESPONSE_INVALID');
  }
  const counts = countOutcomes(outcomes);

  await client.query('BEGIN');
  try {
    const result = await client.query(
      `UPDATE sync_batches
       SET status = $1,
           completed_at = $2,
           accepted_count = $3,
           unchanged_count = $4,
           review_count = $5,
           rejected_count = $6,
           retry_count = $7,
           response_body = $8::jsonb
       WHERE id = $9
         AND installation_id = $10
         AND organization_id = $11
         AND status = 'PROCESSING'
         AND response_body IS NULL`,
      [
        response.batchStatus,
        response.completedAt,
        counts.accepted,
        counts.unchanged,
        counts.review,
        counts.rejected,
        counts.retry,
        JSON.stringify(response),
        batchInternalId,
        context.installationId,
        context.organizationId,
      ],
    );
    if (result.rowCount !== 1) {
      throw new BatchOrchestrationError('BATCH_NOT_AVAILABLE');
    }
    await client.query(
      `UPDATE desktop_installations
       SET last_seen_at = GREATEST(COALESCE(last_seen_at, $1::timestamptz), $1),
           updated_at = GREATEST(updated_at, $1::timestamptz)
       WHERE id = $2 AND organization_id = $3`,
      [response.completedAt, context.installationId, context.organizationId],
    );
    await client.query('COMMIT');
    return response;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function submitSyncBatch(
  database: OrchestrationDatabase,
  context: InstallationContext,
  request: SyncBatchRequest,
  options: BatchOrchestratorOptions = {},
): Promise<SyncBatchSubmission> {
  const clock = options.clock ?? (() => new Date());
  const intake = await beginSyncBatch(database, context, request, clock());
  if (intake.kind === 'REPLAY') {
    const validation = validateSyncBatchResponse(intake.response);
    if (!validation.valid) {
      throw new BatchOrchestrationError('BATCH_RESPONSE_INVALID');
    }
    return { response: intake.response as SyncBatchResponse, replayed: true };
  }

  const client = await database.connect();
  const lockName = `chs.sync-batch.v1:${intake.batchInternalId}`;
  let locked = false;
  try {
    const lockResult = await client.query<LockResultRow>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [lockName],
    );
    locked = lockResult.rows[0]?.locked === true;
    if (!locked) throw new BatchOrchestrationError('BATCH_IN_PROGRESS');

    const batch = await prepareClaimedBatch(
      client,
      context,
      intake.batchInternalId,
    );
    if (batch.response_body !== null) {
      if (!validateSyncBatchResponse(batch.response_body).valid) {
        throw new BatchOrchestrationError('BATCH_RESPONSE_INVALID');
      }
      return { response: batch.response_body, replayed: true };
    }

    const outcomes = await processRecords(
      database,
      context,
      intake.batchInternalId,
      request,
      options,
    );
    const response = await completeBatch(
      client,
      context,
      intake.batchInternalId,
      request,
      batch.received_at,
      outcomes,
      clock(),
    );
    return { response, replayed: false };
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
        lockName,
      ]);
    }
    client.release();
  }
}

export async function getStoredSyncBatchResponse(
  database: Pick<Pool, 'query'>,
  context: InstallationContext,
  batchId: string,
): Promise<SyncBatchResponse> {
  const result = await database.query<{ response_body: unknown | null }>(
    `SELECT response_body
     FROM sync_batches
     WHERE installation_id = $1
       AND organization_id = $2
       AND batch_id = $3`,
    [context.installationId, context.organizationId, batchId],
  );
  const row = result.rows[0];
  if (!row) throw new BatchOrchestrationError('BATCH_NOT_AVAILABLE');
  if (row.response_body === null) {
    throw new BatchOrchestrationError('BATCH_IN_PROGRESS');
  }
  if (!validateSyncBatchResponse(row.response_body).valid) {
    throw new BatchOrchestrationError('BATCH_RESPONSE_INVALID');
  }
  return row.response_body as SyncBatchResponse;
}
