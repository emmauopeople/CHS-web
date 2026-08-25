import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import { canonicalJsonSha256 } from './canonical-json.js';
import type {
  InstallationContext,
  LifestyleAlcoholBaseline,
  LifestyleProvenance,
  LifestyleRecordOutcome,
  LifestyleSyncRecord,
  LifestyleTobaccoBaseline,
  LifestyleWorkBaseline,
  SyncRecordError,
} from './types.js';

type LifestyleDatabase = Pick<Pool, 'connect'>;

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
  status: LifestyleRecordOutcome['status'] | 'PROCESSING' | 'REVIEW_REQUIRED';
  lifestyle_assessment_id: string | null;
  errors: SyncRecordError[];
}>;

type PatientSourceRow = Readonly<{ person_id: string }>;

type EncounterRow = Readonly<{
  id: string;
  person_id: string;
  screening_session_id: string;
  organization_id: string;
  location_id: string;
  protocol_id: string;
  source_location_id: string;
  status: 'DRAFT' | 'COMPLETED' | 'AMENDED' | 'VOID';
  source_type: 'LOCAL';
  amendment_of_encounter_id: string | null;
  local_session_id: string;
  session_date: string;
}>;

type ExistingLifestyleRow = Readonly<{
  id: string;
  encounter_id: string;
  person_id: string;
  screening_session_id: string;
  organization_id: string;
  location_id: string;
  protocol_id: string;
  local_lifestyle_id: string;
  source_location_id: string;
  period_start: string;
  period_end: string;
  alcohol_baseline_id: string;
  tobacco_baseline_id: string;
  work_baseline_id: string;
  created_by_practitioner_id: string;
  source_revision: number;
  source_content_hash: string;
  source_created_at: Date;
}>;

type ExistingEncounterLifestyleRow = Readonly<{
  id: string;
  local_lifestyle_id: string;
}>;

type ExistingBaselineRow = Readonly<{
  id: string;
  person_id: string;
  local_baseline_version_id: string;
  source_version: number;
  source_content_hash: string;
}>;

type BaselineTable =
  | 'lifestyle_alcohol_baselines'
  | 'lifestyle_tobacco_baselines'
  | 'lifestyle_work_baselines';

type PreparedBaseline<T> = Readonly<{
  id: string;
  payload: T;
  contentHash: string;
  insert: boolean;
}>;

type ValidationFailure = Readonly<{
  code: RejectionCode;
  path: string;
}>;

export type LifestyleProcessingErrorCode =
  | 'BATCH_NOT_AVAILABLE'
  | 'LIFESTYLE_INVARIANT'
  | 'SOURCE_ACTOR_NOT_AVAILABLE';

export class LifestyleProcessingError extends Error {
  constructor(readonly code: LifestyleProcessingErrorCode) {
    super('Lifestyle synchronization processing failed');
    this.name = 'LifestyleProcessingError';
  }
}

type RejectionCode =
  | 'BASELINE_IDENTITY_CONFLICT'
  | 'BASELINE_VERSION_CONFLICT'
  | 'ENCOUNTER_CONTEXT_MISMATCH'
  | 'LIFESTYLE_ENCOUNTER_CONFLICT'
  | 'LIFESTYLE_ENCOUNTER_STATE_INVALID'
  | 'LIFESTYLE_IDENTITY_CONFLICT'
  | 'LIFESTYLE_PERIOD_INVALID'
  | 'LIFESTYLE_TERMINAL_CONFLICT'
  | 'PATIENT_CONTEXT_MISMATCH'
  | 'RECORD_PAYLOAD_MISMATCH'
  | 'SESSION_CONTEXT_MISMATCH'
  | 'SOURCE_TIME_INVALID'
  | 'STALE_SOURCE_REVISION';

function outcomeBase(record: LifestyleSyncRecord) {
  return {
    recordId: record.recordId,
    resourceType: 'LIFESTYLE' as const,
    localResourceId: record.localResourceId,
    sourceRevision: record.sourceRevision,
    centralPersonId: null,
    chsMedicalId: null,
    medicalIdStatus: null,
  };
}

