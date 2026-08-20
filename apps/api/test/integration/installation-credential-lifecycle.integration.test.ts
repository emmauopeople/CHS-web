import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import {
  parseRevokeInstallationCredentialInput,
  parseRotateInstallationCredentialInput,
  revokeInstallationCredential,
  rotateInstallationCredential,
} from '../../src/administration/installation-credential-lifecycle.js';
import {
  enrollDesktopInstallation,
  parseDesktopInstallationEnrollmentInput,
} from '../../src/administration/installation-enrollment.js';
import { authenticateInstallation } from '../../src/sync/installation-auth.js';

const connectionString = process.env.DATABASE_TEST_URL;
const runIntegration = connectionString ? describe : describe.skip;
const enrollmentTime = new Date('2026-08-19T12:00:00.000Z');
const rotationTime = new Date('2026-08-19T13:00:00.000Z');
const revocationTime = new Date('2026-08-19T14:00:00.000Z');
const originalToken = `chs_inst_v1_${'E'.repeat(43)}`;
const rotatedToken = `chs_inst_v1_${'R'.repeat(43)}`;
const organizationId = '10000000-0000-4000-8000-000000000081';
const locationId = '30000000-0000-4000-8000-000000000081';
const installationId = '20000000-0000-4000-8000-000000000081';
const sourceLocationId = '32000000-0000-4000-8000-000000000081';
const originalCredentialId = '21000000-0000-4000-8000-000000000081';
const rotatedCredentialId = '21000000-0000-4000-8000-000000000082';

