import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import {
  installationTokenHash,
  installationTokenPrefix,
} from '../sync/installation-auth.js';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const generatedTokenPattern = /^chs_inst_v1_[A-Za-z0-9_-]{43}$/;
const isoTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const allowedInputFields = new Set([
  'installationId',
  'organizationId',
  'configuredLocationId',
  'sourceLocationId',
  'deploymentName',
  'timezone',
  'credentialLabel',
  'credentialExpiresAt',
  'operatorIdentifier',
  'reasonCode',
]);

type EnrollmentDatabase = Pick<Pool, 'connect'>;

type OrganizationRow = Readonly<{ active: boolean }>;
type LocationRow = Readonly<{ organization_id: string; active: boolean }>;
type InstallationRow = Readonly<{
  organization_id: string;
  configured_location_id: string;
  deployment_name: string;
  timezone: string;
}>;
type LocationSourceRow = Readonly<{
  location_id: string;
  organization_id: string;
  source_location_id: string;
}>;

export type DesktopInstallationEnrollmentInput = Readonly<{
  installationId: string;
  organizationId: string;
  configuredLocationId: string;
  sourceLocationId: string;
  deploymentName: string;
  timezone: string;
  credentialLabel: string;
  credentialExpiresAt: string | null;
  operatorIdentifier: string;
  reasonCode: string;
}>;

export type DesktopInstallationEnrollmentResult = Readonly<{
  installationId: string;
  organizationId: string;
  configuredLocationId: string;
  sourceLocationId: string;
  credentialId: string;
  credentialExpiresAt: string | null;
  installationToken: string;
  issuedAt: string;
}>;

export type InstallationEnrollmentErrorCode =
  | 'INVALID_ENROLLMENT_INPUT'
  | 'ORGANIZATION_NOT_FOUND'
  | 'ORGANIZATION_INACTIVE'
  | 'LOCATION_NOT_FOUND'
  | 'LOCATION_INACTIVE'
  | 'LOCATION_ORGANIZATION_MISMATCH'
  | 'INSTALLATION_ALREADY_ENROLLED'
  | 'INSTALLATION_CONFLICT';

export class InstallationEnrollmentError extends Error {
  constructor(
    readonly code: InstallationEnrollmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InstallationEnrollmentError';
  }
}

type EnrollmentDependencies = Readonly<{
  now?: Date;
  randomId?: () => string;
  generateToken?: () => string;
}>;

export function generateInstallationToken(): string {
  return `chs_inst_v1_${randomBytes(32).toString('base64url')}`;
}

export function parseDesktopInstallationEnrollmentInput(
  value: unknown,
  now: Date = new Date(),
): DesktopInstallationEnrollmentInput {
  if (!isRecord(value)) {
    invalid('Enrollment input must be a JSON object');
  }
  const unexpectedFields = Object.keys(value).filter(
    (field) => !allowedInputFields.has(field),
  );
  if (unexpectedFields.length > 0) {
    invalid(`Unexpected enrollment field: ${unexpectedFields.sort()[0]}`);
  }

  const installationId = requiredUuid(value, 'installationId');
  const organizationId = requiredUuid(value, 'organizationId');
  const configuredLocationId = requiredUuid(value, 'configuredLocationId');
  const sourceLocationId = requiredUuid(value, 'sourceLocationId');
  const deploymentName = requiredText(value, 'deploymentName', 120);
  const timezone = requiredText(value, 'timezone', 100);
  const credentialLabel = requiredText(value, 'credentialLabel', 120);
  const operatorIdentifier = requiredText(value, 'operatorIdentifier', 200);
  const reasonCode = requiredText(value, 'reasonCode', 80);

  assertIanaTimezone(timezone);
  if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(reasonCode)) {
    invalid('reasonCode must use upper snake case');
  }

  const rawExpiry = value.credentialExpiresAt;
  let credentialExpiresAt: string | null = null;
  if (rawExpiry !== undefined && rawExpiry !== null) {
    if (
      typeof rawExpiry !== 'string' ||
      !isoTimestampPattern.test(rawExpiry.trim())
    ) {
      invalid('credentialExpiresAt must be an ISO 8601 timestamp or null');
    }
    const parsedExpiry = new Date(rawExpiry.trim());
    if (!Number.isFinite(parsedExpiry.getTime())) {
      invalid('credentialExpiresAt must be an ISO 8601 timestamp or null');
    }
    credentialExpiresAt = parsedExpiry.toISOString();
    if (parsedExpiry <= now) {
      invalid('credentialExpiresAt must be later than the issuance time');
    }
  }

  return {
    installationId,
    organizationId,
    configuredLocationId,
    sourceLocationId,
    deploymentName,
    timezone,
    credentialLabel,
    credentialExpiresAt,
    operatorIdentifier,
    reasonCode,
  };
}

