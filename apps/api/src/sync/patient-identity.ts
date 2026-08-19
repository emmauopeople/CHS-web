import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import { canonicalJsonSha256 } from './canonical-json.js';
import {
  CHS_MEDICAL_ID_SYSTEM,
  CHS_MEDICAL_ID_TYPE,
  generateChsMedicalId,
} from './medical-id.js';
import {
  normalizeIdentityName,
  normalizePhone,
} from './patient-identity-normalization.js';
import type {
  InstallationContext,
  PatientPayload,
  PatientRecordOutcome,
  PatientSyncRecord,
  SyncRecordError,
} from './types.js';

type PatientIdentityDatabase = Pick<Pool, 'connect'>;

type BatchRow = Readonly<{
  id: string;
  status: string;
}>;

type BatchActorRow = Readonly<{ id: string }>;

type ExistingSyncRecordRow = Readonly<{
  id: string;
  payload_hash: string;
  status: PatientRecordOutcome['status'] | 'PROCESSING';
  person_id: string | null;
  identity_review_case_id: string | null;
  errors: SyncRecordError[];
}>;

type PatientSourceLinkRow = Readonly<{
  id: string;
  person_id: string;
  local_patient_id: string;
  local_patient_code: string;
  last_source_revision: number;
  last_content_hash: string;
}>;

type PersonIdentityRow = Readonly<{
  id: string;
  name_normalized: string;
  date_of_birth: string | null;
  phone_normalized: string | null;
}>;

type CandidateRow = PersonIdentityRow &
  Readonly<{
    approximate_age_matches: boolean;
    date_of_birth_matches: boolean;
    phone_matches: boolean;
  }>;

type MedicalIdRow = Readonly<{
  person_id: string;
  identifier_value: string;
}>;

type ReviewCandidate = Readonly<{
  personId: string;
  score: number;
  matchedOn: readonly string[];
}>;

export type PatientRecordProcessingErrorCode =
  | 'BATCH_NOT_AVAILABLE'
  | 'SOURCE_ACTOR_NOT_AVAILABLE'
  | 'PATIENT_IDENTITY_INVARIANT';

export class PatientRecordProcessingError extends Error {
  constructor(readonly code: PatientRecordProcessingErrorCode) {
    super('Patient synchronization record processing failed');
    this.name = 'PatientRecordProcessingError';
  }
}

export type PatientIdentityProcessorOptions = Readonly<{
  generateMedicalId?: () => string;
}>;

function outcomeBase(record: PatientSyncRecord) {
  return {
    recordId: record.recordId,
    resourceType: 'PATIENT' as const,
    localResourceId: record.localResourceId,
    sourceRevision: record.sourceRevision,
  };
}

function acceptedOutcome(
  record: PatientSyncRecord,
  status: 'ACCEPTED' | 'UNCHANGED',
  personId: string,
  medicalId: string,
  medicalIdStatus: 'ASSIGNED' | 'CONFIRMED',
): PatientRecordOutcome {
  return {
    ...outcomeBase(record),
    status,
    canonicalResourceId: personId,
    centralPersonId: personId,
    chsMedicalId: medicalId,
    medicalIdStatus,
    errors: [],
  };
}

function reviewOutcome(
  record: PatientSyncRecord,
  code: 'POSSIBLE_DUPLICATE' | 'IDENTITY_VERIFICATION_REQUIRED',
): PatientRecordOutcome {
  return {
    ...outcomeBase(record),
    status: 'REVIEW_REQUIRED',
    canonicalResourceId: null,
    centralPersonId: null,
    chsMedicalId: null,
    medicalIdStatus: 'PENDING_REVIEW',
    errors: [{ code, path: '/payload', retryable: false }],
  };
}

function rejectedOutcome(
  record: PatientSyncRecord,
  code:
    | 'INVALID_PATIENT_IDENTITY'
    | 'KNOWN_CHS_MEDICAL_ID_CONFLICT'
    | 'LOCAL_PATIENT_CODE_CONFLICT'
    | 'RECORD_PAYLOAD_MISMATCH'
    | 'STALE_SOURCE_REVISION'
    | 'UNKNOWN_CHS_MEDICAL_ID',
  path: string,
): PatientRecordOutcome {
  return {
    ...outcomeBase(record),
    status: 'REJECTED',
    canonicalResourceId: null,
    centralPersonId: null,
    chsMedicalId: null,
    medicalIdStatus: null,
    errors: [{ code, path, retryable: false }],
  };
}

