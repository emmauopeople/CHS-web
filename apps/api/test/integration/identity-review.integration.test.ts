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
const org1 = '14000000-0000-4000-8000-000000000001';
const org2 = '14000000-0000-4000-8000-000000000002';
const location1 = '24000000-0000-4000-8000-000000000001';
const location2 = '24000000-0000-4000-8000-000000000002';
const installation1 = '34000000-0000-4000-8000-000000000001';
const installation2 = '34000000-0000-4000-8000-000000000002';
const availableCase = '44000000-0000-4000-8000-000000000001';
const pendingCase = '44000000-0000-4000-8000-000000000002';
const hiddenCase = '44000000-0000-4000-8000-000000000003';
const candidate1 = '54000000-0000-4000-8000-000000000001';
const candidate2 = '54000000-0000-4000-8000-000000000002';
const reviewerUser = '94000000-0000-4000-8000-000000000001';
const deniedUser = '94000000-0000-4000-8000-000000000002';

const config: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
  databaseUrl: 'postgresql://unused',
  databasePoolMax: 4,
  buildCommit: 'identity-review-test',
  buildTime: now,
  trustedProxyCidrs: [],
  operationsOidc: null,
};

const tokenVerifier: OperationsTokenVerifier = {
  async verify(header) {
    if (!header) {
      throw new OperationsAuthenticationError('OPERATIONS_TOKEN_REQUIRED', 401);
    }
    const token = /^Bearer ([^\s]+)$/.exec(header)?.[1];
    const subject = token
      ? { 'reviewer-token': 'reviewer-user', 'denied-token': 'denied-user' }[
          token
        ]
      : undefined;
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

runIntegration('audited identity-review query routes', () => {
  const schema = `chs_identity_review_${randomUUID().replaceAll('-', '')}`;
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
    await seedIdentityReviews(servicePool);
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

  it('requires the controlled reason, POST, and a valid bearer token', async () => {
    const invalidReason = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/identity-reviews/search',
      headers: { authorization: 'Bearer reviewer-token' },
      payload: { reasonCode: 'OPERATIONS_SUPPORT' },
    });
    expect(invalidReason.statusCode).toBe(400);
    expect(invalidReason.headers['cache-control']).toBe('no-store');

    const missingToken = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/identity-reviews/search',
      payload: { reasonCode: 'IDENTITY_RECONCILIATION' },
    });
    expect(missingToken.statusCode).toBe(401);
    expect(missingToken.headers['www-authenticate']).toBe('Bearer');

    const getAttempt = await app.inject({
      method: 'GET',
      url: '/api/v1/operations/identity-reviews/search',
    });
    expect(getAttempt.statusCode).toBe(404);
  });

  it('requires the dedicated grant and durably audits denial', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/identity-reviews/search',
      headers: { authorization: 'Bearer denied-token' },
      payload: { reasonCode: 'IDENTITY_RECONCILIATION' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'IDENTITY_REVIEW_ACCESS_DENIED',
    });

    const audit = await servicePool.query(
      `SELECT operations_user_id, action_code, outcome_code, reason_code, metadata
       FROM audit_events WHERE request_id = $1`,
      [response.headers['x-request-id']],
    );
    expect(audit.rows[0]).toMatchObject({
      operations_user_id: deniedUser,
      action_code: 'IDENTITY_REVIEW_LIST_VIEW',
      outcome_code: 'DENIED',
      reason_code: 'IDENTITY_RECONCILIATION',
      metadata: { authorizationCode: 'IDENTITY_REVIEW_NOT_PERMITTED' },
    });
  });

  it('lists only scoped open cases with masked hints and evidence state', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/identity-reviews/search',
      headers: { authorization: 'Bearer reviewer-token' },
      payload: {
        reasonCode: 'IDENTITY_RECONCILIATION',
        page: 1,
        pageSize: 25,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      totalItems: 2,
      items: expect.arrayContaining([
        expect.objectContaining({
          caseReference: availableCase,
          evidenceState: 'AVAILABLE',
          maskedSubmittedName: 'S••••• P•••••',
          submittedBirthEvidence: {
            kind: 'DATE_OF_BIRTH',
            maskedDate: '****-**-03',
          },
        }),
        expect.objectContaining({
          caseReference: pendingCase,
          evidenceState: 'EVIDENCE_PENDING',
          maskedSubmittedName: null,
          submittedBirthEvidence: null,
        }),
      ]),
    });
    expect(response.body).not.toContain(hiddenCase);
    expect(response.body).not.toContain('Submitted Patient');
    expect(response.body).not.toContain('CHS-1111-2222-3333');
    expect(response.body).not.toContain('payload_hash');

    const pending = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/identity-reviews/search',
      headers: { authorization: 'Bearer reviewer-token' },
      payload: {
        reasonCode: 'IDENTITY_RECONCILIATION',
        evidenceState: 'EVIDENCE_PENDING',
      },
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({
      totalItems: 1,
      items: [expect.objectContaining({ caseReference: pendingCase })],
    });
  });

  it('returns submitted evidence and only masked candidate identity, then audits the read', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/identity-reviews/detail',
      headers: { authorization: 'Bearer reviewer-token' },
      payload: {
        reasonCode: 'IDENTITY_RECONCILIATION',
        caseReference: availableCase,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      caseReference: availableCase,
      evidenceState: 'AVAILABLE',
      evidence: {
        displayName: 'Submitted Patient',
        dateOfBirth: '1991-02-03',
        maskedClaimedChsMedicalId: 'CHS-••••••••-3333',
      },
      candidates: [
        expect.objectContaining({
          personReference: candidate1,
          maskedName: 'C••••• S••••• O••',
          maskedChsMedicalId: 'CHS-••••••••-CCCC',
        }),
        expect.objectContaining({
          personReference: candidate2,
          maskedName: 'C••••• S••••• T••',
          maskedChsMedicalId: 'CHS-••••••••-FFFF',
        }),
      ],
    });
    expect(response.body).not.toContain('Candidate Secret One');
    expect(response.body).not.toContain('CHS-AAAA-BBBB-CCCC');
    expect(response.body).not.toContain('+237699999901');

    const audit = await servicePool.query(
      `SELECT action_code, entity_type, entity_id, outcome_code, metadata
       FROM audit_events WHERE request_id = $1`,
      [response.headers['x-request-id']],
    );
    expect(audit.rows[0]).toMatchObject({
      action_code: 'IDENTITY_REVIEW_DETAIL_VIEW',
      entity_type: 'IDENTITY_REVIEW_CASE',
      entity_id: availableCase,
      outcome_code: 'SUCCESS',
      metadata: {
        candidateCount: 2,
        evidenceState: 'AVAILABLE',
        latestSourceRevision: 2,
      },
    });
  });

  it('makes missing and out-of-scope case references indistinguishable', async () => {
    for (const reference of [hiddenCase, randomUUID()]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/operations/identity-reviews/detail',
        headers: { authorization: 'Bearer reviewer-token' },
        payload: {
          reasonCode: 'IDENTITY_RECONCILIATION',
          caseReference: reference,
        },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        code: 'IDENTITY_REVIEW_CASE_NOT_FOUND',
      });
      const audit = await servicePool.query(
        `SELECT outcome_code FROM audit_events WHERE request_id = $1`,
        [response.headers['x-request-id']],
      );
      expect(audit.rows[0]?.outcome_code).toBe('NOT_FOUND');
    }
  });
});