export async function enrollDesktopInstallation(
  database: EnrollmentDatabase,
  input: DesktopInstallationEnrollmentInput,
  dependencies: EnrollmentDependencies = {},
): Promise<DesktopInstallationEnrollmentResult> {
  const now = dependencies.now ?? new Date();
  const issuedAt = now.toISOString();
  const randomId = dependencies.randomId ?? randomUUID;
  const installationToken =
    dependencies.generateToken?.() ?? generateInstallationToken();
  if (!generatedTokenPattern.test(installationToken)) {
    throw new Error('Installation token generator returned an invalid token');
  }

  const credentialId = randomId();
  const sourceLinkId = randomId();
  const auditEventId = randomId();
  const requestId = randomId();
  const client = await database.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      input.installationId,
    ]);

    await assertEnrollmentContext(client, input);

    await client.query(
      `INSERT INTO desktop_installations (
         id, organization_id, configured_location_id, deployment_name, timezone,
         status, enrolled_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $6, $6)`,
      [
        input.installationId,
        input.organizationId,
        input.configuredLocationId,
        input.deploymentName,
        input.timezone,
        issuedAt,
      ],
    );
    await client.query(
      `INSERT INTO location_source_links (
         id, location_id, installation_id, organization_id, source_location_id,
         first_observed_at, last_observed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [
        sourceLinkId,
        input.configuredLocationId,
        input.installationId,
        input.organizationId,
        input.sourceLocationId,
        issuedAt,
      ],
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
    await client.query(
      `INSERT INTO audit_events (
         id, organization_id, action_code, entity_type, entity_id, reason_code,
         request_id, occurred_at, metadata, operations_user_id, outcome_code
       ) VALUES ($1, $2, 'DESKTOP_INSTALLATION_ENROLL', 'DESKTOP_INSTALLATION',
         $3, $4, $5, $6, $7::jsonb, NULL, 'SUCCESS')`,
      [
        auditEventId,
        input.organizationId,
        input.installationId,
        input.reasonCode,
        requestId,
        issuedAt,
        JSON.stringify({
          configuredLocationId: input.configuredLocationId,
          credentialId,
          operatorIdentifier: input.operatorIdentifier,
          sourceLocationId: input.sourceLocationId,
          tokenPrefix: installationTokenPrefix(installationToken),
        }),
      ],
    );

    await client.query('COMMIT');
    return {
      installationId: input.installationId,
      organizationId: input.organizationId,
      configuredLocationId: input.configuredLocationId,
      sourceLocationId: input.sourceLocationId,
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

async function assertEnrollmentContext(
  client: PoolClient,
  input: DesktopInstallationEnrollmentInput,
): Promise<void> {
  const organization = await client.query<OrganizationRow>(
    'SELECT active FROM organizations WHERE id = $1 FOR SHARE',
    [input.organizationId],
  );
  if (!organization.rows[0]) {
    throw new InstallationEnrollmentError(
      'ORGANIZATION_NOT_FOUND',
      'The organization does not exist',
    );
  }
  if (!organization.rows[0].active) {
    throw new InstallationEnrollmentError(
      'ORGANIZATION_INACTIVE',
      'The organization is not active',
    );
  }

  const location = await client.query<LocationRow>(
    `SELECT organization_id, active
     FROM locations
     WHERE id = $1
     FOR SHARE`,
    [input.configuredLocationId],
  );
  const locationRow = location.rows[0];
  if (!locationRow) {
    throw new InstallationEnrollmentError(
      'LOCATION_NOT_FOUND',
      'The configured location does not exist',
    );
  }
  if (locationRow.organization_id !== input.organizationId) {
    throw new InstallationEnrollmentError(
      'LOCATION_ORGANIZATION_MISMATCH',
      'The configured location does not belong to the organization',
    );
  }
  if (!locationRow.active) {
    throw new InstallationEnrollmentError(
      'LOCATION_INACTIVE',
      'The configured location is not active',
    );
  }

  const installation = await client.query<InstallationRow>(
    `SELECT organization_id, configured_location_id, deployment_name, timezone
     FROM desktop_installations
     WHERE id = $1
     FOR UPDATE`,
    [input.installationId],
  );
  const existing = installation.rows[0];
  if (!existing) return;

  const source = await client.query<LocationSourceRow>(
    `SELECT location_id, organization_id, source_location_id
     FROM location_source_links
     WHERE installation_id = $1 AND source_location_id = $2`,
    [input.installationId, input.sourceLocationId],
  );
  const sourceRow = source.rows[0];
  const sameEnrollment =
    existing.organization_id === input.organizationId &&
    existing.configured_location_id === input.configuredLocationId &&
    existing.deployment_name === input.deploymentName &&
    existing.timezone === input.timezone &&
    sourceRow?.location_id === input.configuredLocationId &&
    sourceRow.organization_id === input.organizationId;

  if (sameEnrollment) {
    throw new InstallationEnrollmentError(
      'INSTALLATION_ALREADY_ENROLLED',
      'The installation is already enrolled; use explicit credential rotation to replace a lost token',
    );
  }
  throw new InstallationEnrollmentError(
    'INSTALLATION_CONFLICT',
    'The installation ID is already bound to different enrollment data',
  );
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

function assertIanaTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
  } catch {
    invalid('timezone must be a valid IANA timezone');
  }
}

function invalid(message: string): never {
  throw new InstallationEnrollmentError('INVALID_ENROLLMENT_INPUT', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the enrollment error; releasing the client lets pg discard it if needed.
  }
}
