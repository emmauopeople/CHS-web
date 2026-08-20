import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import { generateInstallationToken } from './installation-enrollment.js';
import {
  installationTokenHash,
  installationTokenPrefix,
} from '../sync/installation-auth.js';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenPattern = /^chs_inst_v1_[A-Za-z0-9_-]{43}$/;
const isoTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const rotationFields = new Set([
  'installationId',
  'expectedCredentialId',
  'credentialLabel',
  'credentialExpiresAt',
  'operatorIdentifier',
  'reasonCode',
]);
const revocationFields = new Set([
  'installationId',
  'credentialId',
  'operatorIdentifier',
  'reasonCode',
  'confirmation',
]);

type LifecycleDatabase = Pick<Pool, 'connect'>;
type LifecycleDependencies = Readonly<{
  now?: Date;
  randomId?: () => string;
  generateToken?: () => string;
}>;
type InstallationRow = Readonly<{
  organization_id: string;
  status: string;
}>;
type CredentialRow = Readonly<{
  id: string;
  token_prefix: string;
  status: 'ACTIVE' | 'REVOKED';
  revoked_at: Date | null;
}>;

export type RotateInstallationCredentialInput = Readonly<{
  installationId: string;
  expectedCredentialId: string;
  credentialLabel: string;
  credentialExpiresAt: string | null;
  operatorIdentifier: string;
  reasonCode: string;
}>;

export type RotateInstallationCredentialResult = Readonly<{
  installationId: string;
  replacedCredentialId: string;
  credentialId: string;
  credentialExpiresAt: string | null;
  installationToken: string;
  issuedAt: string;
}>;

export type RevokeInstallationCredentialInput = Readonly<{
  installationId: string;
  credentialId: string;
  operatorIdentifier: string;
  reasonCode: string;
  confirmation: 'REVOKE_INSTALLATION_CREDENTIAL';
}>;

export type RevokeInstallationCredentialResult = Readonly<{
  kind: 'REVOKED' | 'ALREADY_REVOKED';
  installationId: string;
  credentialId: string;
  revokedAt: string;
}>;

export type InstallationCredentialLifecycleErrorCode =
  | 'INVALID_CREDENTIAL_LIFECYCLE_INPUT'
  | 'INSTALLATION_NOT_FOUND'
  | 'INSTALLATION_NOT_ACTIVE'
  | 'CREDENTIAL_NOT_FOUND'
  | 'CREDENTIAL_STATE_CONFLICT';

export class InstallationCredentialLifecycleError extends Error {
  constructor(
    readonly code: InstallationCredentialLifecycleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InstallationCredentialLifecycleError';
  }
}

export function parseRotateInstallationCredentialInput(
  value: unknown,
  now: Date = new Date(),
): RotateInstallationCredentialInput {
  const input = strictObject(value, rotationFields, 'rotation');
  return {
    installationId: requiredUuid(input, 'installationId'),
    expectedCredentialId: requiredUuid(input, 'expectedCredentialId'),
    credentialLabel: requiredText(input, 'credentialLabel', 120),
    credentialExpiresAt: optionalFutureTimestamp(
      input,
      'credentialExpiresAt',
      now,
    ),
    operatorIdentifier: requiredText(input, 'operatorIdentifier', 200),
    reasonCode: requiredReasonCode(input),
  };
}

export function parseRevokeInstallationCredentialInput(
  value: unknown,
): RevokeInstallationCredentialInput {
  const input = strictObject(value, revocationFields, 'revocation');
  if (input.confirmation !== 'REVOKE_INSTALLATION_CREDENTIAL') {
    invalid(
      'confirmation must be exactly REVOKE_INSTALLATION_CREDENTIAL because revocation can stop synchronization',
    );
  }
  return {
    installationId: requiredUuid(input, 'installationId'),
    credentialId: requiredUuid(input, 'credentialId'),
    operatorIdentifier: requiredText(input, 'operatorIdentifier', 200),
    reasonCode: requiredReasonCode(input),
    confirmation: 'REVOKE_INSTALLATION_CREDENTIAL',
  };
}

