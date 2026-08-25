import type { Pool } from 'pg';

import type { PatientAccessScope } from './patient-query.js';

type MonitoringDatabase = Pick<Pool, 'query'>;

export type MonitoredSyncBatchStatus =
  | 'PROCESSING'
  | 'ACCEPTED'
  | 'PARTIAL'
  | 'REJECTED'
  | 'FAILED';

export type SyncBatchMonitoringQuery = Readonly<{
  status?: MonitoredSyncBatchStatus | 'ALL';
  installationId?: string;
  receivedFrom?: string;
  receivedTo?: string;
  page?: number;
  pageSize?: number;
}>;

export type SyncBatchAttentionState = 'HEALTHY' | 'ATTENTION' | 'STALLED';

export type SyncBatchMonitoringItem = Readonly<{
  batchReference: string;
  sourceBatchId: string;
  installationId: string;
  deploymentName: string;
  organizationName: string;
  locationName: string;
  status: MonitoredSyncBatchStatus;
  attentionState: SyncBatchAttentionState;
  contractVersion: string;
  desktopApplicationVersion: string;
  desktopSchemaVersion: number;
  sourceCreatedAt: string;
  receivedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  counts: Readonly<{
    accepted: number;
    unchanged: number;
    reviewRequired: number;
    rejected: number;
    retry: number;
  }>;
}>;

export type SyncBatchMonitoringPage = Readonly<{
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  items: readonly SyncBatchMonitoringItem[];
}>;

export type SyncBatchOutcomeCount = Readonly<{
  resourceType:
    | 'PATIENT'
    | 'SCREENING_SESSION'
    | 'SCREENING_ENCOUNTER'
    | 'VITALS'
    | 'LIFESTYLE';
  status:
    | 'PROCESSING'
    | 'ACCEPTED'
    | 'UNCHANGED'
    | 'REVIEW_REQUIRED'
    | 'REJECTED'
    | 'RETRY';
  count: number;
}>;

export type SyncBatchErrorCodeCount = Readonly<{
  code: string;
  retryable: boolean;
  count: number;
}>;

export type SyncBatchMonitoringDetail = SyncBatchMonitoringItem &
  Readonly<{
    outcomeCounts: readonly SyncBatchOutcomeCount[];
    errorCodeCounts: readonly SyncBatchErrorCodeCount[];
  }>;

export type SyncMonitoringErrorCode =
  | 'INVALID_ACCESS_SCOPE'
  | 'INVALID_BATCH_REFERENCE'
  | 'INVALID_INSTALLATION_ID'
  | 'INVALID_PAGE'
  | 'INVALID_PAGE_SIZE'
  | 'INVALID_RECEIVED_PERIOD'
  | 'INVALID_SYNC_STATUS'
  | 'SYNC_BATCH_NOT_FOUND';

export class SyncMonitoringError extends Error {
  constructor(
    readonly code: SyncMonitoringErrorCode,
    readonly statusCode: 400 | 404,
  ) {
    super('Synchronization monitoring query failed');
    this.name = 'SyncMonitoringError';
  }
}

type PreparedScope = Readonly<{
  global: boolean;
  organizationIds: readonly string[];
}>;

type PreparedQuery = Readonly<{
  status: MonitoredSyncBatchStatus | null;
  installationId: string | null;
  receivedFrom: string | null;
  receivedTo: string | null;
  page: number;
  pageSize: number;
  offset: number;
}>;

type BatchRow = Readonly<{
  total_items?: string;
  batch_reference: string;
  source_batch_id: string;
  installation_id: string;
  deployment_name: string;
  organization_name: string;
  location_name: string;
  status: MonitoredSyncBatchStatus;
  contract_version: string;
  desktop_application_version: string;
  desktop_schema_version: number;
  source_created_at: Date;
  received_at: Date;
  completed_at: Date | null;
  accepted_count: number;
  unchanged_count: number;
  review_count: number;
  rejected_count: number;
  retry_count: number;
}>;

type OutcomeCountRow = Readonly<{
  resource_type: SyncBatchOutcomeCount['resourceType'];
  status: SyncBatchOutcomeCount['status'];
  outcome_count: string;
}>;

type ErrorCodeCountRow = Readonly<{
  error_code: string;
  retryable: boolean;
  error_count: string;
}>;

