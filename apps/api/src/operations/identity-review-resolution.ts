import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import {
  CHS_MEDICAL_ID_SYSTEM,
  CHS_MEDICAL_ID_TYPE,
  generateChsMedicalId,
} from '../sync/medical-id.js';
import { recordPatientAccessAudit } from './audit.js';
import type { PatientAccessScope } from './patient-query.js';

type ResolutionDatabase = Pick<Pool, 'connect'>;

export type IdentityReviewResolutionAction =
  | Readonly<{
      kind: 'LINK_EXISTING';
      candidatePersonReference: string;
    }>
  | Readonly<{ kind: 'CREATE_NEW' }>;

export type IdentityReviewResolutionInput = Readonly<{
  resolutionRequestId: string;
  caseReference: string;
  expectedUpdatedAt: string;
  resolutionNote: string;
  resolution: IdentityReviewResolutionAction;
}>;

export type IdentityReviewResolutionResult = Readonly<{
  resolutionRequestId: string;
  caseReference: string;
  resolutionStatus: 'RESOLVED_EXISTING' | 'RESOLVED_NEW';
  resolvedPersonReference: string;
  chsMedicalId: string;
  installationId: string;
  localPatientReference: string;
  localPatientCode: string;
  sourceRevision: number;
  resolvedAt: string;
  replayed: boolean;
}>;

export type IdentityReviewResolutionAuditContext = Readonly<{
  requestId: string;
  sourceIp: string;
  userAgent: string | null;
  sessionId: string | null;
  authorizedParty: string | null;
}>;

export type IdentityReviewResolutionErrorCode =
  | 'IDENTITY_REVIEW_CASE_NOT_FOUND'
  | 'IDENTITY_REVIEW_ALREADY_RESOLVED'
  | 'IDENTITY_REVIEW_CANDIDATE_NOT_AVAILABLE'
  | 'IDENTITY_REVIEW_EVIDENCE_INCOMPLETE'
  | 'IDENTITY_REVIEW_RESOLUTION_INVARIANT'
  | 'IDENTITY_REVIEW_RESOLUTION_REQUEST_REUSE'
  | 'IDENTITY_REVIEW_STALE'
  | 'INVALID_ACCESS_SCOPE'
  | 'INVALID_CANDIDATE_REFERENCE'
  | 'INVALID_CASE_REFERENCE'
  | 'INVALID_EXPECTED_UPDATED_AT'
  | 'INVALID_RESOLUTION_ACTION'
  | 'INVALID_RESOLUTION_NOTE'
  | 'INVALID_RESOLUTION_REQUEST_ID';

export class IdentityReviewResolutionError extends Error {
  constructor(
    readonly code: IdentityReviewResolutionErrorCode,
    readonly statusCode: 400 | 404 | 409 | 500,
  ) {
    super('Identity review resolution failed');
    this.name = 'IdentityReviewResolutionError';
  }
}

type PreparedScope = Readonly<{
  global: boolean;
  organizationIds: readonly string[];
}>;

type PreparedResolution = Readonly<{
  resolutionRequestId: string;
  caseReference: string;
  expectedUpdatedAt: string;
  resolutionNote: string;
  actionCode: 'LINK_EXISTING' | 'CREATE_NEW';
  candidatePersonReference: string | null;
}>;

type ResolutionRow = Readonly<{
  resolution_request_id: string;
  review_case_id: string;
  request_hash: string;
  action_code: 'LINK_EXISTING' | 'CREATE_NEW';
  resolved_person_id: string;
  resolved_chs_medical_id: string;
  organization_id: string;
  installation_id: string;
  local_patient_id: string;
  local_patient_code: string;
  source_revision: number;
  resolved_at: Date;
}>;