runIntegration('installation credential lifecycle with PostgreSQL', () => {
  const schema = `chs_credential_${randomUUID().replaceAll('-', '')}`;
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
    await seedCanonicalContext(servicePool);
    const enrollmentIds = [
      originalCredentialId,
      '31000000-0000-4000-8000-000000000081',
      '81000000-0000-4000-8000-000000000081',
      '82000000-0000-4000-8000-000000000081',
    ];
    await enrollDesktopInstallation(servicePool, enrollmentInput(), {
      now: enrollmentTime,
      generateToken: () => originalToken,
      randomId: () => enrollmentIds.shift()!,
    });
  });

  afterAll(async () => {
    await servicePool.end();
    await administrationPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrationPool.end();
  });

  it('atomically replaces the sole expected credential and redacts its audit', async () => {
    const rotationIds = [
      rotatedCredentialId,
      '81000000-0000-4000-8000-000000000082',
      '82000000-0000-4000-8000-000000000082',
    ];
    const result = await rotateInstallationCredential(
      servicePool,
      rotationInput(),
      {
        now: rotationTime,
        generateToken: () => rotatedToken,
        randomId: () => rotationIds.shift()!,
      },
    );

    expect(result).toEqual({
      installationId,
      replacedCredentialId: originalCredentialId,
      credentialId: rotatedCredentialId,
      credentialExpiresAt: '2027-08-19T13:00:00.000Z',
      installationToken: rotatedToken,
      issuedAt: rotationTime.toISOString(),
    });
    await expect(
      authenticateInstallation(servicePool, `Bearer ${originalToken}`, rotationTime),
    ).rejects.toMatchObject({ code: 'INVALID_INSTALLATION_TOKEN' });
    await expect(
      authenticateInstallation(servicePool, `Bearer ${rotatedToken}`, rotationTime),
    ).resolves.toMatchObject({ installationId });

    const credentials = await servicePool.query(
      `SELECT id, status, revoked_at, token_hash
       FROM desktop_installation_credentials
       ORDER BY issued_at, id`,
    );
    expect(credentials.rows).toMatchObject([
      { id: originalCredentialId, status: 'REVOKED', revoked_at: rotationTime },
      { id: rotatedCredentialId, status: 'ACTIVE', revoked_at: null },
    ]);
    const audit = await servicePool.query(
      `SELECT action_code, metadata
       FROM audit_events
       WHERE action_code = 'DESKTOP_INSTALLATION_CREDENTIAL_ROTATE'`,
    );
    expect(audit.rows[0]).toEqual({
      action_code: 'DESKTOP_INSTALLATION_CREDENTIAL_ROTATE',
      metadata: {
        credentialId: rotatedCredentialId,
        operatorIdentifier: 'platform-admin@example.test',
        replacedCredentialId: originalCredentialId,
        replacedTokenPrefix: 'chs_inst_v1_EEEEEEEE',
        tokenPrefix: 'chs_inst_v1_RRRRRRRR',
      },
    });
    expect(JSON.stringify({ credentials: credentials.rows, audit: audit.rows })).not.toContain(
      rotatedToken,
    );
  });

  it('rejects a stale expected credential without changing the active token', async () => {
    const before = await credentialCounts();
    await expect(
      rotateInstallationCredential(servicePool, rotationInput(), {
        now: new Date('2026-08-19T13:30:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_STATE_CONFLICT' });
    expect(await credentialCounts()).toEqual(before);
    await expect(
      authenticateInstallation(servicePool, `Bearer ${rotatedToken}`, rotationTime),
    ).resolves.toMatchObject({ installationId });
  });

  it('requires an active installation for rotation', async () => {
    await servicePool.query(
      `UPDATE desktop_installations
       SET status = 'SUSPENDED', updated_at = $1
       WHERE id = $2`,
      [rotationTime.toISOString(), installationId],
    );
    await expect(
      rotateInstallationCredential(
        servicePool,
        {
          ...rotationInput(),
          expectedCredentialId: rotatedCredentialId,
        },
        { now: new Date('2026-08-19T13:45:00.000Z') },
      ),
    ).rejects.toMatchObject({ code: 'INSTALLATION_NOT_ACTIVE' });
    await servicePool.query(
      `UPDATE desktop_installations
       SET status = 'ACTIVE', updated_at = $1
       WHERE id = $2`,
      [revocationTime.toISOString(), installationId],
    );
  });

  it('revokes a credential once and makes repeated revocation idempotent', async () => {
    const revocationIds = [
      '81000000-0000-4000-8000-000000000083',
      '82000000-0000-4000-8000-000000000083',
    ];
    const input = revocationInput();
    await expect(
      revokeInstallationCredential(servicePool, input, {
        now: revocationTime,
        randomId: () => revocationIds.shift()!,
      }),
    ).resolves.toEqual({
      kind: 'REVOKED',
      installationId,
      credentialId: rotatedCredentialId,
      revokedAt: revocationTime.toISOString(),
    });
    await expect(
      authenticateInstallation(servicePool, `Bearer ${rotatedToken}`, revocationTime),
    ).rejects.toMatchObject({ code: 'INVALID_INSTALLATION_TOKEN' });

    await expect(
      revokeInstallationCredential(servicePool, input, {
        now: new Date('2026-08-19T15:00:00.000Z'),
      }),
    ).resolves.toEqual({
      kind: 'ALREADY_REVOKED',
      installationId,
      credentialId: rotatedCredentialId,
      revokedAt: revocationTime.toISOString(),
    });
    const audit = await servicePool.query(
      `SELECT metadata
       FROM audit_events
       WHERE action_code = 'DESKTOP_INSTALLATION_CREDENTIAL_REVOKE'`,
    );
    expect(audit.rows).toEqual([
      {
        metadata: {
          credentialId: rotatedCredentialId,
          operatorIdentifier: 'platform-admin@example.test',
          tokenPrefix: 'chs_inst_v1_RRRRRRRR',
        },
      },
    ]);
  });

  function enrollmentInput() {
    return parseDesktopInstallationEnrollmentInput(
      {
        installationId,
        organizationId,
        configuredLocationId: locationId,
        sourceLocationId,
        deploymentName: 'Credential lifecycle desktop',
        timezone: 'Africa/Douala',
        credentialLabel: 'Initial enrollment',
        credentialExpiresAt: '2027-08-19T12:00:00Z',
        operatorIdentifier: 'platform-admin@example.test',
        reasonCode: 'INITIAL_ENROLLMENT',
      },
      enrollmentTime,
    );
  }

  function rotationInput() {
    return parseRotateInstallationCredentialInput(
      {
        installationId,
        expectedCredentialId: originalCredentialId,
        credentialLabel: 'Scheduled replacement',
        credentialExpiresAt: '2027-08-19T13:00:00Z',
        operatorIdentifier: 'platform-admin@example.test',
        reasonCode: 'SCHEDULED_ROTATION',
      },
      rotationTime,
    );
  }

  function revocationInput() {
    return parseRevokeInstallationCredentialInput({
      installationId,
      credentialId: rotatedCredentialId,
      operatorIdentifier: 'platform-admin@example.test',
      reasonCode: 'DEVICE_RETIRED',
      confirmation: 'REVOKE_INSTALLATION_CREDENTIAL',
    });
  }

  async function credentialCounts() {
    const result = await servicePool.query(
      `SELECT
         count(*)::integer AS total,
         count(*) FILTER (WHERE status = 'ACTIVE')::integer AS active
       FROM desktop_installation_credentials`,
    );
    return result.rows[0];
  }
});

async function seedCanonicalContext(pool: pg.Pool) {
  const timestamp = enrollmentTime.toISOString();
  await pool.query(
    `INSERT INTO organizations (
       id, identifier_system, identifier_value, name, organization_type_code,
       created_at, updated_at
     ) VALUES ($1, 'https://chs.example/id/organization', 'ORG-CREDENTIAL-081',
       'Credential lifecycle organization', 'PROGRAM', $2, $2)`,
    [organizationId, timestamp],
  );
  await pool.query(
    `INSERT INTO locations (
       id, organization_id, identifier_system, identifier_value, name,
       location_type_code, created_at, updated_at
     ) VALUES ($1, $2, 'https://chs.example/id/location', 'LOC-CREDENTIAL-081',
       'Credential lifecycle site', 'SCREENING_SITE', $3, $3)`,
    [locationId, organizationId, timestamp],
  );
}
