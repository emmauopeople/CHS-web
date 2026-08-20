import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import type { OperationsPermission } from '../operations/access.js';

const rootFields = new Set([
  'oidcIssuer',
  'oidcSubject',
  'displayName',
  'email',
  'grants',
  'operatorIdentifier',
  'reasonCode',
]);
const grantFields = new Set([
  'permissionCode',
  'scopeKind',
  'organizationId',
  'expiresAt',
]);
const supportedPermissions = new Set<OperationsPermission>([
  'PATIENT_READ',
  'MEDICAL_ID_RECOVER',
  'IDENTITY_REVIEW',
  'SYNC_MONITOR',
]);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isoTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

type ProvisioningDatabase = Pick<Pool, 'connect'>;
type ProvisioningDependencies = Readonly<{
  now?: Date;
  randomId?: () => string;
}>;
type OperationsUserRow = Readonly<{
  id: string;
  display_name: string;
  email: string | null;
  status: 'ACTIVE' | 'SUSPENDED';
}>;
type OrganizationRow = Readonly<{ id: string; active: boolean }>;
type AccessGrantRow = Readonly<{
  id: string;
  permission_code: OperationsPermission;
  scope_kind: 'GLOBAL' | 'ORGANIZATION';
  organization_id: string | null;
  active: boolean;
  expires_at: Date | null;
}>;

export type OperationsAccessGrantInput = Readonly<{
  permissionCode: OperationsPermission;
  scopeKind: 'GLOBAL' | 'ORGANIZATION';
  organizationId: string | null;
  expiresAt: string | null;
}>;

export type OperationsAccessProvisioningInput = Readonly<{
  oidcIssuer: string;
  oidcSubject: string;
  displayName: string;
  email: string | null;
  grants: readonly OperationsAccessGrantInput[];
  operatorIdentifier: string;
  reasonCode: string;
}>;

export type OperationsAccessProvisioningResult = Readonly<{
  kind: 'PROVISIONED' | 'ALREADY_PROVISIONED';
  operationsUserId: string;
  userCreated: boolean;
  grants: readonly Readonly<{
    grantId: string;
    permissionCode: OperationsPermission;
    scopeKind: 'GLOBAL' | 'ORGANIZATION';
    organizationId: string | null;
    expiresAt: string | null;
    created: boolean;
  }>[];
  processedAt: string;
}>;

export type OperationsAccessProvisioningErrorCode =
  | 'INVALID_OPERATIONS_ACCESS_INPUT'
  | 'OPERATIONS_PRINCIPAL_CONFLICT'
  | 'ORGANIZATION_NOT_FOUND'
  | 'ORGANIZATION_INACTIVE'
  | 'ACCESS_GRANT_CONFLICT'
  | 'ACCESS_GRANT_SCOPE_CONFLICT';

export class OperationsAccessProvisioningError extends Error {
  constructor(
    readonly code: OperationsAccessProvisioningErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OperationsAccessProvisioningError';
  }
}

export function parseOperationsAccessProvisioningInput(
  value: unknown,
  now: Date = new Date(),
): OperationsAccessProvisioningInput {
  const input = strictObject(value, rootFields, 'operations access');
  const rawGrants = input.grants;
  if (!Array.isArray(rawGrants) || rawGrants.length < 1 || rawGrants.length > 20) {
    invalid('grants must contain 1 to 20 access grants');
  }

  const grants = rawGrants.map((grant, index) => parseGrant(grant, index, now));
  const uniqueKeys = new Set<string>();
  const scopesByPermission = new Map<OperationsPermission, Set<string>>();
  for (const grant of grants) {
    const key = grantKey(grant);
    if (uniqueKeys.has(key)) invalid('grants must not contain duplicate scopes');
    uniqueKeys.add(key);
    const scopes = scopesByPermission.get(grant.permissionCode) ?? new Set();
    scopes.add(grant.scopeKind);
    scopesByPermission.set(grant.permissionCode, scopes);
  }
  if ([...scopesByPermission.values()].some((scopes) => scopes.size > 1)) {
    invalid('one permission cannot mix global and organization scopes');
  }

  grants.sort((left, right) => grantKey(left).localeCompare(grantKey(right)));
  return {
    oidcIssuer: requiredOidcIssuer(input),
    oidcSubject: requiredText(input, 'oidcSubject', 255),
    displayName: requiredText(input, 'displayName', 200),
    email: optionalEmail(input),
    grants,
    operatorIdentifier: requiredText(input, 'operatorIdentifier', 200),
    reasonCode: requiredCode(input, 'reasonCode'),
  };
}