async function getMedicalId(
  client: PoolClient,
  personId: string,
): Promise<string> {
  const result = await client.query<{ identifier_value: string }>(
    `SELECT identifier_value
     FROM person_identifiers
     WHERE person_id = $1
       AND identifier_system = $2
       AND identifier_type_code = $3
       AND status = 'ACTIVE'
       AND is_primary = true`,
    [personId, CHS_MEDICAL_ID_SYSTEM, CHS_MEDICAL_ID_TYPE],
  );
  const medicalId = result.rows[0]?.identifier_value;
  if (!medicalId) {
    throw new PatientRecordProcessingError('PATIENT_IDENTITY_INVARIANT');
  }
  return medicalId;
}

async function outcomeFromExisting(
  client: PoolClient,
  record: PatientSyncRecord,
  existing: ExistingSyncRecordRow,
): Promise<PatientRecordOutcome> {
  if (existing.status === 'ACCEPTED' || existing.status === 'UNCHANGED') {
    if (!existing.person_id) {
      throw new PatientRecordProcessingError('PATIENT_IDENTITY_INVARIANT');
    }
    return acceptedOutcome(
      record,
      'UNCHANGED',
      existing.person_id,
      await getMedicalId(client, existing.person_id),
      'CONFIRMED',
    );
  }

  if (existing.status === 'REVIEW_REQUIRED') {
    const error = existing.errors[0];
    return reviewOutcome(
      record,
      error?.code === 'IDENTITY_VERIFICATION_REQUIRED'
        ? 'IDENTITY_VERIFICATION_REQUIRED'
        : 'POSSIBLE_DUPLICATE',
    );
  }

  if (existing.status === 'REJECTED') {
    return {
      ...outcomeBase(record),
      status: 'REJECTED',
      canonicalResourceId: null,
      centralPersonId: null,
      chsMedicalId: null,
      medicalIdStatus: null,
      errors: existing.errors,
    };
  }

  return {
    ...outcomeBase(record),
    status: 'RETRY',
    canonicalResourceId: null,
    centralPersonId: null,
    chsMedicalId: null,
    medicalIdStatus: null,
    errors: [{ code: 'RECORD_IN_PROGRESS', path: '', retryable: true }],
  };
}

