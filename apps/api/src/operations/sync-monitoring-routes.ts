import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import {
  authorizeSyncMonitoring,
  OperationsAuthorizationError,
  type OperationsPrincipal,
} from './access.js';
import {
  OperationsAuthenticationError,
  type OperationsTokenVerifier,
  type VerifiedOperationsIdentity,
} from './authentication.js';
import { recordPatientAccessAudit } from './audit.js';
import {
  getSyncBatchDetail,
  listSyncBatches,
  SyncMonitoringError,
  type MonitoredSyncBatchStatus,
  type SyncBatchMonitoringQuery,
} from './sync-monitoring.js';

type SyncMonitoringRouteDependencies = Readonly<{
  database: Pool;
  tokenVerifier: OperationsTokenVerifier;
}>;

type SearchBody = SyncBatchMonitoringQuery &
  Readonly<{ reasonCode: 'OPERATIONS_SUPPORT' }>;

type DetailBody = Readonly<{
  reasonCode: 'OPERATIONS_SUPPORT';
  batchReference: string;
}>;

const uuidSchema = {
  type: 'string',
  pattern:
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
} as const;

const searchSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['reasonCode'],
    properties: {
      reasonCode: { type: 'string', const: 'OPERATIONS_SUPPORT' },
      status: {
        type: 'string',
        enum: ['PROCESSING', 'ACCEPTED', 'PARTIAL', 'REJECTED', 'FAILED', 'ALL'],
      },
      installationId: uuidSchema,
      receivedFrom: { type: 'string', minLength: 20, maxLength: 40 },
      receivedTo: { type: 'string', minLength: 20, maxLength: 40 },
      page: { type: 'integer', minimum: 1, maximum: 10_000 },
      pageSize: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
} as const;

const detailSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['reasonCode', 'batchReference'],
    properties: {
      reasonCode: { type: 'string', const: 'OPERATIONS_SUPPORT' },
      batchReference: uuidSchema,
    },
  },
} as const;

type MonitoringAction = 'SYNC_BATCH_LIST_VIEW' | 'SYNC_BATCH_DETAIL_VIEW';

function routeFor(action: MonitoringAction): string {
  return action === 'SYNC_BATCH_LIST_VIEW'
    ? '/api/v1/operations/sync/batches/search'
    : '/api/v1/operations/sync/batches/detail';
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

async function preventCaching(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.header('cache-control', 'no-store');
  reply.header('pragma', 'no-cache');
}

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
    return sendProblem(
      request,
      reply,
      error.statusCode,
      error.statusCode === 503
        ? 'OPERATIONS_AUTHENTICATION_UNAVAILABLE'
        : 'OPERATIONS_AUTHENTICATION_FAILED',
      error.statusCode === 503
        ? 'Operations authentication is unavailable'
        : 'Operations authentication failed',
    );
  }
  if (error instanceof OperationsAuthorizationError) {
    return sendProblem(
      request,
      reply,
      403,
      'SYNC_MONITORING_ACCESS_DENIED',
      'Synchronization monitoring is not permitted',
    );
  }
  if (error instanceof SyncMonitoringError) {
    return sendProblem(
      request,
      reply,
      error.statusCode,
      error.statusCode === 404
        ? 'SYNC_BATCH_NOT_FOUND'
        : 'INVALID_SYNC_MONITORING_QUERY',
      error.statusCode === 404
        ? 'Synchronization batch was not found'
        : 'Synchronization monitoring query is invalid',
    );
  }
  throw error;
}

async function recordAudit(
  dependencies: SyncMonitoringRouteDependencies,
  principal: OperationsPrincipal,
  request: FastifyRequest,
  action: MonitoringAction,
  outcome: 'SUCCESS' | 'DENIED' | 'NOT_FOUND' | 'ERROR',
  entityId: string | null,
  metadata: Readonly<Record<string, unknown>> = {},
) {
  await recordPatientAccessAudit(dependencies.database, {
    operationsUserId: principal.operationsUserId,
    principalFingerprint: null,
    scope: principal.patientAccessScope,
    action,
    outcome,
    entityId,
    reason: 'OPERATIONS_SUPPORT',
    ...requestContext(request),
    sessionId: principal.identity.sessionId,
    authorizedParty: principal.identity.authorizedParty,
    route: routeFor(action),
    metadata,
  });
}

