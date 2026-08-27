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
import {
  installationTokenHash,
  installationTokenPrefix,
} from '../../src/sync/installation-auth.js';

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
const createCase = '44000000-0000-4000-8000-000000000004';
const candidate1 = '54000000-0000-4000-8000-000000000001';
const candidate2 = '54000000-0000-4000-8000-000000000002';
const reviewerUser = '94000000-0000-4000-8000-000000000001';
const deniedUser = '94000000-0000-4000-8000-000000000002';
const readOnlyReviewerUser = '94000000-0000-4000-8000-000000000003';
const installationToken1 = `chs_inst_v1_${'R'.repeat(43)}`;
const installationToken2 = `chs_inst_v1_${'S'.repeat(43)}`;

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
      ? {
          'reviewer-token': 'reviewer-user',
          'denied-token': 'denied-user',
          'read-only-reviewer-token': 'read-only-reviewer-user',
        }[token]
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

  it('protects identity resolution delivery with the installation credential', async () => {
    const missingToken = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/identity-resolutions/pull',
      payload: { contractVersion: '1.0' },
    });
    expect(missingToken.statusCode).toBe(401);
    expect(missingToken.headers['www-authenticate']).toBe('Bearer');
    expect(missingToken.json()).toMatchObject({
      code: 'INVALID_INSTALLATION_TOKEN',
    });

    const invalidContract = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/identity-resolutions/pull',
      headers: { authorization: `Bearer ${installationToken1}` },
      payload: { contractVersion: '2.0' },
    });
    expect(invalidContract.statusCode).toBe(400);
    expect(invalidContract.headers['cache-control']).toBe('no-store');
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
      totalItems: 3,
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

  it('rejects an unlisted candidate and stale reviewer state without mutation', async () => {
    const attempts = [
      {
        caseReference: availableCase,
        expectedUpdatedAt: now,
        resolution: {
          kind: 'LINK_EXISTING',
          candidatePersonReference: randomUUID(),
        },
        code: 'IDENTITY_REVIEW_CANDIDATE_NOT_AVAILABLE',
      },
      {
        caseReference: createCase,
        expectedUpdatedAt: '2026-08-20T12:00:01.000Z',
        resolution: { kind: 'CREATE_NEW' },
        code: 'IDENTITY_REVIEW_STALE',
      },
    ];

    for (const attempt of attempts) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/operations/identity-reviews/resolve',
        headers: { authorization: 'Bearer reviewer-token' },
        payload: {
          reasonCode: 'IDENTITY_RECONCILIATION',
          resolutionRequestId: randomUUID(),
          caseReference: attempt.caseReference,
          expectedUpdatedAt: attempt.expectedUpdatedAt,
          resolutionNote: 'This synthetic attempt must be rejected without mutation.',
          resolution: attempt.resolution,
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: attempt.code });
    }

    const states = await servicePool.query(
      `SELECT id, status, resolved_person_id
       FROM identity_review_cases WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[availableCase, createCase]],
    );
    expect(states.rows).toEqual([
      { id: availableCase, status: 'OPEN', resolved_person_id: null },
      { id: createCase, status: 'OPEN', resolved_person_id: null },
    ]);
  });

  it('requires resolution authority in addition to read-only review access', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/identity-reviews/resolve',
      headers: { authorization: 'Bearer read-only-reviewer-token' },
      payload: {
        reasonCode: 'IDENTITY_RECONCILIATION',
        resolutionRequestId: randomUUID(),
        caseReference: availableCase,
        expectedUpdatedAt: now,
        resolutionNote: 'A read-only reviewer must not make this identity decision.',
        resolution: {
          kind: 'LINK_EXISTING',
          candidatePersonReference: candidate1,
        },
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'IDENTITY_REVIEW_ACCESS_DENIED',
    });
    const audit = await servicePool.query(
      `SELECT operations_user_id, outcome_code, metadata
       FROM audit_events WHERE request_id = $1`,
      [response.headers['x-request-id']],
    );
    expect(audit.rows[0]).toMatchObject({
      operations_user_id: readOnlyReviewerUser,
      outcome_code: 'DENIED',
      metadata: {
        authorizationCode: 'IDENTITY_REVIEW_RESOLUTION_NOT_PERMITTED',
      },
    });
  });

  it('atomically links a listed candidate and replays the same resolution request', async () => {
    const resolutionRequestId = randomUUID();
    const payload = {
      reasonCode: 'IDENTITY_RECONCILIATION',
      resolutionRequestId,
      caseReference: availableCase,
      expectedUpdatedAt: now,
      resolutionNote: 'Verified the submitted demographics against the candidate.',
      resolution: {
        kind: 'LINK_EXISTING',
        candidatePersonReference: candidate1,
      },
    };
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/identity-reviews/resolve',
      headers: { authorization: 'Bearer reviewer-token' },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      resolutionRequestId,
      caseReference: availableCase,
      resolutionStatus: 'RESOLVED_EXISTING',
      resolvedPersonReference: candidate1,
      chsMedicalId: 'CHS-AAAA-BBBB-CCCC',
      sourceRevision: 2,
      replayed: false,
    });

    const state = await servicePool.query(
      `SELECT review_case.status, source_link.person_id,
              resolution.operations_user_id, resolution.action_code
       FROM identity_review_cases AS review_case
       JOIN patient_source_links AS source_link
         ON source_link.installation_id = review_case.installation_id
        AND source_link.local_patient_id = review_case.local_patient_id
       JOIN identity_review_resolutions AS resolution
         ON resolution.review_case_id = review_case.id
       WHERE review_case.id = $1`,
      [availableCase],
    );
    expect(state.rows[0]).toMatchObject({
      status: 'RESOLVED_EXISTING',
      person_id: candidate1,
      operations_user_id: reviewerUser,
      action_code: 'LINK_EXISTING',
    });

    const audit = await servicePool.query(
      `SELECT action_code, outcome_code, metadata
       FROM audit_events WHERE request_id = $1`,
      [response.headers['x-request-id']],
    );
    expect(audit.rows[0]).toMatchObject({
      action_code: 'IDENTITY_REVIEW_RESOLVE',
      outcome_code: 'SUCCESS',
      metadata: {
        resolutionAction: 'LINK_EXISTING',
        resolutionStatus: 'RESOLVED_EXISTING',
        replayed: false,
      },
    });

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/identity-reviews/resolve',
      headers: { authorization: 'Bearer reviewer-token' },
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      resolutionRequestId,
      resolvedPersonReference: candidate1,
      replayed: true,
    });
    const changedReplay = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/identity-reviews/resolve',
      headers: { authorization: 'Bearer reviewer-token' },
      payload: {
        ...payload,
        resolutionNote: 'A changed command must not reuse an earlier request identifier.',
      },
    });
    expect(changedReplay.statusCode).toBe(409);
    expect(changedReplay.json()).toMatchObject({
      code: 'IDENTITY_REVIEW_RESOLUTION_REQUEST_REUSE',
    });
    const counts = await servicePool.query(
      `SELECT
         (SELECT count(*)::int FROM identity_review_resolutions
          WHERE review_case_id = $1) AS resolution_count,
         (SELECT count(*)::int FROM patient_source_links
          WHERE installation_id = $2 AND local_patient_id = $3) AS link_count`,
      [availableCase, installation1, '64000000-0000-4000-8000-000000000001'],
    );
    expect(counts.rows[0]).toEqual({ resolution_count: 1, link_count: 1 });
  });

  it('creates one canonical person and medical ID from complete review evidence', async () => {
    const resolutionRequestId = randomUUID();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/identity-reviews/resolve',
      headers: { authorization: 'Bearer reviewer-token' },
      payload: {
        reasonCode: 'IDENTITY_RECONCILIATION',
        resolutionRequestId,
        caseReference: createCase,
        expectedUpdatedAt: now,
        resolutionNote: 'Reviewed the evidence and confirmed this is a new individual.',
        resolution: { kind: 'CREATE_NEW' },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      caseReference: createCase,
      resolutionStatus: 'RESOLVED_NEW',
      replayed: false,
    });
    expect(response.json().chsMedicalId).toMatch(/^CHS-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2}$/);

    const created = await servicePool.query(
      `SELECT person.display_name, person.acknowledgment_status, person.status,
              identifier.identifier_value, source_link.person_id
       FROM identity_review_cases AS review_case
       JOIN persons AS person ON person.id = review_case.resolved_person_id
       JOIN person_identifiers AS identifier
         ON identifier.person_id = person.id AND identifier.is_primary = true
       JOIN patient_source_links AS source_link
         ON source_link.installation_id = review_case.installation_id
        AND source_link.local_patient_id = review_case.local_patient_id
       WHERE review_case.id = $1`,
      [createCase],
    );
    expect(created.rows[0]).toMatchObject({
      display_name: 'New Submitted Patient',
      acknowledgment_status: 'ACKNOWLEDGED',
      status: 'ACTIVE',
      identifier_value: response.json().chsMedicalId,
      person_id: response.json().resolvedPersonReference,
    });

    const pull = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/identity-resolutions/pull',
      headers: { authorization: `Bearer ${installationToken1}` },
      payload: { contractVersion: '1.0', limit: 25 },
    });
    expect(pull.statusCode).toBe(200);
    expect(pull.headers['cache-control']).toBe('no-store');
    expect(pull.headers.pragma).toBe('no-cache');
    expect(pull.json()).toMatchObject({
      contractVersion: '1.0',
      hasMore: false,
      deliveries: expect.arrayContaining([
        {
          resolutionReference: resolutionRequestId,
          localPatientReference: '64000000-0000-4000-8000-000000000004',
          localPatientCode: 'PT-000104',
          sourceRevision: 1,
          centralPersonId: response.json().resolvedPersonReference,
          chsMedicalId: response.json().chsMedicalId,
          resolvedAt: response.json().resolvedAt,
        },
      ]),
    });
    expect(pull.body).not.toContain('Reviewed the evidence');
    expect(pull.body).not.toContain('New Submitted Patient');

    const hidden = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/identity-resolutions/pull',
      headers: { authorization: `Bearer ${installationToken2}` },
      payload: { contractVersion: '1.0' },
    });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json().deliveries).toEqual([]);

    const acknowledgmentId = randomUUID();
    const acknowledgmentPayload = {
      contractVersion: '1.0',
      acknowledgmentId,
      resolutionReference: resolutionRequestId,
      appliedAt: '2026-08-20T12:15:00.000Z',
    };
    const acknowledgment = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/identity-resolutions/acknowledge',
      headers: { authorization: `Bearer ${installationToken1}` },
      payload: acknowledgmentPayload,
    });
    expect(acknowledgment.statusCode).toBe(200);
    expect(acknowledgment.json()).toMatchObject({
      contractVersion: '1.0',
      acknowledgmentId,
      resolutionReference: resolutionRequestId,
      status: 'ACKNOWLEDGED',
      replayed: false,
    });

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/identity-resolutions/acknowledge',
      headers: { authorization: `Bearer ${installationToken1}` },
      payload: acknowledgmentPayload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true });

    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/identity-resolutions/acknowledge',
      headers: { authorization: `Bearer ${installationToken1}` },
      payload: { ...acknowledgmentPayload, acknowledgmentId: randomUUID() },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      code: 'IDENTITY_RESOLUTION_ACKNOWLEDGMENT_CONFLICT',
    });

    const outOfScope = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/identity-resolutions/acknowledge',
      headers: { authorization: `Bearer ${installationToken2}` },
      payload: { ...acknowledgmentPayload, acknowledgmentId: randomUUID() },
    });
    expect(outOfScope.statusCode).toBe(404);
    expect(outOfScope.json()).toMatchObject({
      code: 'IDENTITY_RESOLUTION_DELIVERY_NOT_FOUND',
    });

    const afterAcknowledgment = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/identity-resolutions/pull',
      headers: { authorization: `Bearer ${installationToken1}` },
      payload: { contractVersion: '1.0' },
    });
    expect(afterAcknowledgment.statusCode).toBe(200);
    expect(
      afterAcknowledgment
        .json()
        .deliveries.some(
          (item: { resolutionReference: string }) =>
            item.resolutionReference === resolutionRequestId,
        ),
    ).toBe(false);
  });

  it('rejects incomplete evidence and audits the conflict without mutating the case', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/identity-reviews/resolve',
      headers: { authorization: 'Bearer reviewer-token' },
      payload: {
        reasonCode: 'IDENTITY_RECONCILIATION',
        resolutionRequestId: randomUUID(),
        caseReference: pendingCase,
        expectedUpdatedAt: now,
        resolutionNote: 'Attempted resolution while the submitted evidence was incomplete.',
        resolution: { kind: 'CREATE_NEW' },
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'IDENTITY_REVIEW_EVIDENCE_INCOMPLETE',
    });
    const reviewCase = await servicePool.query(
      `SELECT status, resolved_person_id FROM identity_review_cases WHERE id = $1`,
      [pendingCase],
    );
    expect(reviewCase.rows[0]).toEqual({ status: 'OPEN', resolved_person_id: null });
    const audit = await servicePool.query(
      `SELECT outcome_code, metadata FROM audit_events WHERE request_id = $1`,
      [response.headers['x-request-id']],
    );
    expect(audit.rows[0]).toMatchObject({
      outcome_code: 'DENIED',
      metadata: { resolutionCode: 'IDENTITY_REVIEW_EVIDENCE_INCOMPLETE' },
    });
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

  for (const [installationId, credentialToken] of [
    [installation1, installationToken1],
    [installation2, installationToken2],
  ] as const) {
    await pool.query(
      `INSERT INTO desktop_installation_credentials (
         id, installation_id, token_prefix, token_hash, label, status,
         issued_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'Identity delivery test', 'ACTIVE', $5, $5, $5)`,
      [
        randomUUID(),
        installationId,
        installationTokenPrefix(credentialToken),
        installationTokenHash(credentialToken),
        now,
      ],
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
    [createCase, installation1, '64000000-0000-4000-8000-000000000004'],
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

  for (const [reviewCase, revision, name, claimedId, localPatientCode] of [
    [availableCase, 2, 'Submitted Patient', 'CHS-1111-2222-3333', 'PT-000101'],
    [hiddenCase, 1, 'Hidden Patient', null, 'PT-000103'],
    [createCase, 1, 'New Submitted Patient', null, 'PT-000104'],
  ]) {
    await pool.query(
      `INSERT INTO identity_review_evidence_snapshots (
         id, review_case_id, source_record_id, source_revision, schema_version,
         captured_at, payload_hash, local_patient_code, claimed_chs_medical_id,
         display_name, name_normalized, given_name, family_name, date_of_birth,
         sex, phone, phone_normalized, village, quarter, source_created_at,
         acknowledgment_status, patient_status, source_updated_at, received_at
       ) VALUES ($1, $2, $3, $4, '1.0', $5, $6, $9, $7, $8,
         lower($8), split_part($8, ' ', 1), split_part($8, ' ', 2),
         '1991-02-03', 'FEMALE', '+237612345678', '+237612345678',
         'Submitted Village', 'Submitted Quarter', $5, 'ACKNOWLEDGED',
         'ACTIVE', $5, $5)`,
      [
        randomUUID(),
        reviewCase,
        randomUUID(),
        revision,
        now,
        'a'.repeat(64),
        claimedId,
        name,
        localPatientCode,
      ],
    );
  }

  for (const [userId, subject, displayName] of [
    [reviewerUser, 'reviewer-user', 'Identity Reviewer'],
    [deniedUser, 'denied-user', 'Patient Viewer'],
    [readOnlyReviewerUser, 'read-only-reviewer-user', 'Read-only Reviewer'],
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
       ($5, $2, 'IDENTITY_REVIEW_RESOLVE', 'ORGANIZATION', $3, $4, $4, $4),
       ($6, $7, 'PATIENT_READ', 'ORGANIZATION', $3, $4, $4, $4),
       ($8, $9, 'IDENTITY_REVIEW', 'ORGANIZATION', $3, $4, $4, $4)`,
    [
      randomUUID(),
      reviewerUser,
      org1,
      now,
      randomUUID(),
      randomUUID(),
      deniedUser,
      randomUUID(),
      readOnlyReviewerUser,
    ],
  );
}