async function insertSyncRecord(
  client: PoolClient,
  context: InstallationContext,
  batchInternalId: string,
  batchActorId: string,
  record: PatientSyncRecord,
  recordHash: string,
  outcome: PatientRecordOutcome,
  reviewCaseId: string | null,
  processedAt: string,
) {
  await client.query(
    `INSERT INTO sync_records (
       id, batch_internal_id, installation_id, record_id, resource_type,
       local_resource_id, source_revision, schema_version, operation,
       captured_at, sync_batch_actor_id, payload_hash, status, person_id,
       identity_review_case_id, errors, processed_at, created_at
     ) VALUES (
       $1, $2, $3, $4, 'PATIENT', $5, $6, $7, $8, $9, $10, $11, $12,
       $13, $14, $15::jsonb, $16, $16
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
      batchActorId,
      recordHash,
      outcome.status,
      outcome.centralPersonId,
      reviewCaseId,
      JSON.stringify(outcome.errors),
      processedAt,
    ],
  );
}

function personValues(payload: PatientPayload) {
  return [
    payload.displayName.trim(),
    payload.givenName,
    payload.familyName,
    payload.otherNames,
    normalizeIdentityName(payload.displayName),
    payload.sex,
    payload.acknowledgmentStatus,
    payload.dateOfBirth,
    payload.approximateAgeYears,
    payload.ageAsOfDate,
    payload.phone,
    normalizePhone(payload.phone),
    payload.alternateContactName,
    payload.alternateContactPhone,
    payload.village,
    payload.quarter,
    payload.residenceNotes,
    payload.status,
  ] as const;
}

async function insertPerson(
  client: PoolClient,
  payload: PatientPayload,
  personId: string,
  receivedAt: string,
) {
  await client.query(
    `INSERT INTO persons (
       id, display_name, given_name, family_name, other_names, name_normalized,
       sex, acknowledgment_status, date_of_birth, approximate_age_years,
       age_as_of_date, phone, phone_normalized, alternate_contact_name,
       alternate_contact_phone, village, quarter, residence_notes, status,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19, $20, $20
     )`,
    [personId, ...personValues(payload), receivedAt],
  );
}

async function updatePerson(
  client: PoolClient,
  payload: PatientPayload,
  personId: string,
  receivedAt: string,
) {
  await client.query(
    `UPDATE persons
     SET display_name = $1,
         given_name = $2,
         family_name = $3,
         other_names = $4,
         name_normalized = $5,
         sex = $6,
         acknowledgment_status = $7,
         date_of_birth = $8,
         approximate_age_years = $9,
         age_as_of_date = $10,
         phone = $11,
         phone_normalized = $12,
         alternate_contact_name = $13,
         alternate_contact_phone = $14,
         village = $15,
         quarter = $16,
         residence_notes = $17,
         status = $18,
         updated_at = $19
     WHERE id = $20`,
    [...personValues(payload), receivedAt, personId],
  );
}

async function insertPatientSourceLink(
  client: PoolClient,
  context: InstallationContext,
  record: PatientSyncRecord,
  personId: string,
  contentHash: string,
  receivedAt: string,
) {
  await client.query(
    `INSERT INTO patient_source_links (
       id, person_id, installation_id, local_patient_id, local_patient_code,
       last_source_revision, last_content_hash, source_created_at,
       source_updated_at, first_observed_at, last_observed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
    [
      randomUUID(),
      personId,
      context.installationId,
      record.localResourceId,
      record.payload.localPatientCode,
      record.sourceRevision,
      contentHash,
      record.payload.createdAt,
      record.payload.updatedAt,
      receivedAt,
    ],
  );
}

async function updatePatientSourceLink(
  client: PoolClient,
  linkId: string,
  record: PatientSyncRecord,
  contentHash: string,
  receivedAt: string,
) {
  await client.query(
    `UPDATE patient_source_links
     SET local_patient_code = $1,
         last_source_revision = $2,
         last_content_hash = $3,
         source_created_at = $4,
         source_updated_at = $5,
         last_observed_at = $6
     WHERE id = $7`,
    [
      record.payload.localPatientCode,
      record.sourceRevision,
      contentHash,
      record.payload.createdAt,
      record.payload.updatedAt,
      receivedAt,
      linkId,
    ],
  );
}

async function issueMedicalId(
  client: PoolClient,
  context: InstallationContext,
  personId: string,
  receivedAt: string,
  generator: () => string,
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const medicalId = generator();
    const result = await client.query<{ identifier_value: string }>(
      `INSERT INTO person_identifiers (
         id, person_id, identifier_system, identifier_value,
         identifier_type_code, issuer_organization_id, status, is_primary,
         valid_from, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', true, $7, $7)
       ON CONFLICT (identifier_system, identifier_value) DO NOTHING
       RETURNING identifier_value`,
      [
        randomUUID(),
        personId,
        CHS_MEDICAL_ID_SYSTEM,
        medicalId,
        CHS_MEDICAL_ID_TYPE,
        context.organizationId,
        receivedAt,
      ],
    );
    if (result.rows[0]) return result.rows[0].identifier_value;
  }

  throw new PatientRecordProcessingError('PATIENT_IDENTITY_INVARIANT');
}

function hasStrictKnownIdEvidence(
  person: PersonIdentityRow,
  payload: PatientPayload,
): boolean {
  return (
    payload.dateOfBirth !== null &&
    person.date_of_birth === payload.dateOfBirth &&
    person.name_normalized === normalizeIdentityName(payload.displayName)
  );
}

async function findKnownMedicalId(
  client: PoolClient,
  medicalId: string,
): Promise<(PersonIdentityRow & MedicalIdRow) | undefined> {
  const result = await client.query<PersonIdentityRow & MedicalIdRow>(
    `SELECT
       person.id,
       person.name_normalized,
       person.date_of_birth,
       person.phone_normalized,
       identifier.person_id,
       identifier.identifier_value
     FROM person_identifiers AS identifier
     JOIN persons AS person ON person.id = identifier.person_id
     WHERE identifier.identifier_system = $1
       AND identifier.identifier_type_code = $2
       AND identifier.identifier_value = $3
       AND identifier.status = 'ACTIVE'
       AND identifier.is_primary = true
     FOR SHARE`,
    [CHS_MEDICAL_ID_SYSTEM, CHS_MEDICAL_ID_TYPE, medicalId],
  );
  return result.rows[0];
}

