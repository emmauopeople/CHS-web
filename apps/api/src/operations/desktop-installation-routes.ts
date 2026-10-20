import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import {
  authorizeOperationsPermission,
  OperationsAuthorizationError,
  type OperationsPrincipal,
} from './access.js';
import {
  OperationsAuthenticationError,
  type OperationsTokenVerifier,
} from './authentication.js';
import {
  enrollDesktopInstallation,
  parseDesktopInstallationEnrollmentInput,
  InstallationEnrollmentError,
} from '../administration/installation-enrollment.js';
import {
  rotateInstallationCredential,
  revokeInstallationCredential,
  parseRotateInstallationCredentialInput,
  parseRevokeInstallationCredentialInput,
  InstallationCredentialLifecycleError,
} from '../administration/installation-credential-lifecycle.js';

const reason = 'INSTALLATION_ADMINISTRATION';
const uuid = {
  type: 'string',
  pattern:
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
} as const;
const text = { type: 'string', minLength: 1, maxLength: 120 } as const;
const expiry = { type: 'string', minLength: 20, maxLength: 40 } as const;
const common = { reasonCode: { type: 'string', const: reason } } as const;
function schema(properties: Record<string, unknown>, required: string[]) {
  return {
    body: {
      type: 'object',
      additionalProperties: false,
      properties: { ...common, ...properties },
      required: ['reasonCode', ...required],
    },
  };
}
class ScopeError extends Error {
  readonly statusCode = 404;
  readonly code = 'INSTALLATION_NOT_FOUND';
}

function assertScope(principal: OperationsPrincipal, organizationId: string) {
  const scope = principal.patientAccessScope;
  if (
    scope.kind !== 'GLOBAL' &&
    !scope.organizationIds.includes(organizationId)
  )
    throw new ScopeError();
}

