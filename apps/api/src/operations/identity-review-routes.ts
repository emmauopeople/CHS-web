import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import {
  authorizeIdentityReview,
  authorizeIdentityReviewResolution,
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
  IdentityReviewResolutionError,
  resolveIdentityReviewCase,
  type IdentityReviewResolutionInput,
} from './identity-review-resolution.js';
import {
  getIdentityReviewCaseDetail,
  IdentityReviewQueryError,
  listIdentityReviewCases,
  type IdentityReviewEvidenceState,
  type IdentityReviewQueueQuery,
} from './identity-review.js';

type IdentityReviewRouteDependencies = Readonly<{
  database: Pool;
  tokenVerifier: OperationsTokenVerifier;
}>;

type SearchBody = IdentityReviewQueueQuery &
  Readonly<{ reasonCode: 'IDENTITY_RECONCILIATION' }>;

type DetailBody = Readonly<{
  reasonCode: 'IDENTITY_RECONCILIATION';
  caseReference: string;
}>;

type ResolveBody = IdentityReviewResolutionInput &
  Readonly<{ reasonCode: 'IDENTITY_RECONCILIATION' }>;

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
      reasonCode: { type: 'string', const: 'IDENTITY_RECONCILIATION' },
      evidenceState: {
        type: 'string',
        enum: ['AVAILABLE', 'EVIDENCE_PENDING', 'ALL'],
      },
      installationId: uuidSchema,
      openedFrom: { type: 'string', minLength: 20, maxLength: 40 },
      openedTo: { type: 'string', minLength: 20, maxLength: 40 },
      page: { type: 'integer', minimum: 1, maximum: 10_000 },
      pageSize: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
} as const;

const detailSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['reasonCode', 'caseReference'],
    properties: {
      reasonCode: { type: 'string', const: 'IDENTITY_RECONCILIATION' },
      caseReference: uuidSchema,
    },
  },
} as const;

const resolveSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: [
      'reasonCode',
      'resolutionRequestId',
      'caseReference',
      'expectedUpdatedAt',
      'resolutionNote',
      'resolution',
    ],
    properties: {
      reasonCode: { type: 'string', const: 'IDENTITY_RECONCILIATION' },
      resolutionRequestId: uuidSchema,
      caseReference: uuidSchema,
      expectedUpdatedAt: { type: 'string', minLength: 20, maxLength: 40 },
      resolutionNote: { type: 'string', minLength: 10, maxLength: 1000 },
      resolution: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'candidatePersonReference'],
            properties: {
              kind: { type: 'string', const: 'LINK_EXISTING' },
              candidatePersonReference: uuidSchema,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind'],
            properties: {
              kind: { type: 'string', const: 'CREATE_NEW' },
            },
          },
        ],
      },
    },
  },
} as const;

type IdentityReviewAction =
  | 'IDENTITY_REVIEW_LIST_VIEW'
  | 'IDENTITY_REVIEW_DETAIL_VIEW'
  | 'IDENTITY_REVIEW_RESOLVE';

function routeFor(action: IdentityReviewAction): string {
  switch (action) {
    case 'IDENTITY_REVIEW_LIST_VIEW':
      return '/api/v1/operations/identity-reviews/search';
    case 'IDENTITY_REVIEW_DETAIL_VIEW':
      return '/api/v1/operations/identity-reviews/detail';
    case 'IDENTITY_REVIEW_RESOLVE':
      return '/api/v1/operations/identity-reviews/resolve';
  }
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
      'IDENTITY_REVIEW_ACCESS_DENIED',
      'Identity review is not permitted',
    );
  }
  if (error instanceof IdentityReviewQueryError && error.statusCode !== 500) {
    return sendProblem(
      request,
      reply,
      error.statusCode,
      error.statusCode === 404
        ? 'IDENTITY_REVIEW_CASE_NOT_FOUND'
        : 'INVALID_IDENTITY_REVIEW_QUERY',
      error.statusCode === 404
        ? 'Identity review case was not found'
        : 'Identity review query is invalid',
    );
  }
  if (
    error instanceof IdentityReviewResolutionError &&
    error.statusCode !== 500
  ) {
    return sendProblem(
      request,
      reply,
      error.statusCode,
      error.statusCode === 400
        ? 'INVALID_IDENTITY_REVIEW_RESOLUTION'
        : error.code,
      error.statusCode === 404
        ? 'Identity review case was not found'
        : error.statusCode === 409
          ? 'Identity review resolution conflicts with current state'
          : 'Identity review resolution is invalid',
    );
  }
  throw error;
}

async function recordAudit(
  dependencies: IdentityReviewRouteDependencies,
  principal: OperationsPrincipal,
  request: FastifyRequest,
  action: IdentityReviewAction,
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
    reason: 'IDENTITY_RECONCILIATION',
    ...requestContext(request),
    sessionId: principal.identity.sessionId,
    authorizedParty: principal.identity.authorizedParty,
    route: routeFor(action),
    metadata,
  });
}