async function findCandidates(
  client: PoolClient,
  payload: PatientPayload,
): Promise<readonly ReviewCandidate[]> {
  const normalizedName = normalizeIdentityName(payload.displayName);
  const normalizedPhone = normalizePhone(payload.phone);
  const result = await client.query<CandidateRow>(
    `SELECT
       id,
       name_normalized,
       date_of_birth,
       phone_normalized,
       ($4::integer IS NOT NULL
         AND approximate_age_years BETWEEN $4::integer - 1 AND $4::integer + 1
       ) AS approximate_age_matches,
       ($2::date IS NOT NULL AND date_of_birth = $2::date) AS date_of_birth_matches,
       ($3::text IS NOT NULL AND phone_normalized = $3::text) AS phone_matches
     FROM persons
     WHERE status <> 'DECEASED'
       AND name_normalized = $1
       AND (
         ($2::date IS NOT NULL AND date_of_birth = $2::date)
         OR ($3::text IS NOT NULL AND phone_normalized = $3::text)
         OR ($4::integer IS NOT NULL
           AND approximate_age_years BETWEEN $4::integer - 1 AND $4::integer + 1)
       )
     ORDER BY id
     LIMIT 12
     FOR SHARE`,
    [
      normalizedName,
      payload.dateOfBirth,
      normalizedPhone,
      payload.approximateAgeYears,
    ],
  );

  return result.rows.map((candidate) => {
    const matchedOn = ['NORMALIZED_NAME'];
    if (candidate.date_of_birth_matches) matchedOn.push('DATE_OF_BIRTH');
    if (candidate.phone_matches) matchedOn.push('PHONE');
    if (candidate.approximate_age_matches) matchedOn.push('APPROXIMATE_AGE');
    return {
      personId: candidate.id,
      score: candidate.date_of_birth_matches
        ? 95
        : candidate.phone_matches
          ? 80
          : 65,
      matchedOn,
    };
  });
}

async function openReviewCase(
  client: PoolClient,
  context: InstallationContext,
  record: PatientSyncRecord,
  candidates: readonly ReviewCandidate[],
  receivedAt: string,
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `SELECT id
     FROM identity_review_cases
     WHERE installation_id = $1
       AND local_patient_id = $2
       AND status = 'OPEN'
     FOR UPDATE`,
    [context.installationId, record.localResourceId],
  );
  const reviewCaseId = existing.rows[0]?.id ?? randomUUID();

  if (existing.rows[0]) {
    await client.query(
      `UPDATE identity_review_cases
       SET updated_at = $1
       WHERE id = $2`,
      [receivedAt, reviewCaseId],
    );
  } else {
    await client.query(
      `INSERT INTO identity_review_cases (
         id, installation_id, local_patient_id, status, opened_at, created_at,
         updated_at
       ) VALUES ($1, $2, $3, 'OPEN', $4, $4, $4)`,
      [reviewCaseId, context.installationId, record.localResourceId, receivedAt],
    );
  }

  for (const candidate of candidates) {
    await client.query(
      `INSERT INTO identity_review_candidates (
         review_case_id, person_id, score, matched_on, created_at
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (review_case_id, person_id) DO UPDATE
       SET score = EXCLUDED.score,
           matched_on = EXCLUDED.matched_on`,
      [
        reviewCaseId,
        candidate.personId,
        candidate.score,
        candidate.matchedOn,
        receivedAt,
      ],
    );
  }
  return reviewCaseId;
}

async function persistTerminalOutcome(
  client: PoolClient,
  context: InstallationContext,
  batchInternalId: string,
  batchActorId: string,
  record: PatientSyncRecord,
  recordHash: string,
  outcome: PatientRecordOutcome,
  reviewCaseId: string | null,
  processedAt: string,
): Promise<PatientRecordOutcome> {
  await insertSyncRecord(
    client,
    context,
    batchInternalId,
    batchActorId,
    record,
    recordHash,
    outcome,
    reviewCaseId,
    processedAt,
  );
  return outcome;
}