type CaseRow = Readonly<{
  case_reference: string;
  case_status: 'OPEN' | 'RESOLVED_NEW' | 'RESOLVED_EXISTING' | 'DISMISSED';
  case_updated_at: Date;
  organization_id: string;
  installation_id: string;
  local_patient_id: string;
  evidence_id: string | null;
  source_revision: number | null;
  payload_hash: string | null;
  local_patient_code: string | null;
  display_name: string | null;
  name_normalized: string | null;
  given_name: string | null;
  family_name: string | null;
  other_names: string | null;
  date_of_birth: string | null;
  approximate_age_years: number | null;
  age_as_of_date: string | null;
  sex: 'FEMALE' | 'MALE' | 'OTHER' | 'UNKNOWN' | null;
  phone: string | null;
  phone_normalized: string | null;
  village: string | null;
  quarter: string | null;
  acknowledgment_status:
    | 'ACKNOWLEDGED'
    | 'DECLINED'
    | 'NOT_REQUESTED'
    | null;
  patient_status: 'ACTIVE' | 'INACTIVE' | null;
  source_created_at: Date | null;
  source_updated_at: Date | null;
  received_at: Date | null;
}>;

type CandidateRow = Readonly<{
  person_id: string;
  identifier_value: string;
}>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function prepareScope(scope: PatientAccessScope): PreparedScope {
  if (scope.kind === 'GLOBAL') return { global: true, organizationIds: [] };
  const organizationIds = [...new Set(scope.organizationIds)];
  if (
    organizationIds.length === 0 ||
    organizationIds.some((organizationId) => !uuidPattern.test(organizationId))
  ) {
    throw new IdentityReviewResolutionError('INVALID_ACCESS_SCOPE', 400);
  }
  return { global: false, organizationIds };
}

function normalizedInstant(value: string): string {
  if (
    value.length > 40 ||
    !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new IdentityReviewResolutionError('INVALID_EXPECTED_UPDATED_AT', 400);
  }
  return new Date(value).toISOString();
}

function prepareResolution(input: IdentityReviewResolutionInput): PreparedResolution {
  if (!uuidPattern.test(input.resolutionRequestId)) {
    throw new IdentityReviewResolutionError(
      'INVALID_RESOLUTION_REQUEST_ID',
      400,
    );
  }
  if (!uuidPattern.test(input.caseReference)) {
    throw new IdentityReviewResolutionError('INVALID_CASE_REFERENCE', 400);
  }
  const resolutionNote = input.resolutionNote.trim();
  if (
    resolutionNote.length < 10 ||
    resolutionNote.length > 1000 ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(resolutionNote)
  ) {
    throw new IdentityReviewResolutionError('INVALID_RESOLUTION_NOTE', 400);
  }
  if (input.resolution.kind === 'LINK_EXISTING') {
    if (!uuidPattern.test(input.resolution.candidatePersonReference)) {
      throw new IdentityReviewResolutionError('INVALID_CANDIDATE_REFERENCE', 400);
    }
    return {
      resolutionRequestId: input.resolutionRequestId,
      caseReference: input.caseReference,
      expectedUpdatedAt: normalizedInstant(input.expectedUpdatedAt),
      resolutionNote,
      actionCode: 'LINK_EXISTING',
      candidatePersonReference: input.resolution.candidatePersonReference,
    };
  }
  if (input.resolution.kind !== 'CREATE_NEW') {
    throw new IdentityReviewResolutionError('INVALID_RESOLUTION_ACTION', 400);
  }
  return {
    resolutionRequestId: input.resolutionRequestId,
    caseReference: input.caseReference,
    expectedUpdatedAt: normalizedInstant(input.expectedUpdatedAt),
    resolutionNote,
    actionCode: 'CREATE_NEW',
    candidatePersonReference: null,
  };
}

function requestHash(
  input: PreparedResolution,
  operationsUserId: string,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        resolutionRequestId: input.resolutionRequestId,
        caseReference: input.caseReference,
        expectedUpdatedAt: input.expectedUpdatedAt,
        resolutionNote: input.resolutionNote,
        actionCode: input.actionCode,
        candidatePersonReference: input.candidatePersonReference,
        operationsUserId,
      }),
    )
    .digest('hex');
}