const batchStatuses: readonly MonitoredSyncBatchStatus[] = [
  'PROCESSING',
  'ACCEPTED',
  'PARTIAL',
  'REJECTED',
  'FAILED',
];
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeErrorCodePattern = /^[A-Z][A-Z0-9_]{0,99}$/;
const stalledAfterMs = 15 * 60 * 1_000;

function prepareScope(scope: PatientAccessScope): PreparedScope {
  if (scope.kind === 'GLOBAL') return { global: true, organizationIds: [] };
  const organizationIds = [...new Set(scope.organizationIds)];
  if (
    organizationIds.length === 0 ||
    organizationIds.some((organizationId) => !uuidPattern.test(organizationId))
  ) {
    throw new SyncMonitoringError('INVALID_ACCESS_SCOPE', 400);
  }
  return { global: false, organizationIds };
}

function normalizedInstant(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (
    value.length > 40 ||
    !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new SyncMonitoringError('INVALID_RECEIVED_PERIOD', 400);
  }
  return new Date(value).toISOString();
}

function prepareQuery(query: SyncBatchMonitoringQuery): PreparedQuery {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 25;
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
    throw new SyncMonitoringError('INVALID_PAGE', 400);
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new SyncMonitoringError('INVALID_PAGE_SIZE', 400);
  }
  const status = query.status ?? 'ALL';
  if (status !== 'ALL' && !batchStatuses.includes(status)) {
    throw new SyncMonitoringError('INVALID_SYNC_STATUS', 400);
  }
  const installationId = query.installationId ?? null;
  if (installationId !== null && !uuidPattern.test(installationId)) {
    throw new SyncMonitoringError('INVALID_INSTALLATION_ID', 400);
  }
  const receivedFrom = normalizedInstant(query.receivedFrom);
  const receivedTo = normalizedInstant(query.receivedTo);
  if (receivedFrom && receivedTo && receivedFrom > receivedTo) {
    throw new SyncMonitoringError('INVALID_RECEIVED_PERIOD', 400);
  }
  return {
    status: status === 'ALL' ? null : status,
    installationId,
    receivedFrom,
    receivedTo,
    page,
    pageSize,
    offset: (page - 1) * pageSize,
  };
}

function attentionState(row: BatchRow, now: Date): SyncBatchAttentionState {
  if (
    row.status === 'PROCESSING' &&
    now.getTime() - row.received_at.getTime() >= stalledAfterMs
  ) {
    return 'STALLED';
  }
  if (
    row.status === 'FAILED' ||
    row.status === 'PARTIAL' ||
    row.status === 'REJECTED' ||
    row.review_count > 0 ||
    row.rejected_count > 0 ||
    row.retry_count > 0
  ) {
    return 'ATTENTION';
  }
  return 'HEALTHY';
}

function batchView(row: BatchRow, now: Date): SyncBatchMonitoringItem {
  return {
    batchReference: row.batch_reference,
    sourceBatchId: row.source_batch_id,
    installationId: row.installation_id,
    deploymentName: row.deployment_name,
    organizationName: row.organization_name,
    locationName: row.location_name,
    status: row.status,
    attentionState: attentionState(row, now),
    contractVersion: row.contract_version,
    desktopApplicationVersion: row.desktop_application_version,
    desktopSchemaVersion: row.desktop_schema_version,
    sourceCreatedAt: row.source_created_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    durationMs: row.completed_at
      ? Math.max(0, row.completed_at.getTime() - row.received_at.getTime())
      : null,
    counts: {
      accepted: row.accepted_count,
      unchanged: row.unchanged_count,
      reviewRequired: row.review_count,
      rejected: row.rejected_count,
      retry: row.retry_count,
    },
  };
}

const batchSelect = `
  sync_batch.id AS batch_reference,
  sync_batch.batch_id AS source_batch_id,
  sync_batch.installation_id,
  installation.deployment_name,
  organization.name AS organization_name,
  location.name AS location_name,
  sync_batch.status,
  sync_batch.contract_version,
  sync_batch.desktop_application_version,
  sync_batch.desktop_schema_version,
  sync_batch.source_created_at,
  sync_batch.received_at,
  sync_batch.completed_at,
  sync_batch.accepted_count,
  sync_batch.unchanged_count,
  sync_batch.review_count,
  sync_batch.rejected_count,
  sync_batch.retry_count`;

