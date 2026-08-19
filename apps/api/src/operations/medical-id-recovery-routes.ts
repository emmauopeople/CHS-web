import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import {
  authorizeMedicalIdRecovery,
  OperationsAuthorizationError,
  operationsPrincipalFingerprint,
  type OperationsPrincipal,
} from './access.js';
import {
  OperationsAuthenticationError,
  type OperationsTokenVerifier,
  type VerifiedOperationsIdentity,
} from './authentication.js';
import {
  type PatientAccessReason,
  recordPatientAccessAudit,
} from './audit.js';
import {
  MedicalIdRecoveryError,
  revealMedicalId,
  searchMedicalIdRecovery,
} from './medical-id-recovery.js';

type RecoveryRouteDependencies = Readonly<{
  database: Pool;
  tokenVerifier: OperationsTokenVerifier;
}>;

type SearchBody = Readonly<{
  reasonCode: PatientAccessReason;
  fullName: string;
  dateOfBirth: string;
}>;

type RevealBody = Readonly<{
  reasonCode: PatientAccessReason;
  recoveryToken: string;
  candidateReference: string;
  confirmed: true;
}>;

const reasonCodes = [
  'CARE_DELIVERY',
  'CARE_COORDINATION',
  'PATIENT_REQUEST',
  'QUALITY_IMPROVEMENT',
  'OPERATIONS_SUPPORT',
] as const;

const reasonProperty = { type: 'string', enum: reasonCodes } as const;

const searchSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['reasonCode', 'fullName', 'dateOfBirth'],
    properties: {
      reasonCode: reasonProperty,
      fullName: { type: 'string', minLength: 2, maxLength: 160 },
      dateOfBirth: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    },
  },
} as const;

const revealSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: [
      'reasonCode',
      'recoveryToken',
      'candidateReference',
      'confirmed',
    ],
    properties: {
      reasonCode: reasonProperty,
      recoveryToken: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
      candidateReference: {
        type: 'string',
        pattern:
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
      },
      confirmed: { type: 'boolean', const: true },
    },
  },
} as const;

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

function requestContext(request: FastifyRequest, reason: PatientAccessReason) {
  return {
    reason,
    requestId: request.id,
    sourceIp: request.ip,
    userAgent:
      typeof request.headers['user-agent'] === 'string'
        ? request.headers['user-agent']
        : null,
  };
}

async function auditAuthorizationDenial(
  database: Pool,
  identity: VerifiedOperationsIdentity,
  error: OperationsAuthorizationError,
  request: FastifyRequest,
  reason: PatientAccessReason,
  action: 'MEDICAL_ID_RECOVERY_SEARCH' | 'MEDICAL_ID_RECOVERY_REVEAL',
) {
  await recordPatientAccessAudit(database, {
    operationsUserId: error.operationsUserId,
    principalFingerprint: error.principalFingerprint,
    scope: null,
    action,
    outcome: 'DENIED',
    entityId: null,
    reason,
    requestId: request.id,
    sourceIp: request.ip,
    userAgent:
      typeof request.headers['user-agent'] === 'string'
        ? request.headers['user-agent']
        : null,
    sessionId: identity.sessionId,
    authorizedParty: identity.authorizedParty,
    route:
      action === 'MEDICAL_ID_RECOVERY_SEARCH'
        ? '/api/v1/operations/medical-id-recovery/search'
        : '/api/v1/operations/medical-id-recovery/reveal',
    metadata: { authorizationCode: error.code },
  });
}

async function principalFor(
  request: FastifyRequest,
  dependencies: RecoveryRouteDependencies,
  reason: PatientAccessReason,
  action: 'MEDICAL_ID_RECOVERY_SEARCH' | 'MEDICAL_ID_RECOVERY_REVEAL',
): Promise<OperationsPrincipal> {
  const identity = await dependencies.tokenVerifier.verify(
    request.headers.authorization,
  );
  try {
    return await authorizeMedicalIdRecovery(dependencies.database, identity);
  } catch (error) {
    if (error instanceof OperationsAuthorizationError) {
      await auditAuthorizationDenial(
        dependencies.database,
        identity,
        error,
        request,
        reason,
        action,
      );
    }
    throw error;
  }
}