function scopeAllows(scope: PreparedScope, organizationId: string): boolean {
  return scope.global || scope.organizationIds.includes(organizationId);
}

function resultFromRow(
  row: ResolutionRow,
  replayed: boolean,
): IdentityReviewResolutionResult {
  return {
    resolutionRequestId: row.resolution_request_id,
    caseReference: row.review_case_id,
    resolutionStatus:
      row.action_code === 'LINK_EXISTING'
        ? 'RESOLVED_EXISTING'
        : 'RESOLVED_NEW',
    resolvedPersonReference: row.resolved_person_id,
    chsMedicalId: row.resolved_chs_medical_id,
    installationId: row.installation_id,
    localPatientReference: row.local_patient_id,
    localPatientCode: row.local_patient_code,
    sourceRevision: row.source_revision,
    resolvedAt: row.resolved_at.toISOString(),
    replayed,
  };
}

async function findResolution(
  client: PoolClient,
  resolutionRequestId: string,
): Promise<ResolutionRow | undefined> {
  const result = await client.query<ResolutionRow>(
    `SELECT
       resolution.id AS resolution_request_id,
       resolution.review_case_id,
       resolution.request_hash,
       resolution.action_code,
       resolution.resolved_person_id,
       resolution.resolved_chs_medical_id,
       installation.organization_id,
       review_case.installation_id,
       review_case.local_patient_id,
       evidence.local_patient_code,
       evidence.source_revision,
       resolution.resolved_at
     FROM identity_review_resolutions AS resolution
     JOIN identity_review_cases AS review_case
       ON review_case.id = resolution.review_case_id
     JOIN desktop_installations AS installation
       ON installation.id = review_case.installation_id
     JOIN LATERAL (
       SELECT snapshot.local_patient_code, snapshot.source_revision
       FROM identity_review_evidence_snapshots AS snapshot
       WHERE snapshot.review_case_id = review_case.id
       ORDER BY snapshot.source_revision DESC, snapshot.received_at DESC,
         snapshot.id DESC
       LIMIT 1
     ) AS evidence ON true
     WHERE resolution.id = $1`,
    [resolutionRequestId],
  );
  return result.rows[0];
}

async function lockCase(
  client: PoolClient,
  scope: PreparedScope,
  caseReference: string,
): Promise<CaseRow | undefined> {
  const result = await client.query<CaseRow>(
    `SELECT
       review_case.id AS case_reference,
       review_case.status AS case_status,
       review_case.updated_at AS case_updated_at,
       installation.organization_id,
       review_case.installation_id,
       review_case.local_patient_id,
       evidence.id AS evidence_id,
       evidence.source_revision,
       evidence.payload_hash,
       evidence.local_patient_code,
       evidence.display_name,
       evidence.name_normalized,
       evidence.given_name,
       evidence.family_name,
       evidence.other_names,
       evidence.date_of_birth::text AS date_of_birth,
       evidence.approximate_age_years,
       evidence.age_as_of_date::text AS age_as_of_date,
       evidence.sex,
       evidence.phone,
       evidence.phone_normalized,
       evidence.village,
       evidence.quarter,
       evidence.acknowledgment_status,
       evidence.patient_status,
       evidence.source_created_at,
       evidence.source_updated_at,
       evidence.received_at
     FROM identity_review_cases AS review_case
     JOIN desktop_installations AS installation
       ON installation.id = review_case.installation_id
     LEFT JOIN LATERAL (
       SELECT snapshot.*
       FROM identity_review_evidence_snapshots AS snapshot
       WHERE snapshot.review_case_id = review_case.id
       ORDER BY snapshot.source_revision DESC, snapshot.received_at DESC,
         snapshot.id DESC
       LIMIT 1
     ) AS evidence ON true
     WHERE review_case.id = $1
       AND ($2::boolean OR installation.organization_id = ANY($3::uuid[]))
     FOR UPDATE OF review_case`,
    [caseReference, scope.global, scope.organizationIds],
  );
  return result.rows[0];
}

