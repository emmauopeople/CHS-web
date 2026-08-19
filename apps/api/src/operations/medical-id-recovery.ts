import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import { CHS_MEDICAL_ID_SYSTEM, CHS_MEDICAL_ID_TYPE } from '../sync/medical-id.js';
import { normalizeIdentityName } from '../sync/patient-identity-normalization.js';
import type { OperationsPrincipal } from './access.js';
import {
  type PatientAccessReason,
  recordPatientAccessAudit,
} from './audit.js';

type RecoveryDatabase = Pick<Pool, 'connect'>;

export type MedicalIdRecoverySearchInput = Readonly<{
  fullName: string;
  dateOfBirth: string;
}>;

export type MedicalIdRecoveryCandidate = Readonly<{
  candidateReference: string;
  maskedName: string;
  maskedDateOfBirth: string;
  sex: 'FEMALE' | 'MALE' | 'OTHER' | 'UNKNOWN';
  maskedResidence: string | null;
}>;

export type MedicalIdRecoverySearchResult =
  | Readonly<{ status: 'NOT_RESOLVED' }>
  | Readonly<{
      status: 'CANDIDATE_FOUND';
      caseReference: string;
      recoveryToken: string;
      expiresAt: string;
      candidates: readonly [MedicalIdRecoveryCandidate];
    }>
  | Readonly<{
      status: 'REVIEW_REQUIRED';
      caseReference: string;
      candidateCount: number;
      candidates: readonly MedicalIdRecoveryCandidate[];
    }>;

export type MedicalIdRecoveryRevealInput = Readonly<{
  recoveryToken: string;
  candidateReference: string;
  confirmed: true;
}>;

export type MedicalIdRecoveryRevealResult = Readonly<{
  status: 'REVEALED';
  chsMedicalId: string;
}>;

type AuditContext = Readonly<{
  reason: PatientAccessReason;
  requestId: string;
  sourceIp: string;
  userAgent: string | null;
}>;

type CandidateRow = Readonly<{
  person_id: string;
  display_name: string;
  date_of_birth: string;
  sex: MedicalIdRecoveryCandidate['sex'];
  village: string | null;
  quarter: string | null;
}>;

type RevealRow = Readonly<{
  case_id: string;
  identifier_value: string;
}>;

export type MedicalIdRecoveryErrorCode =
  | 'INVALID_RECOVERY_EVIDENCE'
  | 'RECOVERY_CASE_NOT_AVAILABLE'
  | 'RECOVERY_INVARIANT';

export class MedicalIdRecoveryError extends Error {
  constructor(
    readonly code: MedicalIdRecoveryErrorCode,
    readonly statusCode: 400 | 404 | 500,
    readonly audited = false,
  ) {
    super('Medical ID recovery failed');
    this.name = 'MedicalIdRecoveryError';
  }
}

function validLocalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const normalized = new Date(Date.UTC(year!, month! - 1, day));
  return (
    normalized.getUTCFullYear() === year &&
    normalized.getUTCMonth() + 1 === month &&
    normalized.getUTCDate() === day
  );
}

function prepareEvidence(input: MedicalIdRecoverySearchInput, now: Date) {
  const fullName = input.fullName.trim();
  const normalizedName = normalizeIdentityName(fullName);
  if (
    fullName.length < 2 ||
    fullName.length > 160 ||
    normalizedName.length < 2 ||
    !validLocalDate(input.dateOfBirth) ||
    input.dateOfBirth > now.toISOString().slice(0, 10)
  ) {
    throw new MedicalIdRecoveryError('INVALID_RECOVERY_EVIDENCE', 400);
  }
  return { normalizedName, dateOfBirth: input.dateOfBirth };
}

function prepareScope(principal: OperationsPrincipal) {
  const scope = principal.patientAccessScope;
  return scope.kind === 'GLOBAL'
    ? { global: true, organizationIds: [] as readonly string[] }
    : { global: false, organizationIds: scope.organizationIds };
}

