import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import { canonicalJsonSha256 } from './canonical-json.js';
import type {
  InstallationContext,
  SyncActorSnapshot,
  SyncBatchRequest,
} from './types.js';

type IntakeDatabase = Pick<Pool, 'connect'>;

type ExistingBatchRow = Readonly<{
  id: string;
  payload_hash: string;
  status: string;
  response_body: unknown | null;
}>;

type InstallationRow = Readonly<{
  configured_location_id: string;
  timezone: string;
}>;

type LocationRow = Readonly<{ location_id: string }>;

type PractitionerLinkRow = Readonly<{
  id: string;
  practitioner_id: string;
  source_display_name: string;
  source_role_code: string;
  source_active: boolean;
  source_updated_at: Date;
}>;

export type SyncBatchIntakeResult =
  | Readonly<{
      kind: 'NEW';
      batchInternalId: string;
      payloadHash: string;
    }>
  | Readonly<{
      kind: 'IN_PROGRESS';
      batchInternalId: string;
    }>
  | Readonly<{
      kind: 'RECOVERY_REQUIRED';
      batchInternalId: string;
    }>
  | Readonly<{
      kind: 'REPLAY';
      batchInternalId: string;
      response: unknown;
    }>;

export type SyncBatchIntakeErrorCode =
  | 'INSTALLATION_CONTEXT_MISMATCH'
  | 'INSTALLATION_NOT_ACTIVE'
  | 'LOCATION_NOT_ENROLLED'
  | 'INSTALLATION_TIMEZONE_MISMATCH'
  | 'BATCH_PAYLOAD_MISMATCH';

export class SyncBatchIntakeError extends Error {
  constructor(readonly code: SyncBatchIntakeErrorCode) {
    super('Synchronization batch intake failed');
    this.name = 'SyncBatchIntakeError';
  }
}

function assertEnvelopeContext(
  context: InstallationContext,
  request: SyncBatchRequest,
) {
  if (context.installationId !== request.installationId) {
    throw new SyncBatchIntakeError('INSTALLATION_CONTEXT_MISMATCH');
  }
  if (context.timezone !== request.installationTimezone) {
    throw new SyncBatchIntakeError('INSTALLATION_TIMEZONE_MISMATCH');
  }
}

export function syncBatchPayloadHash(request: SyncBatchRequest): string {
  return canonicalJsonSha256({
    ...request,
    actors: [...request.actors].sort((left, right) =>
      left.localActorId.localeCompare(right.localActorId),
    ),
    records: [...request.records].sort((left, right) =>
      left.recordId.localeCompare(right.recordId),
    ),
  });
}