export async function rotateInstallationCredential(
  database: LifecycleDatabase,
  input: RotateInstallationCredentialInput,
  dependencies: LifecycleDependencies = {},
): Promise<RotateInstallationCredentialResult> {
  const now = dependencies.now ?? new Date();
  const issuedAt = now.toISOString();
  const randomId = dependencies.randomId ?? randomUUID;
  const installationToken =
    dependencies.generateToken?.() ?? generateInstallationToken();
  if (!tokenPattern.test(installationToken)) {
    throw new Error('Installation token generator returned an invalid token');
  }

  const credentialId = randomId();
  const auditEventId = randomId();
  const requestId = randomId();
  const client = await database.connect();

  try {
    await client.query('BEGIN');
    await lockInstallation(client, input.installationId);
    const installation = await requireInstallation(client, input.installationId);
    if (installation.status !== 'ACTIVE') {
      throw new InstallationCredentialLifecycleError(
        'INSTALLATION_NOT_ACTIVE',
        'Only an active installation can receive a new credential',
      );
    }

    const activeCredentials = await client.query<CredentialRow>(
      `SELECT id, token_prefix, status, revoked_at
       FROM desktop_installation_credentials
       WHERE installation_id = $1 AND status = 'ACTIVE'
       ORDER BY issued_at, id
       FOR UPDATE`,
      [input.installationId],
    );
    if (
      activeCredentials.rows.length !== 1 ||
      activeCredentials.rows[0]?.id !== input.expectedCredentialId
    ) {
      throw new InstallationCredentialLifecycleError(
        'CREDENTIAL_STATE_CONFLICT',
        'The expected credential is no longer the sole active credential',
      );
    }
    const replacedCredential = activeCredentials.rows[0];

    await client.query(
      `UPDATE desktop_installation_credentials
       SET status = 'REVOKED', revoked_at = $1, updated_at = $1
       WHERE id = $2`,
      [issuedAt, replacedCredential.id],
    );
    await client.query(
      `INSERT INTO desktop_installation_credentials (
         id, installation_id, token_prefix, token_hash, label, status,
         issued_at, expires_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7, $6, $6)`,
      [
        credentialId,
        input.installationId,
        installationTokenPrefix(installationToken),
        installationTokenHash(installationToken),
        input.credentialLabel,
        issuedAt,
        input.credentialExpiresAt,
      ],
    );
    await insertLifecycleAudit(client, {
      id: auditEventId,
      organizationId: installation.organization_id,
      installationId: input.installationId,
      actionCode: 'DESKTOP_INSTALLATION_CREDENTIAL_ROTATE',
      reasonCode: input.reasonCode,
      requestId,
      occurredAt: issuedAt,
      metadata: {
        credentialId,
        operatorIdentifier: input.operatorIdentifier,
        replacedCredentialId: replacedCredential.id,
        replacedTokenPrefix: replacedCredential.token_prefix,
        tokenPrefix: installationTokenPrefix(installationToken),
      },
    });

    await client.query('COMMIT');
    return {
      installationId: input.installationId,
      replacedCredentialId: replacedCredential.id,
      credentialId,
      credentialExpiresAt: input.credentialExpiresAt,
      installationToken,
      issuedAt,
    };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeInstallationCredential(
  database: LifecycleDatabase,
  input: RevokeInstallationCredentialInput,
  dependencies: Omit<LifecycleDependencies, 'generateToken'> = {},
): Promise<RevokeInstallationCredentialResult> {
  const now = dependencies.now ?? new Date();
  const revokedAt = now.toISOString();
  const randomId = dependencies.randomId ?? randomUUID;
  const client = await database.connect();

  try {
    await client.query('BEGIN');
    await lockInstallation(client, input.installationId);
    const installation = await requireInstallation(client, input.installationId);
    const credentialResult = await client.query<CredentialRow>(
      `SELECT id, token_prefix, status, revoked_at
       FROM desktop_installation_credentials
       WHERE id = $1 AND installation_id = $2
       FOR UPDATE`,
      [input.credentialId, input.installationId],
    );
    const credential = credentialResult.rows[0];
    if (!credential) {
      throw new InstallationCredentialLifecycleError(
        'CREDENTIAL_NOT_FOUND',
        'The credential does not belong to the installation',
      );
    }
    if (credential.status === 'REVOKED') {
      await client.query('COMMIT');
      return {
        kind: 'ALREADY_REVOKED',
        installationId: input.installationId,
        credentialId: credential.id,
        revokedAt: credential.revoked_at!.toISOString(),
      };
    }

    const auditEventId = randomId();
    const requestId = randomId();
    await client.query(
      `UPDATE desktop_installation_credentials
       SET status = 'REVOKED', revoked_at = $1, updated_at = $1
       WHERE id = $2`,
      [revokedAt, credential.id],
    );
    await insertLifecycleAudit(client, {
      id: auditEventId,
      organizationId: installation.organization_id,
      installationId: input.installationId,
      actionCode: 'DESKTOP_INSTALLATION_CREDENTIAL_REVOKE',
      reasonCode: input.reasonCode,
      requestId,
      occurredAt: revokedAt,
      metadata: {
        credentialId: credential.id,
        operatorIdentifier: input.operatorIdentifier,
        tokenPrefix: credential.token_prefix,
      },
    });

    await client.query('COMMIT');
    return {
      kind: 'REVOKED',
      installationId: input.installationId,
      credentialId: credential.id,
      revokedAt,
    };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function lockInstallation(
  client: PoolClient,
  installationId: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    installationId,
  ]);
}

async function requireInstallation(
  client: PoolClient,
  installationId: string,
): Promise<InstallationRow> {
  const result = await client.query<InstallationRow>(
    `SELECT organization_id, status
     FROM desktop_installations
     WHERE id = $1
     FOR UPDATE`,
    [installationId],
  );
  const installation = result.rows[0];
  if (!installation) {
    throw new InstallationCredentialLifecycleError(
      'INSTALLATION_NOT_FOUND',
      'The installation does not exist',
    );
  }
  return installation;
}

async function insertLifecycleAudit(
  client: PoolClient,
  event: Readonly<{
    id: string;
    organizationId: string;
    installationId: string;
    actionCode: string;
    reasonCode: string;
    requestId: string;
    occurredAt: string;
    metadata: Readonly<Record<string, string>>;
  }>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (
       id, organization_id, action_code, entity_type, entity_id, reason_code,
       request_id, occurred_at, metadata, operations_user_id, outcome_code
     ) VALUES ($1, $2, $3, 'DESKTOP_INSTALLATION', $4, $5, $6, $7,
       $8::jsonb, NULL, 'SUCCESS')`,
    [
      event.id,
      event.organizationId,
      event.actionCode,
      event.installationId,
      event.reasonCode,
      event.requestId,
      event.occurredAt,
      JSON.stringify(event.metadata),
    ],
  );
}

function strictObject(
  value: unknown,
  allowedFields: ReadonlySet<string>,
  operation: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`Credential ${operation} input must be a JSON object`);
  }
  const unexpectedFields = Object.keys(value).filter(
    (field) => !allowedFields.has(field),
  );
  if (unexpectedFields.length > 0) {
    invalid(`Unexpected ${operation} field: ${unexpectedFields.sort()[0]}`);
  }
  return value as Record<string, unknown>;
}

function requiredUuid(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== 'string' || !uuidPattern.test(candidate)) {
    invalid(`${field} must be a valid UUID`);
  }
  return candidate.toLowerCase();
}

function requiredText(
  value: Record<string, unknown>,
  field: string,
  maximumLength: number,
): string {
  const candidate = value[field];
  if (typeof candidate !== 'string') {
    invalid(`${field} must be text`);
  }
  const normalized = candidate.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    invalid(`${field} must contain 1 to ${maximumLength} characters`);
  }
  return normalized;
}

function requiredReasonCode(value: Record<string, unknown>): string {
  const reasonCode = requiredText(value, 'reasonCode', 80);
  if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(reasonCode)) {
    invalid('reasonCode must use upper snake case');
  }
  return reasonCode;
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
  if (timestamp <= now) {
    invalid(`${field} must be later than the issuance time`);
  }
  return timestamp.toISOString();
}

function invalid(message: string): never {
  throw new InstallationCredentialLifecycleError(
    'INVALID_CREDENTIAL_LIFECYCLE_INPUT',
    message,
  );
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the lifecycle error; releasing the client lets pg discard it.
  }
}