function acceptedOutcome(
  record: LifestyleSyncRecord,
  status: 'ACCEPTED' | 'UNCHANGED',
  lifestyleId: string,
): LifestyleRecordOutcome {
  return {
    ...outcomeBase(record),
    status,
    canonicalResourceId: lifestyleId,
    errors: [],
  };
}

function rejectedOutcome(
  record: LifestyleSyncRecord,
  code: RejectionCode,
  path: string,
): LifestyleRecordOutcome {
  return {
    ...outcomeBase(record),
    status: 'REJECTED',
    canonicalResourceId: null,
    errors: [{ code, path, retryable: false }],
  };
}

function dependencyOutcome(
  record: LifestyleSyncRecord,
  path: string,
): LifestyleRecordOutcome {
  return {
    ...outcomeBase(record),
    status: 'RETRY',
    canonicalResourceId: null,
    errors: [{ code: 'DEPENDENCY_NOT_AVAILABLE', path, retryable: true }],
  };
}

function inProgressOutcome(record: LifestyleSyncRecord): LifestyleRecordOutcome {
  return {
    ...outcomeBase(record),
    status: 'RETRY',
    canonicalResourceId: null,
    errors: [{ code: 'RECORD_IN_PROGRESS', path: '', retryable: true }],
  };
}

