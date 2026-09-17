import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import {
  historyResourceTypes,
  isHistoryPage,
  type HistoryPage,
  type InstallationHistoryRequest,
} from '../../../../packages/contracts/src/patient-history.mjs';
import { submitSyncBatch } from '../../src/sync/batch-orchestrator.js';
import {
  installationTokenHash,
  installationTokenPrefix,
} from '../../src/sync/installation-auth.js';
import { readPatientHistory } from '../../src/history/service.js';
import { buildApp } from '../../src/app.js';
import { OperationsAuthenticationError } from '../../src/operations/authentication.js';
import type { AppConfig } from '../../src/config.js';
import type {
  InstallationContext,
  SyncBatchRequest,
  SyncRecordSnapshot,
  PatientSyncRecord,
  VitalsSyncRecord,
  ScreeningSessionSyncRecord,
} from '../../src/sync/types.js';
const runIntegration = process.env.DATABASE_TEST_URL ? describe : describe.skip;
const now = new Date('2026-09-17T12:00:00.000Z');
const fixture = async (name: string): Promise<SyncBatchRequest> =>
  JSON.parse(
    await readFile(
      new URL(
        `../../../../packages/contracts/fixtures/sync/v1/valid/${name}.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  ) as SyncBatchRequest;
const audit = {
  requestId: 'history-test',
  route: '/api/v1/sync/patients/history',
};
const org = randomUUID(),
  otherOrg = randomUUID(),
  user = randomUUID();
const identity = {
  issuer: 'https://identity.example.test/',
  subject: 'history-reader',
  sessionId: null,
  authorizedParty: 'operations-web',
};
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
    keepAliveTimeoutMs: 5000,
  },
  buildCommit: 'test',
  buildTime: now.toISOString(),
  trustedProxyCidrs: [],
  operationsOidc: null,
};

runIntegration('protected all-domain patient history', () => {
  const schema = `chs_history_read_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool, pool: pg.Pool, app: Awaited<ReturnType<typeof buildApp>>;
  let source: InstallationContext,
    second: InstallationContext,
    external: InstallationContext;
  let request: InstallationHistoryRequest,
    batch: SyncBatchRequest,
    token: string,
    secondToken: string;
  let personId: string, encounterId: string;
  const caller = () => ({
    kind: 'INSTALLATION' as const,
    authorization: `Bearer ${token}`,
  });
  const read = (
    changes: Partial<InstallationHistoryRequest> = {},
    time = now,
  ) =>
    readPatientHistory(pool, caller(), { ...request, ...changes }, audit, time);
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env.DATABASE_TEST_URL });
    const client = await admin.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await migrateWithClient({ client, logger: { info() {} } });
    } finally {
      client.release();
    }
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_TEST_URL,
      options: `-c search_path=${schema}`,
    });
    batch = await fixture('lifestyle-batch-request');
    const patient = batch.records.find(
      (r) => r.resourceType === 'PATIENT',
    )! as PatientSyncRecord;
    if (patient.resourceType !== 'PATIENT') throw new Error('fixture');
    batch = {
      ...batch,
      records: batch.records.map((r) =>
        r === patient
          ? {
              ...patient,
              payload: { ...patient.payload, knownChsMedicalId: null },
            }
          : r,
      ),
    };
    source = await seedInstallation(pool, org, batch);
    token = await issueToken(pool, source.installationId);
    const first = await submitSyncBatch(
      pool,
      source,
      { ...batch, batchId: randomUUID() },
      { clock: () => now },
    );
    expect(first.response.outcomes.every((o) => o.status === 'ACCEPTED')).toBe(
      true,
    );
    personId = first.response.outcomes.find(
      (o) => o.resourceType === 'PATIENT',
    )!.canonicalResourceId!;
    encounterId = first.response.outcomes.find(
      (o) => o.resourceType === 'SCREENING_ENCOUNTER',
    )!.canonicalResourceId!;
    const medicalId = (
      await pool.query(
        'SELECT identifier_value FROM person_identifiers WHERE person_id=$1',
        [personId],
      )
    ).rows[0].identifier_value as string;
    const base = await fixture('batch-request');
    const original = base.records.find(
      (r) => r.resourceType === 'VITALS',
    )! as VitalsSyncRecord;
    if (original.resourceType !== 'VITALS') throw new Error('fixture');
    const vital: SyncRecordSnapshot = {
      ...original,
      recordId: randomUUID(),
      sourceActorLocalId: batch.actors[0]!.localActorId,
      capturedAt: now.toISOString(),
      payload: {
        ...original.payload,
        localEncounterId: '92000000-0000-4000-8000-000000000001',
        performedByLocalActorId: batch.actors[0]!.localActorId,
        createdAt: '2026-08-20T14:25:00.000Z',
        updatedAt: '2026-08-20T14:25:00.000Z',
        readings: original.payload.readings.map((r) => ({
          ...r,
          measurementLocalDate: '2026-08-20',
          measurementLocalTime: '15:25',
          createdAt: '2026-08-20T14:25:00.000Z',
          updatedAt: '2026-08-20T14:25:00.000Z',
        })),
      },
    };
    const extra: SyncRecordSnapshot[] = [vital];
    for (const name of [
      'food-otc-batch-request',
      'referral-batch-request',
      'encounter-history-batch-request',
    ])
      extra.push(...(await fixture(name)).records);
    const uploaded = await submitSyncBatch(
      pool,
      source,
      { ...batch, batchId: randomUUID(), records: extra },
      { clock: () => now },
    );
    expect(
      uploaded.response.outcomes.every((o) => o.status === 'ACCEPTED'),
    ).toBe(true);
    for (const organizationId of [org, otherOrg]) {
      const peerBatch = {
        ...batch,
        installationId: randomUUID(),
        records: batch.records
          .filter((r) => r.resourceType !== 'LIFESTYLE')
          .map((r) =>
            r.resourceType === 'PATIENT'
              ? {
                  ...r,
                  payload: {
                    ...(r as PatientSyncRecord).payload,
                    knownChsMedicalId: medicalId,
                  },
                }
              : r,
          ),
      };
      const peer = await seedInstallation(pool, organizationId, peerBatch);
      expect(
        (
          await submitSyncBatch(
            pool,
            peer,
            { ...peerBatch, batchId: randomUUID() },
            { clock: () => now },
          )
        ).response.outcomes.every((o) => o.status === 'ACCEPTED'),
      ).toBe(true);
      if (organizationId === org) {
        second = peer;
        secondToken = await issueToken(pool, peer.installationId);
      } else external = peer;
    }
    await pool.query(
      `INSERT INTO operations_users (id,oidc_issuer,oidc_subject,display_name,status,created_at,updated_at) VALUES ($1,$2,$3,'Synthetic reviewer','ACTIVE',$4,$4)`,
      [user, identity.issuer, identity.subject, now],
    );
    await pool.query(
      `INSERT INTO operations_access_grants (id,operations_user_id,permission_code,scope_kind,organization_id,active,granted_at,created_at,updated_at) VALUES ($1,$2,'PATIENT_READ','ORGANIZATION',$3,true,$4,$4,$4)`,
      [randomUUID(), user, org, now],
    );
    request = {
      contractVersion: '1.0',
      personId,
      localPatientId: patient.localResourceId,
      requesterLocalActorId: batch.actors[0]!.localActorId,
      reasonCode: 'CARE_DELIVERY',
      fromDate: '2026-08-01',
      toDate: '2026-09-17',
      limit: 50,
    };
    app = await buildApp({
      config,
      database: { pool, check: async () => {}, close: async () => {} },
      operationsTokenVerifier: {
        async verify(header) {
          if (header !== 'Bearer operations-test')
            throw new OperationsAuthenticationError(
              'INVALID_OPERATIONS_TOKEN',
              401,
            );
          return identity;
        },
      },
    });
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  it('retrieves every synchronized clinical domain with canonical identity, provenance and all child content', async () => {
    const result = await read();
    expect(isHistoryPage(result)).toBe(true);
    expect(new Set(result.items.map((i) => i.resourceType))).toEqual(
      new Set(historyResourceTypes),
    );
    expect(result.patient).toMatchObject({
      personId,
      displayName: 'Synthetic Lifestyle Example',
      dateOfBirth: '1985-04-12',
    });
    expect(
      result.items.find((i) => i.resourceType === 'VITALS')?.data.readings,
    ).toEqual([
      expect.objectContaining({ systolicMmhg: 122, diastolicMmhg: 78 }),
    ]);
    expect(
      result.items.find((i) => i.resourceType === 'LIFESTYLE')?.data.baselines,
    ).toHaveProperty('alcohol');
    expect(
      result.items.find((i) => i.resourceType === 'FOOD')?.data.rows,
    ).not.toHaveLength(0);
    expect(
      result.items.find((i) => i.resourceType === 'OTC')?.data.rows,
    ).not.toHaveLength(0);
    expect(
      result.items.find((i) => i.resourceType === 'REFERRAL_FOLLOWUP')?.data
        .medicationChanges,
    ).not.toHaveLength(0);
    expect(
      result.items.find((i) => i.resourceType === 'ENCOUNTER_REVIEW_FLAG')
        ?.data,
    ).toMatchObject({ currentStatus: 'RESOLVED', latestSequenceNumber: 2 });
    expect(
      result.items.find((i) => i.resourceType === 'ENCOUNTER_ADDENDUM')?.data
        .noteText,
    ).toBe('Synthetic late clarification');
    expect(result.items.every((i) => i.source.organizationId === org)).toBe(
      true,
    );
    expect(new Set(result.items.map((i) => i.source.installationId))).toEqual(
      new Set([source.installationId, second.installationId]),
    );
    expect(
      result.items.some(
        (i) => i.source.installationId === external.installationId,
      ),
    ).toBe(false);
    const json = JSON.stringify(result);
    for (const forbidden of [
      'source_content_hash',
      'contentHash',
      'localResourceId',
      'localPatientId',
      'token_hash',
      request.localPatientId,
    ])
      expect(json).not.toContain(forbidden);
  });
  it('requires a confirmed local patient link and active attributed actor, never Medical ID possession', async () => {
    await expect(read({ localPatientId: randomUUID() })).rejects.toMatchObject({
      code: 'HISTORY_NOT_AVAILABLE',
    });
    await expect(read({ personId: randomUUID() })).rejects.toMatchObject({
      code: 'HISTORY_NOT_AVAILABLE',
    });
    await expect(
      read({ requesterLocalActorId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'HISTORY_ACCESS_DENIED' });
    await pool.query(
      'UPDATE practitioner_source_links SET source_active=false WHERE installation_id=$1 AND source_actor_local_id=$2',
      [source.installationId, request.requesterLocalActorId],
    );
    try {
      await expect(read()).rejects.toMatchObject({
        code: 'HISTORY_ACCESS_DENIED',
      });
    } finally {
      await pool.query(
        'UPDATE practitioner_source_links SET source_active=true WHERE installation_id=$1',
        [source.installationId],
      );
    }
  });
  it('paginates tied timestamps without omissions or duplicates and repeats an interrupted page exactly', async () => {
    const all = await read();
    let next: string | undefined;
    const ids: string[] = [];
    do {
      const page = await read({ limit: 2, ...(next ? { cursor: next } : {}) });
      ids.push(...page.items.map((i) => i.resourceId));
      if (next) expect(await read({ limit: 2, cursor: next })).toEqual(page);
      next = page.nextCursor ?? undefined;
    } while (next);
    expect(ids).toEqual(all.items.map((i) => i.resourceId));
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('binds cursors to caller, patient, reason, dates, domains and expiry', async () => {
    const first = await read({ limit: 1 });
    const cursor = first.nextCursor!;
    for (const change of [
      { reasonCode: 'PATIENT_REQUEST' as const },
      { fromDate: '2026-08-02' },
      { resourceTypes: ['FOOD' as const] },
      { limit: 2 },
    ])
      await expect(read({ limit: 1, cursor, ...change })).rejects.toMatchObject(
        { code: 'HISTORY_CURSOR_STALE' },
      );
    await expect(
      read({ limit: 1, cursor: randomUUID() }),
    ).rejects.toMatchObject({ code: 'HISTORY_CURSOR_STALE' });
    await expect(
      read({ limit: 1, cursor }, new Date(now.getTime() + 16 * 60_000)),
    ).rejects.toMatchObject({ code: 'HISTORY_CURSOR_STALE' });
    await expect(
      readPatientHistory(
        pool,
        { kind: 'INSTALLATION', authorization: `Bearer ${secondToken}` },
        { ...request, limit: 1, cursor },
        audit,
        now,
      ),
    ).rejects.toMatchObject({ code: 'HISTORY_CURSOR_STALE' });
  });
  it('rejects continuation after credential revocation, installation suspension or operations grant removal', async () => {
    const first = await read({ limit: 1 });
    await pool.query(
      "UPDATE desktop_installation_credentials SET status='REVOKED',revoked_at=$2 WHERE installation_id=$1",
      [source.installationId, now],
    );
    try {
      await expect(
        read({ limit: 1, cursor: first.nextCursor! }),
      ).rejects.toMatchObject({ code: 'INVALID_INSTALLATION_TOKEN' });
    } finally {
      await pool.query(
        "UPDATE desktop_installation_credentials SET status='ACTIVE',revoked_at=NULL WHERE installation_id=$1",
        [source.installationId],
      );
    }
    await pool.query(
      "UPDATE desktop_installations SET status='SUSPENDED' WHERE id=$1",
      [source.installationId],
    );
    try {
      await expect(read()).rejects.toMatchObject({
        code: 'INVALID_INSTALLATION_TOKEN',
      });
    } finally {
      await pool.query(
        "UPDATE desktop_installations SET status='ACTIVE' WHERE id=$1",
        [source.installationId],
      );
    }
    const {
      localPatientId: _local,
      requesterLocalActorId: _actor,
      ...webRequest
    } = request;
    const webFirst = await readPatientHistory(
      pool,
      { kind: 'OPERATIONS', identity },
      { ...webRequest, limit: 1 },
      audit,
      now,
    );
    await pool.query(
      'UPDATE operations_access_grants SET active=false WHERE operations_user_id=$1',
      [user],
    );
    try {
      await expect(
        readPatientHistory(
          pool,
          { kind: 'OPERATIONS', identity },
          { ...webRequest, limit: 1, cursor: webFirst.nextCursor! },
          audit,
          now,
        ),
      ).rejects.toMatchObject({ code: 'PATIENT_READ_NOT_PERMITTED' });
    } finally {
      await pool.query(
        'UPDATE operations_access_grants SET active=true WHERE operations_user_id=$1',
        [user],
      );
    }
  });
  it('blocks unresolved identity conflicts for an otherwise linked patient', async () => {
    const reviewId = randomUUID();
    await pool.query(
      `INSERT INTO identity_review_cases (id,installation_id,local_patient_id,status,opened_at,created_at,updated_at) VALUES ($1,$2,$3,'OPEN',$4,$4,$4)`,
      [reviewId, source.installationId, request.localPatientId, now],
    );
    try {
      await expect(read()).rejects.toMatchObject({
        code: 'HISTORY_IDENTITY_REVIEW_REQUIRED',
      });
    } finally {
      await pool.query('DELETE FROM identity_review_cases WHERE id=$1', [
        reviewId,
      ]);
    }
  });
  it('allows a resolved identity even while its immutable upload outcome remains review-required', async () => {
    const reviewId = randomUUID();
    await pool.query(
      `INSERT INTO identity_review_cases
      (id,installation_id,local_patient_id,status,opened_at,resolved_at,resolved_person_id,created_at,updated_at)
      VALUES ($1,$2,$3,'RESOLVED_EXISTING',$4,$4,$5,$4,$4)`,
      [reviewId, source.installationId, request.localPatientId, now, personId],
    );
    await pool.query(
      `UPDATE sync_records SET status='REVIEW_REQUIRED',person_id=NULL,identity_review_case_id=$2
      WHERE installation_id=$1 AND resource_type='PATIENT'`,
      [source.installationId, reviewId],
    );
    try {
      expect((await read()).personId).toBe(personId);
    } finally {
      await pool.query(
        `UPDATE sync_records SET status='ACCEPTED',person_id=$2,identity_review_case_id=NULL
        WHERE installation_id=$1 AND resource_type='PATIENT'`,
        [source.installationId, personId],
      );
      await pool.query('DELETE FROM identity_review_cases WHERE id=$1', [
        reviewId,
      ]);
    }
  });
  it('blocks a newer rejected patient identity instead of trusting the older accepted link', async () => {
    await pool.query(
      `UPDATE sync_records SET status='REJECTED',person_id=NULL,source_revision=source_revision+1
      WHERE installation_id=$1 AND resource_type='PATIENT'`,
      [source.installationId],
    );
    try {
      await expect(read()).rejects.toMatchObject({
        code: 'HISTORY_IDENTITY_REVIEW_REQUIRED',
      });
    } finally {
      await pool.query(
        `UPDATE sync_records SET status='ACCEPTED',person_id=$2,source_revision=source_revision-1
        WHERE installation_id=$1 AND resource_type='PATIENT'`,
        [source.installationId, personId],
      );
    }
  });
  it('filters dates and domains and returns a bounded empty page', async () => {
    expect(
      (await read({ resourceTypes: ['FOOD'] })).items.map(
        (i) => i.resourceType,
      ),
    ).toEqual(['FOOD']);
    expect(
      await read({ fromDate: '2025-01-01', toDate: '2025-01-02' }),
    ).toMatchObject({ items: [], nextCursor: null });
    await expect(read({ fromDate: '2020-01-01' })).rejects.toMatchObject({
      code: 'INVALID_HISTORY_DATE_RANGE',
    });
  });
  it('uses audited POST-only no-store routes, rejects client scope, and keeps clinical values out of audit metadata', async () => {
    const response = await app.inject({
      method: 'POST',
      url: audit.route,
      headers: { authorization: `Bearer ${token}` },
      payload: request,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(
      (await app.inject({ method: 'GET', url: audit.route })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: audit.route, payload: request }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: audit.route,
          headers: { authorization: `Bearer ${token}` },
          payload: { ...request, organizationIds: [otherOrg] },
        })
      ).statusCode,
    ).toBe(400);
    const {
      localPatientId: _local,
      requesterLocalActorId: _actor,
      ...webRequest
    } = request;
    const web = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/patients/history',
      headers: { authorization: 'Bearer operations-test' },
      payload: webRequest,
    });
    expect(web.statusCode).toBe(200);
    expect(web.headers['cache-control']).toBe('no-store');
    expect(isHistoryPage(web.json())).toBe(true);
    const events = await pool.query(
      "SELECT * FROM audit_events WHERE action_code='PATIENT_HISTORY_READ'",
    );
    expect(
      events.rows.some(
        (e) => e.outcome_code === 'SUCCESS' && e.practitioner_id,
      ),
    ).toBe(true);
    expect(events.rows.some((e) => e.outcome_code === 'DENIED')).toBe(true);
    const metadata = JSON.stringify(events.rows.map((e) => e.metadata));
    for (const text of [
      'Synthetic late clarification',
      request.localPatientId,
      personId,
      token,
    ])
      expect(metadata).not.toContain(text);
  });
  it('invalidates old pages on late history and source state changes and retains voided history', async () => {
    const first = await read({ limit: 1 });
    const note = (
      await fixture('encounter-history-batch-request')
    ).records.find((r) => r.resourceType === 'ENCOUNTER_ADDENDUM')!;
    expect(
      (
        await submitSyncBatch(
          pool,
          source,
          {
            ...batch,
            batchId: randomUUID(),
            records: [
              {
                ...note,
                recordId: randomUUID(),
                localResourceId: randomUUID(),
              },
            ],
          },
          { clock: () => new Date(now.getTime() + 1000) },
        )
      ).response.outcomes[0]?.status,
    ).toBe('ACCEPTED');
    await expect(
      read({ limit: 1, cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ code: 'HISTORY_CURSOR_STALE' });
    const refreshed = await read({ limit: 1 });
    await pool.query(
      "UPDATE screening_encounters SET status='VOID',void_reason='Synthetic duplicate',source_revision=source_revision+1 WHERE id=$1",
      [encounterId],
    );
    await expect(
      read({ limit: 1, cursor: refreshed.nextCursor! }),
    ).rejects.toMatchObject({ code: 'HISTORY_CURSOR_STALE' });
    const retained = await read({
      resourceTypes: [
        'ENCOUNTER_ADDENDUM',
        'ENCOUNTER_REVIEW_FLAG',
        'ENCOUNTER_REVIEW_STATUS',
      ],
    });
    expect(
      retained.items.every(
        (i) =>
          i.encounter.status === 'VOID' &&
          i.encounter.voidReason === 'Synthetic duplicate',
      ),
    ).toBe(true);
    expect(
      retained.items.find((i) => i.resourceType === 'ENCOUNTER_REVIEW_FLAG')
        ?.data.currentStatus,
    ).toBe('RESOLVED');
  });
});

