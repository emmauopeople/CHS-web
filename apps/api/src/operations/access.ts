import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

import type { PatientAccessScope } from './patient-query.js';
import type { VerifiedOperationsIdentity } from './authentication.js';

type AccessDatabase = Pick<Pool, 'query'>;

type AccessRow = Readonly<{
  operations_user_id: string;
  display_name: string;
  user_status: 'ACTIVE' | 'SUSPENDED';
  scope_kind: 'GLOBAL' | 'ORGANIZATION' | null;
  organization_id: string | null;
}>;

export type OperationsPrincipal = Readonly<{
  operationsUserId: string;
  displayName: string;
  identity: VerifiedOperationsIdentity;
  patientAccessScope: PatientAccessScope;
}>;

export type OperationsAuthorizationErrorCode =
  | 'OPERATIONS_USER_NOT_ENROLLED'
  | 'OPERATIONS_USER_SUSPENDED'
  | 'PATIENT_READ_NOT_PERMITTED';

export class OperationsAuthorizationError extends Error {
  readonly statusCode = 403;

  constructor(
    readonly code: OperationsAuthorizationErrorCode,
    readonly operationsUserId: string | null,
    readonly principalFingerprint: string,
  ) {
    super('Operations authorization failed');
    this.name = 'OperationsAuthorizationError';
  }
}

export function operationsPrincipalFingerprint(
  identity: VerifiedOperationsIdentity,
): string {
  return createHash('sha256')
    .update(identity.issuer)
    .update('\0')
    .update(identity.subject)
    .digest('hex');
}

export async function authorizePatientRead(
  database: AccessDatabase,
  identity: VerifiedOperationsIdentity,
  now: Date = new Date(),
): Promise<OperationsPrincipal> {
  const fingerprint = operationsPrincipalFingerprint(identity);
  const result = await database.query<AccessRow>(
    `SELECT
       operations_user.id AS operations_user_id,
       operations_user.display_name,
       operations_user.status AS user_status,
       access_grant.scope_kind,
       access_grant.organization_id
     FROM operations_users AS operations_user
     LEFT JOIN operations_access_grants AS access_grant
       ON access_grant.operations_user_id = operations_user.id
      AND access_grant.permission_code = 'PATIENT_READ'
      AND access_grant.active = true
      AND (access_grant.expires_at IS NULL OR access_grant.expires_at > $3)
     WHERE operations_user.oidc_issuer = $1
       AND operations_user.oidc_subject = $2
     ORDER BY access_grant.scope_kind, access_grant.organization_id`,
    [identity.issuer, identity.subject, now.toISOString()],
  );
  const user = result.rows[0];
  if (!user) {
    throw new OperationsAuthorizationError(
      'OPERATIONS_USER_NOT_ENROLLED',
      null,
      fingerprint,
    );
  }
  if (user.user_status !== 'ACTIVE') {
    throw new OperationsAuthorizationError(
      'OPERATIONS_USER_SUSPENDED',
      user.operations_user_id,
      fingerprint,
    );
  }
  if (result.rows.every((row) => row.scope_kind === null)) {
    throw new OperationsAuthorizationError(
      'PATIENT_READ_NOT_PERMITTED',
      user.operations_user_id,
      fingerprint,
    );
  }

  const global = result.rows.some((row) => row.scope_kind === 'GLOBAL');
  const organizationIds = [
    ...new Set(
      result.rows.flatMap((row) =>
        row.scope_kind === 'ORGANIZATION' && row.organization_id
          ? [row.organization_id]
          : [],
      ),
    ),
  ];
  if (!global && organizationIds.length === 0) {
    throw new OperationsAuthorizationError(
      'PATIENT_READ_NOT_PERMITTED',
      user.operations_user_id,
      fingerprint,
    );
  }

  return {
    operationsUserId: user.operations_user_id,
    displayName: user.display_name,
    identity,
    patientAccessScope: global
      ? { kind: 'GLOBAL' }
      : { kind: 'ORGANIZATIONS', organizationIds },
  };
}
