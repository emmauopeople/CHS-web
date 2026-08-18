import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';

import type { AppConfig } from './config.js';
import type { Database } from './database.js';
import { registerDiagnostics } from './diagnostics.js';
import { loggerOptions } from './logger.js';

export type BuildAppDependencies = Readonly<{
  config: AppConfig;
  database: Pick<Database, 'check' | 'close'>;
}>;

export async function buildApp(dependencies: BuildAppDependencies) {
  const app = Fastify({
    logger: loggerOptions(dependencies.config),
    genReqId: () => randomUUID(),
    requestIdLogLabel: 'requestId',
    disableRequestLogging: true,
    bodyLimit: 1_048_576,
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    return payload;
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'CHS Web API',
        description: 'Community Health Screening cloud API',
        version: '0.1.0',
      },
    },
  });

  if (dependencies.config.nodeEnv !== 'production') {
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  await registerDiagnostics(app, {
    config: dependencies.config,
    checkDatabase: dependencies.database.check,
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
    const statusCode =
      error.statusCode && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode
        : 500;

    const errorContext = {
      error: {
        name: error.name,
        code: error.code || 'UNCLASSIFIED',
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