async function seedInstallation(
  pool: pg.Pool,
  organizationId: string,
  batch: SyncBatchRequest,
): Promise<InstallationContext> {
  const time = '2026-08-01T00:00:00.000Z';
  const location = randomUUID(),
    protocol = randomUUID();
  await pool.query(
    `INSERT INTO organizations(id,identifier_system,identifier_value,name,organization_type_code,created_at,updated_at) VALUES ($1,'urn:synthetic:org',$1::text,'Synthetic program','PROGRAM',$2,$2) ON CONFLICT DO NOTHING`,
    [organizationId, time],
  );
  await pool.query(
    `INSERT INTO locations(id,organization_id,identifier_system,identifier_value,name,location_type_code,created_at,updated_at) VALUES ($1,$2,'urn:synthetic:location',$1::text,'Synthetic site','SCREENING_SITE',$3,$3)`,
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
async function issueToken(
  pool: pg.Pool,
  installationId: string,
): Promise<string> {
  const token = `chs_inst_v1_${randomBytes(32).toString('base64url')}`;
  await pool.query(
    `INSERT INTO desktop_installation_credentials(id,installation_id,token_prefix,token_hash,label,status,issued_at,created_at,updated_at) VALUES ($1,$2,$3,$4,'Synthetic test credential','ACTIVE',$5,$5,$5)`,
    [
      randomUUID(),
      installationId,
      installationTokenPrefix(token),
      installationTokenHash(token),
      '2026-08-01T00:00:00.000Z',
    ],
  );
  return token;
}
