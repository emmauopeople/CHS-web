import type { Pool, PoolClient } from 'pg';

import type { InstallationContext } from './types.js';

type DeliveryDatabase = Pick<Pool, 'connect'>;

export type IdentityResolutionDelivery = Readonly<{
  resolutionReference: string;
  localPatientReference: string;
  localPatientCode: string;
  sourceRevision: number;
  centralPersonId: string;
  chsMedicalId: string;
  resolvedAt: string;
}>;

export type IdentityResolutionDeliveryPage = Readonly<{
  contractVersion: '1.0';
  deliveries: readonly IdentityResolutionDelivery[];
  hasMore: boolean;
  serverTime: string;
}>;

export type IdentityResolutionAcknowledgmentInput = Readonly<{
  contractVersion: '1.0';
  acknowledgmentId: string;
  resolutionReference: string;
  appliedAt: string;
}>;

export type IdentityResolutionAcknowledgment = Readonly<{
  contractVersion: '1.0';
  acknowledgmentId: string;
  resolutionReference: string;
  status: 'ACKNOWLEDGED';
  acknowledgedAt: string;
  replayed: boolean;
}>;

export type IdentityResolutionDeliveryErrorCode =
  | 'INVALID_IDENTITY_RESOLUTION_LIMIT'
  | 'INVALID_IDENTITY_RESOLUTION_ACKNOWLEDGMENT'
  | 'IDENTITY_RESOLUTION_DELIVERY_NOT_FOUND'
  | 'IDENTITY_RESOLUTION_ACKNOWLEDGMENT_CONFLICT';

export class IdentityResolutionDeliveryError extends Error {
  constructor(
    readonly code: IdentityResolutionDeliveryErrorCode,
    readonly statusCode: 400 | 404 | 409,
  ) {
    super('Identity resolution delivery failed');
    this.name = 'IdentityResolutionDeliveryError';
  }
}

type DeliveryRow = Readonly<{
  resolution_id: string;
  local_patient_id: string;
  local_patient_code: string;
  source_revision: number;
  central_person_id: string;
  chs_medical_id: string;
  resolved_at: Date;
}>;

type AcknowledgmentRow = Readonly<{
  resolution_id: string;
  delivery_status: 'PENDING' | 'ACKNOWLEDGED';
  acknowledgment_id: string | null;
  desktop_applied_at: Date | null;
  acknowledged_at: Date | null;
}>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeInstant(value: string): string | null {
  if (
    value.length < 20 ||
    value.length > 40 ||
    !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
  ) {
    return null;
  }
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}

function delivery(row: DeliveryRow): IdentityResolutionDelivery {
  return {
    resolutionReference: row.resolution_id,
    localPatientReference: row.local_patient_id,
    localPatientCode: row.local_patient_code,
    sourceRevision: row.source_revision,
    centralPersonId: row.central_person_id,
    chsMedicalId: row.chs_medical_id,
    resolvedAt: row.resolved_at.toISOString(),
  };
}

async function backfillInstallationDeliveries(
  client: PoolClient,
  installationId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO identity_resolution_deliveries (
       resolution_id, installation_id, local_patient_id, local_patient_code,
       source_revision, central_person_id, chs_medical_id, resolved_at,
       delivery_status, created_at, updated_at
     )
     SELECT
       resolution.id,
       review_case.installation_id,
       review_case.local_patient_id,
       source_link.local_patient_code,
       source_link.last_source_revision,
       resolution.resolved_person_id,
       resolution.resolved_chs_medical_id,
       resolution.resolved_at,
       'PENDING',
       resolution.resolved_at,
       resolution.resolved_at
     FROM identity_review_resolutions AS resolution
     JOIN identity_review_cases AS review_case
       ON review_case.id = resolution.review_case_id
     JOIN patient_source_links AS source_link
       ON source_link.installation_id = review_case.installation_id
      AND source_link.local_patient_id = review_case.local_patient_id
      AND source_link.person_id = resolution.resolved_person_id
     WHERE review_case.installation_id = $1
     ON CONFLICT (resolution_id) DO NOTHING`,
    [installationId],
  );
}

export async function enqueueIdentityResolutionDelivery(
  client: PoolClient,
  input: Readonly<{
    resolutionReference: string;
    installationId: string;
    localPatientReference: string;
    localPatientCode: string;
    sourceRevision: number;
    centralPersonId: string;
    chsMedicalId: string;
    resolvedAt: string;
  }>,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO identity_resolution_deliveries AS delivery (
       resolution_id, installation_id, local_patient_id, local_patient_code,
       source_revision, central_person_id, chs_medical_id, resolved_at,
       delivery_status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $8, $8)
     ON CONFLICT (resolution_id) DO UPDATE
       SET resolution_id = delivery.resolution_id
       WHERE delivery.installation_id = EXCLUDED.installation_id
         AND delivery.local_patient_id = EXCLUDED.local_patient_id
         AND delivery.local_patient_code = EXCLUDED.local_patient_code
         AND delivery.source_revision = EXCLUDED.source_revision
         AND delivery.central_person_id = EXCLUDED.central_person_id
         AND delivery.chs_medical_id = EXCLUDED.chs_medical_id
         AND delivery.resolved_at = EXCLUDED.resolved_at
     RETURNING resolution_id`,
    [
      input.resolutionReference,
      input.installationId,
      input.localPatientReference,
      input.localPatientCode,
      input.sourceRevision,
      input.centralPersonId,
      input.chsMedicalId,
      input.resolvedAt,
    ],
  );
  if (result.rowCount !== 1) {
    throw new Error('Identity resolution delivery invariant failed');
  }
}

