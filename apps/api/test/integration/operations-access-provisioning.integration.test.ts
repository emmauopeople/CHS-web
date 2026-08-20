import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import {
  parseOperationsAccessProvisioningInput,
  provisionOperationsAccess,
} from '../../src/administration/operations-access-provisioning.js';
import {
  authorizeIdentityReview,
  authorizeMedicalIdRecovery,
  authorizePatientRead,
  authorizeSyncMonitoring,
} from '../../src/operations/access.js';

const connectionString = process.env.DATABASE_TEST_URL;
const runIntegration = connectionString ? describe : describe.skip;
const now = new Date('2026-08-20T12:00:00.000Z');
const organizationId = '10000000-0000-4000-8000-000000000101';
const secondOrganizationId = '10000000-0000-4000-8000-000000000102';
const inactiveOrganizationId = '10000000-0000-4000-8000-000000000103';
const operationsUserId = '90000000-0000-4000-8000-000000000101';
const identityReviewGrantId = '91000000-0000-4000-8000-000000000101';
const recoveryGrantId = '91000000-0000-4000-8000-000000000102';
const patientGrantId = '91000000-0000-4000-8000-000000000103';
const monitoringGrantId = '91000000-0000-4000-8000-000000000104';
const identity = {
  issuer: 'https://identity.example.test/',
  subject: 'operations-user-101',
  sessionId: 'session-101',
  authorizedParty: 'chs-operations-web',
};

