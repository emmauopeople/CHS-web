import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { OperationsAuthenticationError } from '../../src/operations/authentication.js';
import { provisionScreeningContext } from '../../src/administration/screening-context-provisioning.js';
import { provisionOperationsAccess } from '../../src/administration/operations-access-provisioning.js';
import { installationTokenHash } from '../../src/sync/installation-auth.js';

const integration = process.env.DATABASE_TEST_URL ? describe : describe.skip;
integration(
  'desktop installation management isolation and credential lifecycle',
  () => {
    const schema = `chs_installations_${randomUUID().replaceAll('-', '')}`;
    const issuer = 'https://identity.test/';
    const installationId = randomUUID();
    let root: pg.Pool;
    let pool: pg.Pool;
    let app: Awaited<ReturnType<typeof buildApp>>;
    let first: { organizationId: string; locationId: string };
    let second: { organizationId: string; locationId: string };
    let managerId: string;
    let credentialId: string;
    let token: string;
    const reasonCode = 'INSTALLATION_ADMINISTRATION';
    async function call(action: string, body: object, bearer = 'manager') {
      return app.inject({
        method: 'POST',
        url: `/api/v1/operations/desktop-installations/${action}`,
        headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
        payload: { reasonCode, ...body },
      });
    }
    beforeAll(async () => {
      root = new pg.Pool({ connectionString: process.env.DATABASE_TEST_URL });
      const client = await root.connect();
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
      const context = async (name: string) =>
        provisionScreeningContext(pool, {
          organizationIdentifierSystem: 'urn:test:organization',
          organizationIdentifierValue: name,
          organizationName: name,
          organizationTypeCode: 'SCREENING_PROGRAM',
          locationIdentifierSystem: 'urn:test:location',
          locationIdentifierValue: name,
          locationName: `${name} site`,
          locationTypeCode: 'SCREENING_SITE',
          physicalTypeCode: null,
          village: null,
          subdivision: null,
          region: null,
          directions: null,
          operatorIdentifier: 'test-operator',
          reasonCode: 'TEST_SETUP',
        });
      first = await context('First');
      second = await context('Second');
      for (const [subject, organizationId, permissionCode] of [
        ['manager', first.organizationId, 'DESKTOP_INSTALLATION_MANAGE'],
        ['outsider', second.organizationId, 'DESKTOP_INSTALLATION_MANAGE'],
        ['reader', first.organizationId, 'PATIENT_READ'],
      ] as const) {
        const result = await provisionOperationsAccess(pool, {
          oidcIssuer: issuer,
          oidcSubject: subject,
          displayName: subject,
          email: null,
          grants: [
            {
              permissionCode,
              scopeKind: 'ORGANIZATION',
              organizationId,
              expiresAt: null,
            },
          ],
          operatorIdentifier: 'test-operator',
          reasonCode: 'TEST_SETUP',
        });
        if (subject === 'manager') managerId = result.operationsUserId;
      }
      app = await buildApp({
        config: loadConfig({
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://unused',
          LOG_LEVEL: 'silent',
        }),
        database: {
          pool,
          check: async () => undefined,
          close: async () => undefined,
        },
        operationsTokenVerifier: {
          async verify(header) {
            if (!header)
              throw new OperationsAuthenticationError(
                'OPERATIONS_TOKEN_REQUIRED',
                401,
              );
            const subject = header.replace('Bearer ', '');
            if (!['manager', 'outsider', 'reader'].includes(subject))
              throw new OperationsAuthenticationError(
                'INVALID_OPERATIONS_TOKEN',
                401,
              );
            return {
              issuer,
              subject,
              sessionId: 'test-session',
              authorizedParty: 'test-web',
            };
          },
        },
      });
    }, 30_000);
    afterAll(async () => {
      await app?.close();
      await pool?.end();
      if (root) {
        await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await root.end();
      }
    });

    it('requires authentication and a dedicated permission; returns scoped location options', async () => {
      expect((await call('search', {}, '')).statusCode).toBe(401);
      expect((await call('search', {}, 'reader')).statusCode).toBe(403);
      const result = await call('search', {});
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(
        result
          .json()
          .locations.map(
            (row: { organizationId: string }) => row.organizationId,
          ),
      ).toEqual([first.organizationId]);
      expect(
        (await call('search', { operatorIdentifier: 'spoofed' })).statusCode,
      ).toBe(400);
    });
    it('enrolls once, records the authenticated actor, stores only the hash and hides secrets from listings', async () => {
      const input = {
        installationId,
        organizationId: first.organizationId,
        configuredLocationId: first.locationId,
        sourceLocationId: randomUUID(),
        deploymentName: 'Synthetic desktop',
        timezone: 'Africa/Douala',
        credentialLabel: 'First token',
        credentialExpiresAt: new Date(Date.now() + 86400000).toISOString(),
      };
      expect(
        (
          await call('enroll', {
            ...input,
            organizationId: second.organizationId,
            configuredLocationId: second.locationId,
          })
        ).statusCode,
      ).toBe(404);
      const response = await call('enroll', input);
      expect(response.statusCode).toBe(200);
      token = response.json().installationToken;
      credentialId = response.json().credentialId;
      expect(token).toMatch(/^chs_inst_v1_[A-Za-z0-9_-]{43}$/);
      const saved = await pool.query(
        'SELECT token_hash FROM desktop_installation_credentials WHERE id=$1',
        [credentialId],
      );
      expect(saved.rows[0].token_hash).toBe(installationTokenHash(token));
      const audit = await pool.query(
        "SELECT operations_user_id,request_id,metadata FROM audit_events WHERE action_code='DESKTOP_INSTALLATION_ENROLL'",
      );
      expect(audit.rows[0].operations_user_id).toBe(managerId);
      expect(JSON.stringify(audit.rows)).not.toContain(token);
      expect((await call('enroll', input)).statusCode).toBe(409);
      const list = await call('search', {});
      expect(list.body).not.toContain(token);
      expect(list.body).not.toContain('token_hash');
      expect(list.json().items).toHaveLength(1);
      expect((await call('search', {}, 'outsider')).json().items).toHaveLength(
        0,
      );
    });
    it('blocks cross-organization mutation, missing confirmation and stale rotation; rotation invalidates the old credential', async () => {
      const input = {
        installationId,
        expectedCredentialId: credentialId,
        credentialLabel: 'Rotated',
        credentialExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        confirmation: 'ROTATE_INSTALLATION_CREDENTIAL',
      };
      expect((await call('rotate', input, 'outsider')).statusCode).toBe(404);
      expect(
        (await call('rotate', { ...input, confirmation: 'wrong' })).statusCode,
      ).toBe(400);
      expect(
        (await call('rotate', { ...input, expectedCredentialId: randomUUID() }))
          .statusCode,
      ).toBe(409);
      const results = await Promise.all([
        call('rotate', input),
        call('rotate', input),
      ]);
      expect(results.map((result) => result.statusCode).sort()).toEqual([
        200, 409,
      ]);
      const success = results.find((result) => result.statusCode === 200)!;
      const old = await pool.query(
        'SELECT status FROM desktop_installation_credentials WHERE id=$1',
        [credentialId],
      );
      expect(old.rows[0].status).toBe('REVOKED');
      credentialId = success.json().credentialId;
      token = success.json().installationToken;
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM desktop_installation_credentials WHERE installation_id=$1 AND status='ACTIVE'",
            [installationId],
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it('revokes and can issue a guarded replacement after revocation without restoring the old token', async () => {
      expect(
        (
          await call(
            'revoke',
            {
              installationId,
              credentialId,
              confirmation: 'REVOKE_INSTALLATION_CREDENTIAL',
            },
            'outsider',
          )
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await call('revoke', {
            installationId,
            credentialId,
            confirmation: 'REVOKE_INSTALLATION_CREDENTIAL',
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await call('revoke', {
            installationId,
            credentialId,
            confirmation: 'REVOKE_INSTALLATION_CREDENTIAL',
          })
        ).json().kind,
      ).toBe('ALREADY_REVOKED');
      const result = await call('rotate', {
        installationId,
        expectedCredentialId: credentialId,
        credentialLabel: 'Recovered',
        credentialExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        confirmation: 'ROTATE_INSTALLATION_CREDENTIAL',
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().installationToken).not.toBe(token);
      const events = await pool.query(
        "SELECT operations_user_id,metadata FROM audit_events WHERE action_code IN ('DESKTOP_INSTALLATION_CREDENTIAL_ROTATE','DESKTOP_INSTALLATION_CREDENTIAL_REVOKE') AND outcome_code='SUCCESS'",
      );
      expect(events.rows.length).toBe(3);
      expect(
        events.rows.every((row) => row.operations_user_id === managerId),
      ).toBe(true);
      expect(JSON.stringify(events.rows)).not.toContain(token);
    });
  },
);
