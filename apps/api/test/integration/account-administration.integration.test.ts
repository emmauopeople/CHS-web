import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { provisionScreeningContext } from '../../src/administration/screening-context-provisioning.js';
import { OperationsAuthenticationError } from '../../src/operations/authentication.js';
import { staffPermissions } from '../../src/operations/account-administration.js';

const integration = process.env.DATABASE_TEST_URL ? describe : describe.skip;
integration(
  'CHS account administration role and organization boundaries',
  () => {
    const schema = `chs_accounts_${randomUUID().replaceAll('-', '')}`;
    const issuer = 'https://identity.test/realms/chs';
    let root: pg.Pool, pool: pg.Pool, app: Awaited<ReturnType<typeof buildApp>>;
    let orgA: string, orgB: string;
    const ids = new Map<string, string>();
    const provider = {
      create: vi.fn(async () => randomUUID()),
      enable: vi.fn(async () => {}),
      resetPassword: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };
    async function account(
      subject: string,
      role: string,
      org: string | null,
      permissions: string[],
      status = 'ACTIVE',
    ) {
      const id = randomUUID();
      ids.set(subject, id);
      await pool.query(
        `INSERT INTO operations_users(id,oidc_issuer,oidc_subject,display_name,status,account_role,username,created_at,updated_at)
      VALUES($1,$2,$3,$3,$4,$5,$3,now(),now())`,
        [id, issuer, subject, status, role],
      );
      for (const p of permissions)
        await pool.query(
          `INSERT INTO operations_access_grants
      (id,operations_user_id,permission_code,scope_kind,organization_id,active,granted_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,true,now(),now(),now())`,
          [randomUUID(), id, p, org ? 'ORGANIZATION' : 'GLOBAL', org],
        );
      return id;
    }
    async function call(action: string, body: object = {}, subject = 'root') {
      return app.inject({
        method: 'POST',
        url: `/api/v1/operations/accounts/${action}`,
        headers: subject ? { authorization: `Bearer ${subject}` } : {},
        payload: { reasonCode: 'ACCOUNT_ADMINISTRATION', ...body },
      });
    }
    const creation = (extra: object = {}) => ({
      username: `staff-${randomUUID().slice(0, 8)}`,
      displayName: 'New Staff',
      role: 'STAFF',
      organizationId: orgA,
      permissions: ['PATIENT_READ'],
      ...extra,
    });
    beforeAll(async () => {
      root = new pg.Pool({ connectionString: process.env.DATABASE_TEST_URL });
      const db = await root.connect();
      try {
        await db.query(`CREATE SCHEMA "${schema}"`);
        await db.query(`SET search_path TO "${schema}"`);
        await migrateWithClient({ client: db, logger: { info() {} } });
      } finally {
        db.release();
      }
      pool = new pg.Pool({
        connectionString: process.env.DATABASE_TEST_URL,
        options: `-c search_path=${schema}`,
      });
      const org = async (name: string) =>
        (
          await provisionScreeningContext(pool, {
            organizationIdentifierSystem: 'urn:test',
            organizationIdentifierValue: name,
            organizationName: name,
            organizationTypeCode: 'SCREENING_PROGRAM',
            locationIdentifierSystem: 'urn:test',
            locationIdentifierValue: name,
            locationName: name,
            locationTypeCode: 'SCREENING_SITE',
            physicalTypeCode: null,
            village: null,
            subdivision: null,
            region: null,
            directions: null,
            operatorIdentifier: 'test',
            reasonCode: 'TEST_SETUP',
          })
        ).organizationId;
      orgA = await org('First');
      orgB = await org('Second');
      await account('root', 'SUPER_ADMIN', null, [
        ...staffPermissions,
        'USER_MANAGE',
      ]);
      await account('admin', 'ADMIN', orgA, [
        ...staffPermissions,
        'USER_MANAGE',
      ]);
      await account('outsider', 'ADMIN', orgB, [
        ...staffPermissions,
        'USER_MANAGE',
      ]);
      await account('reader', 'STAFF', orgA, ['PATIENT_READ']);
      await account('forged', 'STAFF', orgA, ['USER_MANAGE']);
      await account(
        'suspended',
        'SUPER_ADMIN',
        null,
        ['USER_MANAGE'],
        'SUSPENDED',
      );
      app = await buildApp({
        config: loadConfig({
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://unused',
          LOG_LEVEL: 'silent',
        }),
        database: { pool, check: async () => {}, close: async () => {} },
        accountIdentity: provider,
        operationsTokenVerifier: {
          async verify(header) {
            if (!header)
              throw new OperationsAuthenticationError(
                'OPERATIONS_TOKEN_REQUIRED',
                401,
              );
            return {
              issuer,
              subject: header.replace('Bearer ', ''),
              sessionId: 'test',
              authorizedParty: 'test',
            };
          },
        },
      });
    }, 30000);
    afterAll(async () => {
      await app?.close();
      await pool?.end();
      if (root) {
        await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await root.end();
      }
    });
    it('requires authentication, permission, active status and an admin role', async () => {
      expect((await call('search', {}, '')).statusCode).toBe(401);
      for (const subject of ['reader', 'forged', 'suspended'])
        expect((await call('search', {}, subject)).statusCode).toBe(403);
      expect(
        (await call('create', creation({ permissions: ['USER_MANAGE'] })))
          .statusCode,
      ).toBe(400);
      expect(
        (await call('create', creation({ operatorIdentifier: 'spoof' })))
          .statusCode,
      ).toBe(400);
    });
    it('allows admins to create scoped staff but never admins or accounts in another organization', async () => {
      const before = provider.create.mock.calls.length;
      expect(
        (await call('create', creation({ role: 'ADMIN' }), 'admin')).statusCode,
      ).toBe(403);
      expect(
        (await call('create', creation({ organizationId: orgB }), 'admin'))
          .statusCode,
      ).toBe(403);
      expect(provider.create.mock.calls.length).toBe(before);
      const response = await call('create', creation(), 'admin');
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json().temporaryPassword.length).toBeGreaterThan(24);
      expect(response.json().requiresPasswordChange).toBe(true);
      const row = await pool.query(
        'SELECT account_role,status FROM operations_users WHERE id=$1',
        [response.json().id],
      );
      expect(row.rows[0]).toEqual({ account_role: 'STAFF', status: 'ACTIVE' });
      const list = await call('search', {}, 'outsider');
      expect(
        list
          .json()
          .items.some((a: { id: string }) => a.id === response.json().id),
      ).toBe(false);
      expect(list.body).not.toContain(response.json().temporaryPassword);
    });
    it('gives new admins all operational permissions without keycloak administrator roles', async () => {
      const response = await call('create', creation({ role: 'ADMIN' }));
      expect(response.statusCode).toBe(200);
      const grants = await pool.query(
        'SELECT permission_code,organization_id FROM operations_access_grants WHERE operations_user_id=$1',
        [response.json().id],
      );
      expect(grants.rows.map((g) => g.permission_code).sort()).toEqual(
        [...staffPermissions, 'USER_MANAGE'].sort(),
      );
      expect(grants.rows.every((g) => g.organization_id === orgA)).toBe(true);
      expect(provider.create).toHaveBeenCalled();
    });
    it('protects admin accounts, other scopes and self changes on every mutation', async () => {
      for (const subject of ['admin', 'outsider', 'root']) {
        const response = await call(
          'change',
          { id: ids.get(subject), action: 'SUSPEND', confirmed: true },
          'admin',
        );
        expect([403, 404]).toContain(response.statusCode);
      }
      expect(
        (
          await call('change', {
            id: ids.get('root'),
            action: 'SUSPEND',
            confirmed: true,
          })
        ).statusCode,
      ).toBe(403);
      const reset = await call(
        'change',
        { id: ids.get('reader'), action: 'RESET_PASSWORD', confirmed: true },
        'admin',
      );
      expect(reset.statusCode).toBe(200);
      expect(reset.json().temporaryPassword).toBeTruthy();
      const suspend = await call(
        'change',
        { id: ids.get('reader'), action: 'SUSPEND', confirmed: true },
        'admin',
      );
      expect(suspend.statusCode).toBe(200);
      expect(
        (
          await pool.query('SELECT status FROM operations_users WHERE id=$1', [
            ids.get('reader'),
          ])
        ).rows[0].status,
      ).toBe('SUSPENDED');
      expect(
        (
          await call(
            'change',
            { id: ids.get('reader'), action: 'ACTIVATE', confirmed: true },
            'admin',
          )
        ).statusCode,
      ).toBe(200);
    });
    it('bounds delegated staff permission lifetime by the administrator grant', async () => {
      const until = new Date(Date.now() + 3_600_000);
      await pool.query(
        "UPDATE operations_access_grants SET expires_at=$2 WHERE operations_user_id=$1 AND permission_code='PATIENT_READ'",
        [ids.get('admin'), until],
      );
      const response = await call('create', creation(), 'admin');
      expect(response.statusCode).toBe(200);
      const result = await pool.query(
        "SELECT expires_at FROM operations_access_grants WHERE operations_user_id=$1 AND permission_code='PATIENT_READ'",
        [response.json().id],
      );
      expect(result.rows[0].expires_at.toISOString()).toBe(until.toISOString());
    });
    it('rolls back an account and removes its new identity if activation fails', async () => {
      provider.enable.mockRejectedValueOnce(new Error('provider failure'));
      const input = creation();
      expect((await call('create', input)).statusCode).toBe(500);
      expect(
        (
          await pool.query(
            'SELECT id FROM operations_users WHERE username=$1',
            [input.username],
          )
        ).rowCount,
      ).toBe(0);
      expect(provider.remove).toHaveBeenCalled();
      const audits = await pool.query(
        "SELECT metadata FROM audit_events WHERE action_code='ACCOUNT_CREATE'",
      );
      expect(audits.rowCount).toBeGreaterThan(0);
      expect(JSON.stringify(audits.rows)).not.toContain('temporaryPassword');
    });
  },
);
