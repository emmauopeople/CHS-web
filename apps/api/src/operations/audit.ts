import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type { PatientAccessScope } from './patient-query.js';

type AuditDatabase = Pick<Pool, 'query'>;

export type PatientAccessReason =
  | 'CARE_DELIVERY'
  | 'CARE_COORDINATION'
  | 'PATIENT_REQUEST'
  | 'QUALITY_IMPROVEMENT'
  | 'OPERATIONS_SUPPORT'
  | 'IDENTITY_RECONCILIATION';

export type PatientAuditAction =
  | 'PATIENT_LIST_VIEW'
  | 'PATIENT_DETAIL_VIEW'
  | 'MEDICAL_ID_RECOVERY_SEARCH'
  | 'MEDICAL_ID_RECOVERY_REVEAL'
  | 'IDENTITY_REVIEW_LIST_VIEW'
  | 'IDENTITY_REVIEW_DETAIL_VIEW'
  | 'SYNC_BATCH_LIST_VIEW'
  | 'SYNC_BATCH_DETAIL_VIEW';
export type PatientAuditOutcome =
  | 'SUCCESS'
  | 'DENIED'
  | 'NOT_FOUND'
  | 'REVIEW_REQUIRED'
  | 'ERROR';

export type PatientAuditEvent = Readonly<{
  operationsUserId: string | null;
  principalFingerprint: string | null;
  scope: PatientAccessScope | null;
  action: PatientAuditAction;
  outcome: PatientAuditOutcome;
  entityId: string | null;
  reason: PatientAccessReason;
  requestId: string;
  sourceIp: string;
  userAgent: string | null;
  sessionId: string | null;
  authorizedParty: string | null;
  route: string;
  metadata?: Readonly<Record<string, unknown>>;
}>;

function scopeMetadata(scope: PatientAccessScope | null) {
  if (!scope) return { scopeKind: null, organizationIds: [] };
  if (scope.kind === 'GLOBAL') return { scopeKind: 'GLOBAL', organizationIds: [] };
  return {
    scopeKind: 'ORGANIZATIONS',
    organizationIds: [...scope.organizationIds],
  };
}

export async function recordPatientAccessAudit(
  database: AuditDatabase,
  event: PatientAuditEvent,
  now: Date = new Date(),
): Promise<void> {
  const organizationId =
    event.scope?.kind === 'ORGANIZATIONS' &&
    event.scope.organizationIds.length === 1
      ? event.scope.organizationIds[0]!
      : null;
  const metadata = {
    ...scopeMetadata(event.scope),
    principalFingerprint: event.principalFingerprint,
    sourceIp: event.sourceIp.slice(0, 100),
    userAgent: event.userAgent?.slice(0, 500) ?? null,
    sessionId: event.sessionId,
    authorizedParty: event.authorizedParty,
    route: event.route,
    ...event.metadata,
  };
  const entityType =
    event.action === 'PATIENT_DETAIL_VIEW'
      ? 'PERSON'
      : event.action === 'PATIENT_LIST_VIEW'
        ? 'PATIENT_SEARCH'
        : event.action.startsWith('IDENTITY_REVIEW_')
          ? 'IDENTITY_REVIEW_CASE'
        : event.action.startsWith('MEDICAL_ID_RECOVERY_')
          ? 'MEDICAL_ID_RECOVERY'
          : 'SYNC_BATCH';

  await database.query(
    `INSERT INTO audit_events (
       id, organization_id, operations_user_id, action_code, entity_type,
       entity_id, reason_code, request_id, occurred_at, outcome_code, metadata
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
     )`,
    [
      randomUUID(),
      organizationId,
      event.operationsUserId,
      event.action,
      entityType,
      event.entityId,
      event.reason,
      event.requestId,
      now.toISOString(),
      event.outcome,
      JSON.stringify(metadata),
    ],
  );
}
