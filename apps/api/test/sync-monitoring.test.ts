import { describe, expect, it, vi } from 'vitest';

import {
  getSyncBatchDetail,
  listSyncBatches,
  SyncMonitoringError,
} from '../src/operations/sync-monitoring.js';

const now = new Date('2026-08-20T12:00:00.000Z');

function batchRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    total_items: '1',
    batch_reference: '11000000-0000-4000-8000-000000000001',
    source_batch_id: '21000000-0000-4000-8000-000000000001',
    installation_id: '31000000-0000-4000-8000-000000000001',
    deployment_name: 'Synthetic Desktop',
    organization_name: 'Synthetic Program',
    location_name: 'Synthetic Site',
    status: 'ACCEPTED',
    contract_version: '1.0',
    desktop_application_version: '0.1.0',
    desktop_schema_version: 14,
    source_created_at: new Date('2026-08-20T11:59:00.000Z'),
    received_at: new Date('2026-08-20T12:00:00.000Z'),
    completed_at: new Date('2026-08-20T12:00:01.500Z'),
    accepted_count: 2,
    unchanged_count: 1,
    review_count: 0,
    rejected_count: 0,
    retry_count: 0,
    ...overrides,
  };
}

describe('synchronization monitoring query service', () => {
  it('validates scope, filters, timestamps, and bounded pagination before querying', async () => {
    const database = { query: vi.fn() };
    const invalidQueries = [
      { status: 'UNKNOWN' },
      { installationId: 'not-a-uuid' },
      { receivedFrom: '2026-08-20' },
      {
        receivedFrom: '2026-08-21T00:00:00Z',
        receivedTo: '2026-08-20T00:00:00Z',
      },
      { page: 0 },
      { pageSize: 101 },
    ] as const;

    for (const query of invalidQueries) {
      await expect(
        listSyncBatches(database as never, { kind: 'GLOBAL' }, query as never, now),
      ).rejects.toBeInstanceOf(SyncMonitoringError);
    }
    await expect(
      listSyncBatches(
        database as never,
        { kind: 'ORGANIZATIONS', organizationIds: [] },
        {},
        now,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_SCOPE' });
    expect(database.query).not.toHaveBeenCalled();
  });

  it('derives healthy, attention, and stalled states without returning payloads', async () => {
    const database = {
      query: vi.fn().mockResolvedValue({
        rows: [
          batchRow({ total_items: '3' }),
          batchRow({
            total_items: '3',
            batch_reference: '11000000-0000-4000-8000-000000000002',
            status: 'PARTIAL',
            rejected_count: 1,
          }),
          batchRow({
            total_items: '3',
            batch_reference: '11000000-0000-4000-8000-000000000003',
            status: 'PROCESSING',
            received_at: new Date('2026-08-20T11:40:00.000Z'),
            completed_at: null,
            accepted_count: 0,
            unchanged_count: 0,
          }),
        ],
      }),
    };

    const result = await listSyncBatches(
      database as never,
      { kind: 'GLOBAL' },
      { page: 1, pageSize: 25 },
      now,
    );

    expect(result).toMatchObject({ page: 1, totalItems: 3, totalPages: 1 });
    expect(result.items.map((item) => item.attentionState)).toEqual([
      'HEALTHY',
      'ATTENTION',
      'STALLED',
    ]);
    expect(result.items[0]).toMatchObject({ durationMs: 1500 });
    expect(JSON.stringify(result)).not.toContain('payload_hash');
    expect(JSON.stringify(result)).not.toContain('response_body');
  });

  it('returns only grouped outcome and stable error-code counts for a scoped detail', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [batchRow()] })
      .mockResolvedValueOnce({
        rows: [
          { resource_type: 'PATIENT', status: 'ACCEPTED', outcome_count: '2' },
          { resource_type: 'VITALS', status: 'RETRY', outcome_count: '1' },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            error_code: 'DEPENDENCY_NOT_AVAILABLE',
            retryable: true,
            error_count: '1',
          },
          { error_code: 'patient name leaked', retryable: false, error_count: '1' },
        ],
      });
    const result = await getSyncBatchDetail(
      { query } as never,
      {
        kind: 'ORGANIZATIONS',
        organizationIds: ['41000000-0000-4000-8000-000000000001'],
      },
      '11000000-0000-4000-8000-000000000001',
      now,
    );

    expect(result.outcomeCounts).toEqual([
      { resourceType: 'PATIENT', status: 'ACCEPTED', count: 2 },
      { resourceType: 'VITALS', status: 'RETRY', count: 1 },
    ]);
    expect(result.errorCodeCounts).toEqual([
      { code: 'DEPENDENCY_NOT_AVAILABLE', retryable: true, count: 1 },
      { code: 'UNKNOWN', retryable: false, count: 1 },
    ]);
    const detailQueryArguments = query.mock.calls[0]?.[1];
    expect(detailQueryArguments).toEqual([
      '11000000-0000-4000-8000-000000000001',
      false,
      ['41000000-0000-4000-8000-000000000001'],
    ]);
  });

  it('uses the same not-found result for missing and out-of-scope batches', async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await expect(
      getSyncBatchDetail(
        database as never,
        { kind: 'GLOBAL' },
        '11000000-0000-4000-8000-000000000001',
        now,
      ),
    ).rejects.toMatchObject({ code: 'SYNC_BATCH_NOT_FOUND', statusCode: 404 });
    expect(database.query).toHaveBeenCalledOnce();
  });
});
