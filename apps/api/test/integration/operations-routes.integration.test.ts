import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import { buildApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import {
  OperationsAuthenticationError,
  type OperationsTokenVerifier,
} from '../../src/operations/authentication.js';

const connectionString = process.env.DATABASE_TEST_URL;
const runIntegration = connectionString ? describe : describe.skip;
const issuer = 'https://identity.example.test/';
const org1 = '11000000-0000-4000-8000-000000000001';
const org2 = '11000000-0000-4000-8000-000000000002';
const patient1 = '41000000-0000-4000-8000-000000000001';
const patient2 = '41000000-0000-4000-8000-000000000002';
const orgUser = '91000000-0000-4000-8000-000000000001';
const globalUser = '91000000-0000-4000-8000-000000000002';
const deniedUser = '91000000-0000-4000-8000-000000000003';
const now = '2026-08-20T12:00:00.000Z';

const config: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
  databaseUrl: 'postgresql://unused',
  databasePoolMax: 4,
  buildCommit: 'operations-route-test',
  buildTime: now,
  trustedProxyCidrs: [],
  operationsOidc: null,
};

const identities = new Map([
  ['org-token', 'org-user'],
  ['global-token', 'global-user'],
  ['denied-token', 'denied-user'],
  ['unknown-token', 'unknown-user'],
]);

const tokenVerifier: OperationsTokenVerifier = {
  async verify(header) {
    if (!header) {
      throw new OperationsAuthenticationError('OPERATIONS_TOKEN_REQUIRED', 401);
    }
    const token = /^Bearer ([^\s]+)$/.exec(header)?.[1];
    const subject = token ? identities.get(token) : undefined;
    if (!subject) {
      throw new OperationsAuthenticationError('INVALID_OPERATIONS_TOKEN', 401);
    }
    return {
      issuer,
      subject,
      sessionId: `session-${subject}`,
      authorizedParty: 'operations-web',
    };
  },
};