export async function processPatientRecord(
  database: PatientIdentityDatabase,
  context: InstallationContext,
  batchInternalId: string,
  record: PatientSyncRecord,
  now: Date = new Date(),
  options: PatientIdentityProcessorOptions = {},
): Promise<PatientRecordOutcome> {
  const processedAt = now.toISOString();
  const recordHash = canonicalJsonSha256(record);
  const contentHash = canonicalJsonSha256(record.payload);
  const generator = options.generateMedicalId ?? generateChsMedicalId;
  const client = await database.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('chs.patient-identity.v1'))`);

    const batchResult = await client.query<BatchRow>(
      `SELECT id, status
       FROM sync_batches
       WHERE id = $1
         AND installation_id = $2
         AND organization_id = $3
       FOR UPDATE`,
      [batchInternalId, context.installationId, context.organizationId],
    );
    const batch = batchResult.rows[0];
    if (!batch || batch.status !== 'PROCESSING') {
      throw new PatientRecordProcessingError('BATCH_NOT_AVAILABLE');
    }

    const actorResult = await client.query<BatchActorRow>(
      `SELECT id
       FROM sync_batch_actors
       WHERE batch_internal_id = $1 AND source_actor_local_id = $2`,
      [batchInternalId, record.sourceActorLocalId],
    );
    const batchActorId = actorResult.rows[0]?.id;
    if (!batchActorId) {
      throw new PatientRecordProcessingError('SOURCE_ACTOR_NOT_AVAILABLE');
    }

    const priorResult = await client.query<ExistingSyncRecordRow>(
      `SELECT id, payload_hash, status, person_id, identity_review_case_id, errors
       FROM sync_records
       WHERE installation_id = $1
         AND (
           record_id = $2
           OR (
             resource_type = 'PATIENT'
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
      const matchingIds = new Set(priorResult.rows.map((prior) => prior.id));
      const mismatch =
        matchingIds.size > 1 ||
        priorResult.rows.some((prior) => prior.payload_hash !== recordHash);
      const outcome = mismatch
        ? rejectedOutcome(record, 'RECORD_PAYLOAD_MISMATCH', '')
        : await outcomeFromExisting(client, record, priorResult.rows[0]!);
      await client.query('COMMIT');
      return outcome;
    }

    const normalizedName = normalizeIdentityName(record.payload.displayName);
    if (normalizedName.length === 0) {
      const outcome = rejectedOutcome(
        record,
        'INVALID_PATIENT_IDENTITY',
        '/payload/displayName',
      );
      await persistTerminalOutcome(
        client,
        context,
        batchInternalId,
        batchActorId,
        record,
        recordHash,
        outcome,
        null,
        processedAt,
      );
      await client.query('COMMIT');
      return outcome;
    }

    const sourceLinks = await client.query<PatientSourceLinkRow>(
      `SELECT
         id, person_id, local_patient_id, local_patient_code,
         last_source_revision, last_content_hash
       FROM patient_source_links
       WHERE installation_id = $1
         AND (local_patient_id = $2 OR local_patient_code = $3)
       FOR UPDATE`,
      [
        context.installationId,
        record.localResourceId,
        record.payload.localPatientCode,
      ],
    );
    const conflictingCode = sourceLinks.rows.find(
      (link) => link.local_patient_id !== record.localResourceId,
    );
    if (conflictingCode) {
      const outcome = rejectedOutcome(
        record,
        'LOCAL_PATIENT_CODE_CONFLICT',
        '/payload/localPatientCode',
      );
      await persistTerminalOutcome(
        client,
        context,
        batchInternalId,
        batchActorId,
        record,
        recordHash,
        outcome,
        null,
        processedAt,
      );
      await client.query('COMMIT');
      return outcome;
    }

    const sourceLink = sourceLinks.rows.find(
      (link) => link.local_patient_id === record.localResourceId,
    );
    if (sourceLink) {
      if (record.sourceRevision < sourceLink.last_source_revision) {
        const outcome = rejectedOutcome(
          record,
          'STALE_SOURCE_REVISION',
          '/sourceRevision',
        );
        await persistTerminalOutcome(
          client,
          context,
          batchInternalId,
          batchActorId,
          record,
          recordHash,
          outcome,
          null,
          processedAt,
        );
        await client.query('COMMIT');
        return outcome;
      }
      if (
        record.sourceRevision === sourceLink.last_source_revision &&
        contentHash !== sourceLink.last_content_hash
      ) {
        const outcome = rejectedOutcome(record, 'RECORD_PAYLOAD_MISMATCH', '/payload');
        await persistTerminalOutcome(
          client,
          context,
          batchInternalId,
          batchActorId,
          record,
          recordHash,
          outcome,
          null,
          processedAt,
        );
        await client.query('COMMIT');
        return outcome;
      }

      const currentMedicalId = await getMedicalId(client, sourceLink.person_id);
      if (
        record.payload.knownChsMedicalId !== null &&
        record.payload.knownChsMedicalId !== currentMedicalId
      ) {
        const outcome = rejectedOutcome(
          record,
          'KNOWN_CHS_MEDICAL_ID_CONFLICT',
          '/payload/knownChsMedicalId',
        );
        await persistTerminalOutcome(
          client,
          context,
          batchInternalId,
          batchActorId,
          record,
          recordHash,
          outcome,
          null,
          processedAt,
        );
        await client.query('COMMIT');
        return outcome;
      }

      if (record.sourceRevision === sourceLink.last_source_revision) {
        const outcome = acceptedOutcome(
          record,
          'UNCHANGED',
          sourceLink.person_id,
          currentMedicalId,
          'CONFIRMED',
        );
        await persistTerminalOutcome(
          client,
          context,
          batchInternalId,
          batchActorId,
          record,
          recordHash,
          outcome,
          null,
          processedAt,
        );
        await client.query('COMMIT');
        return outcome;
      }

      await updatePerson(client, record.payload, sourceLink.person_id, processedAt);
      await updatePatientSourceLink(
        client,
        sourceLink.id,
        record,
        contentHash,
        processedAt,
      );
      const outcome = acceptedOutcome(
        record,
        'ACCEPTED',
        sourceLink.person_id,
        currentMedicalId,
        'CONFIRMED',
      );
      await persistTerminalOutcome(
        client,
        context,
        batchInternalId,
        batchActorId,
        record,
        recordHash,
        outcome,
        null,
        processedAt,
      );
      await client.query('COMMIT');
      return outcome;
    }

    if (record.payload.knownChsMedicalId !== null) {
      const knownPerson = await findKnownMedicalId(
        client,
        record.payload.knownChsMedicalId,
      );
      if (!knownPerson) {
        const outcome = rejectedOutcome(
          record,
          'UNKNOWN_CHS_MEDICAL_ID',
          '/payload/knownChsMedicalId',
        );
        await persistTerminalOutcome(
          client,
          context,
          batchInternalId,
          batchActorId,
          record,
          recordHash,
          outcome,
          null,
          processedAt,
        );
        await client.query('COMMIT');
        return outcome;
      }

      if (!hasStrictKnownIdEvidence(knownPerson, record.payload)) {
        const reviewCaseId = await openReviewCase(
          client,
          context,
          record,
          [
            {
              personId: knownPerson.person_id,
              score: 100,
              matchedOn: ['KNOWN_CHS_MEDICAL_ID'],
            },
          ],
          processedAt,
        );
        const outcome = reviewOutcome(record, 'IDENTITY_VERIFICATION_REQUIRED');
        await persistTerminalOutcome(
          client,
          context,
          batchInternalId,
          batchActorId,
          record,
          recordHash,
          outcome,
          reviewCaseId,
          processedAt,
        );
        await client.query('COMMIT');
        return outcome;
      }

      await updatePerson(client, record.payload, knownPerson.person_id, processedAt);
      await insertPatientSourceLink(
        client,
        context,
        record,
        knownPerson.person_id,
        contentHash,
        processedAt,
      );
      const outcome = acceptedOutcome(
        record,
        'ACCEPTED',
        knownPerson.person_id,
        knownPerson.identifier_value,
        'CONFIRMED',
      );
      await persistTerminalOutcome(
        client,
        context,
        batchInternalId,
        batchActorId,
        record,
        recordHash,
        outcome,
        null,
        processedAt,
      );
      await client.query('COMMIT');
      return outcome;
    }

    const candidates = await findCandidates(client, record.payload);
    if (candidates.length > 0) {
      const reviewCaseId = await openReviewCase(
        client,
        context,
        record,
        candidates,
        processedAt,
      );
      const outcome = reviewOutcome(record, 'POSSIBLE_DUPLICATE');
      await persistTerminalOutcome(
        client,
        context,
        batchInternalId,
        batchActorId,
        record,
        recordHash,
        outcome,
        reviewCaseId,
        processedAt,
      );
      await client.query('COMMIT');
      return outcome;
    }

    const personId = randomUUID();
    await insertPerson(client, record.payload, personId, processedAt);
    const medicalId = await issueMedicalId(
      client,
      context,
      personId,
      processedAt,
      generator,
    );
    await insertPatientSourceLink(
      client,
      context,
      record,
      personId,
      contentHash,
      processedAt,
    );
    const outcome = acceptedOutcome(
      record,
      'ACCEPTED',
      personId,
      medicalId,
      'ASSIGNED',
    );
    await persistTerminalOutcome(
      client,
      context,
      batchInternalId,
      batchActorId,
      record,
      recordHash,
      outcome,
      null,
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
