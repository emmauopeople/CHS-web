import type { FastifyInstance } from 'fastify';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

import type { AppConfig } from './config.js';

type DiagnosticsDependencies = Readonly<{
  config: AppConfig;
  checkDatabase: () => Promise<void>;
}>;

export type SyncMetrics = Readonly<{
  recordBatch: (
    batchStatus: 'ACCEPTED' | 'PARTIAL' | 'REJECTED',
    replayed: boolean,
  ) => void;
  recordOutcome: (resourceType: string, status: string) => void;
  recordIdentityResolutionPull: (deliveryCount: number, hasMore: boolean) => void;
  recordIdentityResolutionAcknowledgment: (replayed: boolean) => void;
}>;

const healthResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['service', 'status', 'timestamp'],
  properties: {
    service: { type: 'string' },
    status: { type: 'string' },
    timestamp: { type: 'string', format: 'date-time' },
  },
} as const;

export async function registerDiagnostics(
  app: FastifyInstance,
  dependencies: DiagnosticsDependencies,
): Promise<SyncMetrics> {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'chs-api' });
  collectDefaultMetrics({ prefix: 'chs_api_', register: registry });

  const httpRequests = new Counter({
    name: 'chs_api_http_requests_total',
    help: 'Total HTTP requests completed by the CHS API',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [registry],
  });
  const httpDuration = new Histogram({
    name: 'chs_api_http_request_duration_seconds',
    help: 'CHS API HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  const syncBatches = new Counter({
    name: 'chs_api_sync_batches_total',
    help: 'Total completed or replayed desktop synchronization batches',
    labelNames: ['batch_status', 'replayed'] as const,
    registers: [registry],
  });
  const syncOutcomes = new Counter({
    name: 'chs_api_sync_record_outcomes_total',
    help: 'Total desktop synchronization record outcomes',
    labelNames: ['resource_type', 'status'] as const,
    registers: [registry],
  });
  const identityResolutionPulls = new Counter({
    name: 'chs_api_identity_resolution_pulls_total',
    help: 'Total successful desktop identity resolution pulls',
    labelNames: ['result', 'has_more'] as const,
    registers: [registry],
  });
  const identityResolutionAcknowledgments = new Counter({
    name: 'chs_api_identity_resolution_acknowledgments_total',
    help: 'Total successful or replayed desktop identity resolution acknowledgments',
    labelNames: ['replayed'] as const,
    registers: [registry],
  });
  const requestStartTimes = new WeakMap<object, bigint>();

  app.addHook('onRequest', async (request, reply) => {
    requestStartTimes.set(request, process.hrtime.bigint());
    reply.header('x-request-id', request.id);
  });

  app.addHook('onResponse', async (request, reply) => {
    const startedAt = requestStartTimes.get(request);
    const durationSeconds = startedAt
      ? Number(process.hrtime.bigint() - startedAt) / 1_000_000_000
      : 0;
    const labels = {
      method: request.method,
      route: request.routeOptions.url || 'unmatched',
      status_code: String(reply.statusCode),
    };

    httpRequests.inc(labels);
    httpDuration.observe(labels, durationSeconds);
    request.log.info(
      {
        http: {
          method: labels.method,
          route: labels.route,
          statusCode: reply.statusCode,
          durationMs: Math.round(durationSeconds * 1_000),
        },
      },
      'Request completed',
    );
  });

  app.get(
    '/health/live',
    { schema: { tags: ['Diagnostics'], response: { 200: healthResponseSchema } } },
    async () => ({
      service: 'chs-api',
      status: 'alive',
      timestamp: new Date().toISOString(),
    }),
  );

  app.get(
    '/health/startup',
    { schema: { tags: ['Diagnostics'], response: { 200: healthResponseSchema } } },
    async () => ({
      service: 'chs-api',
      status: 'started',
      timestamp: new Date().toISOString(),
    }),
  );

  app.get('/health/ready', { schema: { tags: ['Diagnostics'] } }, async (_request, reply) => {
    try {
      await dependencies.checkDatabase();
      return {
        service: 'chs-api',
        status: 'ready',
        timestamp: new Date().toISOString(),
        checks: { postgres: 'pass' },
      };
    } catch {
      app.log.warn({ dependency: 'postgres' }, 'Readiness check failed');
      return reply.code(503).send({
        service: 'chs-api',
        status: 'not-ready',
        timestamp: new Date().toISOString(),
        checks: { postgres: 'fail' },
      });
    }
  });

  app.get('/metrics', { schema: { tags: ['Diagnostics'], hide: true } }, async (_request, reply) => {
    return reply.type(registry.contentType).send(await registry.metrics());
  });

  app.get('/version', { schema: { tags: ['Diagnostics'] } }, async () => ({
    service: 'chs-api',
    version: '0.1.0',
    commit: dependencies.config.buildCommit,
    builtAt: dependencies.config.buildTime,
    runtime: process.version,
  }));

  return {
    recordBatch(batchStatus, replayed) {
      syncBatches.inc({
        batch_status: batchStatus,
        replayed: replayed ? 'true' : 'false',
      });
    },
    recordOutcome(resourceType, status) {
      syncOutcomes.inc({ resource_type: resourceType, status });
    },
    recordIdentityResolutionPull(deliveryCount, hasMore) {
      identityResolutionPulls.inc({
        result: deliveryCount === 0 ? 'empty' : 'deliveries',
        has_more: hasMore ? 'true' : 'false',
      });
    },
    recordIdentityResolutionAcknowledgment(replayed) {
      identityResolutionAcknowledgments.inc({
        replayed: replayed ? 'true' : 'false',
      });
    },
  };
}
