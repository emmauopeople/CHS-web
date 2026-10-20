import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import {
  authorizeOperationsPermission,
  OperationsAuthorizationError,
} from './access.js';
import {
  OperationsAuthenticationError,
  type OperationsTokenVerifier,
} from './authentication.js';
import {
  AccountIdentityError,
  type AccountIdentity,
} from '../administration/account-identity.js';
import {
  accountActor,
  AccountAdministrationError,
  changeAccount,
  createAccount,
  listAccounts,
  staffPermissions,
} from './account-administration.js';

const reasonCode = 'ACCOUNT_ADMINISTRATION';
const uuid = { type: 'string', format: 'uuid' };
function schema(properties: Record<string, unknown>, required: string[] = []) {
  return {
    body: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reasonCode: { const: reasonCode, type: 'string' },
        ...properties,
      },
      required: ['reasonCode', ...required],
    },
  };
}
export async function registerAccountRoutes(
  app: FastifyInstance,
  dependencies: {
    database: Pool;
    tokenVerifier: OperationsTokenVerifier;
    identity: AccountIdentity | null;
  },
) {
  const { database, tokenVerifier, identity } = dependencies;
  function handler(
    action: string,
    operation: (
      body: Record<string, unknown>,
      principal: Awaited<ReturnType<typeof authorizeOperationsPermission>>,
      request: FastifyRequest,
    ) => Promise<unknown>,
  ) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      let actorId: string | null = null;
      reply.header('cache-control', 'no-store');
      try {
        const verified = await tokenVerifier.verify(
          request.headers.authorization,
        );
        const principal = await authorizeOperationsPermission(
          database,
          verified,
          'USER_MANAGE',
        );
        actorId = principal.operationsUserId;
        await accountActor(database, principal);
        return reply.send(
          await operation(
            request.body as Record<string, unknown>,
            principal,
            request,
          ),
        );
      } catch (error) {
        if (error instanceof OperationsAuthenticationError)
          return reply.code(error.statusCode).send({
            code: 'OPERATIONS_AUTHENTICATION_FAILED',
            requestId: request.id,
          });
        if (
          error instanceof OperationsAuthorizationError ||
          error instanceof AccountAdministrationError ||
          error instanceof AccountIdentityError
        ) {
          await database.query(
            `INSERT INTO audit_events(id,operations_user_id,action_code,entity_type,reason_code,request_id,occurred_at,outcome_code,metadata)
            VALUES($1,$2,$3,'OPERATIONS_USER',$4,$5,now(),$6,'{}')`,
            [
              randomUUID(),
              error instanceof OperationsAuthorizationError
                ? error.operationsUserId
              : actorId,
              action,
              reasonCode,
              request.id,
              error.statusCode === 403 ? 'DENIED' : 'ERROR',
            ],
          );
          return reply
            .code(error.statusCode)
            .send({ code: error.code, requestId: request.id });
        }
        throw error;
      }
    };
  }
  const provider = () => {
    if (!identity)
      throw new AccountIdentityError('ACCOUNT_IDENTITY_NOT_CONFIGURED');
    return identity;
  };
  app.post(
    '/api/v1/operations/accounts/search',
    {
      schema: schema({ page: { type: 'integer', minimum: 1, maximum: 10000 } }),
    },
    handler('ACCOUNT_LIST', async (body, principal, request) => {
      const result = await listAccounts(
        database,
        await accountActor(database, principal),
        Number(body.page ?? 1),
      );
      await database.query(
        `INSERT INTO audit_events(id,operations_user_id,action_code,entity_type,reason_code,request_id,occurred_at,outcome_code,metadata)
      VALUES($1,$2,'ACCOUNT_LIST','OPERATIONS_USER',$3,$4,now(),'SUCCESS','{}')`,
        [randomUUID(), principal.operationsUserId, reasonCode, request.id],
      );
      return result;
    }),
  );
  app.post(
    '/api/v1/operations/accounts/create',
    {
      schema: schema(
        {
          username: {
            type: 'string',
            pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$',
          },
          displayName: {
            type: 'string',
            minLength: 1,
            maxLength: 120,
            pattern: '\\S',
          },
          email: { type: 'string', format: 'email', maxLength: 254 },
          role: { type: 'string', enum: ['STAFF', 'ADMIN', 'SUPER_ADMIN'] },
          organizationId: uuid,
          permissions: {
            type: 'array',
            uniqueItems: true,
            maxItems: 6,
            items: { type: 'string', enum: staffPermissions },
          },
        },
        ['username', 'displayName', 'role', 'permissions'],
      ),
    },
    handler('ACCOUNT_CREATE', (body, principal, request) =>
      createAccount(
        database,
        provider(),
        principal,
        body as Parameters<typeof createAccount>[3],
        request.id,
      ),
    ),
  );
  app.post(
    '/api/v1/operations/accounts/change',
    {
      schema: schema(
        {
          id: uuid,
          action: {
            type: 'string',
            enum: ['SUSPEND', 'ACTIVATE', 'RESET_PASSWORD'],
          },
          confirmed: { type: 'boolean', const: true },
        },
        ['id', 'action', 'confirmed'],
      ),
    },
    handler('ACCOUNT_CHANGE', (body, principal, request) =>
      changeAccount(
        database,
        provider(),
        principal,
        body as Parameters<typeof changeAccount>[3],
        request.id,
      ),
    ),
  );
}