export async function provisionOperationsAccess(
  database: ProvisioningDatabase,
  input: OperationsAccessProvisioningInput,
  dependencies: ProvisioningDependencies = {},
): Promise<OperationsAccessProvisioningResult> {
  const now = dependencies.now ?? new Date();
  const processedAt = now.toISOString();
  const randomId = dependencies.randomId ?? randomUUID;
  const client = await database.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      principalFingerprint(input.oidcIssuer, input.oidcSubject),
    ]);

    const userResult = await client.query<OperationsUserRow>(
      `SELECT id, display_name, email, status
       FROM operations_users
       WHERE oidc_issuer = $1 AND oidc_subject = $2
       FOR UPDATE`,
      [input.oidcIssuer, input.oidcSubject],
    );
    let user = userResult.rows[0];
    let userCreated = false;
    if (user) {
      if (
        user.display_name !== input.displayName ||
        user.email !== input.email ||
        user.status !== 'ACTIVE'
      ) {
        throw new OperationsAccessProvisioningError(
          'OPERATIONS_PRINCIPAL_CONFLICT',
          'The OIDC principal is already bound to different or inactive operations-user data',
        );
      }
    } else {
      const userId = randomId();
      await client.query(
        `INSERT INTO operations_users (
           id, oidc_issuer, oidc_subject, display_name, email, status,
           created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $6)`,
        [
          userId,
          input.oidcIssuer,
          input.oidcSubject,
          input.displayName,
          input.email,
          processedAt,
        ],
      );
      user = {
        id: userId,
        display_name: input.displayName,
        email: input.email,
        status: 'ACTIVE',
      };
      userCreated = true;
    }

    await requireActiveOrganizations(client, input.grants);
    const permissionCodes = [...new Set(input.grants.map((g) => g.permissionCode))];
    const existingResult = await client.query<AccessGrantRow>(
      `SELECT
         id, permission_code, scope_kind, organization_id, active, expires_at
       FROM operations_access_grants
       WHERE operations_user_id = $1
         AND permission_code = ANY($2::text[])
       ORDER BY permission_code, scope_kind, organization_id
       FOR UPDATE`,
      [user.id, permissionCodes],
    );
    const existingGrants = existingResult.rows;
    const resultGrants: Array<OperationsAccessProvisioningResult['grants'][number]> = [];
    const createdGrants: Array<OperationsAccessProvisioningResult['grants'][number]> = [];

    for (const requested of input.grants) {
      const exact = existingGrants.find((candidate) => sameGrantKey(candidate, requested));
      if (exact) {
        if (
          !exact.active ||
          expiry(exact.expires_at) !== requested.expiresAt ||
          (exact.expires_at !== null && exact.expires_at <= now)
        ) {
          throw new OperationsAccessProvisioningError(
            'ACCESS_GRANT_CONFLICT',
            'The requested access grant already exists with inactive, expired, or different data',
          );
        }
        resultGrants.push(resultGrant(exact, false));
        continue;
      }

      const effectiveOverlappingScope = existingGrants.some(
        (candidate) =>
          candidate.permission_code === requested.permissionCode &&
          candidate.active &&
          (candidate.expires_at === null || candidate.expires_at > now) &&
          candidate.scope_kind !== requested.scopeKind,
      );
      if (effectiveOverlappingScope) {
        throw new OperationsAccessProvisioningError(
          'ACCESS_GRANT_SCOPE_CONFLICT',
          'The permission already has an incompatible effective scope',
        );
      }

      const grantId = randomId();
      await client.query(
        `INSERT INTO operations_access_grants (
           id, operations_user_id, permission_code, scope_kind,
           organization_id, active, granted_at, expires_at, created_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, true, $6, $7, $6, $6)`,
        [
          grantId,
          user.id,
          requested.permissionCode,
          requested.scopeKind,
          requested.organizationId,
          processedAt,
          requested.expiresAt,
        ],
      );
      const created = {
        grantId,
        permissionCode: requested.permissionCode,
        scopeKind: requested.scopeKind,
        organizationId: requested.organizationId,
        expiresAt: requested.expiresAt,
        created: true,
      } as const;
      resultGrants.push(created);
      createdGrants.push(created);
    }

    if (userCreated || createdGrants.length > 0) {
      const auditId = randomId();
      const requestId = randomId();
      await client.query(
        `INSERT INTO audit_events (
           id, organization_id, practitioner_id, action_code, entity_type,
           entity_id, reason_code, request_id, occurred_at, metadata,
           operations_user_id, outcome_code
         ) VALUES ($1, NULL, NULL, 'OPERATIONS_ACCESS_PROVISION',
           'OPERATIONS_USER', $2, $3, $4, $5, $6::jsonb, NULL, 'SUCCESS')`,
        [
          auditId,
          user.id,
          input.reasonCode,
          requestId,
          processedAt,
          JSON.stringify({
            createdGrants: createdGrants.map((grant) => ({
              grantId: grant.grantId,
              organizationId: grant.organizationId,
              permissionCode: grant.permissionCode,
              scopeKind: grant.scopeKind,
            })),
            operationsUserId: user.id,
            operatorIdentifier: input.operatorIdentifier,
            principalFingerprint: principalFingerprint(
              input.oidcIssuer,
              input.oidcSubject,
            ),
            userCreated,
          }),
        ],
      );
    }

    await client.query('COMMIT');
    return {
      kind:
        userCreated || createdGrants.length > 0
          ? 'PROVISIONED'
          : 'ALREADY_PROVISIONED',
      operationsUserId: user.id,
      userCreated,
      grants: resultGrants,
      processedAt,
    };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function requireActiveOrganizations(
  client: PoolClient,
  grants: readonly OperationsAccessGrantInput[],
): Promise<void> {
  const organizationIds = [
    ...new Set(grants.flatMap((grant) => (grant.organizationId ? [grant.organizationId] : []))),
  ].sort();
  if (organizationIds.length === 0) return;

  const result = await client.query<OrganizationRow>(
    `SELECT id, active
     FROM organizations
     WHERE id = ANY($1::uuid[])
     ORDER BY id
     FOR SHARE`,
    [organizationIds],
  );
  const byId = new Map(result.rows.map((organization) => [organization.id, organization]));
  for (const organizationId of organizationIds) {
    const organization = byId.get(organizationId);
    if (!organization) {
      throw new OperationsAccessProvisioningError(
        'ORGANIZATION_NOT_FOUND',
        'A grant references an organization that does not exist',
      );
    }
    if (!organization.active) {
      throw new OperationsAccessProvisioningError(
        'ORGANIZATION_INACTIVE',
        'A grant references an organization that is not active',
      );
    }
  }
}

