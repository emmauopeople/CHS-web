import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import { canonicalJsonSha256 } from './canonical-json.js';
import { localMeasurementTimeToInstant } from './measurement-time.js';
import type {
  InstallationContext,
  SyncRecordError,
  VitalsReadingPayload,
  VitalsRecordOutcome,
  VitalsSyncRecord,
} from './types.js';

type VitalsDatabase = Pick<Pool, 'connect'>;

type BatchRow = Readonly<{
  location_id: string;
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
  status: VitalsRecordOutcome['status'] | 'PROCESSING' | 'REVIEW_REQUIRED';
  screening_vital_set_id: string | null;
  errors: SyncRecordError[];
}>;

type EncounterRow = Readonly<{
  id: string;
  person_id: string;
  organization_id: string;
  location_id: string;
  status: 'DRAFT' | 'COMPLETED' | 'AMENDED' | 'VOID';
  started_at: Date;
  completed_at: Date | null;
  recorded_by_practitioner_id: string;
}>;

type ExistingVitalSetRow = Readonly<{
  id: string;
  encounter_id: string;
  person_id: string;
  local_vitals_id: string;
  status: 'DRAFT' | 'VITALS_COMPLETE';
  recorded_by_practitioner_id: string;
  source_revision: number;
  source_content_hash: string;
  source_created_at: Date;
}>;

type EncounterVitalSetRow = Readonly<{
  id: string;
  local_vitals_id: string;
}>;

type ExistingReadingRow = Readonly<{
  id: string;
  local_reading_id: string;
  sequence_number: number;
  source_created_at: Date;
}>;

type PreparedReading = Readonly<{
  payload: VitalsReadingPayload;
  measuredAt: string | null;
}>;

export type VitalsProcessingErrorCode =
  | 'BATCH_NOT_AVAILABLE'
  | 'SOURCE_ACTOR_NOT_AVAILABLE'
  | 'VITALS_INVARIANT';

export class VitalsProcessingError extends Error {
  constructor(readonly code: VitalsProcessingErrorCode) {
    super('Vitals synchronization processing failed');
    this.name = 'VitalsProcessingError';
  }
}

type RejectionCode =
  | 'ENCOUNTER_CONTEXT_MISMATCH'
  | 'ENCOUNTER_VOID'
  | 'MEASUREMENT_PERIOD_INVALID'
  | 'MEASUREMENT_TIME_AMBIGUOUS'
  | 'MEASUREMENT_TIME_INVALID'
  | 'MEASUREMENT_TIMEZONE_MISMATCH'
  | 'PERFORMER_CONTEXT_MISMATCH'
  | 'READING_IDENTITY_CONFLICT'
  | 'READING_ORDER_CONFLICT'
  | 'READING_SET_INVALID'
  | 'READING_SOURCE_TIME_INVALID'
  | 'RECORD_PAYLOAD_MISMATCH'
  | 'SOURCE_TIME_INVALID'
  | 'STALE_SOURCE_REVISION'
  | 'VITAL_SET_ENCOUNTER_CONFLICT'
  | 'VITAL_SET_IDENTITY_CONFLICT'
  | 'VITALS_STATE_INVALID'
  | 'VITALS_STATE_REGRESSION'
  | 'VITALS_TERMINAL_CONFLICT';

type ValidationFailure = Readonly<{
  code: RejectionCode;
  path: string;
}>;

function outcomeBase(record: VitalsSyncRecord) {
  return {
    recordId: record.recordId,
    resourceType: 'VITALS' as const,
    localResourceId: record.localResourceId,
    sourceRevision: record.sourceRevision,
    centralPersonId: null,
    chsMedicalId: null,
    medicalIdStatus: null,
  };
}

function acceptedOutcome(
  record: VitalsSyncRecord,
  status: 'ACCEPTED' | 'UNCHANGED',
  vitalSetId: string,
): VitalsRecordOutcome {
  return {
    ...outcomeBase(record),
    status,
    canonicalResourceId: vitalSetId,
    errors: [],
  };
}

