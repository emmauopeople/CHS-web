import type { Pool, PoolClient } from 'pg';

import { CHS_MEDICAL_ID_SYSTEM, CHS_MEDICAL_ID_TYPE } from '../sync/medical-id.js';
import type { PatientAccessScope } from './patient-query.js';

type IdentityReviewDatabase = Pick<Pool, 'connect' | 'query'>;

export type IdentityReviewEvidenceState = 'AVAILABLE' | 'EVIDENCE_PENDING';

export type IdentityReviewQueueQuery = Readonly<{
  evidenceState?: IdentityReviewEvidenceState | 'ALL';
  installationId?: string;
  openedFrom?: string;
  openedTo?: string;
  page?: number;
  pageSize?: number;
}>;

export type MaskedBirthEvidence =
  | Readonly<{ kind: 'DATE_OF_BIRTH'; maskedDate: string }>
  | Readonly<{
      kind: 'APPROXIMATE_AGE';
      ageYears: number;
      asOfYear: number;
    }>;

export type IdentityReviewQueueItem = Readonly<{
  caseReference: string;
  status: 'OPEN';
  evidenceState: IdentityReviewEvidenceState;
  organizationName: string;
  locationName: string;
  installationId: string;
  deploymentName: string;
  openedAt: string;
  updatedAt: string;
  candidateCount: number;
  latestSourceRevision: number | null;
  sourceCapturedAt: string | null;
  localPatientCode: string | null;
  maskedSubmittedName: string | null;
  submittedBirthEvidence: MaskedBirthEvidence | null;
}>;

export type IdentityReviewQueuePage = Readonly<{
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  items: readonly IdentityReviewQueueItem[];
}>;

export type IdentityReviewEvidenceDetail = Readonly<{
  sourceRecordReference: string;
  sourceRevision: number;
  schemaVersion: string;
  capturedAt: string;
  localPatientCode: string;
  maskedClaimedChsMedicalId: string | null;
  displayName: string;
  givenName: string | null;
  familyName: string | null;
  otherNames: string | null;
  dateOfBirth: string | null;
  approximateAgeYears: number | null;
  ageAsOfDate: string | null;
  sex: 'FEMALE' | 'MALE' | 'OTHER' | 'UNKNOWN';
  acknowledgmentStatus:
    | 'ACKNOWLEDGED'
    | 'DECLINED'
    | 'NOT_REQUESTED'
    | null;
  patientStatus: 'ACTIVE' | 'INACTIVE' | null;
  phone: string | null;
  village: string | null;
  quarter: string | null;
  sourceCreatedAt: string;
  sourceUpdatedAt: string;
  receivedAt: string;
}>;

export type IdentityReviewCandidateView = Readonly<{
  personReference: string;
  score: number;
  matchedOn: readonly string[];
  maskedChsMedicalId: string | null;
  maskedName: string;
  birthEvidence: MaskedBirthEvidence;
  sex: 'FEMALE' | 'MALE' | 'OTHER' | 'UNKNOWN';
  maskedPhone: string | null;
  maskedResidence: string | null;
}>;

export type IdentityReviewCaseDetail = Readonly<{
  caseReference: string;
  status: 'OPEN';
  evidenceState: IdentityReviewEvidenceState;
  organization: Readonly<{ id: string; name: string }>;
  location: Readonly<{ id: string; name: string }>;
  installation: Readonly<{ id: string; deploymentName: string }>;
  localPatientReference: string;
  openedAt: string;
  updatedAt: string;
  evidence: IdentityReviewEvidenceDetail | null;
  candidates: readonly IdentityReviewCandidateView[];
}>;

export type IdentityReviewQueryErrorCode =
  | 'IDENTITY_REVIEW_CASE_NOT_FOUND'
  | 'IDENTITY_REVIEW_INVARIANT'
  | 'INVALID_ACCESS_SCOPE'
  | 'INVALID_CASE_REFERENCE'
  | 'INVALID_EVIDENCE_STATE'
  | 'INVALID_INSTALLATION_ID'
  | 'INVALID_OPENED_PERIOD'
  | 'INVALID_PAGE'
  | 'INVALID_PAGE_SIZE';

