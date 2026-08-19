import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import {
  OperationsAuthenticationError,
  type OperationsTokenVerifier,
  type VerifiedOperationsIdentity,
} from './authentication.js';
import {
  authorizePatientRead,
  OperationsAuthorizationError,
  type OperationsPrincipal,
} from './access.js';
import {
  type PatientAccessReason,
  type PatientAuditAction,
  recordPatientAccessAudit,
} from './audit.js';
import {
  getCanonicalPatientDetail,
  listCanonicalPatients,
  PatientQueryError,
  type PatientHistoryQuery,
  type PatientListQuery,
} from './patient-query.js';

type OperationsRouteDependencies = Readonly<{
  database: Pool;
  tokenVerifier: OperationsTokenVerifier;
}>;

type PatientSearchBody = PatientListQuery &
  Readonly<{ reasonCode: PatientAccessReason }>;

type PatientDetailBody = PatientHistoryQuery &
  Readonly<{
    reasonCode: PatientAccessReason;
    personId: string;
  }>;

const reasonCodes = [
  'CARE_DELIVERY',
  'CARE_COORDINATION',
  'PATIENT_REQUEST',
  'QUALITY_IMPROVEMENT',
  'OPERATIONS_SUPPORT',
] as const;

const paginationProperties = {
  page: { type: 'integer', minimum: 1, maximum: 10_000 },
  pageSize: { type: 'integer', minimum: 1, maximum: 100 },
} as const;

const patientSearchSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['reasonCode'],
    properties: {
      reasonCode: { type: 'string', enum: reasonCodes },
      search: { type: 'string', minLength: 1, maxLength: 120 },
      dateOfBirth: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      status: {
        type: 'string',
        enum: ['ACTIVE', 'INACTIVE', 'DECEASED', 'ALL'],
      },
      ...paginationProperties,
    },
  },
} as const;

const patientDetailSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['reasonCode', 'personId'],
    properties: {
      reasonCode: { type: 'string', enum: reasonCodes },
      personId: {
        type: 'string',
        pattern:
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
      },
      ...paginationProperties,
    },
  },
} as const;

function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  title: string,
) {
  if (status === 401) reply.header('www-authenticate', 'Bearer');
  return reply.code(status).type('application/problem+json').send({
    type: 'about:blank',
    title,
    status,
    code,
    requestId: request.id,
  });
}

function handleKnownError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof OperationsAuthenticationError) {
    if (error.statusCode === 503) {
      return sendProblem(
        request,
        reply,
        503,
        'OPERATIONS_AUTHENTICATION_UNAVAILABLE',
        'Operations authentication is unavailable',
      );
    }
    return sendProblem(
      request,
      reply,
      401,
      'OPERATIONS_AUTHENTICATION_FAILED',
      'Operations authentication failed',
    );
  }
  if (error instanceof OperationsAuthorizationError) {
    return sendProblem(
      request,
      reply,
      403,
      'OPERATIONS_ACCESS_DENIED',
      'Patient access is not permitted',
    );
  }
  if (error instanceof PatientQueryError) {
    return sendProblem(
      request,
      reply,
      400,
      'INVALID_PATIENT_QUERY',
      'Patient query is invalid',
    );
  }
  throw error;
}

function requestContext(request: FastifyRequest) {
  return {
    requestId: request.id,
    sourceIp: request.ip,
    userAgent:
      typeof request.headers['user-agent'] === 'string'
        ? request.headers['user-agent']
        : null,
  };
}

async function preventPatientResponseCaching(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.header('cache-control', 'no-store');
  reply.header('pragma', 'no-cache');
}

async function authenticateAndAuthorize(
  request: FastifyRequest,
  dependencies: OperationsRouteDependencies,
  action: PatientAuditAction,
  reason: PatientAccessReason,
  entityId: string | null,
): Promise<OperationsPrincipal> {
  const identity = await dependencies.tokenVerifier.verify(
    request.headers.authorization,
  );
  try {
    return await authorizePatientRead(dependencies.database, identity);
  } catch (error) {
    if (error instanceof OperationsAuthorizationError) {
      await recordPatientAccessAudit(dependencies.database, {
        operationsUserId: error.operationsUserId,
        principalFingerprint: error.principalFingerprint,
        scope: null,
        action,
        outcome: 'DENIED',
        entityId,
        reason,
        ...requestContext(request),
        sessionId: identity.sessionId,
        authorizedParty: identity.authorizedParty,
        route:
          action === 'PATIENT_LIST_VIEW'
            ? '/api/v1/operations/patients/search'
            : '/api/v1/operations/patients/detail',
        metadata: { authorizationCode: error.code },
      });
    }
    throw error;
  }
}