function rejectedOutcome(
  record: VitalsSyncRecord,
  code: RejectionCode,
  path: string,
): VitalsRecordOutcome {
  return {
    ...outcomeBase(record),
    status: 'REJECTED',
    canonicalResourceId: null,
    errors: [{ code, path, retryable: false }],
  };
}

function dependencyOutcome(record: VitalsSyncRecord): VitalsRecordOutcome {
  return {
    ...outcomeBase(record),
    status: 'RETRY',
    canonicalResourceId: null,
    errors: [
      {
        code: 'DEPENDENCY_NOT_AVAILABLE',
        path: '/payload/localEncounterId',
        retryable: true,
      },
    ],
  };
}

function inProgressOutcome(record: VitalsSyncRecord): VitalsRecordOutcome {
  return {
    ...outcomeBase(record),
    status: 'RETRY',
    canonicalResourceId: null,
    errors: [{ code: 'RECORD_IN_PROGRESS', path: '', retryable: true }],
  };
}

function outcomeFromExisting(
  record: VitalsSyncRecord,
  existing: ExistingSyncRecordRow,
): VitalsRecordOutcome {
  if (existing.status === 'ACCEPTED' || existing.status === 'UNCHANGED') {
    if (!existing.screening_vital_set_id) {
      throw new VitalsProcessingError('VITALS_INVARIANT');
    }
    return acceptedOutcome(record, 'UNCHANGED', existing.screening_vital_set_id);
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
  record: VitalsSyncRecord,
  recordHash: string,
  outcome: VitalsRecordOutcome,
  processedAt: string,
  retryRecordId: string | null,
) {
  if (retryRecordId) {
    const result = await client.query(
      `UPDATE sync_records
       SET status = $1,
           screening_vital_set_id = $2,
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
      throw new VitalsProcessingError('VITALS_INVARIANT');
    }
    return;
  }

  await client.query(
    `INSERT INTO sync_records (
       id, batch_internal_id, installation_id, record_id, resource_type,
       local_resource_id, source_revision, schema_version, operation,
       captured_at, sync_batch_actor_id, payload_hash, status,
       screening_vital_set_id, errors, processed_at, created_at
     ) VALUES (
       $1, $2, $3, $4, 'VITALS', $5, $6, $7, $8, $9, $10, $11, $12,
       $13, $14::jsonb, $15, $15
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

async function finish(
  client: PoolClient,
  context: InstallationContext,
  batchInternalId: string,
  mutationActorId: string,
  record: VitalsSyncRecord,
  recordHash: string,
  outcome: VitalsRecordOutcome,
  processedAt: string,
  retryRecordId: string | null,
): Promise<VitalsRecordOutcome> {
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

function validateReadingSet(record: VitalsSyncRecord): ValidationFailure | null {
  const idSet = new Set<string>();
  const sequenceSet = new Set<number>();
  const sortedSequences = [...record.payload.readings]
    .map((reading) => reading.sequenceNumber)
    .sort((left, right) => left - right);
  if (
    sortedSequences.some((sequence, index) => sequence !== index + 1)
  ) {
    return { code: 'READING_SET_INVALID', path: '/payload/readings' };
  }

  for (const [index, reading] of record.payload.readings.entries()) {
    if (
      idSet.has(reading.localReadingId) ||
      sequenceSet.has(reading.sequenceNumber)
    ) {
      return { code: 'READING_SET_INVALID', path: '/payload/readings' };
    }
    idSet.add(reading.localReadingId);
    sequenceSet.add(reading.sequenceNumber);

    if (new Date(reading.updatedAt) < new Date(reading.createdAt)) {
      return {
        code: 'READING_SOURCE_TIME_INVALID',
        path: `/payload/readings/${index}/updatedAt`,
      };
    }
    if (
      record.payload.status === 'VITALS_COMPLETE' &&
      (reading.systolic === null ||
        reading.diastolic === null ||
        reading.pulse === null ||
        reading.measurementSite === null ||
        reading.patientPosition === null ||
        reading.measurementLocalTime === null)
    ) {
      return {
        code: 'VITALS_STATE_INVALID',
        path: `/payload/readings/${index}`,
      };
    }
  }
  return null;
}

function prepareReadings(
  record: VitalsSyncRecord,
  context: InstallationContext,
  encounter: EncounterRow,
): PreparedReading[] | ValidationFailure {
  const prepared: PreparedReading[] = [];
  let priorInstant: number | null = null;
  const readings = [...record.payload.readings].sort(
    (left, right) => left.sequenceNumber - right.sequenceNumber,
  );

  for (const reading of readings) {
    const index = record.payload.readings.indexOf(reading);
    const basePath = `/payload/readings/${index}`;
    if (reading.measurementTimezone !== context.timezone) {
      return {
        code: 'MEASUREMENT_TIMEZONE_MISMATCH',
        path: `${basePath}/measurementTimezone`,
      };
    }
    if (reading.measurementLocalTime === null) {
      prepared.push({ payload: reading, measuredAt: null });
      continue;
    }

    let converted: ReturnType<typeof localMeasurementTimeToInstant>;
    try {
      converted = localMeasurementTimeToInstant(
        reading.measurementLocalDate,
        reading.measurementLocalTime,
        reading.measurementTimezone,
      );
    } catch (error) {
      if (error instanceof RangeError) {
        return {
          code: 'MEASUREMENT_TIME_INVALID',
          path: `${basePath}/measurementTimezone`,
        };
      }
      throw error;
    }
    if (converted.kind === 'INVALID') {
      return {
        code: 'MEASUREMENT_TIME_INVALID',
        path: `${basePath}/measurementLocalTime`,
      };
    }
    if (converted.kind === 'AMBIGUOUS') {
      return {
        code: 'MEASUREMENT_TIME_AMBIGUOUS',
        path: `${basePath}/measurementLocalTime`,
      };
    }

    const instant = new Date(converted.instant).getTime();
    if (
      instant < encounter.started_at.getTime() ||
      (encounter.completed_at !== null &&
        instant > encounter.completed_at.getTime()) ||
      (priorInstant !== null && instant < priorInstant)
    ) {
      return { code: 'MEASUREMENT_PERIOD_INVALID', path: basePath };
    }
    priorInstant = instant;
    prepared.push({ payload: reading, measuredAt: converted.instant });
  }
  return prepared;
}

function identityConflict(
  existing: ExistingVitalSetRow,
  encounter: EncounterRow,
  performerId: string,
  record: VitalsSyncRecord,
): boolean {
  return (
    existing.encounter_id !== encounter.id ||
    existing.person_id !== encounter.person_id ||
    existing.recorded_by_practitioner_id !== performerId ||
    existing.local_vitals_id !== record.localResourceId ||
    existing.source_created_at.toISOString() !==
      new Date(record.payload.createdAt).toISOString()
  );
}

function sharedReadingOrderChanged(
  existing: readonly ExistingReadingRow[],
  readings: readonly PreparedReading[],
): boolean {
  const incomingIds = new Set(readings.map((reading) => reading.payload.localReadingId));
  const existingIds = new Set(existing.map((reading) => reading.local_reading_id));
  const oldShared = [...existing]
    .sort((left, right) => left.sequence_number - right.sequence_number)
    .filter((reading) => incomingIds.has(reading.local_reading_id))
    .map((reading) => reading.local_reading_id);
  const newShared = [...readings]
    .sort((left, right) => left.payload.sequenceNumber - right.payload.sequenceNumber)
    .filter((reading) => existingIds.has(reading.payload.localReadingId))
    .map((reading) => reading.payload.localReadingId);
  return oldShared.some((id, index) => id !== newShared[index]);
}

async function insertReading(
  client: PoolClient,
  vitalSetId: string,
  reading: PreparedReading,
  processedAt: string,
) {
  const payload = reading.payload;
  await client.query(
    `INSERT INTO vital_readings (
       id, vital_set_id, local_reading_id, sequence_number, systolic_mmhg,
       diastolic_mmhg, pulse_bpm, measurement_site, patient_position,
       measurement_local_date, measurement_local_time, measurement_timezone,
       measured_at, source_created_at, source_updated_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14, $15, $16, $16
     )`,
    [
      randomUUID(),
      vitalSetId,
      payload.localReadingId,
      payload.sequenceNumber,
      payload.systolic,
      payload.diastolic,
      payload.pulse,
      payload.measurementSite,
      payload.patientPosition,
      payload.measurementLocalDate,
      payload.measurementLocalTime,
      payload.measurementTimezone,
      reading.measuredAt,
      payload.createdAt,
      payload.updatedAt,
      processedAt,
    ],
  );
}

async function updateReading(
  client: PoolClient,
  existing: ExistingReadingRow,
  reading: PreparedReading,
  processedAt: string,
) {
  const payload = reading.payload;
  await client.query(
    `UPDATE vital_readings
     SET sequence_number = $1,
         systolic_mmhg = $2,
         diastolic_mmhg = $3,
         pulse_bpm = $4,
         measurement_site = $5,
         patient_position = $6,
         measurement_local_date = $7,
         measurement_local_time = $8,
         measurement_timezone = $9,
         measured_at = $10,
         source_updated_at = $11,
         updated_at = $12
     WHERE id = $13`,
    [
      payload.sequenceNumber,
      payload.systolic,
      payload.diastolic,
      payload.pulse,
      payload.measurementSite,
      payload.patientPosition,
      payload.measurementLocalDate,
      payload.measurementLocalTime,
      payload.measurementTimezone,
      reading.measuredAt,
      payload.updatedAt,
      processedAt,
      existing.id,
    ],
  );
}

async function synchronizeDraftReadings(
  client: PoolClient,
  vitalSetId: string,
  readings: readonly PreparedReading[],
  processedAt: string,
): Promise<ValidationFailure | null> {
  const result = await client.query<ExistingReadingRow>(
    `SELECT id, local_reading_id, sequence_number, source_created_at
     FROM vital_readings
     WHERE vital_set_id = $1
     ORDER BY sequence_number
     FOR UPDATE`,
    [vitalSetId],
  );
  const existing = result.rows;
  if (sharedReadingOrderChanged(existing, readings)) {
    return { code: 'READING_ORDER_CONFLICT', path: '/payload/readings' };
  }

  const incomingById = new Map(
    readings.map((reading) => [reading.payload.localReadingId, reading]),
  );
  const existingById = new Map(
    existing.map((reading) => [reading.local_reading_id, reading]),
  );
  for (const current of existing) {
    const incoming = incomingById.get(current.local_reading_id);
    if (
      incoming &&
      current.source_created_at.toISOString() !==
        new Date(incoming.payload.createdAt).toISOString()
    ) {
      return {
        code: 'READING_IDENTITY_CONFLICT',
        path: '/payload/readings',
      };
    }
  }

  const removedIds = existing
    .filter((reading) => !incomingById.has(reading.local_reading_id))
    .map((reading) => reading.local_reading_id);
  if (removedIds.length > 0) {
    await client.query(
      `DELETE FROM vital_readings
       WHERE vital_set_id = $1 AND local_reading_id = ANY($2::uuid[])`,
      [vitalSetId, removedIds],
    );
  }

  const shared = readings
    .map((reading) => ({ reading, existing: existingById.get(reading.payload.localReadingId) }))
    .filter(
      (entry): entry is { reading: PreparedReading; existing: ExistingReadingRow } =>
        entry.existing !== undefined,
    );
  const lower = shared
    .filter((entry) => entry.reading.payload.sequenceNumber < entry.existing.sequence_number)
    .sort((left, right) => left.existing.sequence_number - right.existing.sequence_number);
  const higher = shared
    .filter((entry) => entry.reading.payload.sequenceNumber > entry.existing.sequence_number)
    .sort((left, right) => right.existing.sequence_number - left.existing.sequence_number);
  const unchanged = shared.filter(
    (entry) => entry.reading.payload.sequenceNumber === entry.existing.sequence_number,
  );
  for (const entry of [...lower, ...higher, ...unchanged]) {
    await updateReading(client, entry.existing, entry.reading, processedAt);
  }
  for (const reading of readings.filter(
    (candidate) => !existingById.has(candidate.payload.localReadingId),
  )) {
    await insertReading(client, vitalSetId, reading, processedAt);
  }
  return null;
}

export async function processVitalsRecord(
  database: VitalsDatabase,
  context: InstallationContext,
  batchInternalId: string,
  record: VitalsSyncRecord,
  now: Date = new Date(),
): Promise<VitalsRecordOutcome> {
  const processedAt = now.toISOString();
  const recordHash = canonicalJsonSha256(record);
  const contentHash = canonicalJsonSha256(record.payload);
  const client = await database.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('chs.vitals.v1'))`,
    );

    const batchResult = await client.query<BatchRow>(
      `SELECT location_id, status
       FROM sync_batches
       WHERE id = $1
         AND installation_id = $2
         AND organization_id = $3
       FOR UPDATE`,
      [batchInternalId, context.installationId, context.organizationId],
    );
    const batch = batchResult.rows[0];
    if (!batch || batch.status !== 'PROCESSING') {
      throw new VitalsProcessingError('BATCH_NOT_AVAILABLE');
    }

    const actorIds = [
      record.sourceActorLocalId,
      record.payload.performedByLocalActorId,
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
    const performer = actors.get(record.payload.performedByLocalActorId);
    if (!mutationActor || !performer) {
      throw new VitalsProcessingError('SOURCE_ACTOR_NOT_AVAILABLE');
    }

    const priorResult = await client.query<ExistingSyncRecordRow>(
      `SELECT id, payload_hash, status, screening_vital_set_id, errors
       FROM sync_records
       WHERE installation_id = $1
         AND (
           record_id = $2
           OR (
             resource_type = 'VITALS'
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
    const readingFailure = validateReadingSet(record);
    if (readingFailure) {
      return finish(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        rejectedOutcome(record, readingFailure.code, readingFailure.path),
        processedAt,
        retryRecordId,
      );
    }

    const encounterResult = await client.query<EncounterRow>(
      `SELECT
         id, person_id, organization_id, location_id, status, started_at,
         completed_at, recorded_by_practitioner_id
       FROM screening_encounters
       WHERE installation_id = $1 AND local_encounter_id = $2
       FOR SHARE`,
      [context.installationId, record.payload.localEncounterId],
    );
    const encounter = encounterResult.rows[0];
    if (!encounter) {
      return finish(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        dependencyOutcome(record),
        processedAt,
        retryRecordId,
      );
    }
    if (
      encounter.organization_id !== context.organizationId ||
      encounter.location_id !== batch.location_id
    ) {
      return finish(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        rejectedOutcome(record, 'ENCOUNTER_CONTEXT_MISMATCH', '/payload/localEncounterId'),
        processedAt,
        retryRecordId,
      );
    }
    if (encounter.status === 'VOID') {
      return finish(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        rejectedOutcome(record, 'ENCOUNTER_VOID', '/payload/localEncounterId'),
        processedAt,
        retryRecordId,
      );
    }
    if (performer.practitioner_id !== encounter.recorded_by_practitioner_id) {
      return finish(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        rejectedOutcome(
          record,
          'PERFORMER_CONTEXT_MISMATCH',
          '/payload/performedByLocalActorId',
        ),
        processedAt,
        retryRecordId,
      );
    }

    const prepared = prepareReadings(record, context, encounter);
    if (!Array.isArray(prepared)) {
      return finish(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        rejectedOutcome(record, prepared.code, prepared.path),
        processedAt,
        retryRecordId,
      );
    }

    const existingResult = await client.query<ExistingVitalSetRow>(
      `SELECT
         id, encounter_id, person_id, local_vitals_id, status,
         recorded_by_practitioner_id, source_revision, source_content_hash,
         source_created_at
       FROM screening_vital_sets
       WHERE installation_id = $1 AND local_vitals_id = $2
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
          encounter,
          performer.practitioner_id,
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
          rejectedOutcome(record, 'VITAL_SET_IDENTITY_CONFLICT', '/payload'),
          processedAt,
          retryRecordId,
        );
      }
      if (record.sourceRevision === existing.source_revision) {
        const outcome =
          contentHash === existing.source_content_hash
            ? acceptedOutcome(record, 'UNCHANGED', existing.id)
            : rejectedOutcome(record, 'RECORD_PAYLOAD_MISMATCH', '/payload');
        return finish(
          client,
          context,
          batchInternalId,
          mutationActor.id,
          record,
          recordHash,
          outcome,
          processedAt,
          retryRecordId,
        );
      }
      if (
        existing.status === 'VITALS_COMPLETE' &&
        record.payload.status === 'DRAFT'
      ) {
        return finish(
          client,
          context,
          batchInternalId,
          mutationActor.id,
          record,
          recordHash,
          rejectedOutcome(record, 'VITALS_STATE_REGRESSION', '/payload/status'),
          processedAt,
          retryRecordId,
        );
      }
      if (
        existing.status === 'VITALS_COMPLETE' &&
        contentHash !== existing.source_content_hash
      ) {
        return finish(
          client,
          context,
          batchInternalId,
          mutationActor.id,
          record,
          recordHash,
          rejectedOutcome(record, 'VITALS_TERMINAL_CONFLICT', '/payload'),
          processedAt,
          retryRecordId,
        );
      }

      if (existing.status === 'DRAFT') {
        const synchronizationFailure = await synchronizeDraftReadings(
          client,
          existing.id,
          prepared,
          processedAt,
        );
        if (synchronizationFailure) {
          return finish(
            client,
            context,
            batchInternalId,
            mutationActor.id,
            record,
            recordHash,
            rejectedOutcome(
              record,
              synchronizationFailure.code,
              synchronizationFailure.path,
            ),
            processedAt,
            retryRecordId,
          );
        }
      }
      await client.query(
        `UPDATE screening_vital_sets
         SET status = $1,
             weight_kg = $2,
             waist_cm = $3,
             notes = $4,
             source_revision = $5,
             source_content_hash = $6,
             source_updated_at = $7,
             updated_at = $8
         WHERE id = $9`,
        [
          record.payload.status,
          record.payload.weightKg,
          record.payload.waistCm,
          record.payload.notes,
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

    const encounterVitalResult = await client.query<EncounterVitalSetRow>(
      `SELECT id, local_vitals_id
       FROM screening_vital_sets
       WHERE encounter_id = $1
       FOR UPDATE`,
      [encounter.id],
    );
    if (encounterVitalResult.rows[0]) {
      return finish(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        rejectedOutcome(
          record,
          'VITAL_SET_ENCOUNTER_CONFLICT',
          '/payload/localEncounterId',
        ),
        processedAt,
        retryRecordId,
      );
    }

    const vitalSetId = randomUUID();
    await client.query(
      `INSERT INTO screening_vital_sets (
         id, encounter_id, person_id, installation_id, local_vitals_id,
         status, weight_kg, waist_cm, notes, recorded_by_practitioner_id,
         source_revision, source_content_hash, source_created_at,
         source_updated_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $15
       )`,
      [
        vitalSetId,
        encounter.id,
        encounter.person_id,
        context.installationId,
        record.localResourceId,
        record.payload.status,
        record.payload.weightKg,
        record.payload.waistCm,
        record.payload.notes,
        performer.practitioner_id,
        record.sourceRevision,
        contentHash,
        record.payload.createdAt,
        record.payload.updatedAt,
        processedAt,
      ],
    );
    for (const reading of prepared) {
      await insertReading(client, vitalSetId, reading, processedAt);
    }
    return finish(
      client,
      context,
      batchInternalId,
      mutationActor.id,
      record,
      recordHash,
      acceptedOutcome(record, 'ACCEPTED', vitalSetId),
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
