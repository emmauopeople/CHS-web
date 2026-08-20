import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import {
  enrollDesktopInstallation,
  parseDesktopInstallationEnrollmentInput,
} from '../../src/administration/installation-enrollment.js';
import { authenticateInstallation } from '../../src/sync/installation-auth.js';

const connectionString = process.env.DATABASE_TEST_URL;
const runIntegration = connectionString ? describe : describe.skip;
const now = new Date('2026-08-19T12:00:00.000Z');
const token = `chs_inst_v1_${'E'.repeat(43)}`;
const organizationId = '10000000-0000-4000-8000-000000000071';
const locationId = '30000000-0000-4000-8000-000000000071';
const otherOrganizationId = '10000000-0000-4000-8000-000000000072';
const otherLocationId = '30000000-0000-4000-8000-000000000072';
const installationId = '20000000-0000-4000-8000-000000000071';
const sourceLocationId = '32000000-0000-4000-8000-000000000071';

runIntegration('desktop installation enrollment with PostgreSQL', () => {
  const schema = `chs_enrollment_${randomUUID().replaceAll('-', '')}`;
  let administrationPool: pg.Pool;
  let servicePool: pg.Pool;

  beforeAll(async () => {
    administrationPool = new pg.Pool({ connectionString });
    const migrationClient = await administrationPool.connect();
    await migrationClient.query(`CREATE SCHEMA "${schema}"`);
    await migrationClient.query(`SET search_path TO "${schema}"`);
    await migrateWithClient({ client: migrationClient, logger: { info() {} } });
    migrationClient.release();

    servicePool = new pg.Pool({
      connectionString,
      options: `-c search_path=${schema}`,
    });
    await seedOrganizationsAndLocations(servicePool);
  });

  afterAll(async () => {
    await servicePool.end();
    await administrationPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrationPool.end();
  });

  it('atomically enrolls an installation and reveals a usable token once', async () => {
    const ids = [
      '21000000-0000-4000-8000-000000000071',
      '31000000-0000-4000-8000-000000000071',
      '81000000-0000-4000-8000-000000000071',
      '82000000-0000-4000-8000-000000000071',
    ];
    const input = enrollmentInput();
    const result = await enrollDesktopInstallation(servicePool, input, {
      now,
      generateToken: () => token,
      randomId: () => ids.shift()!,
    });

    expect(result).toEqual({
      installationId,
      organizationId,
      configuredLocationId: locationId,
      sourceLocationId,
      credentialId: '21000000-0000-4000-8000-000000000071',
      credentialExpiresAt: '2027-08-19T12:00:00.000Z',
      installationToken: token,
      issuedAt: now.toISOString(),
    });
    await expect(
      authenticateInstallation(servicePool, `Bearer ${token}`, now),
    ).resolves.toEqual({
      installationId,
      organizationId,
      configuredLocationId: locationId,
      timezone: 'Africa/Douala',
    });

    const persisted = await servicePool.query(
      `SELECT
         installation.status,
         credential.token_prefix,
         credential.token_hash,
         credential.status AS credential_status,
         source.source_location_id,
         audit.action_code,
         audit.outcome_code,
         audit.metadata
       FROM desktop_installations AS installation
       JOIN desktop_installation_credentials AS credential
         ON credential.installation_id = installation.id
       JOIN location_source_links AS source
         ON source.installation_id = installation.id
       JOIN audit_events AS audit
         ON audit.entity_id = installation.id
       WHERE installation.id = $1`,
      [installationId],
    );
    expect(persisted.rows[0]).toMatchObject({
      status: 'ACTIVE',
      token_prefix: 'chs_inst_v1_EEEEEEEE',
      credential_status: 'ACTIVE',
      source_location_id: sourceLocationId,
      action_code: 'DESKTOP_INSTALLATION_ENROLL',
      outcome_code: 'SUCCESS',
      metadata: {
        configuredLocationId: locationId,
        credentialId: '21000000-0000-4000-8000-000000000071',
        operatorIdentifier: 'platform-admin@example.test',
        sourceLocationId,
        tokenPrefix: 'chs_inst_v1_EEEEEEEE',
      },
    });
    expect(persisted.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(persisted.rows[0])).not.toContain(token);
  });

  it('does not issue another token when the same enrollment is repeated', async () => {
    await expect(
      enrollDesktopInstallation(servicePool, enrollmentInput(), {
        now,
        generateToken: () => `chs_inst_v1_${'F'.repeat(43)}`,
      }),
    ).rejects.toMatchObject({ code: 'INSTALLATION_ALREADY_ENROLLED' });

    const counts = await servicePool.query(
      `SELECT
         (SELECT count(*)::integer FROM desktop_installations) AS installations,
         (SELECT count(*)::integer FROM desktop_installation_credentials) AS credentials,
         (SELECT count(*)::integer FROM audit_events) AS audit_events`,
    );
    expect(counts.rows[0]).toEqual({
      installations: 1,
      credentials: 1,
      audit_events: 1,
    });
  });

  it('rejects conflicting bindings and rolls the transaction back', async () => {
    await expect(
      enrollDesktopInstallation(
        servicePool,
        { ...enrollmentInput(), configuredLocationId: otherLocationId },
        { now },
      ),
    ).rejects.toMatchObject({ code: 'LOCATION_ORGANIZATION_MISMATCH' });

    const counts = await servicePool.query(
      `SELECT
         (SELECT count(*)::integer FROM desktop_installations) AS installations,
         (SELECT count(*)::integer FROM desktop_installation_credentials) AS credentials`,
    );
    expect(counts.rows[0]).toEqual({ installations: 1, credentials: 1 });
  });

  function enrollmentInput() {
    return parseDesktopInstallationEnrollmentInput(
      {
        installationId,
        organizationId,
        configuredLocationId: locationId,
        sourceLocationId,
        deploymentName: 'Synthetic enrollment desktop',
        timezone: 'Africa/Douala',
        credentialLabel: 'Initial enrollment',
        credentialExpiresAt: '2027-08-19T12:00:00Z',
        operatorIdentifier: 'platform-admin@example.test',
        reasonCode: 'INITIAL_ENROLLMENT',
      },
      now,
    );
  }
});

async function seedOrganizationsAndLocations(pool: pg.Pool) {
  const timestamp = now.toISOString();
  for (const [id, identifier, name] of [
    [organizationId, 'ORG-ENROLL-071', 'Enrollment organization'],
    [otherOrganizationId, 'ORG-ENROLL-072', 'Other organization'],
  ]) {
    await pool.query(
      `INSERT INTO organizations (
         id, identifier_system, identifier_value, name, organization_type_code,
         created_at, updated_at
       ) VALUES ($1, 'https://chs.example/id/organization', $2, $3, 'PROGRAM',
         $4, $4)`,
      [id, identifier, name, timestamp],
    );
  }
  for (const [id, ownerId, identifier, name] of [
    [locationId, organizationId, 'LOC-ENROLL-071', 'Enrollment site'],
    [otherLocationId, otherOrganizationId, 'LOC-ENROLL-072', 'Other site'],
  ]) {
    await pool.query(
      `INSERT INTO locations (
         id, organization_id, identifier_system, identifier_value, name,
         location_type_code, created_at, updated_at
       ) VALUES ($1, $2, 'https://chs.example/id/location', $3, $4,
         'SCREENING_SITE', $5, $5)`,
      [id, ownerId, identifier, name, timestamp],
    );
  }
}