function identityAuditFields(identity: VerifiedOperationsIdentity) {
  return {
    principalFingerprint: null,
    sessionId: identity.sessionId,
    authorizedParty: identity.authorizedParty,
  };
}

export async function registerOperationsRoutes(
  app: FastifyInstance,
  dependencies: OperationsRouteDependencies,
): Promise<void> {
  app.post<{ Body: PatientSearchBody }>(
    '/api/v1/operations/patients/search',
    { schema: patientSearchSchema, onRequest: preventPatientResponseCaching },
    async (request, reply) => {
      let principal: OperationsPrincipal | null = null;
      let auditAttempted = false;
      const { reasonCode, ...query } = request.body;
      try {
        principal = await authenticateAndAuthorize(
          request,
          dependencies,
          'PATIENT_LIST_VIEW',
          reasonCode,
          null,
        );
        const result = await listCanonicalPatients(
          dependencies.database,
          principal.patientAccessScope,
          query,
        );
        auditAttempted = true;
        await recordPatientAccessAudit(dependencies.database, {
          operationsUserId: principal.operationsUserId,
          scope: principal.patientAccessScope,
          action: 'PATIENT_LIST_VIEW',
          outcome: 'SUCCESS',
          entityId: null,
          reason: reasonCode,
          ...requestContext(request),
          ...identityAuditFields(principal.identity),
          route: '/api/v1/operations/patients/search',
          metadata: {
            page: result.page,
            pageSize: result.pageSize,
            resultCount: result.items.length,
            hasSearch: query.search !== undefined,
            hasDateOfBirth: query.dateOfBirth !== undefined,
            statusFilter: query.status ?? 'ACTIVE',
          },
        });
        return reply.code(200).send(result);
      } catch (error) {
        if (principal && !auditAttempted) {
          auditAttempted = true;
          await recordPatientAccessAudit(dependencies.database, {
            operationsUserId: principal.operationsUserId,
            scope: principal.patientAccessScope,
            action: 'PATIENT_LIST_VIEW',
            outcome: error instanceof PatientQueryError ? 'DENIED' : 'ERROR',
            entityId: null,
            reason: reasonCode,
            ...requestContext(request),
            ...identityAuditFields(principal.identity),
            route: '/api/v1/operations/patients/search',
          });
        }
        return handleKnownError(error, request, reply);
      }
    },
  );

  app.post<{ Body: PatientDetailBody }>(
    '/api/v1/operations/patients/detail',
    { schema: patientDetailSchema, onRequest: preventPatientResponseCaching },
    async (request, reply) => {
      let principal: OperationsPrincipal | null = null;
      let auditAttempted = false;
      const { reasonCode, personId, ...historyQuery } = request.body;
      try {
        principal = await authenticateAndAuthorize(
          request,
          dependencies,
          'PATIENT_DETAIL_VIEW',
          reasonCode,
          personId,
        );
        const result = await getCanonicalPatientDetail(
          dependencies.database,
          principal.patientAccessScope,
          personId,
          historyQuery,
        );
        auditAttempted = true;
        await recordPatientAccessAudit(dependencies.database, {
          operationsUserId: principal.operationsUserId,
          scope: principal.patientAccessScope,
          action: 'PATIENT_DETAIL_VIEW',
          outcome: result ? 'SUCCESS' : 'NOT_FOUND',
          entityId: personId,
          reason: reasonCode,
          ...requestContext(request),
          ...identityAuditFields(principal.identity),
          route: '/api/v1/operations/patients/detail',
          metadata: {
            historyPage: historyQuery.page ?? 1,
            historyPageSize: historyQuery.pageSize ?? 20,
          },
        });
        if (!result) {
          return sendProblem(
            request,
            reply,
            404,
            'PATIENT_NOT_FOUND',
            'Patient was not found',
          );
        }
        return reply.code(200).send(result);
      } catch (error) {
        if (principal && !auditAttempted) {
          auditAttempted = true;
          await recordPatientAccessAudit(dependencies.database, {
            operationsUserId: principal.operationsUserId,
            scope: principal.patientAccessScope,
            action: 'PATIENT_DETAIL_VIEW',
            outcome: error instanceof PatientQueryError ? 'DENIED' : 'ERROR',
            entityId: personId,
            reason: reasonCode,
            ...requestContext(request),
            ...identityAuditFields(principal.identity),
            route: '/api/v1/operations/patients/detail',
          });
        }
        return handleKnownError(error, request, reply);
      }
    },
  );
}