async function recordAuthorizationDenial(
  dependencies: IdentityReviewRouteDependencies,
  identity: VerifiedOperationsIdentity,
  error: OperationsAuthorizationError,
  request: FastifyRequest,
  action: IdentityReviewAction,
  entityId: string | null,
) {
  await recordPatientAccessAudit(dependencies.database, {
    operationsUserId: error.operationsUserId,
    principalFingerprint: error.principalFingerprint,
    scope: null,
    action,
    outcome: 'DENIED',
    entityId,
    reason: 'IDENTITY_RECONCILIATION',
    ...requestContext(request),
    sessionId: identity.sessionId,
    authorizedParty: identity.authorizedParty,
    route: routeFor(action),
    metadata: { authorizationCode: error.code },
  });
}

async function principalFor(
  dependencies: IdentityReviewRouteDependencies,
  request: FastifyRequest,
  action: IdentityReviewAction,
  entityId: string | null,
): Promise<OperationsPrincipal> {
  const identity = await dependencies.tokenVerifier.verify(
    request.headers.authorization,
  );
  try {
    return await (action === 'IDENTITY_REVIEW_RESOLVE'
      ? authorizeIdentityReviewResolution(dependencies.database, identity)
      : authorizeIdentityReview(dependencies.database, identity));
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

export async function registerIdentityReviewRoutes(
  app: FastifyInstance,
  dependencies: IdentityReviewRouteDependencies,
): Promise<void> {
  app.post<{ Body: SearchBody }>(
    '/api/v1/operations/identity-reviews/search',
    { schema: searchSchema, onRequest: preventCaching },
    async (request, reply) => {
      let principal: OperationsPrincipal | null = null;
      let auditAttempted = false;
      const { reasonCode: _reasonCode, ...query } = request.body;
      try {
        principal = await principalFor(
          dependencies,
          request,
          'IDENTITY_REVIEW_LIST_VIEW',
          null,
        );
        const result = await listIdentityReviewCases(
          dependencies.database,
          principal.patientAccessScope,
          query,
        );
        auditAttempted = true;
        await recordAudit(
          dependencies,
          principal,
          request,
          'IDENTITY_REVIEW_LIST_VIEW',
          'SUCCESS',
          null,
          {
            page: result.page,
            pageSize: result.pageSize,
            resultCount: result.items.length,
            evidenceStateFilter: (query.evidenceState ?? 'ALL') as
              | IdentityReviewEvidenceState
              | 'ALL',
            hasInstallationFilter: query.installationId !== undefined,
            hasOpenedFrom: query.openedFrom !== undefined,
            hasOpenedTo: query.openedTo !== undefined,
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
            'IDENTITY_REVIEW_LIST_VIEW',
            error instanceof IdentityReviewQueryError && error.statusCode !== 500
              ? 'DENIED'
              : 'ERROR',
            null,
          );
        }
        return handleKnownError(error, request, reply);
      }
    },
  );

  app.post<{ Body: DetailBody }>(
    '/api/v1/operations/identity-reviews/detail',
    { schema: detailSchema, onRequest: preventCaching },
    async (request, reply) => {
      let principal: OperationsPrincipal | null = null;
      let auditAttempted = false;
      const { caseReference } = request.body;
      try {
        principal = await principalFor(
          dependencies,
          request,
          'IDENTITY_REVIEW_DETAIL_VIEW',
          caseReference,
        );
        const result = await getIdentityReviewCaseDetail(
          dependencies.database,
          principal.patientAccessScope,
          caseReference,
        );
        auditAttempted = true;
        await recordAudit(
          dependencies,
          principal,
          request,
          'IDENTITY_REVIEW_DETAIL_VIEW',
          'SUCCESS',
          caseReference,
          {
            candidateCount: result.candidates.length,
            evidenceState: result.evidenceState,
            latestSourceRevision: result.evidence?.sourceRevision ?? null,
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
            'IDENTITY_REVIEW_DETAIL_VIEW',
            error instanceof IdentityReviewQueryError
              ? error.statusCode === 404
                ? 'NOT_FOUND'
                : error.statusCode === 400
                  ? 'DENIED'
                  : 'ERROR'
              : 'ERROR',
            caseReference,
          );
        }
        return handleKnownError(error, request, reply);
      }
    },
  );

  app.post<{ Body: ResolveBody }>(
    '/api/v1/operations/identity-reviews/resolve',
    { schema: resolveSchema, onRequest: preventCaching },
    async (request, reply) => {
      let principal: OperationsPrincipal | null = null;
      const { reasonCode: _reasonCode, ...input } = request.body;
      try {
        principal = await principalFor(
          dependencies,
          request,
          'IDENTITY_REVIEW_RESOLVE',
          input.caseReference,
        );
        const result = await resolveIdentityReviewCase(
          dependencies.database,
          principal.patientAccessScope,
          principal.operationsUserId,
          input,
          {
            ...requestContext(request),
            sessionId: principal.identity.sessionId,
            authorizedParty: principal.identity.authorizedParty,
          },
        );
        return reply.code(200).send(result);
      } catch (error) {
        if (principal) {
          await recordAudit(
            dependencies,
            principal,
            request,
            'IDENTITY_REVIEW_RESOLVE',
            error instanceof IdentityReviewResolutionError
              ? error.statusCode === 404
                ? 'NOT_FOUND'
                : error.statusCode === 500
                  ? 'ERROR'
                  : 'DENIED'
              : 'ERROR',
            input.caseReference,
            error instanceof IdentityReviewResolutionError
              ? { resolutionCode: error.code }
              : {},
          );
        }
        return handleKnownError(error, request, reply);
      }
    },
  );
}