async function resolveLocation(
  client: PoolClient,
  context: InstallationContext,
  request: SyncBatchRequest,
): Promise<string> {
  const result = await client.query<LocationRow>(
    `SELECT location_id
     FROM location_source_links
     WHERE installation_id = $1
       AND organization_id = $2
       AND source_location_id = $3
       AND location_id = $4`,
    [
      context.installationId,
      context.organizationId,
      request.locationId,
      context.configuredLocationId,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new SyncBatchIntakeError('LOCATION_NOT_ENROLLED');
  }
  return row.location_id;
}

async function upsertActor(
  client: PoolClient,
  context: InstallationContext,
  batchInternalId: string,
  actor: SyncActorSnapshot,
  receivedAt: string,
): Promise<string> {
  const existingResult = await client.query<PractitionerLinkRow>(
    `SELECT
       id,
       practitioner_id,
       source_display_name,
       source_role_code,
       source_active,
       source_updated_at
     FROM practitioner_source_links
     WHERE installation_id = $1 AND source_actor_local_id = $2
     FOR UPDATE`,
    [context.installationId, actor.localActorId],
  );

  let link = existingResult.rows[0];
  if (!link) {
    const practitionerId = randomUUID();
    const linkId = randomUUID();
    await client.query(
      `INSERT INTO practitioners (
         id, display_name, active, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $4)`,
      [practitionerId, actor.displayName, actor.active, receivedAt],
    );
    await client.query(
      `INSERT INTO practitioner_source_links (
         id, practitioner_id, installation_id, source_actor_local_id,
         source_display_name, source_role_code, source_active, source_updated_at,
         first_observed_at, last_observed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
      [
        linkId,
        practitionerId,
        context.installationId,
        actor.localActorId,
        actor.displayName,
        actor.role,
        actor.active,
        actor.updatedAt,
        receivedAt,
      ],
    );
    link = {
      id: linkId,
      practitioner_id: practitionerId,
      source_display_name: actor.displayName,
      source_role_code: actor.role,
      source_active: actor.active,
      source_updated_at: new Date(actor.updatedAt),
    };
  } else if (new Date(actor.updatedAt) >= link.source_updated_at) {
    await client.query(
      `UPDATE practitioners
       SET display_name = $1,
           active = $2,
           updated_at = GREATEST(updated_at, $3::timestamptz)
       WHERE id = $4`,
      [actor.displayName, actor.active, receivedAt, link.practitioner_id],
    );
    await client.query(
      `UPDATE practitioner_source_links
       SET source_display_name = $1,
           source_role_code = $2,
           source_active = $3,
           source_updated_at = $4,
           last_observed_at = GREATEST(last_observed_at, $5::timestamptz)
       WHERE id = $6`,
      [
        actor.displayName,
        actor.role,
        actor.active,
        actor.updatedAt,
        receivedAt,
        link.id,
      ],
    );
  } else {
    await client.query(
      `UPDATE practitioner_source_links
       SET last_observed_at = GREATEST(last_observed_at, $1::timestamptz)
       WHERE id = $2`,
      [receivedAt, link.id],
    );
  }

  const syncBatchActorId = randomUUID();
  await client.query(
    `INSERT INTO sync_batch_actors (
       id, batch_internal_id, installation_id, source_actor_local_id,
       practitioner_source_link_id, practitioner_id, source_display_name,
       source_role_code, source_active, source_updated_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      syncBatchActorId,
      batchInternalId,
      context.installationId,
      actor.localActorId,
      link.id,
      link.practitioner_id,
      actor.displayName,
      actor.role,
      actor.active,
      actor.updatedAt,
      receivedAt,
    ],
  );
  return syncBatchActorId;
}

export async function beginSyncBatch(
  database: IntakeDatabase,
  context: InstallationContext,
  request: SyncBatchRequest,
  now: Date = new Date(),
): Promise<SyncBatchIntakeResult> {
  assertEnvelopeContext(context, request);
  const payloadHash = syncBatchPayloadHash(request);
  const receivedAt = now.toISOString();
  const client = await database.connect();

  try {
    await client.query('BEGIN');

    const installationResult = await client.query<InstallationRow>(
      `SELECT configured_location_id, timezone
       FROM desktop_installations
       WHERE id = $1 AND organization_id = $2 AND status = 'ACTIVE'
       FOR UPDATE`,
      [context.installationId, context.organizationId],
    );
    const installation = installationResult.rows[0];
    if (!installation) {
      throw new SyncBatchIntakeError('INSTALLATION_NOT_ACTIVE');
    }
    if (
      installation.configured_location_id !== context.configuredLocationId ||
      installation.timezone !== context.timezone
    ) {
      throw new SyncBatchIntakeError('INSTALLATION_CONTEXT_MISMATCH');
    }

    const existingResult = await client.query<ExistingBatchRow>(
      `SELECT id, payload_hash, status, response_body
       FROM sync_batches
       WHERE installation_id = $1 AND batch_id = $2
       FOR UPDATE`,
      [context.installationId, request.batchId],
    );
    const existing = existingResult.rows[0];
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        throw new SyncBatchIntakeError('BATCH_PAYLOAD_MISMATCH');
      }
      await client.query('COMMIT');
      if (existing.response_body !== null) {
        return {
          kind: 'REPLAY',
          batchInternalId: existing.id,
          response: existing.response_body,
        };
      }
      return {
        kind: existing.status === 'PROCESSING' ? 'IN_PROGRESS' : 'RECOVERY_REQUIRED',
        batchInternalId: existing.id,
      };
    }

    const locationId = await resolveLocation(client, context, request);
    const batchInternalId = randomUUID();
    await client.query(
      `INSERT INTO sync_batches (
         id, installation_id, organization_id, batch_id, location_id,
         source_location_id, contract_version, desktop_application_version,
         desktop_schema_version, source_created_at, received_at, payload_hash,
         status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         'PROCESSING')`,
      [
        batchInternalId,
        context.installationId,
        context.organizationId,
        request.batchId,
        locationId,
        request.locationId,
        request.contractVersion,
        request.desktopApplicationVersion,
        request.desktopSchemaVersion,
        request.createdAt,
        receivedAt,
        payloadHash,
      ],
    );

    for (const actor of request.actors) {
      await upsertActor(client, context, batchInternalId, actor, receivedAt);
    }

    await client.query('COMMIT');
    return { kind: 'NEW', batchInternalId, payloadHash };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