function requireEvidence(row: CaseRow): asserts row is CaseRow & {
  evidence_id: string;
  source_revision: number;
  payload_hash: string;
  local_patient_code: string;
  display_name: string;
  name_normalized: string;
  sex: NonNullable<CaseRow['sex']>;
  source_created_at: Date;
  source_updated_at: Date;
  received_at: Date;
} {
  if (
    !row.evidence_id ||
    row.source_revision === null ||
    !row.payload_hash ||
    !row.local_patient_code ||
    !row.display_name ||
    !row.name_normalized ||
    !row.sex ||
    !row.source_created_at ||
    !row.source_updated_at ||
    !row.received_at
  ) {
    throw new IdentityReviewResolutionError(
      'IDENTITY_REVIEW_EVIDENCE_INCOMPLETE',
      409,
    );
  }
}

async function candidateTarget(
  client: PoolClient,
  caseReference: string,
  personReference: string,
): Promise<CandidateRow> {
  const result = await client.query<CandidateRow>(
    `SELECT candidate.person_id, medical_id.identifier_value
     FROM identity_review_candidates AS candidate
     JOIN persons AS person
       ON person.id = candidate.person_id AND person.status = 'ACTIVE'
     JOIN person_identifiers AS medical_id
       ON medical_id.person_id = person.id
      AND medical_id.identifier_system = $3
      AND medical_id.identifier_type_code = $4
      AND medical_id.status = 'ACTIVE'
      AND medical_id.is_primary = true
     WHERE candidate.review_case_id = $1
       AND candidate.person_id = $2
     FOR SHARE OF candidate, person, medical_id`,
    [caseReference, personReference, CHS_MEDICAL_ID_SYSTEM, CHS_MEDICAL_ID_TYPE],
  );
  const target = result.rows[0];
  if (!target) {
    throw new IdentityReviewResolutionError(
      'IDENTITY_REVIEW_CANDIDATE_NOT_AVAILABLE',
      409,
    );
  }
  return target;
}

async function createPerson(
  client: PoolClient,
  evidence: CaseRow & {
    display_name: string;
    name_normalized: string;
    sex: NonNullable<CaseRow['sex']>;
    received_at: Date;
  },
  organizationId: string,
  resolvedAt: Date,
  randomId: () => string,
  medicalIdGenerator: () => string,
): Promise<CandidateRow> {
  if (!evidence.acknowledgment_status || !evidence.patient_status) {
    throw new IdentityReviewResolutionError(
      'IDENTITY_REVIEW_EVIDENCE_INCOMPLETE',
      409,
    );
  }
  const personId = randomId();
  await client.query(
    `INSERT INTO persons (
       id, display_name, given_name, family_name, other_names, name_normalized,
       sex, acknowledgment_status, date_of_birth, approximate_age_years,
       age_as_of_date, phone, phone_normalized, alternate_contact_name,
       alternate_contact_phone, village, quarter, residence_notes, status,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       NULL, NULL, $14, $15, NULL, $16, $17, $17
     )`,
    [
      personId,
      evidence.display_name,
      evidence.given_name,
      evidence.family_name,
      evidence.other_names,
      evidence.name_normalized,
      evidence.sex,
      evidence.acknowledgment_status,
      evidence.date_of_birth,
      evidence.approximate_age_years,
      evidence.age_as_of_date,
      evidence.phone,
      evidence.phone_normalized,
      evidence.village,
      evidence.quarter,
      evidence.patient_status,
      resolvedAt.toISOString(),
    ],
  );

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const medicalId = medicalIdGenerator();
    const result = await client.query<{ identifier_value: string }>(
      `INSERT INTO person_identifiers (
         id, person_id, identifier_system, identifier_value,
         identifier_type_code, issuer_organization_id, status, is_primary,
         valid_from, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', true, $7, $7)
       ON CONFLICT (identifier_system, identifier_value) DO NOTHING
       RETURNING identifier_value`,
      [
        randomId(),
        personId,
        CHS_MEDICAL_ID_SYSTEM,
        medicalId,
        CHS_MEDICAL_ID_TYPE,
        organizationId,
        resolvedAt.toISOString(),
      ],
    );
    if (result.rows[0]) {
      return { person_id: personId, identifier_value: result.rows[0].identifier_value };
    }
  }
  throw new IdentityReviewResolutionError(
    'IDENTITY_REVIEW_RESOLUTION_INVARIANT',
    500,
  );
}

