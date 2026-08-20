import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import type { SyncMetrics } from '../diagnostics.js';
import {
  acknowledgeIdentityResolution,
  IdentityResolutionDeliveryError,
  pullPendingIdentityResolutions,
  type IdentityResolutionAcknowledgmentInput,
} from './identity-resolution-delivery.js';
import {
  authenticateInstallation,
  InstallationAuthenticationError,
} from './installation-auth.js';

type Dependencies = Readonly<{ database: Pool; metrics: SyncMetrics }>;

type PullBody = Readonly<{ contractVersion: '1.0'; limit?: number }>;

const uuidSchema = {
  type: 'string',
  pattern:
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
} as const;

const pullSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['contractVersion'],
    properties: {
      contractVersion: { type: 'string', const: '1.0' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
} as const;

const acknowledgmentSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: [
      'contractVersion',
      'acknowledgmentId',
      'resolutionReference',
      'appliedAt',
    ],
    properties: {
      contractVersion: { type: 'string', const: '1.0' },
      acknowledgmentId: uuidSchema,
      resolutionReference: uuidSchema,
      appliedAt: { type: 'string', minLength: 20, maxLength: 40 },
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
  if (error instanceof InstallationAuthenticationError) {
    return sendProblem(
      request,
      reply,
      401,
      'INVALID_INSTALLATION_TOKEN',
      'Installation authentication failed',
    );
  }
  if (error instanceof IdentityResolutionDeliveryError) {
    const title =
      error.statusCode === 404
        ? 'Identity resolution delivery was not found'
        : error.statusCode === 409
          ? 'Identity resolution acknowledgment conflicts with stored state'
          : 'Identity resolution delivery request is invalid';
    return sendProblem(
      request,
      reply,
      error.statusCode,
      error.code,
      title,
    );
  }
  throw error;
}

async function preventCaching(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.header('cache-control', 'no-store');
  reply.header('pragma', 'no-cache');
}

export async function registerIdentityResolutionDeliveryRoutes(
  app: FastifyInstance,
  dependencies: Dependencies,
): Promise<void> {
  app.post<{ Body: PullBody }>(
    '/api/v1/sync/identity-resolutions/pull',
    { schema: pullSchema, preHandler: preventCaching },
    async (request, reply) => {
      try {
        const installation = await authenticateInstallation(
          dependencies.database,
          request.headers.authorization,
        );
        const result = await pullPendingIdentityResolutions(
          dependencies.database,
          installation,
          request.body.limit,
        );
        dependencies.metrics.recordIdentityResolutionPull(
          result.deliveries.length,
          result.hasMore,
        );
        return reply.code(200).send(result);
      } catch (error) {
        return handleKnownError(error, request, reply);
      }
    },
  );

  app.post<{ Body: IdentityResolutionAcknowledgmentInput }>(
    '/api/v1/sync/identity-resolutions/acknowledge',
    { schema: acknowledgmentSchema, preHandler: preventCaching },
    async (request, reply) => {
      try {
        const installation = await authenticateInstallation(
          dependencies.database,
          request.headers.authorization,
        );
        const result = await acknowledgeIdentityResolution(
          dependencies.database,
          installation,
          request.body,
        );
        dependencies.metrics.recordIdentityResolutionAcknowledgment(
          result.replayed,
        );
        return reply.code(200).send(result);
      } catch (error) {
        return handleKnownError(error, request, reply);
      }
    },
  );
}
