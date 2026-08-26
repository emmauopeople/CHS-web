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
const now = '2026-08-20T12:00:00.000Z';
const org1 = '12000000-0000-4000-8000-000000000001';
const org2 = '12000000-0000-4000-8000-000000000002';
const recoveryUser = '92000000-0000-4000-8000-000000000001';
const readOnlyUser = '92000000-0000-4000-8000-000000000002';
const existingMedicalId = 'CHS-AAAA-BBBB-CCCC';

const config: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
  databaseUrl: 'postgresql://unused',
  databasePoolMax: 4,
  http: {
    bodyLimitBytes: 1_048_576,
    requestTimeoutMs: 120_000,
    connectionTimeoutMs: 30_000,
    keepAliveTimeoutMs: 5_000,
  },
  buildCommit: 'medical-id-recovery-test',
  buildTime: now,
  trustedProxyCidrs: [],
  operationsOidc: null,
};

const tokenVerifier: OperationsTokenVerifier = {
  async verify(header) {
    if (!header) throw new OperationsAuthenticationError('OPERATIONS_TOKEN_REQUIRED', 401);
    const token = /^Bearer ([^\s]+)$/.exec(header)?.[1];
    const identity = token
      ? {
          'recovery-token': { subject: 'recovery-user', sessionId: 'session-one' },
          'different-session-token': { subject: 'recovery-user', sessionId: 'session-two' },
          'read-only-token': { subject: 'read-only-user', sessionId: 'read-only-session' },
        }[token]
      : undefined;
    if (!identity) throw new OperationsAuthenticationError('INVALID_OPERATIONS_TOKEN', 401);
    return {
      issuer,
      subject: identity.subject,
      sessionId: identity.sessionId,
      authorizedParty: 'operations-web',
    };
  },
};