export async function registerDesktopInstallationRoutes(
  app: FastifyInstance,
  dependencies: { database: Pool; tokenVerifier: OperationsTokenVerifier },
) {
  const { database, tokenVerifier } = dependencies;
  async function audit(
    request: FastifyRequest,
    principal: OperationsPrincipal | null,
    action: string,
    outcome: string,
  ) {
    await database.query(
      `INSERT INTO audit_events
      (id, operations_user_id, action_code, entity_type, reason_code, request_id, occurred_at, outcome_code, metadata)
      VALUES ($1, $2, $3, 'DESKTOP_INSTALLATION', $4, $5, now(), $6, '{}'::jsonb)`,
      [
        randomUUID(),
        principal?.operationsUserId ?? null,
        action,
        reason,
        request.id,
        outcome,
      ],
    );
  }
  function handler(
    action: string,
    operation: (
      body: Record<string, unknown>,
      principal: OperationsPrincipal,
      request: FastifyRequest,
    ) => Promise<unknown>,
  ) {
    return async (
      request: FastifyRequest,
      reply: import('fastify').FastifyReply,
    ) => {
      let principal: OperationsPrincipal | null = null;
      reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
      try {
        const identity = await tokenVerifier.verify(
          request.headers.authorization,
        );
        principal = await authorizeOperationsPermission(
          database,
          identity,
          'DESKTOP_INSTALLATION_MANAGE',
        );
        const result = await operation(
          request.body as Record<string, unknown>,
          principal,
          request,
        );
        // Mutations already audit inside their own transaction, including actor and request ID.
        if (action === 'DESKTOP_INSTALLATION_LIST')
          await audit(request, principal, action, 'SUCCESS');
        return reply.send(result);
      } catch (error) {
        if (error instanceof OperationsAuthenticationError) {
          if (error.statusCode === 401)
            reply.header('www-authenticate', 'Bearer');
          return reply
            .code(error.statusCode)
            .send({
              code: 'OPERATIONS_AUTHENTICATION_FAILED',
              requestId: request.id,
            });
        }
        if (error instanceof OperationsAuthorizationError) {
          await database.query(
            `INSERT INTO audit_events
            (id, operations_user_id, action_code, entity_type, reason_code, request_id, occurred_at, outcome_code, metadata)
            VALUES ($1,$2,$3,'DESKTOP_INSTALLATION',$4,$5,now(),'DENIED',$6::jsonb)`,
            [
              randomUUID(),
              error.operationsUserId,
              action,
              reason,
              request.id,
              JSON.stringify({
                principalFingerprint: error.principalFingerprint,
              }),
            ],
          );
          return reply
            .code(403)
            .send({ code: error.code, requestId: request.id });
        }
        if (
          error instanceof ScopeError ||
          error instanceof InstallationEnrollmentError ||
          error instanceof InstallationCredentialLifecycleError
        ) {
          await audit(
            request,
            principal,
            action,
            error instanceof ScopeError ? 'NOT_FOUND' : 'ERROR',
          );
          const invalid = error.code.startsWith('INVALID_');
          const missing =
            error instanceof ScopeError || error.code.endsWith('_NOT_FOUND');
          // Never reveal another organization's installation or enrollment existence.
          const code =
            error.code === 'INSTALLATION_CONFLICT'
              ? 'INSTALLATION_UNAVAILABLE'
              : error.code;
          return reply
            .code(invalid ? 400 : missing ? 404 : 409)
            .send({ code, requestId: request.id });
        }
        throw error;
      }
    };
  }

  app.post(
    '/api/v1/operations/desktop-installations/search',
    {
      schema: schema(
        { page: { type: 'integer', minimum: 1, maximum: 10000 } },
        [],
      ),
    },
    handler('DESKTOP_INSTALLATION_LIST', async (body, principal) => {
      const scope = principal.patientAccessScope;
      const ids = scope.kind === 'GLOBAL' ? null : scope.organizationIds;
      const page = Number(body.page ?? 1);
      const installations = await database.query(
        `SELECT i.id, i.organization_id AS "organizationId",
      o.name AS "organizationName", l.name AS "locationName", i.configured_location_id AS "configuredLocationId",
      i.deployment_name AS "deploymentName", i.timezone, i.status, i.enrolled_at AS "enrolledAt", i.last_seen_at AS "lastSeenAt",
      c.id AS "credentialId", c.token_prefix AS "tokenPrefix", c.expires_at AS "credentialExpiresAt",
      CASE WHEN c.id IS NULL OR c.status='REVOKED' THEN 'REVOKED' WHEN c.expires_at <= now() THEN 'EXPIRED' ELSE 'ACTIVE' END AS "credentialStatus"
      FROM desktop_installations i JOIN organizations o ON o.id=i.organization_id
      JOIN locations l ON l.id=i.configured_location_id
      LEFT JOIN LATERAL (SELECT id, token_prefix, expires_at, status FROM desktop_installation_credentials
        WHERE installation_id=i.id ORDER BY (status='ACTIVE') DESC, issued_at DESC, id DESC LIMIT 1) c ON true
      WHERE ($1::uuid[] IS NULL OR i.organization_id=ANY($1::uuid[]))
      ORDER BY i.enrolled_at DESC, i.id LIMIT 51 OFFSET $2`,
        [ids, (page - 1) * 50],
      );
      const locations = await database.query(
        `SELECT l.id, l.organization_id AS "organizationId", l.name,
      o.name AS "organizationName" FROM locations l JOIN organizations o ON o.id=l.organization_id
      WHERE l.active AND o.active AND ($1::uuid[] IS NULL OR l.organization_id=ANY($1::uuid[])) ORDER BY o.name,l.name,l.id LIMIT 501`,
        [ids],
      );
      return {
        items: installations.rows.slice(0, 50),
        page,
        hasMore: installations.rows.length > 50,
        locations: locations.rows.slice(0, 500),
        locationsTruncated: locations.rows.length > 500,
      };
    }),
  );

  app.post(
    '/api/v1/operations/desktop-installations/enroll',
    {
      schema: schema(
        {
          installationId: uuid,
          organizationId: uuid,
          configuredLocationId: uuid,
          sourceLocationId: uuid,
          deploymentName: text,
          timezone: { type: 'string', minLength: 1, maxLength: 100 },
          credentialLabel: text,
          credentialExpiresAt: expiry,
        },
        [
          'installationId',
          'organizationId',
          'configuredLocationId',
          'sourceLocationId',
          'deploymentName',
          'timezone',
          'credentialLabel',
          'credentialExpiresAt',
        ],
      ),
    },
    handler('DESKTOP_INSTALLATION_ENROLL', async (body, principal, request) => {
      assertScope(principal, String(body.organizationId).toLowerCase());
      const input = parseDesktopInstallationEnrollmentInput({
        ...body,
        operatorIdentifier: `operations:${principal.operationsUserId}`,
      });
      return enrollDesktopInstallation(database, input, {
        operationsUserId: principal.operationsUserId,
        requestId: request.id,
        authorizeOrganization: (id) => assertScope(principal, id),
      });
    }),
  );

  app.post(
    '/api/v1/operations/desktop-installations/rotate',
    {
      schema: schema(
        {
          installationId: uuid,
          expectedCredentialId: uuid,
          credentialLabel: text,
          credentialExpiresAt: expiry,
          confirmation: {
            type: 'string',
            const: 'ROTATE_INSTALLATION_CREDENTIAL',
          },
        },
        [
          'installationId',
          'expectedCredentialId',
          'credentialLabel',
          'credentialExpiresAt',
          'confirmation',
        ],
      ),
    },
    handler(
      'DESKTOP_INSTALLATION_CREDENTIAL_ROTATE',
      async (body, principal, request) => {
        const { confirmation: _confirmation, ...values } = body;
        const input = parseRotateInstallationCredentialInput({
          ...values,
          operatorIdentifier: `operations:${principal.operationsUserId}`,
        });
        return rotateInstallationCredential(database, input, {
          operationsUserId: principal.operationsUserId,
          requestId: request.id,
          allowRevokedRecovery: true,
          authorizeOrganization: (id) => assertScope(principal, id),
        });
      },
    ),
  );

  app.post(
    '/api/v1/operations/desktop-installations/revoke',
    {
      schema: schema(
        {
          installationId: uuid,
          credentialId: uuid,
          confirmation: {
            type: 'string',
            const: 'REVOKE_INSTALLATION_CREDENTIAL',
          },
        },
        ['installationId', 'credentialId', 'confirmation'],
      ),
    },
    handler(
      'DESKTOP_INSTALLATION_CREDENTIAL_REVOKE',
      async (body, principal, request) => {
        const input = parseRevokeInstallationCredentialInput({
          ...body,
          operatorIdentifier: `operations:${principal.operationsUserId}`,
        });
        return revokeInstallationCredential(database, input, {
          operationsUserId: principal.operationsUserId,
          requestId: request.id,
          authorizeOrganization: (id) => assertScope(principal, id),
        });
      },
    ),
  );
}