runIntegration('audited operations patient routes', () => {
  const schema = `chs_operations_routes_${randomUUID().replaceAll('-', '')}`;
  let administrationPool: pg.Pool;
  let servicePool: pg.Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;

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
    await seed(servicePool);
    app = await buildApp({
      config,
      database: {
        pool: servicePool,
        check: async () => undefined,
        close: async () => undefined,
      },
      operationsTokenVerifier: tokenVerifier,
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (servicePool) await servicePool.end();
    await administrationPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrationPool.end();
  });

  it('requires a reason and valid bearer token without placing PHI in the URL', async () => {
    const missingReason = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/patients/search',
      headers: { authorization: 'Bearer org-token' },
      payload: {},
    });
    expect(missingReason.statusCode).toBe(400);

    const missingToken = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/patients/search',
      payload: { reasonCode: 'CARE_DELIVERY' },
    });
    expect(missingToken.statusCode).toBe(401);
    expect(missingToken.headers['www-authenticate']).toBe('Bearer');
    expect(missingToken.json()).toMatchObject({
      code: 'OPERATIONS_AUTHENTICATION_FAILED',
    });

    const getAttempt = await app.inject({
      method: 'GET',
      url: '/api/v1/operations/patients/search?search=Alpha',
    });
    expect(getAttempt.statusCode).toBe(404);
  });

  it('derives organization scope from grants and records a redacted success audit', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/patients/search',
      headers: {
        authorization: 'Bearer org-token',
        'user-agent': 'CHS Operations Integration Test',
      },
      remoteAddress: '192.0.2.10',
      payload: {
        reasonCode: 'CARE_COORDINATION',
        search: 'Alpha',
        page: 1,
        pageSize: 25,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      totalItems: 1,
      items: [{ personId: patient1, chsMedicalId: 'CHS-AAAA-BBBB-CCCC' }],
    });

    const audit = await servicePool.query<{
      operations_user_id: string;
      action_code: string;
      reason_code: string;
      outcome_code: string;
      request_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT operations_user_id, action_code, reason_code, outcome_code,
              request_id, metadata
       FROM audit_events
       WHERE request_id = $1`,
      [response.headers['x-request-id']],
    );
    expect(audit.rows[0]).toMatchObject({
      operations_user_id: orgUser,
      action_code: 'PATIENT_LIST_VIEW',
      reason_code: 'CARE_COORDINATION',
      outcome_code: 'SUCCESS',
      metadata: {
        scopeKind: 'ORGANIZATIONS',
        organizationIds: [org1],
        sourceIp: '192.0.2.10',
        resultCount: 1,
        hasSearch: true,
      },
    });
    expect(JSON.stringify(audit.rows[0]?.metadata)).not.toContain('Alpha');
    expect(JSON.stringify(audit.rows[0]?.metadata)).not.toContain(
      'CHS-AAAA-BBBB-CCCC',
    );
  });

  it('returns scoped not-found results and audits the targeted read', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/patients/detail',
      headers: { authorization: 'Bearer org-token' },
      payload: {
        reasonCode: 'PATIENT_REQUEST',
        personId: patient2,
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('Beta Example');

    const audit = await servicePool.query(
      `SELECT operations_user_id, entity_id, outcome_code, reason_code
       FROM audit_events
       WHERE request_id = $1`,
      [response.headers['x-request-id']],
    );
    expect(audit.rows[0]).toMatchObject({
      operations_user_id: orgUser,
      entity_id: patient2,
      outcome_code: 'NOT_FOUND',
      reason_code: 'PATIENT_REQUEST',
    });
  });

  it('allows an explicit global grant without accepting client-provided scope', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/patients/search',
      headers: { authorization: 'Bearer global-token' },
      payload: {
        reasonCode: 'QUALITY_IMPROVEMENT',
        pageSize: 10,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { personId: string }) => item.personId)).toEqual([
      patient1,
      patient2,
    ]);

    const injectedScope = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/patients/search',
      headers: { authorization: 'Bearer org-token' },
      payload: {
        reasonCode: 'CARE_DELIVERY',
        organizationIds: [org2],
      },
    });
    expect(injectedScope.statusCode).toBe(400);
  });

  it('denies unenrolled and ungranted identities and durably audits both', async () => {
    for (const token of ['denied-token', 'unknown-token']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/operations/patients/search',
        headers: { authorization: `Bearer ${token}` },
        payload: { reasonCode: 'OPERATIONS_SUPPORT' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'OPERATIONS_ACCESS_DENIED' });
    }

    const audits = await servicePool.query<{
      operations_user_id: string | null;
      outcome_code: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT operations_user_id, outcome_code, metadata
       FROM audit_events
       WHERE outcome_code = 'DENIED'
       ORDER BY occurred_at, id`,
    );
    expect(audits.rows).toHaveLength(2);
    expect(audits.rows.map((row) => row.operations_user_id)).toEqual(
      expect.arrayContaining([deniedUser, null]),
    );
    for (const audit of audits.rows) {
      expect(audit.metadata.principalFingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

async function seed(pool: pg.Pool) {
  for (const [organizationId, suffix] of [
    [org1, 'One'],
    [org2, 'Two'],
  ]) {
    await pool.query(
      `INSERT INTO organizations (
         id, identifier_system, identifier_value, name, organization_type_code,
         created_at, updated_at
       ) VALUES ($1, 'urn:synthetic:organization', $2, $3, 'PROGRAM', $4, $4)`,
      [organizationId, `ORG-${suffix}`, `Synthetic Program ${suffix}`, now],
    );
  }

  for (const [locationId, organizationId, suffix] of [
    ['31000000-0000-4000-8000-000000000001', org1, 'One'],
    ['31000000-0000-4000-8000-000000000002', org2, 'Two'],
  ]) {
    await pool.query(
      `INSERT INTO locations (
         id, organization_id, identifier_system, identifier_value, name,
         location_type_code, created_at, updated_at
       ) VALUES ($1, $2, 'urn:synthetic:location', $3, $4,
         'SCREENING_SITE', $5, $5)`,
      [locationId, organizationId, `LOC-${suffix}`, `Site ${suffix}`, now],
    );
  }

  for (const [installationId, organizationId, locationId, suffix] of [
    [
      '21000000-0000-4000-8000-000000000001',
      org1,
      '31000000-0000-4000-8000-000000000001',
      'One',
    ],
    [
      '21000000-0000-4000-8000-000000000002',
      org2,
      '31000000-0000-4000-8000-000000000002',
      'Two',
    ],
  ]) {
    await pool.query(
      `INSERT INTO desktop_installations (
         id, organization_id, configured_location_id, deployment_name, timezone,
         status, enrolled_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'Africa/Douala', 'ACTIVE', $5, $5, $5)`,
      [installationId, organizationId, locationId, `Desktop ${suffix}`, now],
    );
  }

  for (const patient of [
    {
      id: patient1,
      name: 'Alpha Example',
      normalized: 'alpha example',
      medicalId: 'CHS-AAAA-BBBB-CCCC',
      installationId: '21000000-0000-4000-8000-000000000001',
      localPatientCode: 'PT-000001',
    },
    {
      id: patient2,
      name: 'Beta Example',
      normalized: 'beta example',
      medicalId: 'CHS-DDDD-EEEE-FFFF',
      installationId: '21000000-0000-4000-8000-000000000002',
      localPatientCode: 'PT-000002',
    },
  ]) {
    await pool.query(
      `INSERT INTO persons (
         id, display_name, name_normalized, sex, acknowledgment_status,
         date_of_birth, status, created_at, updated_at
       ) VALUES ($1, $2, $3, 'UNKNOWN', 'ACKNOWLEDGED',
         '1980-01-02', 'ACTIVE', $4, $4)`,
      [patient.id, patient.name, patient.normalized, now],
    );
    await pool.query(
      `INSERT INTO person_identifiers (
         id, person_id, identifier_system, identifier_value,
         identifier_type_code, status, is_primary, valid_from, created_at
       ) VALUES ($1, $2, 'urn:chs:id:medical-id:v1', $3,
         'CHS_MEDICAL_ID', 'ACTIVE', true, $4, $4)`,
      [randomUUID(), patient.id, patient.medicalId, now],
    );
    await pool.query(
      `INSERT INTO patient_source_links (
         id, person_id, installation_id, local_patient_id, local_patient_code,
         last_source_revision, last_content_hash, source_created_at,
         source_updated_at, first_observed_at, last_observed_at
       ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $7, $7, $7)`,
      [
        randomUUID(),
        patient.id,
        patient.installationId,
        randomUUID(),
        patient.localPatientCode,
        'b'.repeat(64),
        now,
      ],
    );
  }

  for (const [userId, subject, displayName] of [
    [orgUser, 'org-user', 'Organization Viewer'],
    [globalUser, 'global-user', 'Global Viewer'],
    [deniedUser, 'denied-user', 'Denied Viewer'],
  ]) {
    await pool.query(
      `INSERT INTO operations_users (
         id, oidc_issuer, oidc_subject, display_name, status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $5)`,
      [userId, issuer, subject, displayName, now],
    );
  }
  await pool.query(
    `INSERT INTO operations_access_grants (
       id, operations_user_id, permission_code, scope_kind, organization_id,
       granted_at, created_at, updated_at
     ) VALUES
       ($1, $2, 'PATIENT_READ', 'ORGANIZATION', $3, $4, $4, $4),
       ($5, $6, 'PATIENT_READ', 'GLOBAL', NULL, $4, $4, $4)`,
    [randomUUID(), orgUser, org1, now, randomUUID(), globalUser],
  );
}
