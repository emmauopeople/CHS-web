import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

const allowedFields = new Set([
  'organizationIdentifierSystem',
  'organizationIdentifierValue',
  'organizationName',
  'organizationTypeCode',
  'locationIdentifierSystem',
  'locationIdentifierValue',
  'locationName',
  'locationTypeCode',
  'physicalTypeCode',
  'village',
  'subdivision',
  'region',
  'directions',
  'operatorIdentifier',
  'reasonCode',
]);

type ProvisioningDatabase = Pick<Pool, 'connect'>;
type ProvisioningDependencies = Readonly<{
  now?: Date;
  randomId?: () => string;
}>;
type OrganizationRow = Readonly<{
  id: string;
  name: string;
  organization_type_code: string;
  active: boolean;
}>;
type LocationRow = Readonly<{
  id: string;
  parent_location_id: string | null;
  name: string;
  location_type_code: string;
  physical_type_code: string | null;
  village: string | null;
  subdivision: string | null;
  region: string | null;
  directions: string | null;
  active: boolean;
}>;

export type ScreeningContextProvisioningInput = Readonly<{
  organizationIdentifierSystem: string;
  organizationIdentifierValue: string;
  organizationName: string;
  organizationTypeCode: string;
  locationIdentifierSystem: string;
  locationIdentifierValue: string;
  locationName: string;
  locationTypeCode: string;
  physicalTypeCode: string | null;
  village: string | null;
  subdivision: string | null;
  region: string | null;
  directions: string | null;
  operatorIdentifier: string;
  reasonCode: string;
}>;

export type ScreeningContextProvisioningResult = Readonly<{
  kind: 'PROVISIONED' | 'ALREADY_PROVISIONED';
  organizationId: string;
  locationId: string;
  organizationCreated: boolean;
  locationCreated: boolean;
  processedAt: string;
}>;

export type ScreeningContextProvisioningErrorCode =
  | 'INVALID_SCREENING_CONTEXT_INPUT'
  | 'ORGANIZATION_IDENTIFIER_CONFLICT'
  | 'LOCATION_IDENTIFIER_CONFLICT';

export class ScreeningContextProvisioningError extends Error {
  constructor(
    readonly code: ScreeningContextProvisioningErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ScreeningContextProvisioningError';
  }
}

export function parseScreeningContextProvisioningInput(
  value: unknown,
): ScreeningContextProvisioningInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('Screening context input must be a JSON object');
  }
  const input = value as Record<string, unknown>;
  const unexpectedFields = Object.keys(input).filter(
    (field) => !allowedFields.has(field),
  );
  if (unexpectedFields.length > 0) {
    invalid(`Unexpected screening context field: ${unexpectedFields.sort()[0]}`);
  }

  const organizationIdentifierSystem = requiredIdentifierSystem(
    input,
    'organizationIdentifierSystem',
  );
  const locationIdentifierSystem = requiredIdentifierSystem(
    input,
    'locationIdentifierSystem',
  );
  const organizationTypeCode = requiredCode(input, 'organizationTypeCode');
  const locationTypeCode = requiredCode(input, 'locationTypeCode');
  const physicalTypeCode = optionalCode(input, 'physicalTypeCode');
  const reasonCode = requiredCode(input, 'reasonCode');

  return {
    organizationIdentifierSystem,
    organizationIdentifierValue: requiredText(
      input,
      'organizationIdentifierValue',
      120,
    ),
    organizationName: requiredText(input, 'organizationName', 200),
    organizationTypeCode,
    locationIdentifierSystem,
    locationIdentifierValue: requiredText(
      input,
      'locationIdentifierValue',
      120,
    ),
    locationName: requiredText(input, 'locationName', 200),
    locationTypeCode,
    physicalTypeCode,
    village: optionalText(input, 'village', 160),
    subdivision: optionalText(input, 'subdivision', 160),
    region: optionalText(input, 'region', 160),
    directions: optionalText(input, 'directions', 500),
    operatorIdentifier: requiredText(input, 'operatorIdentifier', 200),
    reasonCode,
  };
}