async function seedIdentityReviews(pool: pg.Pool) {
  for (const [organizationId, suffix] of [
    [org1, 'One'],
    [org2, 'Two'],
  ]) {
    await pool.query(
      `INSERT INTO organizations (
         id, identifier_system, identifier_value, name, organization_type_code,
         created_at, updated_at
       ) VALUES ($1, 'urn:test:organization', $2, $3, 'PROGRAM', $4, $4)`,
      [organizationId, `ORG-${suffix}`, `Program ${suffix}`, now],
    );
  }

  for (const [locationId, organizationId, suffix] of [
    [location1, org1, 'One'],
    [location2, org2, 'Two'],
  ]) {
    await pool.query(
      `INSERT INTO locations (
         id, organization_id, identifier_system, identifier_value, name,
         location_type_code, created_at, updated_at
       ) VALUES ($1, $2, 'urn:test:location', $3, $4, 'SCREENING_SITE', $5, $5)`,
      [locationId, organizationId, `LOC-${suffix}`, `Site ${suffix}`, now],
    );
  }

  for (const [installationId, organizationId, locationId, suffix] of [
    [installation1, org1, location1, 'One'],
    [installation2, org2, location2, 'Two'],
  ]) {
    await pool.query(
      `INSERT INTO desktop_installations (
         id, organization_id, configured_location_id, deployment_name, timezone,
         status, enrolled_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'Africa/Douala', 'ACTIVE', $5, $5, $5)`,
      [installationId, organizationId, locationId, `Desktop ${suffix}`, now],
    );
  }

  for (const [personId, suffix, medicalId, phone] of [
    [candidate1, 'One', 'CHS-AAAA-BBBB-CCCC', '+237699999901'],
    [candidate2, 'Two', 'CHS-DDDD-EEEE-FFFF', '+237699999902'],
  ]) {
    await pool.query(
      `INSERT INTO persons (
         id, display_name, given_name, family_name, name_normalized, sex,
         acknowledgment_status, date_of_birth, phone, phone_normalized, village,
         quarter, status, created_at, updated_at
       ) VALUES ($1, $2, 'Candidate', $3, $4, 'FEMALE', 'ACKNOWLEDGED',
         '1991-02-03', $5, $5, 'Candidate Village', 'Candidate Quarter',
         'ACTIVE', $6, $6)`,
      [personId, `Candidate Secret ${suffix}`, suffix, `candidate secret ${suffix}`, phone, now],
    );
    await pool.query(
      `INSERT INTO person_identifiers (
         id, person_id, identifier_system, identifier_value, identifier_type_code,
         issuer_organization_id, status, is_primary, valid_from, created_at
       ) VALUES ($1, $2, 'urn:chs:id:medical-id:v1', $3, 'CHS_MEDICAL_ID',
         $4, 'ACTIVE', true, $5, $5)`,
      [randomUUID(), personId, medicalId, org1, now],
    );
  }

  for (const [reviewCase, installationId, localPatientId] of [
    [availableCase, installation1, '64000000-0000-4000-8000-000000000001'],
    [pendingCase, installation1, '64000000-0000-4000-8000-000000000002'],
    [hiddenCase, installation2, '64000000-0000-4000-8000-000000000003'],
  ]) {
    await pool.query(
      `INSERT INTO identity_review_cases (
         id, installation_id, local_patient_id, status, opened_at, created_at, updated_at
       ) VALUES ($1, $2, $3, 'OPEN', $4, $4, $4)`,
      [reviewCase, installationId, localPatientId, now],
    );
  }

  for (const [personId, score] of [
    [candidate1, 91],
    [candidate2, 82],
  ]) {
    await pool.query(
      `INSERT INTO identity_review_candidates (
         review_case_id, person_id, score, matched_on, created_at
       ) VALUES ($1, $2, $3, ARRAY['NAME', 'DATE_OF_BIRTH'], $4)`,
      [availableCase, personId, score, now],
    );
  }

  for (const [reviewCase, revision, name, claimedId] of [
    [availableCase, 2, 'Submitted Patient', 'CHS-1111-2222-3333'],
    [hiddenCase, 1, 'Hidden Patient', null],
  ]) {
    await pool.query(
      `INSERT INTO identity_review_evidence_snapshots (
         id, review_case_id, source_record_id, source_revision, schema_version,
         captured_at, payload_hash, local_patient_code, claimed_chs_medical_id,
         display_name, name_normalized, given_name, family_name, date_of_birth,
         sex, phone, phone_normalized, village, quarter, source_created_at,
         source_updated_at, received_at
       ) VALUES ($1, $2, $3, $4, '1.0', $5, $6, 'PT-000101', $7, $8,
         lower($8), split_part($8, ' ', 1), split_part($8, ' ', 2),
         '1991-02-03', 'FEMALE', '+237612345678', '+237612345678',
         'Submitted Village', 'Submitted Quarter', $5, $5, $5)`,
      [randomUUID(), reviewCase, randomUUID(), revision, now, 'a'.repeat(64), claimedId, name],
    );
  }

  for (const [userId, subject, displayName] of [
    [reviewerUser, 'reviewer-user', 'Identity Reviewer'],
    [deniedUser, 'denied-user', 'Patient Viewer'],
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
       ($1, $2, 'IDENTITY_REVIEW', 'ORGANIZATION', $3, $4, $4, $4),
       ($5, $6, 'PATIENT_READ', 'ORGANIZATION', $3, $4, $4, $4)`,
    [randomUUID(), reviewerUser, org1, now, randomUUID(), deniedUser],
  );
}