function parseGrant(
  value: unknown,
  index: number,
  now: Date,
): OperationsAccessGrantInput {
  const grant = strictObject(value, grantFields, `grant ${index}`);
  const permissionCode = requiredCode(grant, 'permissionCode');
  if (!supportedPermissions.has(permissionCode as OperationsPermission)) {
    invalid(
      'permissionCode must be PATIENT_READ, MEDICAL_ID_RECOVER, IDENTITY_REVIEW, or SYNC_MONITOR',
    );
  }
  const scopeKind = requiredCode(grant, 'scopeKind');
  if (scopeKind !== 'GLOBAL' && scopeKind !== 'ORGANIZATION') {
    invalid('scopeKind must be GLOBAL or ORGANIZATION');
  }

  const rawOrganizationId = grant.organizationId;
  let organizationId: string | null;
  if (scopeKind === 'GLOBAL') {
    if (rawOrganizationId !== null) {
      invalid('GLOBAL grants require organizationId to be null');
    }
    organizationId = null;
  } else {
    organizationId = requiredUuid(grant, 'organizationId');
  }

  return {
    permissionCode: permissionCode as OperationsPermission,
    scopeKind,
    organizationId,
    expiresAt: optionalFutureTimestamp(grant, 'expiresAt', now),
  };
}

