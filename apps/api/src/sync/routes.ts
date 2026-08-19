import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import { validateSyncBatchRequest } from '../../../../packages/contracts/src/sync-validation.mjs';
import type { SyncMetrics } from '../diagnostics.js';
import {
  BatchOrchestrationError,
  getStoredSyncBatchResponse,
  submitSyncBatch,
} from './batch-orchestrator.js';
import { SyncBatchIntakeError } from './batch-intake.js';
import {
  authenticateInstallation,
  InstallationAuthenticationError,
} from './installation-auth.js';
import type { SyncBatchRequest } from './types.js';

type SyncRouteDependencies = Readonly<{
  database: Pool;
  metrics: SyncMetrics;
}>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  title: string,
) {
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
  if (error instanceof SyncBatchIntakeError) {
    if (error.code === 'BATCH_PAYLOAD_MISMATCH') {
      return sendProblem(
        request,
        reply,
        409,
        error.code,
        'Batch identifier conflicts with stored content',
      );
    }
    return sendProblem(
      request,
      reply,
      403,
      error.code,
      'Installation is not authorized for this synchronization context',
    );
  }
  if (error instanceof BatchOrchestrationError) {
    if (error.code === 'BATCH_IN_PROGRESS') {
      return sendProblem(
        request,
        reply,
        409,
        error.code,
        'Synchronization batch is still processing',
      );
    }
    if (error.code === 'BATCH_NOT_AVAILABLE') {
      return sendProblem(
        request,
        reply,
        404,
        error.code,
        'Synchronization batch was not found',
      );
    }
  }
  throw error;
}

export async function registerSyncRoutes(
  app: FastifyInstance,
  dependencies: SyncRouteDependencies,
): Promise<void> {
  app.post('/api/v1/sync/batches', async (request, reply) => {
    try {
      const context = await authenticateInstallation(
        dependencies.database,
        request.headers.authorization,
      );
      const validation = validateSyncBatchRequest(request.body);
      if (!validation.valid) {
        return sendProblem(
          request,
          reply,
          400,
          'INVALID_SYNC_BATCH',
          'Synchronization batch does not match contract version 1.0',
        );
      }
      const submission = await submitSyncBatch(
        dependencies.database,
        context,
        request.body as SyncBatchRequest,
      );
      dependencies.metrics.recordBatch(
        submission.response.batchStatus,
        submission.replayed,
      );
      if (!submission.replayed) {
        for (const outcome of submission.response.outcomes) {
          dependencies.metrics.recordOutcome(outcome.resourceType, outcome.status);
        }
      }
      return reply.code(200).send(submission.response);
    } catch (error) {
      return handleKnownError(error, request, reply);
    }
  });

  app.get<{ Params: { batchId: string } }>(
    '/api/v1/sync/batches/:batchId',
    async (request, reply) => {
      if (!uuidPattern.test(request.params.batchId)) {
        return sendProblem(
          request,
          reply,
          400,
          'INVALID_BATCH_ID',
          'Batch identifier is invalid',
        );
      }

      try {
        const context = await authenticateInstallation(
          dependencies.database,
          request.headers.authorization,
        );
        const response = await getStoredSyncBatchResponse(
          dependencies.database,
          context,
          request.params.batchId,
        );
        return reply.code(200).send(response);
      } catch (error) {
        return handleKnownError(error, request, reply);
      }
    },
  );
}