const batchJoins = `
  JOIN desktop_installations AS installation
    ON installation.id = sync_batch.installation_id
  JOIN organizations AS organization
    ON organization.id = sync_batch.organization_id
  JOIN locations AS location
    ON location.id = sync_batch.location_id`;

export async function listSyncBatches(
  database: MonitoringDatabase,
  accessScope: PatientAccessScope,
  query: SyncBatchMonitoringQuery,
  now: Date = new Date(),
): Promise<SyncBatchMonitoringPage> {
  const scope = prepareScope(accessScope);
  const prepared = prepareQuery(query);
  const result = await database.query<BatchRow>(
    `SELECT count(*) OVER()::text AS total_items, ${batchSelect}
     FROM sync_batches AS sync_batch
     ${batchJoins}
     WHERE ($1::boolean OR sync_batch.organization_id = ANY($2::uuid[]))
       AND ($3::text IS NULL OR sync_batch.status = $3)
       AND ($4::uuid IS NULL OR sync_batch.installation_id = $4)
       AND ($5::timestamptz IS NULL OR sync_batch.received_at >= $5)
       AND ($6::timestamptz IS NULL OR sync_batch.received_at <= $6)
     ORDER BY sync_batch.received_at DESC, sync_batch.id DESC
     LIMIT $7 OFFSET $8`,
    [
      scope.global,
      scope.organizationIds,
      prepared.status,
      prepared.installationId,
      prepared.receivedFrom,
      prepared.receivedTo,
      prepared.pageSize,
      prepared.offset,
    ],
  );
  const totalItems = Number(result.rows[0]?.total_items ?? 0);
  return {
    page: prepared.page,
    pageSize: prepared.pageSize,
    totalItems,
    totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / prepared.pageSize),
    items: result.rows.map((row) => batchView(row, now)),
  };
}

export async function getSyncBatchDetail(
  database: MonitoringDatabase,
  accessScope: PatientAccessScope,
  batchReference: string,
  now: Date = new Date(),
): Promise<SyncBatchMonitoringDetail> {
  if (!uuidPattern.test(batchReference)) {
    throw new SyncMonitoringError('INVALID_BATCH_REFERENCE', 400);
  }
  const scope = prepareScope(accessScope);
  const batchResult = await database.query<BatchRow>(
    `SELECT ${batchSelect}
     FROM sync_batches AS sync_batch
     ${batchJoins}
     WHERE sync_batch.id = $1
       AND ($2::boolean OR sync_batch.organization_id = ANY($3::uuid[]))`,
    [batchReference, scope.global, scope.organizationIds],
  );
  const batch = batchResult.rows[0];
  if (!batch) throw new SyncMonitoringError('SYNC_BATCH_NOT_FOUND', 404);

  const [outcomes, errors] = await Promise.all([
    database.query<OutcomeCountRow>(
      `SELECT resource_type, status, count(*)::text AS outcome_count
       FROM sync_records
       WHERE batch_internal_id = $1
       GROUP BY resource_type, status
       ORDER BY resource_type, status`,
      [batchReference],
    ),
    database.query<ErrorCodeCountRow>(
      `SELECT
         CASE
           WHEN error_item->>'code' ~ '^[A-Z][A-Z0-9_]{0,99}$'
             THEN error_item->>'code'
           ELSE 'UNKNOWN'
         END AS error_code,
         CASE
           WHEN error_item->>'retryable' IN ('true', 'false')
             THEN (error_item->>'retryable')::boolean
           ELSE false
         END AS retryable,
         count(*)::text AS error_count
       FROM sync_records AS sync_record
       CROSS JOIN LATERAL jsonb_array_elements(sync_record.errors) AS error_item
       WHERE sync_record.batch_internal_id = $1
       GROUP BY error_code, retryable
       ORDER BY error_code, retryable`,
      [batchReference],
    ),
  ]);

  return {
    ...batchView(batch, now),
    outcomeCounts: outcomes.rows.map((row) => ({
      resourceType: row.resource_type,
      status: row.status,
      count: Number(row.outcome_count),
    })),
    errorCodeCounts: errors.rows.map((row) => ({
      code: safeErrorCodePattern.test(row.error_code) ? row.error_code : 'UNKNOWN',
      retryable: row.retryable,
      count: Number(row.error_count),
    })),
  };
}