async function recordAuthorizationDenial(
  dependencies: SyncMonitoringRouteDependencies,
  identity: VerifiedOperationsIdentity,
  error: OperationsAuthorizationError,
  request: FastifyRequest,
  action: MonitoringAction,
  entityId: string | null,
) {
  await recordPatientAccessAudit(dependencies.database, {
    operationsUserId: error.operationsUserId,
    principalFingerprint: error.principalFingerprint,
    scope: null,
    action,
    outcome: 'DENIED',
    entityId,
    reason: 'OPERATIONS_SUPPORT',
    ...requestContext(request),
    sessionId: identity.sessionId,
    authorizedParty: identity.authorizedParty,
    route: routeFor(action),
    metadata: { authorizationCode: error.code },
  });
}

async function principalFor(
  dependencies: SyncMonitoringRouteDependencies,
  request: FastifyRequest,
  action: MonitoringAction,
  entityId: string | null,
): Promise<OperationsPrincipal> {
  const identity = await dependencies.tokenVerifier.verify(
    request.headers.authorization,
  );
  try {
    return await authorizeSyncMonitoring(dependencies.database, identity);
  } catch (error) {
    if (error instanceof OperationsAuthorizationError) {
      await recordAuthorizationDenial(
        dependencies,
        identity,
        error,
        request,
        action,
        entityId,
      );
    }
    throw error;
  }
}

export async function registerSyncMonitoringRoutes(
  app: FastifyInstance,
  dependencies: SyncMonitoringRouteDependencies,
): Promise<void> {
  app.post<{ Body: SearchBody }>(
    '/api/v1/operations/sync/batches/search',
    { schema: searchSchema, onRequest: preventCaching },
    async (request, reply) => {
      let principal: OperationsPrincipal | null = null;
      let auditAttempted = false;
      const { reasonCode: _reasonCode, ...query } = request.body;
      try {
        principal = await principalFor(
          dependencies,
          request,
          'SYNC_BATCH_LIST_VIEW',
          null,
        );
        const result = await listSyncBatches(
          dependencies.database,
          principal.patientAccessScope,
          query,
        );
        auditAttempted = true;
        await recordAudit(
          dependencies,
          principal,
          request,
          'SYNC_BATCH_LIST_VIEW',
          'SUCCESS',
          null,
          {
            page: result.page,
            pageSize: result.pageSize,
            resultCount: result.items.length,
            statusFilter: (query.status ?? 'ALL') as MonitoredSyncBatchStatus | 'ALL',
            hasInstallationFilter: query.installationId !== undefined,
            hasReceivedFrom: query.receivedFrom !== undefined,
            hasReceivedTo: query.receivedTo !== undefined,
          },
        );
        return reply.code(200).send(result);
      } catch (error) {
        if (principal && !auditAttempted) {
          auditAttempted = true;
          await recordAudit(
            dependencies,
            principal,
            request,
            'SYNC_BATCH_LIST_VIEW',
            error instanceof SyncMonitoringError ? 'DENIED' : 'ERROR',
            null,
          );
        }
        return handleKnownError(error, request, reply);
      }
    },
  );

  app.post<{ Body: DetailBody }>(
    '/api/v1/operations/sync/batches/detail',
    { schema: detailSchema, onRequest: preventCaching },
    async (request, reply) => {
      let principal: OperationsPrincipal | null = null;
      let auditAttempted = false;
      const { batchReference } = request.body;
      try {
        principal = await principalFor(
          dependencies,
          request,
          'SYNC_BATCH_DETAIL_VIEW',
          batchReference,
        );
        const result = await getSyncBatchDetail(
          dependencies.database,
          principal.patientAccessScope,
          batchReference,
        );
        auditAttempted = true;
        await recordAudit(
          dependencies,
          principal,
          request,
          'SYNC_BATCH_DETAIL_VIEW',
          'SUCCESS',
          batchReference,
          {
            outcomeGroupCount: result.outcomeCounts.length,
            errorCodeGroupCount: result.errorCodeCounts.length,
          },
        );
        return reply.code(200).send(result);
      } catch (error) {
        if (principal && !auditAttempted) {
          auditAttempted = true;
          await recordAudit(
            dependencies,
            principal,
            request,
            'SYNC_BATCH_DETAIL_VIEW',
            error instanceof SyncMonitoringError
              ? error.statusCode === 404
                ? 'NOT_FOUND'
                : 'DENIED'
              : 'ERROR',
            batchReference,
          );
        }
        return handleKnownError(error, request, reply);
      }
    },
  );
}