runIntegration('audited Medical ID recovery routes', () => {
  const schema = `chs_medical_id_recovery_${randomUUID().replaceAll('-', '')}`;
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

  it('requires MEDICAL_ID_RECOVER permission and durably audits denial', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/medical-id-recovery/search',
      headers: { authorization: 'Bearer read-only-token' },
      payload: {
        reasonCode: 'PATIENT_REQUEST',
        fullName: 'Alpha Example',
        dateOfBirth: '1980-01-02',
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ code: 'MEDICAL_ID_RECOVERY_ACCESS_DENIED' });

    const audit = await servicePool.query(
      `SELECT operations_user_id, action_code, outcome_code, reason_code
       FROM audit_events WHERE request_id = $1`,
      [response.headers['x-request-id']],
    );
    expect(audit.rows[0]).toMatchObject({
      operations_user_id: readOnlyUser,
      action_code: 'MEDICAL_ID_RECOVERY_SEARCH',
      outcome_code: 'DENIED',
      reason_code: 'PATIENT_REQUEST',
    });
  });

  it('returns one masked scoped candidate and reveals the existing ID only once', async () => {
    const identifierCountBefore = await activeMedicalIdCount(servicePool);
    const search = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/medical-id-recovery/search',
      headers: { authorization: 'Bearer recovery-token' },
      payload: {
        reasonCode: 'CARE_DELIVERY',
        fullName: 'Alpha Example',
        dateOfBirth: '1980-01-02',
      },
    });
    expect(search.statusCode).toBe(200);
    expect(search.headers['cache-control']).toBe('no-store');
    const searchBody = search.json();
    expect(searchBody).toMatchObject({
      status: 'CANDIDATE_FOUND',
      candidates: [{
        maskedName: 'A•••• E•••••',
        maskedDateOfBirth: '****-**-02',
      }],
    });
    expect(search.body).not.toContain('Alpha Example');
    expect(search.body).not.toContain(existingMedicalId);

    const revealPayload = {
      reasonCode: 'CARE_DELIVERY',
      recoveryToken: searchBody.recoveryToken,
      candidateReference: searchBody.candidates[0].candidateReference,
      confirmed: true,
    };
    const reveal = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/medical-id-recovery/reveal',
      headers: { authorization: 'Bearer recovery-token' },
      payload: revealPayload,
    });
    expect(reveal.statusCode).toBe(200);
    expect(reveal.json()).toEqual({ status: 'REVEALED', chsMedicalId: existingMedicalId });

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/medical-id-recovery/reveal',
      headers: { authorization: 'Bearer recovery-token' },
      payload: revealPayload,
    });
    expect(replay.statusCode).toBe(404);
    expect(replay.body).not.toContain(existingMedicalId);
    expect(await activeMedicalIdCount(servicePool)).toBe(identifierCountBefore);

    const audits = await servicePool.query(
      `SELECT action_code, outcome_code, metadata
       FROM audit_events
       WHERE request_id = ANY($1::text[])
       ORDER BY occurred_at, id`,
      [[search.headers['x-request-id'], reveal.headers['x-request-id'], replay.headers['x-request-id']]],
    );
    expect(audits.rows).toHaveLength(3);
    expect(audits.rows.map((row) => [row.action_code, row.outcome_code])).toEqual(
      expect.arrayContaining([
        ['MEDICAL_ID_RECOVERY_SEARCH', 'SUCCESS'],
        ['MEDICAL_ID_RECOVERY_REVEAL', 'SUCCESS'],
        ['MEDICAL_ID_RECOVERY_REVEAL', 'DENIED'],
      ]),
    );
    expect(JSON.stringify(audits.rows)).not.toContain(existingMedicalId);
    expect(JSON.stringify(audits.rows)).not.toContain('Alpha Example');
  });

  it('binds confirmation to the authenticated session', async () => {
    const search = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/medical-id-recovery/search',
      headers: { authorization: 'Bearer recovery-token' },
      payload: {
        reasonCode: 'CARE_DELIVERY',
        fullName: 'Alpha Example',
        dateOfBirth: '1980-01-02',
      },
    });
    const searchBody = search.json();
    const reveal = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/medical-id-recovery/reveal',
      headers: { authorization: 'Bearer different-session-token' },
      payload: {
        reasonCode: 'CARE_DELIVERY',
        recoveryToken: searchBody.recoveryToken,
        candidateReference: searchBody.candidates[0].candidateReference,
        confirmed: true,
      },
    });
    expect(reveal.statusCode).toBe(404);
    expect(reveal.body).not.toContain(existingMedicalId);
  });

  it('returns a review case without a reveal token for ambiguous evidence', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/medical-id-recovery/search',
      headers: { authorization: 'Bearer recovery-token' },
      payload: {
        reasonCode: 'OPERATIONS_SUPPORT',
        fullName: 'Twin Match',
        dateOfBirth: '1990-03-04',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      status: 'REVIEW_REQUIRED',
      candidateCount: 2,
    });
    expect(body.recoveryToken).toBeUndefined();
    expect(body.candidates).toHaveLength(2);
    expect(response.body).not.toContain('CHS-TWIN');

    const recoveryCase = await servicePool.query(
      `SELECT status, token_hash, candidate_count
       FROM medical_id_recovery_cases WHERE id = $1`,
      [body.caseReference],
    );
    expect(recoveryCase.rows[0]).toMatchObject({
      status: 'REVIEW_REQUIRED',
      token_hash: null,
      candidate_count: 2,
    });
  });

  it('does not disclose out-of-scope or nonexistent records', async () => {
    for (const [fullName, dateOfBirth] of [
      ['Hidden Patient', '1975-05-06'],
      ['Nobody Here', '1975-05-06'],
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/operations/medical-id-recovery/search',
        headers: { authorization: 'Bearer recovery-token' },
        payload: { reasonCode: 'PATIENT_REQUEST', fullName, dateOfBirth },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'NOT_RESOLVED' });
      expect(response.body).not.toContain('CHS-HIDDEN');
    }
  });
});