export class IdentityReviewQueryError extends Error {
  constructor(
    readonly code: IdentityReviewQueryErrorCode,
    readonly statusCode: 400 | 404 | 500,
  ) {
    super('Identity review query failed');
    this.name = 'IdentityReviewQueryError';
  }
}

type PreparedScope = Readonly<{
  global: boolean;
  organizationIds: readonly string[];
}>;

type PreparedQuery = Readonly<{
  evidenceState: IdentityReviewEvidenceState | null;
  installationId: string | null;
  openedFrom: string | null;
  openedTo: string | null;
  page: number;
  pageSize: number;
  offset: number;
}>;

type QueueRow = Readonly<{
  total_items?: string;
  case_reference: string;
  status: 'OPEN';
  organization_name: string;
  location_name: string;
  installation_id: string;
  deployment_name: string;
  opened_at: Date;
  updated_at: Date;
  candidate_count: number;
  evidence_id: string | null;
  source_revision: number | null;
  captured_at: Date | null;
  local_patient_code: string | null;
  display_name: string | null;
  date_of_birth: string | null;
  approximate_age_years: number | null;
  age_as_of_date: string | null;
}>;

type DetailRow = Readonly<{
  case_reference: string;
  status: 'OPEN';
  organization_id: string;
  organization_name: string;
  location_id: string;
  location_name: string;
  installation_id: string;
  deployment_name: string;
  local_patient_id: string;
  opened_at: Date;
  updated_at: Date;
  evidence_id: string | null;
  source_record_id: string | null;
  source_revision: number | null;
  schema_version: string | null;
  captured_at: Date | null;
  local_patient_code: string | null;
  claimed_chs_medical_id: string | null;
  display_name: string | null;
  given_name: string | null;
  family_name: string | null;
  other_names: string | null;
  date_of_birth: string | null;
  approximate_age_years: number | null;
  age_as_of_date: string | null;
  sex: IdentityReviewEvidenceDetail['sex'] | null;
  acknowledgment_status: IdentityReviewEvidenceDetail['acknowledgmentStatus'];
  patient_status: IdentityReviewEvidenceDetail['patientStatus'];
  phone: string | null;
  village: string | null;
  quarter: string | null;
  source_created_at: Date | null;
  source_updated_at: Date | null;
  received_at: Date | null;
}>;

type CandidateRow = Readonly<{
  person_id: string;
  score: number;
  matched_on: string[];
  identifier_value: string | null;
  display_name: string;
  date_of_birth: string | null;
  approximate_age_years: number | null;
  age_as_of_date: string | null;
  sex: IdentityReviewCandidateView['sex'];
  phone: string | null;
  village: string | null;
  quarter: string | null;
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
    throw new IdentityReviewQueryError('INVALID_ACCESS_SCOPE', 400);
  }
  return { global: false, organizationIds };
}

function normalizedInstant(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (
    value.length > 40 ||
    !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new IdentityReviewQueryError('INVALID_OPENED_PERIOD', 400);
  }
  return new Date(value).toISOString();
}

function prepareQuery(query: IdentityReviewQueueQuery): PreparedQuery {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 25;
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
    throw new IdentityReviewQueryError('INVALID_PAGE', 400);
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new IdentityReviewQueryError('INVALID_PAGE_SIZE', 400);
  }
  const evidenceState = query.evidenceState ?? 'ALL';
  if (!['ALL', 'AVAILABLE', 'EVIDENCE_PENDING'].includes(evidenceState)) {
    throw new IdentityReviewQueryError('INVALID_EVIDENCE_STATE', 400);
  }
  const installationId = query.installationId ?? null;
  if (installationId !== null && !uuidPattern.test(installationId)) {
    throw new IdentityReviewQueryError('INVALID_INSTALLATION_ID', 400);
  }
  const openedFrom = normalizedInstant(query.openedFrom);
  const openedTo = normalizedInstant(query.openedTo);
  if (openedFrom && openedTo && openedFrom > openedTo) {
    throw new IdentityReviewQueryError('INVALID_OPENED_PERIOD', 400);
  }
  return {
    evidenceState: evidenceState === 'ALL' ? null : evidenceState,
    installationId,
    openedFrom,
    openedTo,
    page,
    pageSize,
    offset: (page - 1) * pageSize,
  };
}

