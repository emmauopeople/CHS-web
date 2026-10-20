import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type {
  InstallationContext,
  SyncBatchRequest,
  ScreeningSessionSyncRecord,
} from '../../src/sync/types.js';
export async function seedInstallation(
  pool: pg.Pool,
  organizationId: string,
  batch: SyncBatchRequest,
): Promise<InstallationContext> {
  const time = '2026-08-01T00:00:00.000Z';
  const location = randomUUID(),
    protocol = randomUUID();
  await pool.query(
    `INSERT INTO organizations(id,identifier_system,identifier_value,name,organization_type_code,created_at,updated_at) VALUES ($1::uuid,'urn:synthetic:org',$1::uuid::text,'Synthetic program','PROGRAM',$2,$2) ON CONFLICT DO NOTHING`,
    [organizationId, time],
  );
  await pool.query(
    `INSERT INTO locations(id,organization_id,identifier_system,identifier_value,name,location_type_code,created_at,updated_at) VALUES ($1::uuid,$2,'urn:synthetic:location',$1::uuid::text,'Synthetic site','SCREENING_SITE',$3,$3)`,
    [location, organizationId, time],
  );
  await pool.query(
    `INSERT INTO desktop_installations(id,organization_id,configured_location_id,deployment_name,timezone,status,enrolled_at,created_at,updated_at) VALUES ($1,$2,$3,'Synthetic desktop','Africa/Douala','ACTIVE',$4,$4,$4)`,
    [batch.installationId, organizationId, location, time],
  );
  await pool.query(
    `INSERT INTO location_source_links(id,location_id,installation_id,organization_id,source_location_id,first_observed_at,last_observed_at) VALUES ($1,$2,$3,$4,$5,$6,$6)`,
    [
      randomUUID(),
      location,
      batch.installationId,
      organizationId,
      batch.locationId,
      time,
    ],
  );
  const session = batch.records.find(
    (r) => r.resourceType === 'SCREENING_SESSION',
  )! as ScreeningSessionSyncRecord;
  if (session.resourceType !== 'SCREENING_SESSION') throw new Error('fixture');
  // Each installation may use the same source protocol; canonical identity is organization scoped.
  const known = await pool.query(
    'SELECT id FROM screening_protocols WHERE organization_id=$1',
    [organizationId],
  );
  const canonicalProtocol =
    (known.rows[0]?.id as string | undefined) ?? protocol;
  if (!known.rows.length)
    await pool.query(
      `INSERT INTO screening_protocols(id,organization_id,protocol_key,version_label,checksum,status,effective_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,$6,$6)`,
      [
        canonicalProtocol,
        organizationId,
        session.payload.protocolKey,
        session.payload.protocolVersionLabel,
        session.payload.protocolChecksum,
        time,
      ],
    );
  await pool.query(
    `INSERT INTO protocol_source_links(id,protocol_id,installation_id,organization_id,local_protocol_version_id,first_observed_at,last_observed_at) VALUES ($1,$2,$3,$4,$5,$6,$6)`,
    [
      randomUUID(),
      canonicalProtocol,
      batch.installationId,
      organizationId,
      session.payload.localProtocolVersionId,
      time,
    ],
  );
  return {
    installationId: batch.installationId,
    organizationId,
    configuredLocationId: location,
    timezone: 'Africa/Douala',
  };
}
