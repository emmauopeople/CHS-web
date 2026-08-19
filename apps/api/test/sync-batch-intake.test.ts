import { describe, expect, it } from 'vitest';

import { syncBatchPayloadHash } from '../src/sync/batch-intake.js';
import type { SyncBatchRequest } from '../src/sync/types.js';

const request = {
  contractVersion: '1.0',
  batchId: '10000000-0000-4000-8000-000000000001',
  installationId: '20000000-0000-4000-8000-000000000001',
  locationId: '30000000-0000-4000-8000-000000000001',
  installationTimezone: 'Africa/Douala',
  desktopApplicationVersion: '0.13.0',
  desktopSchemaVersion: 13,
  createdAt: '2026-08-19T12:00:00.000Z',
  actors: [
    {
      localActorId: '60000000-0000-4000-8000-000000000002',
      displayName: 'Second Synthetic Actor',
      role: 'NURSE',
      active: true,
      updatedAt: '2026-08-19T11:00:00.000Z',
    },
    {
      localActorId: '60000000-0000-4000-8000-000000000001',
      displayName: 'First Synthetic Actor',
      role: 'LOCAL_ADMIN',
      active: true,
      updatedAt: '2026-08-19T11:00:00.000Z',
    },
  ],
  records: [
    {
      recordId: '40000000-0000-4000-8000-000000000002',
      resourceType: 'VITALS',
      localResourceId: '50000000-0000-4000-8000-000000000002',
      sourceRevision: 1,
      schemaVersion: 'vitals.v1',
      operation: 'UPSERT',
      capturedAt: '2026-08-19T11:00:00.000Z',
      sourceActorLocalId: '60000000-0000-4000-8000-000000000002',
      payload: { value: 2 },
    },
    {
      recordId: '40000000-0000-4000-8000-000000000001',
      resourceType: 'PATIENT',
      localResourceId: '50000000-0000-4000-8000-000000000001',
      sourceRevision: 1,
      schemaVersion: 'patient.v1',
      operation: 'UPSERT',
      capturedAt: '2026-08-19T10:00:00.000Z',
      sourceActorLocalId: '60000000-0000-4000-8000-000000000001',
      payload: { value: 1 },
    },
  ],
} satisfies SyncBatchRequest;

describe('sync batch payload identity', () => {
  it('ignores actor and record array order as required by the contract', () => {
    const reordered = {
      ...request,
      actors: [...request.actors].reverse(),
      records: [...request.records].reverse(),
    };

    expect(syncBatchPayloadHash(reordered)).toBe(syncBatchPayloadHash(request));
  });

  it('changes when approved request content changes', () => {
    expect(
      syncBatchPayloadHash({ ...request, desktopSchemaVersion: 14 }),
    ).not.toBe(syncBatchPayloadHash(request));
  });
});