function maskWord(value: string): string {
  const characters = Array.from(value);
  if (characters.length === 0) return '';
  return `${characters[0]}${'•'.repeat(Math.min(Math.max(characters.length - 1, 1), 5))}`;
}

function maskName(value: string): string {
  return value.split(/\s+/u).filter(Boolean).map(maskWord).join(' ');
}

function maskPhone(value: string | null): string | null {
  if (!value) return null;
  const characters = Array.from(value);
  const visible = characters.slice(-2).join('');
  return `${'•'.repeat(Math.min(Math.max(characters.length - visible.length, 4), 10))}${visible}`;
}

function maskResidence(quarter: string | null, village: string | null): string | null {
  const value = [quarter, village].filter(Boolean).join(', ');
  return value
    ? value
        .split(/([,\s]+)/u)
        .map((part) => (/\p{Letter}/u.test(part) ? maskWord(part) : part))
        .join('')
    : null;
}

function maskMedicalId(value: string | null): string | null {
  if (!value) return null;
  const suffix = value.slice(-4);
  return `${value.slice(0, Math.min(4, value.length))}${'•'.repeat(8)}-${suffix}`;
}

function birthEvidence(
  dateOfBirth: string | null,
  approximateAgeYears: number | null,
  ageAsOfDate: string | null,
): MaskedBirthEvidence {
  if (dateOfBirth) {
    return { kind: 'DATE_OF_BIRTH', maskedDate: `****-**-${dateOfBirth.slice(8, 10)}` };
  }
  if (approximateAgeYears !== null && ageAsOfDate) {
    return {
      kind: 'APPROXIMATE_AGE',
      ageYears: approximateAgeYears,
      asOfYear: Number(ageAsOfDate.slice(0, 4)),
    };
  }
  throw new IdentityReviewQueryError('IDENTITY_REVIEW_INVARIANT', 500);
}

function queueItem(row: QueueRow): IdentityReviewQueueItem {
  const evidenceState = row.evidence_id ? 'AVAILABLE' : 'EVIDENCE_PENDING';
  return {
    caseReference: row.case_reference,
    status: row.status,
    evidenceState,
    organizationName: row.organization_name,
    locationName: row.location_name,
    installationId: row.installation_id,
    deploymentName: row.deployment_name,
    openedAt: row.opened_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    candidateCount: row.candidate_count,
    latestSourceRevision: row.source_revision,
    sourceCapturedAt: row.captured_at?.toISOString() ?? null,
    localPatientCode: row.local_patient_code,
    maskedSubmittedName: row.display_name ? maskName(row.display_name) : null,
    submittedBirthEvidence: row.evidence_id
      ? birthEvidence(row.date_of_birth, row.approximate_age_years, row.age_as_of_date)
      : null,
  };
}

const reviewJoins = `
  JOIN desktop_installations AS installation
    ON installation.id = review_case.installation_id
  JOIN organizations AS organization
    ON organization.id = installation.organization_id
  JOIN locations AS location
    ON location.id = installation.configured_location_id
  LEFT JOIN LATERAL (
    SELECT evidence.*
    FROM identity_review_evidence_snapshots AS evidence
    WHERE evidence.review_case_id = review_case.id
    ORDER BY evidence.source_revision DESC, evidence.received_at DESC, evidence.id DESC
    LIMIT 1
  ) AS evidence ON true`;

