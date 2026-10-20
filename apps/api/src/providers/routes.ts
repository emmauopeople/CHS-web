import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  authorizeOperationsPermission,
  OperationsAuthorizationError,
} from '../operations/access.js';
import {
  accountActor,
  AccountAdministrationError,
} from '../operations/account-administration.js';
import {
  OperationsAuthenticationError,
  type OperationsTokenVerifier,
  type VerifiedOperationsIdentity,
} from '../operations/authentication.js';
import { AccountIdentityError } from '../administration/account-identity.js';
import type { ProviderIdentity } from './identity.js';
import { ProviderAccessError } from './access.js';
import { readPatientHistory, HistoryError } from '../history/service.js';
import {
  operationsHistoryRequestSchema,
  type HistoryRequest,
} from '../../../../packages/contracts/src/patient-history.mjs';

const uuid = { type: 'string', format: 'uuid' };
const reason = { type: 'string', const: 'PROVIDER_ADMINISTRATION' };
const text = (max = 120, min = 1) => ({
  type: 'string',
  minLength: min,
  maxLength: max,
  pattern: '\\S',
});
const schema = (properties: Record<string, unknown>, required: string[]) => ({
  body: {
    type: 'object',
    additionalProperties: false,
    properties: { reasonCode: reason, ...properties },
    required: ['reasonCode', ...required],
  },
});
async function audit(
  db: Pick<Pool, 'query'> | PoolClient,
  actor: string | null,
  action: string,
  id: string | null,
  requestId: string,
  outcome = 'SUCCESS',
) {
  await db.query(
    `INSERT INTO audit_events(id,operations_user_id,action_code,entity_type,entity_id,reason_code,request_id,occurred_at,outcome_code,metadata)
 VALUES($1,$2,$3,'PROVIDER_ACCESS',$4,'PROVIDER_ADMINISTRATION',$5,now(),$6,'{}')`,
    [randomUUID(), actor, action, id, requestId, outcome],
  );
}
function expiry(value: unknown, maxDays: number) {
  const time = Date.parse(String(value));
  if (
    !Number.isFinite(time) ||
    time <= Date.now() ||
    time > Date.now() + maxDays * 86400000
  )
    throw new ProviderAccessError('PROVIDER_EXPIRY_INVALID', 400);
  return new Date(time);
}
export async function registerProviderRoutes(
  app: FastifyInstance,
  {
    database,
    tokenVerifier,
    identity,
  }: {
    database: Pool;
    tokenVerifier: OperationsTokenVerifier;
    identity: ProviderIdentity | null;
  },
) {
  const provider = () => {
    if (!identity)
      throw new ProviderAccessError('PROVIDER_IDENTITY_NOT_CONFIGURED', 503);
    return identity;
  };
  async function superAdmin(
    db: Pick<Pool, 'query'> | PoolClient,
    verified: VerifiedOperationsIdentity,
  ) {
    const principal = await authorizeOperationsPermission(
      db,
      verified,
      'USER_MANAGE',
    );
    const actor = await accountActor(db, principal);
    if (actor.role !== 'SUPER_ADMIN') throw new ProviderAccessError();
    return principal.operationsUserId;
  }
  const wrap =
    (
      action: string,
      operation: (
        body: Record<string, unknown>,
        verified: VerifiedOperationsIdentity,
        req: FastifyRequest,
      ) => Promise<unknown>,
    ) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
      try {
        return reply.send(
          await operation(
            req.body as Record<string, unknown>,
            await tokenVerifier.verify(req.headers.authorization),
            req,
          ),
        );
      } catch (error) {
        if (
          error instanceof OperationsAuthenticationError ||
          error instanceof OperationsAuthorizationError ||
          error instanceof AccountAdministrationError ||
          error instanceof AccountIdentityError ||
          error instanceof ProviderAccessError ||
          error instanceof HistoryError
        ) {
          await audit(
            database,
            error instanceof OperationsAuthorizationError
              ? error.operationsUserId
              : null,
            action,
            null,
            req.id,
            error.statusCode === 403 ? 'DENIED' : 'ERROR',
          );
          return reply
            .code(error.statusCode)
            .send({ code: error.code, requestId: req.id });
        }
        throw error;
      }
    };
  app.post(
    '/api/v1/providers/onboarding/request',
    {
      schema: schema(
        {
          organizationName: text(),
          registrationIdentifier: text(),
          contactEmail: { type: 'string', format: 'email', maxLength: 254 },
          purpose: text(1000, 10),
        },
        [
          'organizationName',
          'registrationIdentifier',
          'contactEmail',
          'purpose',
        ],
      ),
    },
    wrap('PROVIDER_REQUEST', async (body, verified, req) => {
      const db = await database.connect();
      try {
        await db.query('BEGIN');
        const result = await db.query(
          `INSERT INTO provider_requests(id,requester_issuer,requester_subject,organization_name,registration_identifier,contact_email,purpose)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(requester_issuer,requester_subject) WHERE status='PENDING' DO NOTHING RETURNING id`,
          [
            randomUUID(),
            verified.issuer,
            verified.subject,
            body.organizationName,
            body.registrationIdentifier,
            body.contactEmail,
            body.purpose,
          ],
        );
        if (!result.rowCount)
          throw new ProviderAccessError(
            'PROVIDER_REQUEST_ALREADY_PENDING',
            409,
          );
        const id = result.rows[0].id as string;
        await audit(db, null, 'PROVIDER_REQUEST', id, req.id);
        await db.query('COMMIT');
        return { id, status: 'PENDING' };
      } catch (e) {
        await db.query('ROLLBACK');
        throw e;
      } finally {
        db.release();
      }
    }),
  );
  app.post(
    '/api/v1/operations/providers/search',
    {
      schema: schema(
        { page: { type: 'integer', minimum: 1, maximum: 10000 } },
        [],
      ),
    },
    wrap('PROVIDER_LIST', async (body, verified, req) => {
      const actor = await superAdmin(database, verified);
      const page = Number(body.page ?? 1);
      const rows = await database.query(
        `SELECT r.id,r.organization_name AS "organizationName",r.registration_identifier AS "registrationIdentifier",r.contact_email AS "contactEmail",r.purpose,r.status,r.created_at AS "createdAt",
   c.id AS "clientId",c.oidc_client_id AS "oauthClientId",c.status AS "clientStatus",c.scopes,c.expires_at AS "expiresAt",
   COALESCE((SELECT jsonb_agg(g.organization_id) FROM provider_organization_grants g WHERE g.client_id=c.id),'[]') AS "organizationIds"
   FROM provider_requests r LEFT JOIN provider_clients c ON c.request_id=r.id ORDER BY r.created_at DESC,r.id LIMIT 51 OFFSET $1`,
        [(page - 1) * 50],
      );
      const orgs = await database.query(
        'SELECT id,name FROM organizations WHERE active ORDER BY name,id LIMIT 500',
      );
      await audit(database, actor, 'PROVIDER_LIST', null, req.id);
      return {
        items: rows.rows.slice(0, 50),
        hasMore: rows.rows.length > 50,
        page,
        organizations: orgs.rows,
      };
    }),
  );
  app.post(
    '/api/v1/operations/providers/review',
    {
      schema: schema(
        {
          id: uuid,
          decision: { type: 'string', enum: ['APPROVE', 'REJECT'] },
          reviewReason: text(500, 10),
          organizationIds: {
            type: 'array',
            uniqueItems: true,
            minItems: 1,
            maxItems: 20,
            items: uuid,
          },
          scopes: {
            type: 'array',
            uniqueItems: true,
            minItems: 1,
            maxItems: 2,
            items: { type: 'string', enum: ['history:read', 'fhir:read'] },
          },
          expiresAt: { type: 'string', format: 'date-time' },
          confirmed: { const: true, type: 'boolean' },
        },
        ['id', 'decision', 'reviewReason', 'confirmed'],
      ),
    },
    wrap('PROVIDER_REVIEW', async (body, verified, req) => {
      const db = await database.connect();
      let created: string | undefined;
      try {
        await db.query('BEGIN');
        const actor = await superAdmin(db, verified);
        const result = await db.query(
          "SELECT id FROM provider_requests WHERE id=$1 AND status='PENDING' FOR UPDATE",
          [body.id],
        );
        if (!result.rowCount)
          throw new ProviderAccessError('PROVIDER_REQUEST_NOT_PENDING', 409);
        if (body.decision === 'REJECT') {
          await db.query(
            "UPDATE provider_requests SET status='REJECTED',reviewed_by=$2,review_reason=$3,reviewed_at=now() WHERE id=$1",
            [body.id, actor, body.reviewReason],
          );
          await audit(db, actor, 'PROVIDER_REJECT', String(body.id), req.id);
          await db.query('COMMIT');
          return { id: body.id, status: 'REJECTED' };
        }
        if (
          !Array.isArray(body.organizationIds) ||
          !Array.isArray(body.scopes) ||
          !body.scopes.length
        )
          throw new ProviderAccessError(
            'PROVIDER_APPROVAL_SCOPE_REQUIRED',
            400,
          );
        const until = expiry(body.expiresAt, 366);
        const orgs = await db.query(
          'SELECT id FROM organizations WHERE active AND id=ANY($1::uuid[]) FOR SHARE',
          [body.organizationIds],
        );
        if (orgs.rowCount !== body.organizationIds.length)
          throw new ProviderAccessError('PROVIDER_SCOPE_INVALID', 400);
        const id = randomUUID(),
          clientId = `chs-provider-${id}`;
        const account = await provider().create(clientId);
        created = account.identityClientId;
        await db.query(
          `INSERT INTO provider_clients(id,request_id,oidc_issuer,oidc_subject,oidc_client_id,identity_client_id,status,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,'ACTIVE',$7,$8)`,
          [
            id,
            body.id,
            verified.issuer,
            account.subject,
            clientId,
            account.identityClientId,
            body.scopes,
            until,
          ],
        );
        for (const org of body.organizationIds)
          await db.query(
            'INSERT INTO provider_organization_grants(client_id,organization_id) VALUES($1,$2)',
            [id, org],
          );
        await db.query(
          "UPDATE provider_requests SET status='APPROVED',reviewed_by=$2,review_reason=$3,reviewed_at=now() WHERE id=$1",
          [body.id, actor, body.reviewReason],
        );
        await audit(db, actor, 'PROVIDER_APPROVE', id, req.id);
        await db.query('COMMIT');
        created = undefined;
        return {
          id: body.id,
          status: 'APPROVED',
          clientId: id,
          oauthClientId: clientId,
          clientSecret: account.secret,
          tokenEndpoint: `${verified.issuer}/protocol/openid-connect/token`,
        };
      } catch (e) {
        await db.query('ROLLBACK');
        if (created) {
          try {
            await provider().remove(created);
          } catch {}
        }
        throw e;
      } finally {
        db.release();
      }
    }),
  );
  app.post(
    '/api/v1/operations/providers/credentials',
    {
      schema: schema(
        {
          clientId: uuid,
          action: { type: 'string', enum: ['ROTATE', 'REVOKE'] },
          confirmed: { const: true, type: 'boolean' },
        },
        ['clientId', 'action', 'confirmed'],
      ),
    },
    wrap('PROVIDER_CREDENTIAL', async (body, verified, req) => {
      const db = await database.connect();
      try {
        await db.query('BEGIN');
        const actor = await superAdmin(db, verified);
        const {
          rows: [client],
        } = await db.query(
          'SELECT * FROM provider_clients WHERE id=$1 FOR UPDATE',
          [body.clientId],
        );
        if (!client)
          throw new ProviderAccessError('PROVIDER_CLIENT_NOT_FOUND', 404);
        if (body.action === 'REVOKE') {
          await db.query(
            "UPDATE provider_clients SET status='REVOKED',updated_at=now() WHERE id=$1",
            [client.id],
          );
          await db.query(
            "UPDATE provider_requests SET status='SUSPENDED' WHERE id=$1",
            [client.request_id],
          );
          await audit(db, actor, 'PROVIDER_REVOKE', client.id, req.id);
          await db.query('COMMIT');
          await provider().revoke(client.identity_client_id);
          return { clientId: client.id, status: 'REVOKED' };
        }
        if (client.status !== 'ACTIVE')
          throw new ProviderAccessError('PROVIDER_CLIENT_REVOKED', 409);
        const secret = await provider().rotate(client.identity_client_id);
        await db.query(
          'UPDATE provider_clients SET tokens_valid_after=clock_timestamp(),updated_at=now() WHERE id=$1',
          [client.id],
        );
        await audit(db, actor, 'PROVIDER_ROTATE', client.id, req.id);
        await db.query('COMMIT');
        return {
          clientId: client.id,
          oauthClientId: client.oidc_client_id,
          clientSecret: secret,
          tokenEndpoint: `${verified.issuer}/protocol/openid-connect/token`,
        };
      } catch (e) {
        await db.query('ROLLBACK');
        throw e;
      } finally {
        db.release();
      }
    }),
  );
  app.post(
    '/api/v1/operations/providers/patient-access',
    {
      schema: schema(
        {
          clientId: uuid,
          personId: uuid,
          action: { type: 'string', enum: ['GRANT', 'REVOKE'] },
          basis: text(500, 10),
          expiresAt: { type: 'string', format: 'date-time' },
          confirmed: { type: 'boolean', const: true },
        },
        ['clientId', 'personId', 'action', 'basis', 'confirmed'],
      ),
    },
    wrap('PROVIDER_PATIENT_ACCESS', async (body, verified, req) => {
      const db = await database.connect();
      try {
        await db.query('BEGIN');
        const actor = await superAdmin(db, verified);
        const client = await db.query(
          "SELECT id FROM provider_clients WHERE id=$1 AND status='ACTIVE' AND expires_at>now() FOR UPDATE",
          [body.clientId],
        );
        if (!client.rowCount)
          throw new ProviderAccessError('PROVIDER_CLIENT_NOT_FOUND', 404);
        if (body.action === 'GRANT') {
          const until = expiry(body.expiresAt, 90);
          const eligible = await db.query(
            `SELECT 1 FROM patient_source_links p JOIN desktop_installations i ON i.id=p.installation_id
      JOIN provider_organization_grants g ON g.organization_id=i.organization_id WHERE g.client_id=$1 AND p.person_id=$2 LIMIT 1`,
            [body.clientId, body.personId],
          );
          if (!eligible.rowCount)
            throw new ProviderAccessError('PROVIDER_PATIENT_NOT_IN_SCOPE', 404);
          await db.query(
            `INSERT INTO provider_patient_grants(client_id,person_id,basis,granted_by,expires_at) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(client_id,person_id) DO UPDATE SET basis=$3,granted_by=$4,expires_at=$5,active=true,updated_at=now()`,
            [body.clientId, body.personId, body.basis, actor, until],
          );
        } else
          await db.query(
            'UPDATE provider_patient_grants SET active=false,updated_at=now() WHERE client_id=$1 AND person_id=$2',
            [body.clientId, body.personId],
          );
        await audit(
          db,
          actor,
          `PROVIDER_PATIENT_${body.action}`,
          String(body.personId),
          req.id,
        );
        await db.query('COMMIT');
        return {
          clientId: body.clientId,
          personId: body.personId,
          active: body.action === 'GRANT',
        };
      } catch (e) {
        await db.query('ROLLBACK');
        throw e;
      } finally {
        db.release();
      }
    }),
  );
  app.post<{ Body: HistoryRequest }>(
    '/api/v1/providers/patients/history',
    { schema: { body: operationsHistoryRequestSchema } },
    wrap('PROVIDER_HISTORY', async (body, verified, req) =>
      readPatientHistory(
        database,
        { kind: 'PROVIDER', identity: verified },
        body as unknown as HistoryRequest,
        { requestId: req.id, route: '/api/v1/providers/patients/history' },
      ),
    ),
  );
}