runIntegration('operations access provisioning with PostgreSQL', () => {
  const schema = `chs_operations_access_${randomUUID().replaceAll('-', '')}`;
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
    await seedOrganizations(servicePool);
  });

  afterAll(async () => {
    await servicePool.end();
    await administrationPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrationPool.end();
  });

  it('atomically provisions a principal and immediately effective grants', async () => {
    const ids = [
      operationsUserId,
      identityReviewGrantId,
      recoveryGrantId,
      patientGrantId,
      monitoringGrantId,
      '81000000-0000-4000-8000-000000000101',
      '82000000-0000-4000-8000-000000000101',
    ];
    const result = await provisionOperationsAccess(servicePool, initialInput(), {
      now,
      randomId: () => ids.shift()!,
    });

    expect(result).toEqual({
      kind: 'PROVISIONED',
      operationsUserId,
      userCreated: true,
      grants: [
        {
          grantId: identityReviewGrantId,
          permissionCode: 'IDENTITY_REVIEW',
          scopeKind: 'ORGANIZATION',
          organizationId,
          expiresAt: null,
          created: true,
        },
        {
          grantId: recoveryGrantId,
          permissionCode: 'MEDICAL_ID_RECOVER',
          scopeKind: 'ORGANIZATION',
          organizationId,
          expiresAt: null,
          created: true,
        },
        {
          grantId: patientGrantId,
          permissionCode: 'PATIENT_READ',
          scopeKind: 'GLOBAL',
          organizationId: null,
          expiresAt: null,
          created: true,
        },
        {
          grantId: monitoringGrantId,
          permissionCode: 'SYNC_MONITOR',
          scopeKind: 'ORGANIZATION',
          organizationId,
          expiresAt: null,
          created: true,
        },
      ],
      processedAt: now.toISOString(),
    });
    await expect(authorizePatientRead(servicePool, identity, now)).resolves.toMatchObject({
      operationsUserId,
      patientAccessScope: { kind: 'GLOBAL' },
    });
    await expect(
      authorizeMedicalIdRecovery(servicePool, identity, now),
    ).resolves.toMatchObject({
      operationsUserId,
      patientAccessScope: { kind: 'ORGANIZATIONS', organizationIds: [organizationId] },
    });
    await expect(
      authorizeIdentityReview(servicePool, identity, now),
    ).resolves.toMatchObject({
      operationsUserId,
      patientAccessScope: { kind: 'ORGANIZATIONS', organizationIds: [organizationId] },
    });
    await expect(
      authorizeSyncMonitoring(servicePool, identity, now),
    ).resolves.toMatchObject({
      operationsUserId,
      patientAccessScope: { kind: 'ORGANIZATIONS', organizationIds: [organizationId] },
    });

    const audit = await servicePool.query(
      `SELECT action_code, entity_type, entity_id, operations_user_id, metadata
       FROM audit_events
       WHERE action_code = 'OPERATIONS_ACCESS_PROVISION'`,
    );
    expect(audit.rows[0]).toMatchObject({
      action_code: 'OPERATIONS_ACCESS_PROVISION',
      entity_type: 'OPERATIONS_USER',
      entity_id: operationsUserId,
      operations_user_id: null,
      metadata: {
        operationsUserId,
        operatorIdentifier: 'platform-admin@example.test',
        userCreated: true,
      },
    });
    expect(audit.rows[0].metadata.principalFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(audit.rows[0].metadata.createdGrants).toHaveLength(4);
    expect(JSON.stringify(audit.rows[0])).not.toContain(identity.subject);
    expect(JSON.stringify(audit.rows[0])).not.toContain(identity.issuer);
  });

  it('returns exact existing IDs without duplicate rows or audit', async () => {
    await expect(
      provisionOperationsAccess(servicePool, initialInput(), {
        now: new Date('2026-08-20T12:30:00.000Z'),
        randomId: () => {
          throw new Error('Exact retry must not allocate IDs');
        },
      }),
    ).resolves.toMatchObject({
      kind: 'ALREADY_PROVISIONED',
      operationsUserId,
      userCreated: false,
      grants: [
        { grantId: identityReviewGrantId, created: false },
        { grantId: recoveryGrantId, created: false },
        { grantId: patientGrantId, created: false },
        { grantId: monitoringGrantId, created: false },
      ],
    });
    expect(await counts()).toEqual({ users: 1, grants: 4, audits: 1 });
  });

  it('adds another organization grant to the exact existing principal', async () => {
    const ids = [
      '91000000-0000-4000-8000-000000000104',
      '81000000-0000-4000-8000-000000000102',
      '82000000-0000-4000-8000-000000000102',
    ];
    const input = parseOperationsAccessProvisioningInput(
      {
        ...basePrincipal(),
        grants: [
          {
            permissionCode: 'MEDICAL_ID_RECOVER',
            scopeKind: 'ORGANIZATION',
            organizationId: secondOrganizationId,
            expiresAt: null,
          },
        ],
        reasonCode: 'ADD_ORGANIZATION_SCOPE',
      },
      now,
    );
    await expect(
      provisionOperationsAccess(servicePool, input, {
        now: new Date('2026-08-20T13:00:00.000Z'),
        randomId: () => ids.shift()!,
      }),
    ).resolves.toMatchObject({ kind: 'PROVISIONED', userCreated: false });
    await expect(
      authorizeMedicalIdRecovery(servicePool, identity, now),
    ).resolves.toMatchObject({
      patientAccessScope: {
        kind: 'ORGANIZATIONS',
        organizationIds: [organizationId, secondOrganizationId],
      },
    });
    expect(await counts()).toEqual({ users: 1, grants: 5, audits: 2 });
  });

  it('rejects principal changes, incompatible scopes, and inactive organizations', async () => {
    const before = await counts();
    await expect(
      provisionOperationsAccess(servicePool, {
        ...initialInput(),
        displayName: 'Changed Display Name',
      }),
    ).rejects.toMatchObject({ code: 'OPERATIONS_PRINCIPAL_CONFLICT' });

    const organizationPatientGrant = parseOperationsAccessProvisioningInput(
      {
        ...basePrincipal(),
        grants: [
          {
            permissionCode: 'PATIENT_READ',
            scopeKind: 'ORGANIZATION',
            organizationId,
            expiresAt: null,
          },
        ],
      },
      now,
    );
    await expect(
      provisionOperationsAccess(servicePool, organizationPatientGrant),
    ).rejects.toMatchObject({ code: 'ACCESS_GRANT_SCOPE_CONFLICT' });

    const inactiveGrant = parseOperationsAccessProvisioningInput(
      {
        ...basePrincipal(),
        grants: [
          {
            permissionCode: 'SYNC_MONITOR',
            scopeKind: 'ORGANIZATION',
            organizationId: inactiveOrganizationId,
            expiresAt: null,
          },
        ],
      },
      now,
    );
    await expect(
      provisionOperationsAccess(servicePool, inactiveGrant),
    ).rejects.toMatchObject({ code: 'ORGANIZATION_INACTIVE' });
    expect(await counts()).toEqual(before);
  });

  function basePrincipal() {
    return {
      oidcIssuer: identity.issuer,
      oidcSubject: identity.subject,
      displayName: 'Operations Nurse',
      email: 'operations.nurse@example.test',
      operatorIdentifier: 'platform-admin@example.test',
      reasonCode: 'INITIAL_ACCESS',
    };
  }

  function initialInput() {
    return parseOperationsAccessProvisioningInput(
      {
        ...basePrincipal(),
        grants: [
          {
            permissionCode: 'IDENTITY_REVIEW',
            scopeKind: 'ORGANIZATION',
            organizationId,
            expiresAt: null,
          },
          {
            permissionCode: 'PATIENT_READ',
            scopeKind: 'GLOBAL',
            organizationId: null,
            expiresAt: null,
          },
          {
            permissionCode: 'MEDICAL_ID_RECOVER',
            scopeKind: 'ORGANIZATION',
            organizationId,
            expiresAt: null,
          },
          {
            permissionCode: 'SYNC_MONITOR',
            scopeKind: 'ORGANIZATION',
            organizationId,
            expiresAt: null,
          },
        ],
      },
      now,
    );
  }

  async function counts() {
    const result = await servicePool.query(
      `SELECT
         (SELECT count(*)::integer FROM operations_users) AS users,
         (SELECT count(*)::integer FROM operations_access_grants) AS grants,
         (SELECT count(*)::integer FROM audit_events) AS audits`,
    );
    return result.rows[0];
  }
});

async function seedOrganizations(pool: pg.Pool) {
  const timestamp = now.toISOString();
  for (const [id, identifier, active] of [
    [organizationId, 'ORG-OPS-101', true],
    [secondOrganizationId, 'ORG-OPS-102', true],
    [inactiveOrganizationId, 'ORG-OPS-103', false],
  ] as const) {
    await pool.query(
      `INSERT INTO organizations (
         id, identifier_system, identifier_value, name, organization_type_code,
         active, created_at, updated_at
       ) VALUES ($1, 'https://chs.example/id/organization', $2, $2,
         'SCREENING_PROGRAM', $3, $4, $4)`,
      [id, identifier, active, timestamp],
    );
  }
}