export async function listIdentityReviewCases(
  database: IdentityReviewDatabase,
  accessScope: PatientAccessScope,
  query: IdentityReviewQueueQuery = {},
): Promise<IdentityReviewQueuePage> {
  const scope = prepareScope(accessScope);
  const prepared = prepareQuery(query);
  const result = await database.query<QueueRow>(
    `SELECT
       count(*) OVER()::text AS total_items,
       review_case.id AS case_reference,
       review_case.status,
       organization.name AS organization_name,
       location.name AS location_name,
       installation.id AS installation_id,
       installation.deployment_name,
       review_case.opened_at,
       review_case.updated_at,
       (SELECT count(*)::integer
        FROM identity_review_candidates AS candidate
        WHERE candidate.review_case_id = review_case.id) AS candidate_count,
       evidence.id AS evidence_id,
       evidence.source_revision,
       evidence.captured_at,
       evidence.local_patient_code,
       evidence.display_name,
       evidence.date_of_birth::text AS date_of_birth,
       evidence.approximate_age_years,
       evidence.age_as_of_date::text AS age_as_of_date
     FROM identity_review_cases AS review_case
     ${reviewJoins}
     WHERE review_case.status = 'OPEN'
       AND ($1::boolean OR installation.organization_id = ANY($2::uuid[]))
       AND (
         $3::text IS NULL
         OR ($3 = 'AVAILABLE' AND evidence.id IS NOT NULL)
         OR ($3 = 'EVIDENCE_PENDING' AND evidence.id IS NULL)
       )
       AND ($4::uuid IS NULL OR installation.id = $4)
       AND ($5::timestamptz IS NULL OR review_case.opened_at >= $5)
       AND ($6::timestamptz IS NULL OR review_case.opened_at <= $6)
     ORDER BY review_case.opened_at ASC, review_case.id ASC
     LIMIT $7 OFFSET $8`,
    [
      scope.global,
      scope.organizationIds,
      prepared.evidenceState,
      prepared.installationId,
      prepared.openedFrom,
      prepared.openedTo,
      prepared.pageSize,
      prepared.offset,
    ],
  );
  const totalItems = Number(result.rows[0]?.total_items ?? 0);
  return {
    page: prepared.page,
    pageSize: prepared.pageSize,
    totalItems,
    totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / prepared.pageSize),
    items: result.rows.map(queueItem),
  };
}

async function beginReadTransaction(client: PoolClient): Promise<void> {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
}

function evidenceDetail(row: DetailRow): IdentityReviewEvidenceDetail | null {
  if (!row.evidence_id) return null;
  if (
    !row.source_record_id ||
    row.source_revision === null ||
    !row.schema_version ||
    !row.captured_at ||
    !row.local_patient_code ||
    !row.display_name ||
    !row.sex ||
    !row.source_created_at ||
    !row.source_updated_at ||
    !row.received_at
  ) {
    throw new IdentityReviewQueryError('IDENTITY_REVIEW_INVARIANT', 500);
  }
  return {
    sourceRecordReference: row.source_record_id,
    sourceRevision: row.source_revision,
    schemaVersion: row.schema_version,
    capturedAt: row.captured_at.toISOString(),
    localPatientCode: row.local_patient_code,
    maskedClaimedChsMedicalId: maskMedicalId(row.claimed_chs_medical_id),
    displayName: row.display_name,
    givenName: row.given_name,
    familyName: row.family_name,
    otherNames: row.other_names,
    dateOfBirth: row.date_of_birth,
    approximateAgeYears: row.approximate_age_years,
    ageAsOfDate: row.age_as_of_date,
    sex: row.sex,
    acknowledgmentStatus: row.acknowledgment_status,
    patientStatus: row.patient_status,
    phone: row.phone,
    village: row.village,
    quarter: row.quarter,
    sourceCreatedAt: row.source_created_at.toISOString(),
    sourceUpdatedAt: row.source_updated_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
  };
}

function candidateView(row: CandidateRow): IdentityReviewCandidateView {
  return {
    personReference: row.person_id,
    score: row.score,
    matchedOn: [...row.matched_on],
    maskedChsMedicalId: maskMedicalId(row.identifier_value),
    maskedName: maskName(row.display_name),
    birthEvidence: birthEvidence(
      row.date_of_birth,
      row.approximate_age_years,
      row.age_as_of_date,
    ),
    sex: row.sex,
    maskedPhone: maskPhone(row.phone),
    maskedResidence: maskResidence(row.quarter, row.village),
  };
}