function outcomeFromExisting(
  record: LifestyleSyncRecord,
  existing: ExistingSyncRecordRow,
): LifestyleRecordOutcome {
  if (existing.status === 'ACCEPTED' || existing.status === 'UNCHANGED') {
    if (!existing.lifestyle_assessment_id) {
      throw new LifestyleProcessingError('LIFESTYLE_INVARIANT');
    }
    return acceptedOutcome(record, 'UNCHANGED', existing.lifestyle_assessment_id);
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
  record: LifestyleSyncRecord,
  recordHash: string,
  outcome: LifestyleRecordOutcome,
  processedAt: string,
  retryRecordId: string | null,
) {
  if (retryRecordId) {
    const result = await client.query(
      `UPDATE sync_records
       SET status = $1,
           lifestyle_assessment_id = $2,
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
      throw new LifestyleProcessingError('LIFESTYLE_INVARIANT');
    }
    return;
  }

  await client.query(
    `INSERT INTO sync_records (
       id, batch_internal_id, installation_id, record_id, resource_type,
       local_resource_id, source_revision, schema_version, operation,
       captured_at, sync_batch_actor_id, payload_hash, status,
       lifestyle_assessment_id, errors, processed_at, created_at
     ) VALUES (
       $1, $2, $3, $4, 'LIFESTYLE', $5, $6, $7, $8, $9, $10, $11, $12,
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
  record: LifestyleSyncRecord,
  recordHash: string,
  outcome: LifestyleRecordOutcome,
  processedAt: string,
  retryRecordId: string | null,
): Promise<LifestyleRecordOutcome> {
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

function provenanceEntries(record: LifestyleSyncRecord) {
  const entries: Array<Readonly<{ path: string; value: LifestyleProvenance }>> = [
    { path: '/payload', value: record.payload },
    { path: '/payload/baselines/alcohol', value: record.payload.baselines.alcohol },
    { path: '/payload/baselines/tobacco', value: record.payload.baselines.tobacco },
    { path: '/payload/baselines/work', value: record.payload.baselines.work },
    { path: '/payload/alcohol', value: record.payload.alcohol },
    { path: '/payload/tobacco', value: record.payload.tobacco },
    { path: '/payload/physicalActivity', value: record.payload.physicalActivity },
    { path: '/payload/work', value: record.payload.work },
  ];
  record.payload.tobacco.products.forEach((value, index) => {
    entries.push({ path: `/payload/tobacco/products/${index}`, value });
  });
  record.payload.physicalActivity.activities.forEach((value, index) => {
    entries.push({ path: `/payload/physicalActivity/activities/${index}`, value });
  });
  record.payload.otherActivity.activities.forEach((value, index) => {
    entries.push({ path: `/payload/otherActivity/activities/${index}`, value });
  });
  return entries;
}

function sourceTimeFailure(record: LifestyleSyncRecord): ValidationFailure | null {
  for (const entry of provenanceEntries(record)) {
    if (new Date(entry.value.updatedAt) < new Date(entry.value.createdAt)) {
      return { code: 'SOURCE_TIME_INVALID', path: `${entry.path}/updatedAt` };
    }
  }
  return null;
}

function actorLocalIds(record: LifestyleSyncRecord): string[] {
  const ids = new Set<string>([record.sourceActorLocalId]);
  for (const entry of provenanceEntries(record)) {
    ids.add(entry.value.createdByLocalActorId);
    ids.add(entry.value.updatedByLocalActorId);
  }
  return [...ids];
}

function practitionerId(
  actors: ReadonlyMap<string, BatchActorRow>,
  localActorId: string,
): string {
  const actor = actors.get(localActorId);
  if (!actor) throw new LifestyleProcessingError('SOURCE_ACTOR_NOT_AVAILABLE');
  return actor.practitioner_id;
}

async function prepareBaseline<T extends { localBaselineVersionId: string; version: number }>(
  client: PoolClient,
  table: BaselineTable,
  context: InstallationContext,
  personId: string,
  payload: T,
): Promise<PreparedBaseline<T> | ValidationFailure> {
  const contentHash = canonicalJsonSha256(payload);
  const result = await client.query<ExistingBaselineRow>(
    `SELECT
       id, person_id, local_baseline_version_id, source_version,
       source_content_hash
     FROM ${table}
     WHERE installation_id = $1
       AND (
         local_baseline_version_id = $2
         OR (person_id = $3 AND source_version = $4)
       )
     FOR UPDATE`,
    [context.installationId, payload.localBaselineVersionId, personId, payload.version],
  );
  if (result.rows.length === 0) {
    return { id: randomUUID(), payload, contentHash, insert: true };
  }
  if (result.rows.length > 1) {
    return { code: 'BASELINE_VERSION_CONFLICT', path: '/payload/baselines' };
  }
  const existing = result.rows[0]!;
  if (
    existing.local_baseline_version_id !== payload.localBaselineVersionId ||
    existing.person_id !== personId ||
    existing.source_version !== payload.version
  ) {
    return { code: 'BASELINE_VERSION_CONFLICT', path: '/payload/baselines' };
  }
  if (existing.source_content_hash !== contentHash) {
    return { code: 'BASELINE_IDENTITY_CONFLICT', path: '/payload/baselines' };
  }
  return { id: existing.id, payload, contentHash, insert: false };
}

function isFailure<T>(
  value: PreparedBaseline<T> | ValidationFailure,
): value is ValidationFailure {
  return 'code' in value;
}

function identityConflict(
  existing: ExistingLifestyleRow,
  encounter: EncounterRow,
  alcoholBaselineId: string,
  tobaccoBaselineId: string,
  workBaselineId: string,
  createdByPractitionerId: string,
  record: LifestyleSyncRecord,
): boolean {
  const payload = record.payload;
  return (
    existing.encounter_id !== encounter.id ||
    existing.person_id !== encounter.person_id ||
    existing.screening_session_id !== encounter.screening_session_id ||
    existing.organization_id !== encounter.organization_id ||
    existing.location_id !== encounter.location_id ||
    existing.protocol_id !== encounter.protocol_id ||
    existing.local_lifestyle_id !== record.localResourceId ||
    existing.source_location_id !== payload.localLocationId ||
    existing.period_start !== payload.periodStart ||
    existing.period_end !== payload.periodEnd ||
    existing.alcohol_baseline_id !== alcoholBaselineId ||
    existing.tobacco_baseline_id !== tobaccoBaselineId ||
    existing.work_baseline_id !== workBaselineId ||
    existing.created_by_practitioner_id !== createdByPractitionerId ||
    existing.source_created_at.toISOString() !== new Date(payload.createdAt).toISOString()
  );
}

async function insertAlcoholBaseline(
  client: PoolClient,
  context: InstallationContext,
  personId: string,
  prepared: PreparedBaseline<LifestyleAlcoholBaseline>,
  actors: ReadonlyMap<string, BatchActorRow>,
  processedAt: string,
) {
  if (!prepared.insert) return;
  const payload = prepared.payload;
  await client.query(
    `INSERT INTO lifestyle_alcohol_baselines (
       id, person_id, installation_id, local_baseline_version_id,
       source_version, status, ever_consumed, consumed_past_12_months,
       other_beverage_description, created_by_practitioner_id,
       updated_by_practitioner_id, source_content_hash, source_created_at,
       source_updated_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15
     )`,
    [
      prepared.id,
      personId,
      context.installationId,
      payload.localBaselineVersionId,
      payload.version,
      payload.status,
      payload.everConsumed,
      payload.consumedPast12Months,
      payload.otherBeverageDescription,
      practitionerId(actors, payload.createdByLocalActorId),
      practitionerId(actors, payload.updatedByLocalActorId),
      prepared.contentHash,
      payload.createdAt,
      payload.updatedAt,
      processedAt,
    ],
  );
  for (const beverageType of payload.commonBeverageTypes) {
    await client.query(
      `INSERT INTO lifestyle_alcohol_baseline_beverages (baseline_id, beverage_type)
       VALUES ($1, $2)`,
      [prepared.id, beverageType],
    );
  }
}

async function insertTobaccoBaseline(
  client: PoolClient,
  context: InstallationContext,
  personId: string,
  prepared: PreparedBaseline<LifestyleTobaccoBaseline>,
  actors: ReadonlyMap<string, BatchActorRow>,
  processedAt: string,
) {
  if (!prepared.insert) return;
  const payload = prepared.payload;
  await client.query(
    `INSERT INTO lifestyle_tobacco_baselines (
       id, person_id, installation_id, local_baseline_version_id,
       source_version, status, ever_regularly_used,
       former_use_approximate_stop_date, current_use_frequency,
       other_product_description, created_by_practitioner_id,
       updated_by_practitioner_id, source_content_hash, source_created_at,
       source_updated_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16
     )`,
    [
      prepared.id,
      personId,
      context.installationId,
      payload.localBaselineVersionId,
      payload.version,
      payload.status,
      payload.everRegularlyUsed,
      payload.formerUseApproximateStopDate,
      payload.currentUseFrequency,
      payload.otherProductDescription,
      practitionerId(actors, payload.createdByLocalActorId),
      practitionerId(actors, payload.updatedByLocalActorId),
      prepared.contentHash,
      payload.createdAt,
      payload.updatedAt,
      processedAt,
    ],
  );
  for (const productType of payload.productTypes) {
    await client.query(
      `INSERT INTO lifestyle_tobacco_baseline_products (baseline_id, product_type)
       VALUES ($1, $2)`,
      [prepared.id, productType],
    );
  }
}

async function insertWorkBaseline(
  client: PoolClient,
  context: InstallationContext,
  personId: string,
  prepared: PreparedBaseline<LifestyleWorkBaseline>,
  actors: ReadonlyMap<string, BatchActorRow>,
  processedAt: string,
) {
  if (!prepared.insert) return;
  const payload = prepared.payload;
  await client.query(
    `INSERT INTO lifestyle_work_baselines (
       id, person_id, installation_id, local_baseline_version_id,
       source_version, status, occupation_job_title, usual_physical_demand,
       typical_workdays_per_week, typical_hours_per_workday, shift_pattern,
       description, created_by_practitioner_id, updated_by_practitioner_id,
       source_content_hash, source_created_at, source_updated_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $18
     )`,
    [
      prepared.id,
      personId,
      context.installationId,
      payload.localBaselineVersionId,
      payload.version,
      payload.status,
      payload.occupationJobTitle,
      payload.usualPhysicalDemand,
      payload.typicalWorkdaysPerWeek,
      payload.typicalHoursPerWorkday,
      payload.shiftPattern,
      payload.description,
      practitionerId(actors, payload.createdByLocalActorId),
      practitionerId(actors, payload.updatedByLocalActorId),
      prepared.contentHash,
      payload.createdAt,
      payload.updatedAt,
      processedAt,
    ],
  );
}

async function insertWeeklyRecords(
  client: PoolClient,
  lifestyleId: string,
  record: LifestyleSyncRecord,
  actors: ReadonlyMap<string, BatchActorRow>,
  processedAt: string,
) {
  const { alcohol, tobacco, physicalActivity, work, otherActivity } = record.payload;
  await client.query(
    `INSERT INTO lifestyle_alcohol_weekly (
       lifestyle_assessment_id, local_weekly_record_id, weekly_response,
       drinking_days, total_standardized_drinks, largest_one_day_amount,
       days_at_largest_amount, other_beverage_description,
       created_by_practitioner_id, updated_by_practitioner_id,
       source_created_at, source_updated_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13
     )`,
    [
      lifestyleId,
      alcohol.localWeeklyRecordId,
      alcohol.weeklyResponse,
      alcohol.drinkingDays,
      alcohol.totalStandardizedDrinks,
      alcohol.largestOneDayAmount,
      alcohol.daysAtLargestAmount,
      alcohol.otherBeverageDescription,
      practitionerId(actors, alcohol.createdByLocalActorId),
      practitionerId(actors, alcohol.updatedByLocalActorId),
      alcohol.createdAt,
      alcohol.updatedAt,
      processedAt,
    ],
  );
  for (const beverageType of alcohol.commonBeverageTypes) {
    await client.query(
      `INSERT INTO lifestyle_alcohol_weekly_beverages (
         lifestyle_assessment_id, beverage_type
       ) VALUES ($1, $2)`,
      [lifestyleId, beverageType],
    );
  }

  await client.query(
    `INSERT INTO lifestyle_tobacco_weekly (
       lifestyle_assessment_id, local_weekly_record_id, weekly_response,
       created_by_practitioner_id, updated_by_practitioner_id,
       source_created_at, source_updated_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [
      lifestyleId,
      tobacco.localWeeklyRecordId,
      tobacco.weeklyResponse,
      practitionerId(actors, tobacco.createdByLocalActorId),
      practitionerId(actors, tobacco.updatedByLocalActorId),
      tobacco.createdAt,
      tobacco.updatedAt,
      processedAt,
    ],
  );
  for (const product of tobacco.products) {
    await client.query(
      `INSERT INTO lifestyle_tobacco_products (
         id, lifestyle_assessment_id, local_product_row_id, sequence_number,
         product_type, days_used, average_quantity_per_use_day, unit,
         secondhand_smoke_exposure, other_product_description,
         other_unit_description, created_by_practitioner_id,
         updated_by_practitioner_id, source_created_at, source_updated_at,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $16
       )`,
      [
        randomUUID(),
        lifestyleId,
        product.localProductRowId,
        product.sequenceNumber,
        product.productType,
        product.daysUsed,
        product.averageQuantityPerUseDay,
        product.unit,
        product.secondhandSmokeExposure,
        product.otherProductDescription,
        product.otherUnitDescription,
        practitionerId(actors, product.createdByLocalActorId),
        practitionerId(actors, product.updatedByLocalActorId),
        product.createdAt,
        product.updatedAt,
        processedAt,
      ],
    );
  }

  await client.query(
    `INSERT INTO lifestyle_physical_activity_weekly (
       lifestyle_assessment_id, local_weekly_record_id, weekly_response,
       sedentary_time_response, sedentary_minutes_per_day,
       created_by_practitioner_id, updated_by_practitioner_id,
       source_created_at, source_updated_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
    [
      lifestyleId,
      physicalActivity.localWeeklyRecordId,
      physicalActivity.weeklyResponse,
      physicalActivity.sedentaryTimeResponse,
      physicalActivity.sedentaryMinutesPerDay,
      practitionerId(actors, physicalActivity.createdByLocalActorId),
      practitionerId(actors, physicalActivity.updatedByLocalActorId),
      physicalActivity.createdAt,
      physicalActivity.updatedAt,
      processedAt,
    ],
  );
  for (const activity of physicalActivity.activities) {
    await client.query(
      `INSERT INTO lifestyle_physical_activities (
         id, lifestyle_assessment_id, local_activity_row_id, sequence_number,
         activity_domain, description, intensity, days_in_past_seven_days,
         average_minutes_per_active_day, created_by_practitioner_id,
         updated_by_practitioner_id, source_created_at, source_updated_at,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14
       )`,
      [
        randomUUID(),
        lifestyleId,
        activity.localActivityRowId,
        activity.sequenceNumber,
        activity.activityDomain,
        activity.description,
        activity.intensity,
        activity.daysInPastSevenDays,
        activity.averageMinutesPerActiveDay,
        practitionerId(actors, activity.createdByLocalActorId),
        practitionerId(actors, activity.updatedByLocalActorId),
        activity.createdAt,
        activity.updatedAt,
        processedAt,
      ],
    );
  }

  await client.query(
    `INSERT INTO lifestyle_work_weekly (
       lifestyle_assessment_id, local_weekly_record_id, weekly_response,
       created_by_practitioner_id, updated_by_practitioner_id,
       source_created_at, source_updated_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [
      lifestyleId,
      work.localWeeklyRecordId,
      work.weeklyResponse,
      practitionerId(actors, work.createdByLocalActorId),
      practitionerId(actors, work.updatedByLocalActorId),
      work.createdAt,
      work.updatedAt,
      processedAt,
    ],
  );

  await client.query(
    `INSERT INTO lifestyle_other_activity_weekly (
       lifestyle_assessment_id, weekly_response
     ) VALUES ($1, $2)`,
    [lifestyleId, otherActivity.weeklyResponse],
  );
  for (const activity of otherActivity.activities) {
    await client.query(
      `INSERT INTO lifestyle_other_activities (
         id, lifestyle_assessment_id, local_activity_row_id, sequence_number,
         category, description, days_in_past_seven_days,
         average_minutes_per_day, intensity, created_by_practitioner_id,
         updated_by_practitioner_id, source_created_at, source_updated_at,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14
       )`,
      [
        randomUUID(),
        lifestyleId,
        activity.localActivityRowId,
        activity.sequenceNumber,
        activity.category,
        activity.description,
        activity.daysInPastSevenDays,
        activity.averageMinutesPerDay,
        activity.intensity,
        practitionerId(actors, activity.createdByLocalActorId),
        practitionerId(actors, activity.updatedByLocalActorId),
        activity.createdAt,
        activity.updatedAt,
        processedAt,
      ],
    );
  }
}

export async function processLifestyleRecord(
  database: LifestyleDatabase,
  context: InstallationContext,
  batchInternalId: string,
  record: LifestyleSyncRecord,
  now: Date = new Date(),
): Promise<LifestyleRecordOutcome> {
  const processedAt = now.toISOString();
  const recordHash = canonicalJsonSha256(record);
  const contentHash = canonicalJsonSha256(record.payload);
  const client = await database.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('chs.lifestyle.v1'))`);

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
      throw new LifestyleProcessingError('BATCH_NOT_AVAILABLE');
    }

    const actorsResult = await client.query<BatchActorRow>(
      `SELECT id, practitioner_id, source_actor_local_id
       FROM sync_batch_actors
       WHERE batch_internal_id = $1
         AND source_actor_local_id = ANY($2::uuid[])`,
      [batchInternalId, actorLocalIds(record)],
    );
    const actors = new Map(
      actorsResult.rows.map((actor) => [actor.source_actor_local_id, actor]),
    );
    const mutationActor = actors.get(record.sourceActorLocalId);
    if (!mutationActor || actors.size !== actorLocalIds(record).length) {
      throw new LifestyleProcessingError('SOURCE_ACTOR_NOT_AVAILABLE');
    }

    const priorResult = await client.query<ExistingSyncRecordRow>(
      `SELECT id, payload_hash, status, lifestyle_assessment_id, errors
       FROM sync_records
       WHERE installation_id = $1
         AND (
           record_id = $2
           OR (
             resource_type = 'LIFESTYLE'
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

    const timeFailure = sourceTimeFailure(record);
    if (timeFailure) {
      return finish(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        rejectedOutcome(record, timeFailure.code, timeFailure.path),
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
    const patient = patientResult.rows[0];
    if (!patient) {
      return finish(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        dependencyOutcome(record, '/payload/localPatientId'),
        processedAt,
        retryRecordId,
      );
    }

    const encounterResult = await client.query<EncounterRow>(
      `SELECT
         encounter.id, encounter.person_id, encounter.screening_session_id,
         encounter.organization_id, encounter.location_id, encounter.protocol_id,
         encounter.source_location_id, encounter.status, encounter.source_type,
         encounter.amendment_of_encounter_id,
         session.local_session_id,
         session.session_date::text AS session_date
       FROM screening_encounters AS encounter
       JOIN screening_sessions AS session ON session.id = encounter.screening_session_id
       WHERE encounter.installation_id = $1 AND encounter.local_encounter_id = $2
       FOR SHARE OF encounter, session`,
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
        dependencyOutcome(record, '/payload/localEncounterId'),
        processedAt,
        retryRecordId,
      );
    }
    if (patient.person_id !== encounter.person_id) {
      return finish(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        rejectedOutcome(record, 'PATIENT_CONTEXT_MISMATCH', '/payload/localPatientId'),
        processedAt,
        retryRecordId,
      );
    }
    if (
      encounter.organization_id !== context.organizationId ||
      encounter.location_id !== batch.location_id ||
      encounter.source_location_id !== batch.source_location_id ||
      record.payload.localLocationId !== batch.source_location_id
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
    if (
      encounter.local_session_id !== record.payload.localScreeningSessionId
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
          'SESSION_CONTEXT_MISMATCH',
          '/payload/localScreeningSessionId',
        ),
        processedAt,
        retryRecordId,
      );
    }
    if (
      encounter.status !== 'COMPLETED' ||
      encounter.source_type !== 'LOCAL' ||
      encounter.amendment_of_encounter_id !== null
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
          'LIFESTYLE_ENCOUNTER_STATE_INVALID',
          '/payload/localEncounterId',
        ),
        processedAt,
        retryRecordId,
      );
    }
    if (record.payload.periodEnd !== encounter.session_date) {
      return finish(
        client,
        context,
        batchInternalId,
        mutationActor.id,
        record,
        recordHash,
        rejectedOutcome(record, 'LIFESTYLE_PERIOD_INVALID', '/payload/periodEnd'),
        processedAt,
        retryRecordId,
      );
    }

    const alcoholBaseline = await prepareBaseline(
      client,
      'lifestyle_alcohol_baselines',
      context,
      encounter.person_id,
      record.payload.baselines.alcohol,
    );
    if (isFailure(alcoholBaseline)) {
      return finish(
        client, context, batchInternalId, mutationActor.id, record, recordHash,
        rejectedOutcome(record, alcoholBaseline.code, `${alcoholBaseline.path}/alcohol`),
        processedAt, retryRecordId,
      );
    }
    const tobaccoBaseline = await prepareBaseline(
      client,
      'lifestyle_tobacco_baselines',
      context,
      encounter.person_id,
      record.payload.baselines.tobacco,
    );
    if (isFailure(tobaccoBaseline)) {
      return finish(
        client, context, batchInternalId, mutationActor.id, record, recordHash,
        rejectedOutcome(record, tobaccoBaseline.code, `${tobaccoBaseline.path}/tobacco`),
        processedAt, retryRecordId,
      );
    }
    const workBaseline = await prepareBaseline(
      client,
      'lifestyle_work_baselines',
      context,
      encounter.person_id,
      record.payload.baselines.work,
    );
    if (isFailure(workBaseline)) {
      return finish(
        client, context, batchInternalId, mutationActor.id, record, recordHash,
        rejectedOutcome(record, workBaseline.code, `${workBaseline.path}/work`),
        processedAt, retryRecordId,
      );
    }

    const existingResult = await client.query<ExistingLifestyleRow>(
      `SELECT
         id, encounter_id, person_id, screening_session_id, organization_id,
         location_id, protocol_id, local_lifestyle_id, source_location_id,
         period_start::text AS period_start, period_end::text AS period_end,
         alcohol_baseline_id, tobacco_baseline_id, work_baseline_id,
         created_by_practitioner_id, source_revision, source_content_hash,
         source_created_at
       FROM lifestyle_assessments
       WHERE installation_id = $1 AND local_lifestyle_id = $2
       FOR UPDATE`,
      [context.installationId, record.localResourceId],
    );
    const existing = existingResult.rows[0];
    const createdByPractitionerId = practitionerId(
      actors,
      record.payload.createdByLocalActorId,
    );
    if (existing) {
      if (record.sourceRevision < existing.source_revision) {
        return finish(
          client, context, batchInternalId, mutationActor.id, record, recordHash,
          rejectedOutcome(record, 'STALE_SOURCE_REVISION', '/sourceRevision'),
          processedAt, retryRecordId,
        );
      }
      if (
        identityConflict(
          existing,
          encounter,
          alcoholBaseline.id,
          tobaccoBaseline.id,
          workBaseline.id,
          createdByPractitionerId,
          record,
        )
      ) {
        return finish(
          client, context, batchInternalId, mutationActor.id, record, recordHash,
          rejectedOutcome(record, 'LIFESTYLE_IDENTITY_CONFLICT', '/payload'),
          processedAt, retryRecordId,
        );
      }
      if (record.sourceRevision === existing.source_revision) {
        const outcome =
          contentHash === existing.source_content_hash
            ? acceptedOutcome(record, 'UNCHANGED', existing.id)
            : rejectedOutcome(record, 'RECORD_PAYLOAD_MISMATCH', '/payload');
        return finish(
          client, context, batchInternalId, mutationActor.id, record, recordHash,
          outcome, processedAt, retryRecordId,
        );
      }
      if (contentHash !== existing.source_content_hash) {
        return finish(
          client, context, batchInternalId, mutationActor.id, record, recordHash,
          rejectedOutcome(record, 'LIFESTYLE_TERMINAL_CONFLICT', '/payload'),
          processedAt, retryRecordId,
        );
      }
      await client.query(
        `UPDATE lifestyle_assessments
         SET source_revision = $1, updated_at = $2
         WHERE id = $3`,
        [record.sourceRevision, processedAt, existing.id],
      );
      return finish(
        client, context, batchInternalId, mutationActor.id, record, recordHash,
        acceptedOutcome(record, 'ACCEPTED', existing.id), processedAt, retryRecordId,
      );
    }

    const encounterLifestyle = await client.query<ExistingEncounterLifestyleRow>(
      `SELECT id, local_lifestyle_id
       FROM lifestyle_assessments
       WHERE encounter_id = $1
       FOR UPDATE`,
      [encounter.id],
    );
    if (encounterLifestyle.rows[0]) {
      return finish(
        client, context, batchInternalId, mutationActor.id, record, recordHash,
        rejectedOutcome(
          record,
          'LIFESTYLE_ENCOUNTER_CONFLICT',
          '/payload/localEncounterId',
        ),
        processedAt, retryRecordId,
      );
    }

    await insertAlcoholBaseline(
      client,
      context,
      encounter.person_id,
      alcoholBaseline,
      actors,
      processedAt,
    );
    await insertTobaccoBaseline(
      client,
      context,
      encounter.person_id,
      tobaccoBaseline,
      actors,
      processedAt,
    );
    await insertWorkBaseline(
      client,
      context,
      encounter.person_id,
      workBaseline,
      actors,
      processedAt,
    );

    const lifestyleId = randomUUID();
    await client.query(
      `INSERT INTO lifestyle_assessments (
         id, encounter_id, person_id, screening_session_id, installation_id,
         organization_id, location_id, protocol_id, local_lifestyle_id,
         source_location_id, status, period_start, period_end,
         alcohol_baseline_id, tobacco_baseline_id, work_baseline_id,
         created_by_practitioner_id, updated_by_practitioner_id,
         source_revision, source_content_hash, source_created_at,
         source_updated_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'COMPLETE', $11, $12,
         $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $22
       )`,
      [
        lifestyleId,
        encounter.id,
        encounter.person_id,
        encounter.screening_session_id,
        context.installationId,
        encounter.organization_id,
        encounter.location_id,
        encounter.protocol_id,
        record.localResourceId,
        record.payload.localLocationId,
        record.payload.periodStart,
        record.payload.periodEnd,
        alcoholBaseline.id,
        tobaccoBaseline.id,
        workBaseline.id,
        createdByPractitionerId,
        practitionerId(actors, record.payload.updatedByLocalActorId),
        record.sourceRevision,
        contentHash,
        record.payload.createdAt,
        record.payload.updatedAt,
        processedAt,
      ],
    );
    await insertWeeklyRecords(client, lifestyleId, record, actors, processedAt);
    return finish(
      client,
      context,
      batchInternalId,
      mutationActor.id,
      record,
      recordHash,
      acceptedOutcome(record, 'ACCEPTED', lifestyleId),
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
