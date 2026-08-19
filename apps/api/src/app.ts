import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';

import type { AppConfig } from './config.js';
import type { Database } from './database.js';
import { registerDiagnostics } from './diagnostics.js';
import { loggerOptions } from './logger.js';
import {
  createDisabledOperationsTokenVerifier,
  createOidcOperationsTokenVerifier,
  type OperationsTokenVerifier,
} from './operations/authentication.js';
import { registerOperationsRoutes } from './operations/routes.js';
import { registerSyncRoutes } from './sync/routes.js';

export type BuildAppDependencies = Readonly<{
  config: AppConfig;
  database: Pick<Database, 'pool' | 'check' | 'close'>;
  operationsTokenVerifier?: OperationsTokenVerifier;
}>;

function normalizeError(error: unknown) {
  const errorRecord =
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>)
      : {};
  const candidateStatusCode = errorRecord.statusCode;

  return {
    statusCode:
      typeof candidateStatusCode === 'number' &&
      candidateStatusCode >= 400 &&
      candidateStatusCode < 500
        ? candidateStatusCode
        : 500,
    name: error instanceof Error ? error.name : 'UnknownError',
    code:
      typeof errorRecord.code === 'string'
        ? errorRecord.code
        : 'UNCLASSIFIED',
  };
}

export async function buildApp(dependencies: BuildAppDependencies) {
  const app = Fastify({
    logger: loggerOptions(dependencies.config),
    genReqId: () => randomUUID(),
    logController: new LogController({
      requestIdLogLabel: 'requestId',
      disableRequestLogging: true,
    }),
    bodyLimit: 1_048_576,
    ajv: {
      customOptions: { removeAdditional: false },
    },
    trustProxy:
      dependencies.config.trustedProxyCidrs.length > 0
        ? [...dependencies.config.trustedProxyCidrs]
        : false,
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    return payload;
  });

  if (dependencies.config.nodeEnv === 'development') {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'CHS Web API',
          description: 'Community Health Screening cloud API',
          version: '0.1.0',
        },
      },
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  const syncMetrics = await registerDiagnostics(app, {
    config: dependencies.config,
    checkDatabase: dependencies.database.check,
  });

  const operationsTokenVerifier =
    dependencies.operationsTokenVerifier ??
    (dependencies.config.operationsOidc
      ? createOidcOperationsTokenVerifier(dependencies.config.operationsOidc)
      : createDisabledOperationsTokenVerifier());

  await registerOperationsRoutes(app, {
    database: dependencies.database.pool,
    tokenVerifier: operationsTokenVerifier,
  });

  await registerSyncRoutes(app, {
    database: dependencies.database.pool,
    metrics: syncMetrics,
  });

  app.addHook('onClose', async () => {
    await dependencies.database.close();
  });

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({
      code: 'ROUTE_NOT_FOUND',
      message: 'The requested route does not exist',
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    const normalizedError = normalizeError(error);
    const { statusCode } = normalizedError;

    const errorContext = {
      error: {
        name: normalizedError.name,
        code: normalizedError.code,
      },
    };

    if (statusCode === 500) {
      request.log.error(errorContext, 'Request failed');
    } else {
      request.log.warn(errorContext, 'Request rejected');
    }

    return reply.code(statusCode).send({
      code: statusCode === 500 ? 'INTERNAL_ERROR' : 'REQUEST_REJECTED',
      message:
        statusCode === 500
          ? 'An unexpected error occurred'
          : 'The request could not be accepted',
      requestId: request.id,
    });
  });

  return app;
}