export async function getIdentityReviewCaseDetail(
  database: IdentityReviewDatabase,
  accessScope: PatientAccessScope,
  caseReference: string,
): Promise<IdentityReviewCaseDetail> {
  if (!uuidPattern.test(caseReference)) {
    throw new IdentityReviewQueryError('INVALID_CASE_REFERENCE', 400);
  }
  const scope = prepareScope(accessScope);
  const client = await database.connect();
  try {
    await beginReadTransaction(client);
    const detailResult = await client.query<DetailRow>(
      `SELECT
         review_case.id AS case_reference,
         review_case.status,
         organization.id AS organization_id,
         organization.name AS organization_name,
         location.id AS location_id,
         location.name AS location_name,
         installation.id AS installation_id,
         installation.deployment_name,
         review_case.local_patient_id,
         review_case.opened_at,
         review_case.updated_at,
         evidence.id AS evidence_id,
         evidence.source_record_id,
         evidence.source_revision,
         evidence.schema_version,
         evidence.captured_at,
         evidence.local_patient_code,
         evidence.claimed_chs_medical_id,
         evidence.display_name,
         evidence.given_name,
         evidence.family_name,
         evidence.other_names,
         evidence.date_of_birth::text AS date_of_birth,
         evidence.approximate_age_years,
         evidence.age_as_of_date::text AS age_as_of_date,
         evidence.sex,
         evidence.acknowledgment_status,
         evidence.patient_status,
         evidence.phone,
         evidence.village,
         evidence.quarter,
         evidence.source_created_at,
         evidence.source_updated_at,
         evidence.received_at
       FROM identity_review_cases AS review_case
       ${reviewJoins}
       WHERE review_case.id = $1
         AND review_case.status = 'OPEN'
         AND ($2::boolean OR installation.organization_id = ANY($3::uuid[]))`,
      [caseReference, scope.global, scope.organizationIds],
    );
    const detail = detailResult.rows[0];
    if (!detail) {
      throw new IdentityReviewQueryError('IDENTITY_REVIEW_CASE_NOT_FOUND', 404);
    }
    const candidates = await client.query<CandidateRow>(
      `SELECT
         candidate.person_id,
         candidate.score,
         candidate.matched_on,
         medical_id.identifier_value,
         person.display_name,
         person.date_of_birth::text AS date_of_birth,
         person.approximate_age_years,
         person.age_as_of_date::text AS age_as_of_date,
         person.sex,
         person.phone,
         person.village,
         person.quarter
       FROM identity_review_candidates AS candidate
       JOIN persons AS person ON person.id = candidate.person_id
       LEFT JOIN person_identifiers AS medical_id
         ON medical_id.person_id = person.id
        AND medical_id.identifier_system = $2
        AND medical_id.identifier_type_code = $3
        AND medical_id.status = 'ACTIVE'
        AND medical_id.is_primary = true
       WHERE candidate.review_case_id = $1
       ORDER BY candidate.score DESC, candidate.person_id ASC`,
      [caseReference, CHS_MEDICAL_ID_SYSTEM, CHS_MEDICAL_ID_TYPE],
    );
    const result: IdentityReviewCaseDetail = {
      caseReference: detail.case_reference,
      status: detail.status,
      evidenceState: detail.evidence_id ? 'AVAILABLE' : 'EVIDENCE_PENDING',
      organization: { id: detail.organization_id, name: detail.organization_name },
      location: { id: detail.location_id, name: detail.location_name },
      installation: {
        id: detail.installation_id,
        deploymentName: detail.deployment_name,
      },
      localPatientReference: detail.local_patient_id,
      openedAt: detail.opened_at.toISOString(),
      updatedAt: detail.updated_at.toISOString(),
      evidence: evidenceDetail(detail),
      candidates: candidates.rows.map(candidateView),
    };
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
