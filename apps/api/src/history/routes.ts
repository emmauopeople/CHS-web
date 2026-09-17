import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import {
  installationHistoryRequestSchema,
  operationsHistoryRequestSchema,
  type HistoryRequest,
  type InstallationHistoryRequest,
} from '../../../../packages/contracts/src/patient-history.mjs';
import {
  OperationsAuthenticationError,
  type OperationsTokenVerifier,
} from '../operations/authentication.js';
import { OperationsAuthorizationError } from '../operations/access.js';
import { InstallationAuthenticationError } from '../sync/installation-auth.js';
import { HistoryError, readPatientHistory } from './service.js';

function problem(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (
    error instanceof HistoryError ||
    error instanceof OperationsAuthenticationError ||
    error instanceof OperationsAuthorizationError ||
    error instanceof InstallationAuthenticationError
  ) {
    if (error.statusCode === 401) reply.header('www-authenticate', 'Bearer');
    return reply.code(error.statusCode).type('application/problem+json').send({
      type: 'about:blank',
      title: 'Patient history is unavailable',
      status: error.statusCode,
      code: error.code,
      requestId: request.id,
    });
  }
  throw error;
}
export async function registerPatientHistoryRoutes(
  app: FastifyInstance,
  dependencies: Readonly<{
    database: Pool;
    tokenVerifier: OperationsTokenVerifier;
  }>,
) {
  const preventCaching = async (
    _request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    reply.header('cache-control', 'no-store');
    reply.header('pragma', 'no-cache');
  };
  app.post<{ Body: InstallationHistoryRequest }>(
    '/api/v1/sync/patients/history',
    {
      schema: { body: installationHistoryRequestSchema },
      onRequest: preventCaching,
    },
    async (request, reply) => {
      try {
        return reply.send(
          await readPatientHistory(
            dependencies.database,
            {
              kind: 'INSTALLATION',
              authorization: request.headers.authorization,
            },
            request.body,
            { requestId: request.id, route: '/api/v1/sync/patients/history' },
          ),
        );
      } catch (error) {
        return problem(error, request, reply);
      }
    },
  );
  app.post<{ Body: HistoryRequest }>(
    '/api/v1/operations/patients/history',
    {
      schema: { body: operationsHistoryRequestSchema },
      onRequest: preventCaching,
    },
    async (request, reply) => {
      try {
        const identity = await dependencies.tokenVerifier.verify(
          request.headers.authorization,
        );
        return reply.send(
          await readPatientHistory(
            dependencies.database,
            { kind: 'OPERATIONS', identity },
            request.body,
            {
              requestId: request.id,
              route: '/api/v1/operations/patients/history',
            },
          ),
        );
      } catch (error) {
        return problem(error, request, reply);
      }
    },
  );
}