export async function provisionScreeningContext(
  database: ProvisioningDatabase,
  input: ScreeningContextProvisioningInput,
  dependencies: ProvisioningDependencies = {},
): Promise<ScreeningContextProvisioningResult> {
  const now = dependencies.now ?? new Date();
  const provisionedAt = now.toISOString();
  const randomId = dependencies.randomId ?? randomUUID;
  const client = await database.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${input.organizationIdentifierSystem}\u001f${input.organizationIdentifierValue}`,
    ]);

    const organizationResult = await client.query<OrganizationRow>(
      `SELECT id, name, organization_type_code, active
       FROM organizations
       WHERE identifier_system = $1 AND identifier_value = $2
       FOR UPDATE`,
      [input.organizationIdentifierSystem, input.organizationIdentifierValue],
    );
    let organization = organizationResult.rows[0];
    let organizationCreated = false;
    if (organization) {
      if (!sameOrganization(organization, input)) {
        throw new ScreeningContextProvisioningError(
          'ORGANIZATION_IDENTIFIER_CONFLICT',
          'The organization identifier is already bound to different canonical data',
        );
      }
    } else {
      const organizationId = randomId();
      await client.query(
        `INSERT INTO organizations (
           id, identifier_system, identifier_value, name,
           organization_type_code, active, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, true, $6, $6)`,
        [
          organizationId,
          input.organizationIdentifierSystem,
          input.organizationIdentifierValue,
          input.organizationName,
          input.organizationTypeCode,
          provisionedAt,
        ],
      );
      organization = {
        id: organizationId,
        name: input.organizationName,
        organization_type_code: input.organizationTypeCode,
        active: true,
      };
      organizationCreated = true;
    }

    const locationResult = await client.query<LocationRow>(
      `SELECT
         id,
         parent_location_id,
         name,
         location_type_code,
         physical_type_code,
         village,
         subdivision,
         region,
         directions,
         active
       FROM locations
       WHERE organization_id = $1
         AND identifier_system = $2
         AND identifier_value = $3
       FOR UPDATE`,
      [
        organization.id,
        input.locationIdentifierSystem,
        input.locationIdentifierValue,
      ],
    );
    let location = locationResult.rows[0];
    let locationCreated = false;
    if (location) {
      if (!sameLocation(location, input)) {
        throw new ScreeningContextProvisioningError(
          'LOCATION_IDENTIFIER_CONFLICT',
          'The location identifier is already bound to different canonical data',
        );
      }
    } else {
      const locationId = randomId();
      await client.query(
        `INSERT INTO locations (
           id, organization_id, parent_location_id, identifier_system,
           identifier_value, name, location_type_code, physical_type_code,
           village, subdivision, region, directions, active, created_at,
           updated_at
         ) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           true, $12, $12)`,
        [
          locationId,
          organization.id,
          input.locationIdentifierSystem,
          input.locationIdentifierValue,
          input.locationName,
          input.locationTypeCode,
          input.physicalTypeCode,
          input.village,
          input.subdivision,
          input.region,
          input.directions,
          provisionedAt,
        ],
      );
      location = {
        id: locationId,
        parent_location_id: null,
        name: input.locationName,
        location_type_code: input.locationTypeCode,
        physical_type_code: input.physicalTypeCode,
        village: input.village,
        subdivision: input.subdivision,
        region: input.region,
        directions: input.directions,
        active: true,
      };
      locationCreated = true;
    }

    if (organizationCreated || locationCreated) {
      const auditEventId = randomId();
      const requestId = randomId();
      await client.query(
        `INSERT INTO audit_events (
           id, organization_id, action_code, entity_type, entity_id,
           reason_code, request_id, occurred_at, metadata, operations_user_id,
           outcome_code
         ) VALUES ($1, $2, 'SCREENING_CONTEXT_PROVISION', 'ORGANIZATION', $2,
           $3, $4, $5, $6::jsonb, NULL, 'SUCCESS')`,
        [
          auditEventId,
          organization.id,
          input.reasonCode,
          requestId,
          provisionedAt,
          JSON.stringify({
            locationId: location.id,
            locationIdentifierSystem: input.locationIdentifierSystem,
            locationIdentifierValue: input.locationIdentifierValue,
            operatorIdentifier: input.operatorIdentifier,
            organizationCreated,
            organizationIdentifierSystem: input.organizationIdentifierSystem,
            organizationIdentifierValue: input.organizationIdentifierValue,
          }),
        ],
      );
    }

    await client.query('COMMIT');
    return {
      kind:
        organizationCreated || locationCreated
          ? 'PROVISIONED'
          : 'ALREADY_PROVISIONED',
      organizationId: organization.id,
      locationId: location.id,
      organizationCreated,
      locationCreated,
      processedAt: provisionedAt,
    };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

function sameOrganization(
  organization: OrganizationRow,
  input: ScreeningContextProvisioningInput,
): boolean {
  return (
    organization.name === input.organizationName &&
    organization.organization_type_code === input.organizationTypeCode &&
    organization.active
  );
}

function sameLocation(
  location: LocationRow,
  input: ScreeningContextProvisioningInput,
): boolean {
  return (
    location.parent_location_id === null &&
    location.name === input.locationName &&
    location.location_type_code === input.locationTypeCode &&
    location.physical_type_code === input.physicalTypeCode &&
    location.village === input.village &&
    location.subdivision === input.subdivision &&
    location.region === input.region &&
    location.directions === input.directions &&
    location.active
  );
}

function requiredIdentifierSystem(
  value: Record<string, unknown>,
  field: string,
): string {
  const identifierSystem = requiredText(value, field, 300);
  let parsed: URL;
  try {
    parsed = new URL(identifierSystem);
  } catch {
    invalid(`${field} must be an absolute HTTPS or URN identifier`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'urn:') {
    invalid(`${field} must be an absolute HTTPS or URN identifier`);
  }
  return identifierSystem;
}

function requiredCode(value: Record<string, unknown>, field: string): string {
  const code = requiredText(value, field, 80);
  if (!/^[A-Z][A-Z0-9_]{1,79}$/.test(code)) {
    invalid(`${field} must use upper snake case`);
  }
  return code;
}

function optionalCode(
  value: Record<string, unknown>,
  field: string,
): string | null {
  const code = optionalText(value, field, 80);
  if (code !== null && !/^[A-Z][A-Z0-9_]{1,79}$/.test(code)) {
    invalid(`${field} must use upper snake case or null`);
  }
  return code;
}

function requiredText(
  value: Record<string, unknown>,
  field: string,
  maximumLength: number,
): string {
  const candidate = value[field];
  if (typeof candidate !== 'string') invalid(`${field} must be text`);
  const normalized = candidate.trim();
  if (!validText(normalized, maximumLength)) {
    invalid(`${field} must contain 1 to ${maximumLength} characters`);
  }
  return normalized;
}

function optionalText(
  value: Record<string, unknown>,
  field: string,
  maximumLength: number,
): string | null {
  const candidate = value[field];
  if (candidate === undefined || candidate === null) return null;
  if (typeof candidate !== 'string') invalid(`${field} must be text or null`);
  const normalized = candidate.trim();
  if (!validText(normalized, maximumLength)) {
    invalid(`${field} must contain 1 to ${maximumLength} characters or be null`);
  }
  return normalized;
}

function validText(value: string, maximumLength: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function invalid(message: string): never {
  throw new ScreeningContextProvisioningError(
    'INVALID_SCREENING_CONTEXT_INPUT',
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