async function recordSuccessAudit(
  client: PoolClient,
  accessScope: PatientAccessScope,
  operationsUserId: string,
  input: PreparedResolution,
  result: IdentityReviewResolutionResult,
  audit: IdentityReviewResolutionAuditContext,
  occurredAt: Date,
) {
  await recordPatientAccessAudit(
    client,
    {
      operationsUserId,
      principalFingerprint: null,
      scope: accessScope,
      action: 'IDENTITY_REVIEW_RESOLVE',
      outcome: 'SUCCESS',
      entityId: input.caseReference,
      reason: 'IDENTITY_RECONCILIATION',
      ...audit,
      route: '/api/v1/operations/identity-reviews/resolve',
      metadata: {
        resolutionAction: input.actionCode,
        resolutionStatus: result.resolutionStatus,
        replayed: result.replayed,
      },
    },
    occurredAt,
  );
}

export async function resolveIdentityReviewCase(
  database: ResolutionDatabase,
  accessScope: PatientAccessScope,
  operationsUserId: string,
  input: IdentityReviewResolutionInput,
  audit: IdentityReviewResolutionAuditContext,
  options: Readonly<{
    now?: Date;
    randomId?: () => string;
    medicalIdGenerator?: () => string;
  }> = {},
): Promise<IdentityReviewResolutionResult> {
  const scope = prepareScope(accessScope);
  if (!uuidPattern.test(operationsUserId)) {
    throw new IdentityReviewResolutionError(
      'IDENTITY_REVIEW_RESOLUTION_INVARIANT',
      500,
    );
  }
  const prepared = prepareResolution(input);
  const hash = requestHash(prepared, operationsUserId);
  const now = options.now ?? new Date();
  const randomId = options.randomId ?? randomUUID;
  const medicalIdGenerator = options.medicalIdGenerator ?? generateChsMedicalId;
  const client = await database.connect();
  let committed = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    const existing = await findResolution(client, prepared.resolutionRequestId);
    if (existing) {
      if (!scopeAllows(scope, existing.organization_id)) {
        throw new IdentityReviewResolutionError(
          'IDENTITY_REVIEW_CASE_NOT_FOUND',
          404,
        );
      }
      if (
        existing.review_case_id !== prepared.caseReference ||
        existing.request_hash !== hash
      ) {
        throw new IdentityReviewResolutionError(
          'IDENTITY_REVIEW_RESOLUTION_REQUEST_REUSE',
          409,
        );
      }
      const replay = resultFromRow(existing, true);
      await recordSuccessAudit(
        client,
        accessScope,
        operationsUserId,
        prepared,
        replay,
        audit,
        now,
      );
      await client.query('COMMIT');
      committed = true;
      return replay;
    }

    const reviewCase = await lockCase(client, scope, prepared.caseReference);
    if (!reviewCase) {
      throw new IdentityReviewResolutionError(
        'IDENTITY_REVIEW_CASE_NOT_FOUND',
        404,
      );
    }
    if (reviewCase.case_status !== 'OPEN') {
      throw new IdentityReviewResolutionError(
        'IDENTITY_REVIEW_ALREADY_RESOLVED',
        409,
      );
    }
    if (reviewCase.case_updated_at.toISOString() !== prepared.expectedUpdatedAt) {
      throw new IdentityReviewResolutionError('IDENTITY_REVIEW_STALE', 409);
    }
    requireEvidence(reviewCase);

    const sourceLink = await client.query(
      `SELECT person_id
       FROM patient_source_links
       WHERE installation_id = $1 AND local_patient_id = $2
       FOR UPDATE`,
      [reviewCase.installation_id, reviewCase.local_patient_id],
    );
    if (sourceLink.rows[0]) {
      throw new IdentityReviewResolutionError(
        'IDENTITY_REVIEW_RESOLUTION_INVARIANT',
        500,
      );
    }

    const target =
      prepared.actionCode === 'LINK_EXISTING'
        ? await candidateTarget(
            client,
            prepared.caseReference,
            prepared.candidatePersonReference!,
          )
        : await createPerson(
            client,
            reviewCase,
            reviewCase.organization_id,
            now,
            randomId,
            medicalIdGenerator,
          );

    const caseUpdate = await client.query(
      `INSERT INTO patient_source_links (
         id, person_id, installation_id, local_patient_id, local_patient_code,
         last_source_revision, last_content_hash, source_created_at,
         source_updated_at, first_observed_at, last_observed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [
        randomId(),
        target.person_id,
        reviewCase.installation_id,
        reviewCase.local_patient_id,
        reviewCase.local_patient_code,
        reviewCase.source_revision,
        reviewCase.payload_hash,
        reviewCase.source_created_at.toISOString(),
        reviewCase.source_updated_at.toISOString(),
        reviewCase.received_at.toISOString(),
      ],
    );
    if (caseUpdate.rowCount !== 1) {
      throw new IdentityReviewResolutionError('IDENTITY_REVIEW_STALE', 409);
    }

    const resolutionStatus =
      prepared.actionCode === 'LINK_EXISTING'
        ? 'RESOLVED_EXISTING'
        : 'RESOLVED_NEW';
    await client.query(
      `UPDATE identity_review_cases
       SET status = $1,
           resolved_at = $2,
           resolved_person_id = $3,
           resolution_note = $4,
           updated_at = $2
       WHERE id = $5 AND status = 'OPEN' AND updated_at = $6`,
      [
        resolutionStatus,
        now.toISOString(),
        target.person_id,
        prepared.resolutionNote,
        prepared.caseReference,
        prepared.expectedUpdatedAt,
      ],
    );
    await client.query(
      `INSERT INTO identity_review_resolutions (
         id, review_case_id, request_hash, action_code,
         selected_candidate_person_id, resolved_person_id,
         resolved_chs_medical_id, operations_user_id, expected_case_updated_at,
         resolution_note, resolved_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
      [
        prepared.resolutionRequestId,
        prepared.caseReference,
        hash,
        prepared.actionCode,
        prepared.candidatePersonReference,
        target.person_id,
        target.identifier_value,
        operationsUserId,
        prepared.expectedUpdatedAt,
        prepared.resolutionNote,
        now.toISOString(),
      ],
    );
    const result: IdentityReviewResolutionResult = {
      resolutionRequestId: prepared.resolutionRequestId,
      caseReference: prepared.caseReference,
      resolutionStatus,
      resolvedPersonReference: target.person_id,
      chsMedicalId: target.identifier_value,
      installationId: reviewCase.installation_id,
      localPatientReference: reviewCase.local_patient_id,
      localPatientCode: reviewCase.local_patient_code,
      sourceRevision: reviewCase.source_revision,
      resolvedAt: now.toISOString(),
      replayed: false,
    };
    await recordSuccessAudit(
      client,
      accessScope,
      operationsUserId,
      prepared,
      result,
      audit,
      now,
    );
    await client.query('COMMIT');
    committed = true;
    return result;
  } catch (error) {
    if (!committed) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
