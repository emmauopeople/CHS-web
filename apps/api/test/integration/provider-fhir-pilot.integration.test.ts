import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { submitSyncBatch } from '../../src/sync/batch-orchestrator.js';
import type {
  SyncBatchRequest,
  PatientSyncRecord,
  VitalsSyncRecord,
  SyncRecordSnapshot,
} from '../../src/sync/types.js';
import { seedInstallation } from '../helpers/pilot-fixtures.js';
import {
  publishNextPatient,
  createFhirTransport,
  type FhirTransport,
} from '../../src/fhir/publication.js';
import { loadFhirSnapshot } from '../../src/fhir/snapshot.js';
import { OperationsAuthenticationError } from '../../src/operations/authentication.js';
const run = process.env.DATABASE_TEST_URL ? describe : describe.skip;
run(
  'combined multi-installation pilot, provider approval and FHIR publication',
  () => {
    const schema = `chs_pilot_${randomUUID().replaceAll('-', '')}`;
    const org = randomUUID(),
      externalOrg = randomUUID();
    const issuer = 'https://identity.test/realms/chs',
      providerSubject = randomUUID();
    let oauthClientId = '';
    let root: pg.Pool,
      pool: pg.Pool,
      app: Awaited<ReturnType<typeof buildApp>>,
      personId: string,
      requestId: string,
      clientId: string;
    const memory = new Map<string, Record<string, unknown>>();
    let fail = false;
    const real = process.env.FHIR_TEST_BASE_URL
      ? createFhirTransport(process.env.FHIR_TEST_BASE_URL)
      : null;
    const transport: FhirTransport = {
      async transaction(bundle) {
        if (fail) throw new Error('simulated unavailable');
        const entries = (
          bundle as {
            entry: {
              resource?: Record<string, unknown>;
              request: { method: string; url: string };
            }[];
          }
        ).entry;
        if (real) await real.transaction(bundle);
        for (const e of entries) {
          if (e.resource) memory.set(e.request.url, e.resource);
          else memory.delete(e.request.url);
        }
      },
      async read(type, id) {
        if (real) return real.read(type, id);
        const r = memory.get(`${type}/${id}`);
        if (!r) throw new Error('missing fixture resource');
        return structuredClone(r);
      },
    };
    const identity = {
      create: vi.fn(async (id: string) => {
        oauthClientId = id;
        return {
          identityClientId: randomUUID(),
          subject: providerSubject,
          secret: 'synthetic-secret-' + randomUUID(),
        };
      }),
      rotate: vi.fn(async () => `rotated-${randomUUID()}`),
      revoke: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };
    const fixture = async (name: string): Promise<SyncBatchRequest> =>
      JSON.parse(
        await readFile(
          new URL(
            `../../../../packages/contracts/fixtures/sync/v1/valid/${name}.json`,
            import.meta.url,
          ),
          'utf8',
        ),
      );
    async function call(path: string, body: object, subject = 'root') {
      return app.inject({
        method: 'POST',
        url: path,
        headers: subject ? { authorization: `Bearer ${subject}` } : {},
        payload: body,
      });
    }
    const admin = (action: string, body: object = {}, subject = 'root') =>
      call(
        `/api/v1/operations/providers/${action}`,
        { reasonCode: 'PROVIDER_ADMINISTRATION', ...body },
        subject,
      );
    beforeAll(async () => {
      const url = new URL(process.env.DATABASE_TEST_URL!);
      if (!/_tests?$/.test(url.pathname))
        throw new Error('Use a test-named database');
      root = new pg.Pool({ connectionString: url.href });
      const db = await root.connect();
      try {
        await db.query(`CREATE SCHEMA "${schema}"`);
        await db.query(`SET search_path TO "${schema}"`);
        await migrateWithClient({ client: db, logger: { info() {} } });
      } finally {
        db.release();
      }
      pool = new pg.Pool({
        connectionString: url.href,
        options: `-c search_path=${schema}`,
        max: 5,
      });
      const original = await fixture('lifestyle-batch-request');
      const batch: SyncBatchRequest = {
        ...original,
        batchId: randomUUID(),
        records: original.records.map((record) =>
          record.resourceType === 'PATIENT'
            ? {
                ...record,
                payload: {
                  ...(record as PatientSyncRecord).payload,
                  knownChsMedicalId: null,
                },
              }
            : record,
        ),
      };
      const source = await seedInstallation(pool, org, batch);
      const first = await submitSyncBatch(pool, source, batch);
      expect(
        first.response.outcomes.every((o) => o.status === 'ACCEPTED'),
      ).toBe(true);
      personId = first.response.outcomes.find(
        (o) => o.resourceType === 'PATIENT',
      )!.canonicalResourceId!;
      const medical = (
        await pool.query(
          'SELECT identifier_value FROM person_identifiers WHERE person_id=$1',
          [personId],
        )
      ).rows[0].identifier_value as string;
      const extra: SyncRecordSnapshot[] = [];
      const v = (await fixture('batch-request')).records.find(
        (r) => r.resourceType === 'VITALS',
      )! as VitalsSyncRecord;
      const vital: VitalsSyncRecord = {
        ...v,
        sourceActorLocalId: batch.actors[0]!.localActorId,
        payload: {
          ...v.payload,
          localEncounterId: '92000000-0000-4000-8000-000000000001',
          performedByLocalActorId: batch.actors[0]!.localActorId,
          createdAt: '2026-08-20T14:25:00.000Z',
          updatedAt: '2026-08-20T14:25:00.000Z',
          readings: v.payload.readings.map((r) => ({
            ...r,
            measurementLocalDate: '2026-08-20',
            measurementLocalTime: '15:25',
            createdAt: '2026-08-20T14:25:00.000Z',
            updatedAt: '2026-08-20T14:25:00.000Z',
          })),
        },
      };
      extra.push(vital);
      for (const name of [
        'food-otc-batch-request',
        'referral-batch-request',
        'encounter-history-batch-request',
      ])
        extra.push(...(await fixture(name)).records);
      const uploaded = await submitSyncBatch(pool, source, {
        ...batch,
        batchId: randomUUID(),
        records: extra,
      });
      expect(
        uploaded.response.outcomes.every((o) => o.status === 'ACCEPTED'),
      ).toBe(true);
      // Exact replay cannot create duplicate canonical data.
      const replay = await submitSyncBatch(pool, source, batch);
      expect(replay.response).toEqual(first.response);
      for (const organizationId of [org, externalOrg]) {
        const peer: SyncBatchRequest = {
          ...structuredClone(batch),
          installationId: randomUUID(),
          batchId: randomUUID(),
          records: batch.records
            .filter((r) => r.resourceType !== 'LIFESTYLE')
            .map((r) =>
              r.resourceType === 'PATIENT'
                ? {
                    ...r,
                    payload: {
                      ...(r as PatientSyncRecord).payload,
                      knownChsMedicalId: medical,
                    },
                  }
                : r,
            ),
        };
        const context = await seedInstallation(pool, organizationId, peer);
        expect(
          (await submitSyncBatch(pool, context, peer)).response.outcomes.every(
            (o) => o.status === 'ACCEPTED',
          ),
        ).toBe(true);
      }
      for (const [subject, role] of [
        ['root', 'SUPER_ADMIN'],
        ['admin', 'ADMIN'],
      ]) {
        const id = randomUUID();
        await pool.query(
          `INSERT INTO operations_users(id,oidc_issuer,oidc_subject,display_name,status,account_role,created_at,updated_at) VALUES($1,$2,$3,$3,'ACTIVE',$4,now(),now())`,
          [id, issuer, subject, role],
        );
        await pool.query(
          `INSERT INTO operations_access_grants(id,operations_user_id,permission_code,scope_kind,organization_id,active,granted_at,created_at,updated_at) VALUES($1,$2,'USER_MANAGE','GLOBAL',NULL,true,now(),now(),now())`,
          [randomUUID(), id],
        );
      }
      app = await buildApp({
        config: loadConfig({
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://unused',
          LOG_LEVEL: 'silent',
        }),
        database: { pool, check: async () => {}, close: async () => {} },
        providerIdentity: identity,
        fhirTransport: transport,
        operationsTokenVerifier: {
          async verify(header) {
            if (!header)
              throw new OperationsAuthenticationError(
                'OPERATIONS_TOKEN_REQUIRED',
                401,
              );
            const subject = header.replace('Bearer ', '');
            return {
              issuer,
              subject: ['provider', 'provider-renewed', 'old-token'].includes(
                subject,
              )
                ? providerSubject
                : subject,
              sessionId: null,
              authorizedParty: [
                'provider',
                'provider-renewed',
                'old-token',
              ].includes(subject)
                ? oauthClientId
                : 'portal',
              issuedAt:
                subject === 'old-token'
                  ? 1
                  : Math.floor(Date.now() / 1000) +
                    (subject === 'provider-renewed' ? 4 : 2),
            };
          },
        },
      });
    }, 60000);
    afterAll(async () => {
      await app?.close();
      if (real && memory.size)
        await real.transaction({
          resourceType: 'Bundle',
          type: 'transaction',
          entry: [...memory.keys()].map((url) => ({
            request: { method: 'DELETE', url },
          })),
        });
      await pool?.end();
      if (root) {
        await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await root.end();
      }
    }, 60000);
    it('accepts a bounded authenticated hospital request and permits only super admin approval', async () => {
      const body = {
        reasonCode: 'PROVIDER_ADMINISTRATION',
        organizationName: 'Synthetic Hospital',
        registrationIdentifier: 'SYNTHETIC-123',
        contactEmail: 'integration@example.test',
        purpose: 'Synthetic continuity of care acceptance test',
      };
      expect(
        (await call('/api/v1/providers/onboarding/request', body, ''))
          .statusCode,
      ).toBe(401);
      const request = await call(
        '/api/v1/providers/onboarding/request',
        body,
        'applicant',
      );
      expect(request.statusCode).toBe(200);
      requestId = request.json().id;
      expect(
        (await call('/api/v1/providers/onboarding/request', body, 'applicant'))
          .statusCode,
      ).toBe(409);
      expect((await admin('search', {}, 'admin')).statusCode).toBe(403);
      const review = {
        id: requestId,
        decision: 'APPROVE',
        reviewReason: 'Verified synthetic hospital identity and agreement',
        organizationIds: [org],
        scopes: ['history:read', 'fhir:read'],
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        confirmed: true,
      };
      expect((await admin('review', review, 'admin')).statusCode).toBe(403);
      const result = await admin('review', review);
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store');
      clientId = result.json().clientId;
      expect(result.json().clientSecret).toBeTruthy();
      expect((await admin('search')).body).not.toContain(
        result.json().clientSecret,
      );
      expect((await admin('review', review)).statusCode).toBe(409);
    });
    it('requires explicit patient authorization and rejects spoofed scopes and expired tokens', async () => {
      const input = {
        contractVersion: '1.0',
        personId,
        reasonCode: 'CARE_DELIVERY',
        fromDate: '2026-08-01',
        toDate: '2026-09-30',
        limit: 50,
      };
      expect(
        (await call('/api/v1/providers/patients/history', input, 'provider'))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await admin('patient-access', {
            clientId,
            personId,
            action: 'GRANT',
            basis: 'Verified synthetic patient authorization',
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
            confirmed: true,
          })
        ).statusCode,
      ).toBe(200);
      const history = await call(
        '/api/v1/providers/patients/history',
        input,
        'provider',
      );
      expect(history.statusCode).toBe(200);
      expect((await admin('search', {}, 'provider')).statusCode).toBe(403);
      expect(
        (
          await call(
            '/api/v1/sync/batches',
            await fixture('lifestyle-batch-request'),
            'provider',
          )
        ).statusCode,
      ).toBe(401);
      await pool.query(
        "UPDATE provider_clients SET scopes=ARRAY['history:read'] WHERE id=$1",
        [clientId],
      );
      expect(
        (
          await call(
            '/api/v1/providers/fhir/patient',
            { personId, reasonCode: 'CARE_DELIVERY' },
            'provider',
          )
        ).statusCode,
      ).toBe(403);
      await pool.query(
        "UPDATE provider_clients SET scopes=ARRAY['history:read','fhir:read'] WHERE id=$1",
        [clientId],
      );
      await pool.query(
        "UPDATE provider_patient_grants SET expires_at=now()-interval '1 minute' WHERE client_id=$1 AND person_id=$2",
        [clientId, personId],
      );
      expect(
        (await call('/api/v1/providers/patients/history', input, 'provider'))
          .statusCode,
      ).toBe(403);
      await pool.query(
        "UPDATE provider_patient_grants SET expires_at=now()+interval '1 day' WHERE client_id=$1 AND person_id=$2",
        [clientId, personId],
      );
      const initial = await call(
        '/api/v1/providers/patients/history',
        { ...input, limit: 1 },
        'provider',
      );
      expect(initial.json().nextCursor).toBeTruthy();
      expect(
        (
          await call(
            '/api/v1/providers/patients/history',
            { ...input, limit: 1, cursor: initial.json().nextCursor },
            'provider-renewed',
          )
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await call(
            '/api/v1/providers/patients/history',
            { ...input, reasonCode: 'QUALITY_IMPROVEMENT' },
            'provider',
          )
        ).statusCode,
      ).toBe(403);
      expect(
        history
          .json()
          .items.every(
            (i: { source: { organizationId: string } }) =>
              i.source.organizationId === org,
          ),
      ).toBe(true);
      expect(
        (
          await call(
            '/api/v1/providers/patients/history',
            { ...input, organizationIds: [externalOrg] },
            'provider',
          )
        ).statusCode,
      ).toBe(400);
      expect(
        (await call('/api/v1/providers/patients/history', input, 'old-token'))
          .statusCode,
      ).toBe(403);
    });
    it('publishes linked R4 resources, handles retry independently of sync and hides other organizations', async () => {
      const before = (
        await pool.query('SELECT count(*) FROM screening_encounters')
      ).rows[0].count;
      fail = true;
      expect(await publishNextPatient(pool, transport)).toBe(true);
      expect(
        (
          await pool.query(
            'SELECT status FROM fhir_publish_queue WHERE person_id=$1',
            [personId],
          )
        ).rows[0].status,
      ).toBe('RETRY');
      expect(
        (await pool.query('SELECT count(*) FROM screening_encounters')).rows[0]
          .count,
      ).toBe(before);
      fail = false;
      await pool.query(
        'UPDATE fhir_publish_queue SET next_attempt_at=now() WHERE person_id=$1',
        [personId],
      );
      await publishNextPatient(pool, transport);
      const db = await pool.connect();
      try {
        const mapped = await loadFhirSnapshot(db, personId);
        expect(new Set(mapped.map((r) => r.resource.resourceType))).toEqual(
          new Set([
            'Patient',
            'Organization',
            'Location',
            'Encounter',
            'Provenance',
            'Observation',
            'ServiceRequest',
            'Task',
            'QuestionnaireResponse',
            'Communication',
            'Flag',
          ]),
        );
        if (real)
          for (const item of mapped) {
            const validation = await fetch(
              `${process.env.FHIR_TEST_BASE_URL}/${item.resource.resourceType}/$validate`,
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/fhir+json',
                  accept: 'application/fhir+json',
                },
                body: JSON.stringify(item.resource),
                signal: AbortSignal.timeout(60000),
              },
            );
            const outcome = (await validation.json()) as {
              issue?: { severity: string; diagnostics?: string }[];
            };
            expect(
              outcome.issue?.filter((i) =>
                ['error', 'fatal'].includes(i.severity),
              ),
              `${item.resource.resourceType} validation`,
            ).toEqual([]);
          }
      } finally {
        db.release();
      }
      const input = { personId, reasonCode: 'CARE_DELIVERY' };
      const first = await call(
        '/api/v1/providers/fhir/patient',
        input,
        'provider',
      );
      expect(first.statusCode).toBe(200);
      expect(first.body).not.toContain('http://fhir');
      const allowed = (
        await pool.query(
          'SELECT id FROM screening_encounters WHERE person_id=$1 AND organization_id=$2',
          [personId, org],
        )
      ).rows.map((r) => `chs-${r.id}`);
      const resources = first
        .json()
        .bundle.entry.map(
          (e: { resource: { resourceType: string; id: string } }) => e.resource,
        );
      expect(
        resources
          .filter(
            (r: { resourceType: string }) => r.resourceType === 'Encounter',
          )
          .every((r: { id: string }) => allowed.includes(r.id)),
      ).toBe(true);
      await pool.query(
        "UPDATE persons SET display_name=display_name||' updated',updated_at=now() WHERE id=$1",
        [personId],
      );
      expect(
        (await call('/api/v1/providers/fhir/patient', input, 'provider'))
          .statusCode,
      ).toBe(503);
      await publishNextPatient(pool, transport);
      expect(
        (
          await call(
            '/api/v1/providers/fhir/patient',
            { ...input, generation: first.json().generation },
            'provider',
          )
        ).statusCode,
      ).toBe(409);
    }, 180000);
    it('retains a concurrent source generation and recovers an expired worker lease', async () => {
      await pool.query(
        "UPDATE persons SET display_name=display_name||' next',updated_at=now() WHERE id=$1",
        [personId],
      );
      let changed = false;
      await publishNextPatient(pool, {
        ...transport,
        async transaction(bundle) {
          if (!changed) {
            changed = true;
            await pool.query(
              "UPDATE persons SET display_name=display_name||' concurrent',updated_at=now() WHERE id=$1",
              [personId],
            );
          }
          await transport.transaction(bundle);
        },
      });
      expect(
        (
          await pool.query(
            'SELECT status FROM fhir_publish_queue WHERE person_id=$1',
            [personId],
          )
        ).rows[0].status,
      ).toBe('PENDING');
      await pool.query(
        "UPDATE fhir_publish_queue SET status='PUBLISHING',lease_id=$2,lease_until=now()-interval '1 minute' WHERE person_id=$1",
        [personId, randomUUID()],
      );
      await publishNextPatient(pool, transport);
      const row = (
        await pool.query(
          'SELECT status,generation,published_generation FROM fhir_publish_queue WHERE person_id=$1',
          [personId],
        )
      ).rows[0];
      expect(row.status).toBe('PUBLISHED');
      expect(row.generation).toBe(row.published_generation);
    }, 60000);
    it('revokes an individual sharing grant and the whole provider immediately', async () => {
      expect(
        (
          await admin('patient-access', {
            clientId,
            personId,
            action: 'REVOKE',
            basis: 'Synthetic authorization withdrawn',
            confirmed: true,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await call(
            '/api/v1/providers/fhir/patient',
            { personId, reasonCode: 'CARE_DELIVERY' },
            'provider',
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await admin('credentials', {
            clientId,
            action: 'ROTATE',
            confirmed: true,
          })
        ).json().clientSecret,
      ).toBeTruthy();
      expect(
        (
          await admin('credentials', {
            clientId,
            action: 'REVOKE',
            confirmed: true,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await pool.query('SELECT status FROM provider_clients WHERE id=$1', [
            clientId,
          ])
        ).rows[0].status,
      ).toBe('REVOKED');
      const audit = (
        await pool.query(
          "SELECT metadata FROM audit_events WHERE entity_type='PROVIDER_ACCESS'",
        )
      ).rows;
      expect(JSON.stringify(audit)).not.toContain('synthetic-secret');
    });
  },
);