function requiredOidcIssuer(value: Record<string, unknown>): string {
  const raw = requiredText(value, 'oidcIssuer', 500);
  let issuer: URL;
  try {
    issuer = new URL(raw);
  } catch {
    invalid('oidcIssuer must be an absolute HTTPS URL');
  }
  if (
    issuer.protocol !== 'https:' ||
    issuer.username !== '' ||
    issuer.password !== '' ||
    issuer.search !== '' ||
    issuer.hash !== ''
  ) {
    invalid('oidcIssuer must be an absolute HTTPS URL without credentials, query, or fragment');
  }
  return issuer.href;
}

function optionalEmail(value: Record<string, unknown>): string | null {
  const raw = value.email;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') invalid('email must be text or null');
  const email = raw.trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > 320 ||
    /[\u0000-\u0020\u007f]/.test(email) ||
    !/^[^@]+@[^@]+$/.test(email)
  ) {
    invalid('email must be a valid bounded address or null');
  }
  return email;
}

function requiredUuid(value: Record<string, unknown>, field: string): string {
  const raw = value[field];
  if (typeof raw !== 'string' || !uuidPattern.test(raw)) {
    invalid(`${field} must be a valid UUID`);
  }
  return raw.toLowerCase();
}

function requiredCode(value: Record<string, unknown>, field: string): string {
  const code = requiredText(value, field, 80);
  if (!/^[A-Z][A-Z0-9_]{1,79}$/.test(code)) {
    invalid(`${field} must use upper snake case`);
  }
  return code;
}

function requiredText(
  value: Record<string, unknown>,
  field: string,
  maximumLength: number,
): string {
  const raw = value[field];
  if (typeof raw !== 'string') invalid(`${field} must be text`);
  const text = raw.trim();
  if (
    text.length < 1 ||
    text.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(text)
  ) {
    invalid(`${field} must contain 1 to ${maximumLength} characters`);
  }
  return text;
}

function optionalFutureTimestamp(
  value: Record<string, unknown>,
  field: string,
  now: Date,
): string | null {
  const raw = value[field];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !isoTimestampPattern.test(raw.trim())) {
    invalid(`${field} must be an ISO 8601 timestamp or null`);
  }
  const timestamp = new Date(raw.trim());
  if (!Number.isFinite(timestamp.getTime())) {
    invalid(`${field} must be an ISO 8601 timestamp or null`);
  }
  if (timestamp <= now) invalid(`${field} must be in the future`);
  return timestamp.toISOString();
}

function strictObject(
  value: unknown,
  allowedFields: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${label} input must be a JSON object`);
  }
  const input = value as Record<string, unknown>;
  const unexpected = Object.keys(input).filter((field) => !allowedFields.has(field));
  if (unexpected.length > 0) {
    invalid(`Unexpected ${label} field: ${unexpected.sort()[0]}`);
  }
  return input;
}

function sameGrantKey(
  existing: AccessGrantRow,
  requested: OperationsAccessGrantInput,
): boolean {
  return (
    existing.permission_code === requested.permissionCode &&
    existing.scope_kind === requested.scopeKind &&
    existing.organization_id === requested.organizationId
  );
}

function resultGrant(
  grant: AccessGrantRow,
  created: boolean,
): OperationsAccessProvisioningResult['grants'][number] {
  return {
    grantId: grant.id,
    permissionCode: grant.permission_code,
    scopeKind: grant.scope_kind,
    organizationId: grant.organization_id,
    expiresAt: expiry(grant.expires_at),
    created,
  };
}

function expiry(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function grantKey(grant: OperationsAccessGrantInput): string {
  return `${grant.permissionCode}|${grant.scopeKind}|${grant.organizationId ?? ''}`;
}

function principalFingerprint(issuer: string, subject: string): string {
  return createHash('sha256')
    .update(issuer)
    .update('\u0000')
    .update(subject)
    .digest('hex');
}

function invalid(message: string): never {
  throw new OperationsAccessProvisioningError(
    'INVALID_OPERATIONS_ACCESS_INPUT',
    message,
  );
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the provisioning error; releasing lets pg discard the client.
  }
}