function sessionFingerprint(principal: OperationsPrincipal): string {
  return createHash('sha256')
    .update(principal.identity.issuer)
    .update('\0')
    .update(principal.identity.subject)
    .update('\0')
    .update(principal.identity.sessionId ?? 'NO_SESSION_CLAIM')
    .update('\0')
    .update(principal.identity.authorizedParty ?? 'NO_AUTHORIZED_PARTY')
    .digest('hex');
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function maskWord(value: string): string {
  const characters = Array.from(value);
  if (characters.length === 0) return '';
  return `${characters[0]}${'•'.repeat(Math.min(Math.max(characters.length - 1, 1), 5))}`;
}

function maskName(value: string): string {
  return value.split(/\s+/u).filter(Boolean).map(maskWord).join(' ');
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

function candidateView(row: CandidateRow, reference: string): MedicalIdRecoveryCandidate {
  return {
    candidateReference: reference,
    maskedName: maskName(row.display_name),
    maskedDateOfBirth: `****-**-${row.date_of_birth.slice(8, 10)}`,
    sex: row.sex,
    maskedResidence: maskResidence(row.quarter, row.village),
  };
}

async function audit(
  client: PoolClient,
  principal: OperationsPrincipal,
  context: AuditContext,
  action: 'MEDICAL_ID_RECOVERY_SEARCH' | 'MEDICAL_ID_RECOVERY_REVEAL',
  outcome: 'SUCCESS' | 'DENIED' | 'NOT_FOUND' | 'REVIEW_REQUIRED' | 'ERROR',
  entityId: string | null,
  metadata: Readonly<Record<string, unknown>>,
  now: Date,
) {
  await recordPatientAccessAudit(client as unknown as Pick<Pool, 'query'>, {
    operationsUserId: principal.operationsUserId,
    principalFingerprint: null,
    scope: principal.patientAccessScope,
    action,
    outcome,
    entityId,
    reason: context.reason,
    requestId: context.requestId,
    sourceIp: context.sourceIp,
    userAgent: context.userAgent,
    sessionId: principal.identity.sessionId,
    authorizedParty: principal.identity.authorizedParty,
    route:
      action === 'MEDICAL_ID_RECOVERY_SEARCH'
        ? '/api/v1/operations/medical-id-recovery/search'
        : '/api/v1/operations/medical-id-recovery/reveal',
    metadata,
  }, now);
}

export async function searchMedicalIdRecovery(
  database: RecoveryDatabase,
  principal: OperationsPrincipal,
  input: MedicalIdRecoverySearchInput,
  context: AuditContext,
  now: Date = new Date(),
): Promise<MedicalIdRecoverySearchResult> {
  const evidence = prepareEvidence(input, now);
  const scope = prepareScope(principal);
  const client = await database.connect();
  let transactionCompleted = false;
  try {
    await client.query('BEGIN');
    const result = await client.query<CandidateRow>(
      `SELECT
         person.id AS person_id,
         person.display_name,
         person.date_of_birth::text AS date_of_birth,
         person.sex,
         person.village,
         person.quarter
       FROM persons AS person
       JOIN person_identifiers AS medical_id
         ON medical_id.person_id = person.id
        AND medical_id.identifier_system = $5
        AND medical_id.identifier_type_code = $6
        AND medical_id.status = 'ACTIVE'
        AND medical_id.is_primary = true
       WHERE person.status <> 'DECEASED'
         AND person.name_normalized = $3
         AND person.date_of_birth = $4::date
         AND (
           $1::boolean
           OR EXISTS (
             SELECT 1
             FROM patient_source_links AS source_link
             JOIN desktop_installations AS installation
               ON installation.id = source_link.installation_id
             WHERE source_link.person_id = person.id
               AND installation.organization_id = ANY($2::uuid[])
           )
         )
       ORDER BY person.id
       LIMIT 1000`,
      [
        scope.global,
        scope.organizationIds,
        evidence.normalizedName,
        evidence.dateOfBirth,
        CHS_MEDICAL_ID_SYSTEM,
        CHS_MEDICAL_ID_TYPE,
      ],
    );

    if (result.rows.length === 0) {
      await audit(
        client,
        principal,
        context,
        'MEDICAL_ID_RECOVERY_SEARCH',
        'NOT_FOUND',
        null,
        { candidateCount: 0 },
        now,
      );
      await client.query('COMMIT');
      transactionCompleted = true;
      return { status: 'NOT_RESOLVED' };
    }

    const caseReference = randomUUID();
    const candidateReferences = result.rows.map(() => randomUUID());
    const singleCandidate = result.rows.length === 1;
    const recoveryToken = singleCandidate
      ? randomBytes(32).toString('base64url')
      : null;
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1_000);
    await client.query(
      `INSERT INTO medical_id_recovery_cases (
         id, operations_user_id, status, token_hash, session_fingerprint,
         candidate_count, created_at, expires_at, revealed_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $7)`,
      [
        caseReference,
        principal.operationsUserId,
        singleCandidate ? 'PENDING_CONFIRMATION' : 'REVIEW_REQUIRED',
        recoveryToken ? tokenHash(recoveryToken) : null,
        sessionFingerprint(principal),
        result.rows.length,
        now.toISOString(),
        expiresAt.toISOString(),
      ],
    );
    for (const [index, row] of result.rows.entries()) {
      await client.query(
        `INSERT INTO medical_id_recovery_candidates (
           id, recovery_case_id, person_id, created_at
         ) VALUES ($1, $2, $3, $4)`,
        [candidateReferences[index], caseReference, row.person_id, now.toISOString()],
      );
    }
    await audit(
      client,
      principal,
      context,
      'MEDICAL_ID_RECOVERY_SEARCH',
      singleCandidate ? 'SUCCESS' : 'REVIEW_REQUIRED',
      caseReference,
      { candidateCount: result.rows.length },
      now,
    );
    await client.query('COMMIT');
    transactionCompleted = true;

    const candidates = result.rows.slice(0, 5).map((row, index) =>
      candidateView(row, candidateReferences[index]!),
    );
    if (!singleCandidate) {
      return {
        status: 'REVIEW_REQUIRED',
        caseReference,
        candidateCount: result.rows.length,
        candidates,
      };
    }
    return {
      status: 'CANDIDATE_FOUND',
      caseReference,
      recoveryToken: recoveryToken!,
      expiresAt: expiresAt.toISOString(),
      candidates: [candidates[0]!],
    };
  } catch (error) {
    if (!transactionCompleted) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function revealMedicalId(
  database: RecoveryDatabase,
  principal: OperationsPrincipal,
  input: MedicalIdRecoveryRevealInput,
  context: AuditContext,
  now: Date = new Date(),
): Promise<MedicalIdRecoveryRevealResult> {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(input.recoveryToken) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.candidateReference,
    ) ||
    input.confirmed !== true
  ) {
    throw new MedicalIdRecoveryError('RECOVERY_CASE_NOT_AVAILABLE', 404);
  }
  const client = await database.connect();
  let transactionCompleted = false;
  try {
    await client.query('BEGIN');
    const result = await client.query<RevealRow>(
      `SELECT
         recovery_case.id AS case_id,
         medical_id.identifier_value
       FROM medical_id_recovery_cases AS recovery_case
       JOIN medical_id_recovery_candidates AS candidate
         ON candidate.recovery_case_id = recovery_case.id
        AND candidate.id = $2
       JOIN person_identifiers AS medical_id
         ON medical_id.person_id = candidate.person_id
        AND medical_id.identifier_system = $6
        AND medical_id.identifier_type_code = $7
        AND medical_id.status = 'ACTIVE'
        AND medical_id.is_primary = true
       WHERE recovery_case.token_hash = $1
         AND recovery_case.operations_user_id = $3
         AND recovery_case.session_fingerprint = $4
         AND recovery_case.status = 'PENDING_CONFIRMATION'
         AND recovery_case.expires_at > $5
       FOR UPDATE OF recovery_case`,
      [
        tokenHash(input.recoveryToken),
        input.candidateReference,
        principal.operationsUserId,
        sessionFingerprint(principal),
        now.toISOString(),
        CHS_MEDICAL_ID_SYSTEM,
        CHS_MEDICAL_ID_TYPE,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      await audit(
        client,
        principal,
        context,
        'MEDICAL_ID_RECOVERY_REVEAL',
        'DENIED',
        null,
        { caseAvailable: false },
        now,
      );
      await client.query('COMMIT');
      transactionCompleted = true;
      throw new MedicalIdRecoveryError('RECOVERY_CASE_NOT_AVAILABLE', 404, true);
    }
    await client.query(
      `UPDATE medical_id_recovery_cases
       SET status = 'REVEALED', revealed_at = $2, updated_at = $2
       WHERE id = $1`,
      [row.case_id, now.toISOString()],
    );
    await audit(
      client,
      principal,
      context,
      'MEDICAL_ID_RECOVERY_REVEAL',
      'SUCCESS',
      row.case_id,
      { oneTimeReveal: true },
      now,
    );
    await client.query('COMMIT');
    transactionCompleted = true;
    return { status: 'REVEALED', chsMedicalId: row.identifier_value };
  } catch (error) {
    if (!transactionCompleted) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    client.release();
  }
}