export async function pullPendingIdentityResolutions(
  database: DeliveryDatabase,
  installation: InstallationContext,
  limit = 50,
  now: Date = new Date(),
): Promise<IdentityResolutionDeliveryPage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new IdentityResolutionDeliveryError(
      'INVALID_IDENTITY_RESOLUTION_LIMIT',
      400,
    );
  }

  const client = await database.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await backfillInstallationDeliveries(client, installation.installationId);
    const result = await client.query<DeliveryRow>(
      `SELECT
         resolution_id,
         local_patient_id,
         local_patient_code,
         source_revision,
         central_person_id,
         chs_medical_id,
         resolved_at
       FROM identity_resolution_deliveries
       WHERE installation_id = $1 AND delivery_status = 'PENDING'
       ORDER BY resolved_at ASC, resolution_id ASC
       LIMIT $2`,
      [installation.installationId, limit + 1],
    );
    await client.query('COMMIT');
    committed = true;
    return {
      contractVersion: '1.0',
      deliveries: result.rows.slice(0, limit).map(delivery),
      hasMore: result.rows.length > limit,
      serverTime: now.toISOString(),
    };
  } catch (error) {
    if (!committed) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function acknowledgeIdentityResolution(
  database: DeliveryDatabase,
  installation: InstallationContext,
  input: IdentityResolutionAcknowledgmentInput,
  now: Date = new Date(),
): Promise<IdentityResolutionAcknowledgment> {
  const appliedAt = normalizeInstant(input.appliedAt);
  if (
    input.contractVersion !== '1.0' ||
    !uuidPattern.test(input.acknowledgmentId) ||
    !uuidPattern.test(input.resolutionReference) ||
    !appliedAt
  ) {
    throw new IdentityResolutionDeliveryError(
      'INVALID_IDENTITY_RESOLUTION_ACKNOWLEDGMENT',
      400,
    );
  }

  const client = await database.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const existing = await client.query<AcknowledgmentRow>(
      `SELECT
         resolution_id,
         delivery_status,
         acknowledgment_id,
         desktop_applied_at,
         acknowledged_at
       FROM identity_resolution_deliveries
       WHERE resolution_id = $1 AND installation_id = $2
       FOR UPDATE`,
      [input.resolutionReference, installation.installationId],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new IdentityResolutionDeliveryError(
        'IDENTITY_RESOLUTION_DELIVERY_NOT_FOUND',
        404,
      );
    }

    if (row.delivery_status === 'ACKNOWLEDGED') {
      if (
        row.acknowledgment_id !== input.acknowledgmentId ||
        row.desktop_applied_at?.toISOString() !== appliedAt ||
        !row.acknowledged_at
      ) {
        throw new IdentityResolutionDeliveryError(
          'IDENTITY_RESOLUTION_ACKNOWLEDGMENT_CONFLICT',
          409,
        );
      }
      await client.query('COMMIT');
      committed = true;
      return {
        contractVersion: '1.0',
        acknowledgmentId: input.acknowledgmentId,
        resolutionReference: input.resolutionReference,
        status: 'ACKNOWLEDGED',
        acknowledgedAt: row.acknowledged_at.toISOString(),
        replayed: true,
      };
    }

    const acknowledgedAt = now.toISOString();
    const update = await client.query(
      `UPDATE identity_resolution_deliveries
       SET delivery_status = 'ACKNOWLEDGED',
           acknowledgment_id = $1,
           desktop_applied_at = $2,
           acknowledged_at = $3,
           updated_at = $3
       WHERE resolution_id = $4
         AND installation_id = $5
         AND delivery_status = 'PENDING'`,
      [
        input.acknowledgmentId,
        appliedAt,
        acknowledgedAt,
        input.resolutionReference,
        installation.installationId,
      ],
    );
    if (update.rowCount !== 1) {
      throw new Error('Identity resolution acknowledgment invariant failed');
    }
    await client.query('COMMIT');
    committed = true;
    return {
      contractVersion: '1.0',
      acknowledgmentId: input.acknowledgmentId,
      resolutionReference: input.resolutionReference,
      status: 'ACKNOWLEDGED',
      acknowledgedAt,
      replayed: false,
    };
  } catch (error) {
    if (!committed) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