async function auditUnhandledFailure(
  dependencies: RecoveryRouteDependencies,
  principal: OperationsPrincipal,
  request: FastifyRequest,
  reason: PatientAccessReason,
  action: 'MEDICAL_ID_RECOVERY_SEARCH' | 'MEDICAL_ID_RECOVERY_REVEAL',
  outcome: 'DENIED' | 'ERROR',
) {
  await recordPatientAccessAudit(dependencies.database, {
    operationsUserId: principal.operationsUserId,
    principalFingerprint: operationsPrincipalFingerprint(principal.identity),
    scope: principal.patientAccessScope,
    action,
    outcome,
    entityId: null,
    reason,
    requestId: request.id,
    sourceIp: request.ip,
    userAgent:
      typeof request.headers['user-agent'] === 'string'
        ? request.headers['user-agent']
        : null,
    sessionId: principal.identity.sessionId,
    authorizedParty: principal.identity.authorizedParty,
    route:
      action === 'MEDICAL_ID_RECOVERY_SEARCH'
        ? '/api/v1/operations/medical-id-recovery/search'
        : '/api/v1/operations/medical-id-recovery/reveal',
    metadata: {},
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
      'MEDICAL_ID_RECOVERY_ACCESS_DENIED',
      'Medical ID recovery is not permitted',
    );
  }
  if (error instanceof MedicalIdRecoveryError) {
    const code =
      error.statusCode === 400
        ? 'INVALID_RECOVERY_EVIDENCE'
        : error.statusCode === 404
          ? 'RECOVERY_CASE_NOT_AVAILABLE'
          : 'MEDICAL_ID_RECOVERY_FAILED';
    const title =
      error.statusCode === 400
        ? 'Recovery evidence is invalid'
        : error.statusCode === 404
          ? 'The recovery case is unavailable'
          : 'Medical ID recovery failed';
    return sendProblem(
      request,
      reply,
      error.statusCode,
      code,
      title,
    );
  }
  throw error;
}

export async function registerMedicalIdRecoveryRoutes(
  app: FastifyInstance,
  dependencies: RecoveryRouteDependencies,
): Promise<void> {
  app.post<{ Body: SearchBody }>(
    '/api/v1/operations/medical-id-recovery/search',
    { schema: searchSchema, onRequest: preventCaching },
    async (request, reply) => {
      const { reasonCode, ...evidence } = request.body;
      let principal: OperationsPrincipal | null = null;
      try {
        principal = await principalFor(
          request,
          dependencies,
          reasonCode,
          'MEDICAL_ID_RECOVERY_SEARCH',
        );
        const result = await searchMedicalIdRecovery(
          dependencies.database,
          principal,
          evidence,
          requestContext(request, reasonCode),
        );
        return reply.code(200).send(result);
      } catch (error) {
        if (
          principal &&
          (!(error instanceof MedicalIdRecoveryError) || !error.audited)
        ) {
          await auditUnhandledFailure(
            dependencies,
            principal,
            request,
            reasonCode,
            'MEDICAL_ID_RECOVERY_SEARCH',
            error instanceof MedicalIdRecoveryError ? 'DENIED' : 'ERROR',
          );
        }
        return handleKnownError(error, request, reply);
      }
    },
  );

  app.post<{ Body: RevealBody }>(
    '/api/v1/operations/medical-id-recovery/reveal',
    { schema: revealSchema, onRequest: preventCaching },
    async (request, reply) => {
      const { reasonCode, ...input } = request.body;
      let principal: OperationsPrincipal | null = null;
      try {
        principal = await principalFor(
          request,
          dependencies,
          reasonCode,
          'MEDICAL_ID_RECOVERY_REVEAL',
        );
        const result = await revealMedicalId(
          dependencies.database,
          principal,
          input,
          requestContext(request, reasonCode),
        );
        return reply.code(200).send(result);
      } catch (error) {
        if (
          principal &&
          (!(error instanceof MedicalIdRecoveryError) || !error.audited)
        ) {
          await auditUnhandledFailure(
            dependencies,
            principal,
            request,
            reasonCode,
            'MEDICAL_ID_RECOVERY_REVEAL',
            error instanceof MedicalIdRecoveryError ? 'DENIED' : 'ERROR',
          );
        }
        return handleKnownError(error, request, reply);
      }
    },
  );
}