async function activeMedicalIdCount(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM person_identifiers
     WHERE identifier_system = 'urn:chs:id:medical-id:v1'
       AND identifier_type_code = 'CHS_MEDICAL_ID'
       AND status = 'ACTIVE'`,
  );
  return Number(result.rows[0]?.count);
}

async function seed(pool: pg.Pool): Promise<void> {
  for (const [organizationId, locationId, installationId, suffix] of [
    [org1, '32000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'One'],
    [org2, '32000000-0000-4000-8000-000000000002', '22000000-0000-4000-8000-000000000002', 'Two'],
  ]) {
    await pool.query(
      `INSERT INTO organizations (
       id, identifier_system, identifier_value, name, organization_type_code,
         created_at, updated_at
       ) VALUES ($1, 'urn:synthetic:organization', $2, $3, 'PROGRAM', $4, $4)`,
      [organizationId, `ORG-${suffix}`, `Program ${suffix}`, now],
    );
    await pool.query(
      `INSERT INTO locations (
         id, organization_id, identifier_system, identifier_value, name,
         location_type_code, created_at, updated_at
       ) VALUES ($1, $2, 'urn:synthetic:location', $3, $4,
         'SCREENING_SITE', $5, $5)`,
      [locationId, organizationId, `LOC-${suffix}`, `Site ${suffix}`, now],
    );
    await pool.query(
      `INSERT INTO desktop_installations (
         id, organization_id, configured_location_id, deployment_name, timezone,
         status, enrolled_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'Africa/Douala', 'ACTIVE', $5, $5, $5)`,
      [installationId, organizationId, locationId, `Desktop ${suffix}`, now],
    );
  }

  const patients = [
    ['42000000-0000-4000-8000-000000000001', 'Alpha Example', 'alpha example', '1980-01-02', existingMedicalId, '22000000-0000-4000-8000-000000000001', 'PT-000001'],
    ['42000000-0000-4000-8000-000000000002', 'Hidden Patient', 'hidden patient', '1975-05-06', 'CHS-HIDDEN-0001', '22000000-0000-4000-8000-000000000002', 'PT-000002'],
    ['42000000-0000-4000-8000-000000000003', 'Twin Match', 'match twin', '1990-03-04', 'CHS-TWIN-0001', '22000000-0000-4000-8000-000000000001', 'PT-000003'],
    ['42000000-0000-4000-8000-000000000004', 'Twin Match', 'match twin', '1990-03-04', 'CHS-TWIN-0002', '22000000-0000-4000-8000-000000000001', 'PT-000004'],
  ] as const;
  for (const [personId, name, normalized, dateOfBirth, medicalId, installationId, localCode] of patients) {
    await pool.query(
      `INSERT INTO persons (
         id, display_name, name_normalized, sex, acknowledgment_status,
         date_of_birth, village, quarter, status, created_at, updated_at
       ) VALUES ($1, $2, $3, 'UNKNOWN', 'ACKNOWLEDGED', $4, 'Test Village',
         'Test Quarter', 'ACTIVE', $5, $5)`,
      [personId, name, normalized, dateOfBirth, now],
    );
    await pool.query(
      `INSERT INTO person_identifiers (
         id, person_id, identifier_system, identifier_value,
         identifier_type_code, status, is_primary, valid_from, created_at
       ) VALUES ($1, $2, 'urn:chs:id:medical-id:v1', $3,
         'CHS_MEDICAL_ID', 'ACTIVE', true, $4, $4)`,
      [randomUUID(), personId, medicalId, now],
    );
    await pool.query(
      `INSERT INTO patient_source_links (
         id, person_id, installation_id, local_patient_id, local_patient_code,
         last_source_revision, last_content_hash, source_created_at,
         source_updated_at, first_observed_at, last_observed_at
       ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $7, $7, $7)`,
      [randomUUID(), personId, installationId, randomUUID(), localCode, 'a'.repeat(64), now],
    );
  }

  for (const [userId, subject, name] of [
    [recoveryUser, 'recovery-user', 'Recovery User'],
    [readOnlyUser, 'read-only-user', 'Read-only User'],
  ]) {
    await pool.query(
      `INSERT INTO operations_users (
         id, oidc_issuer, oidc_subject, display_name, status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $5)`,
      [userId, issuer, subject, name, now],
    );
  }
  await pool.query(
    `INSERT INTO operations_access_grants (
       id, operations_user_id, permission_code, scope_kind, organization_id,
       granted_at, created_at, updated_at
     ) VALUES
       ($1, $2, 'MEDICAL_ID_RECOVER', 'ORGANIZATION', $3, $4, $4, $4),
       ($5, $6, 'PATIENT_READ', 'ORGANIZATION', $3, $4, $4, $4)`,
    [randomUUID(), recoveryUser, org1, now, randomUUID(), readOnlyUser],
  );
}
