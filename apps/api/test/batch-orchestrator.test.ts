import { describe, expect, it } from 'vitest';

import {
  deriveBatchStatus,
  orderSyncRecords,
} from '../src/sync/batch-orchestrator.js';
import type {
  SyncRecordOutcome,
  SyncRecordSnapshot,
} from '../src/sync/types.js';

function record(
  resourceType: SyncRecordSnapshot['resourceType'],
  localResourceId: string,
  sourceRevision = 1,
): SyncRecordSnapshot {
  return {
    recordId: `${resourceType}-${localResourceId}-${sourceRevision}`,
    resourceType,
    localResourceId,
    sourceRevision,
    schemaVersion: 'synthetic.v1',
    operation: 'UPSERT',
    capturedAt: '2026-08-19T12:00:00.000Z',
    sourceActorLocalId: 'actor',
    payload: {},
  };
}

function outcome(
  status: SyncRecordOutcome['status'],
): SyncRecordOutcome {
  return {
    recordId: '40000000-0000-4000-8000-000000000001',
    resourceType: 'PATIENT',
    localResourceId: '50000000-0000-4000-8000-000000000001',
    sourceRevision: 1,
    status,
    canonicalResourceId: null,
    centralPersonId: null,
    chsMedicalId: null,
    medicalIdStatus: status === 'REVIEW_REQUIRED' ? 'PENDING_REVIEW' : null,
    errors: [],
  };
}

describe('sync batch orchestration policy', () => {
  it('orders dependencies independently of request array order', () => {
    const records = [
      record('VITALS', 'a', 2),
      record('SCREENING_ENCOUNTER', 'z'),
      record('PATIENT', 'b', 2),
      record('SCREENING_SESSION', 's'),
      record('PATIENT', 'b', 1),
    ];

    expect(orderSyncRecords(records).map((item) => [item.resourceType, item.sourceRevision]))
      .toEqual([
        ['PATIENT', 1],
        ['PATIENT', 2],
        ['SCREENING_SESSION', 1],
        ['SCREENING_ENCOUNTER', 1],
        ['VITALS', 2],
      ]);
    expect(records[0]?.resourceType).toBe('VITALS');
  });

  it('derives accepted, rejected, and partial batch states', () => {
    expect(deriveBatchStatus([outcome('ACCEPTED'), outcome('UNCHANGED')])).toBe(
      'ACCEPTED',
    );
    expect(deriveBatchStatus([outcome('REJECTED'), outcome('RETRY')])).toBe(
      'REJECTED',
    );
    expect(deriveBatchStatus([outcome('ACCEPTED'), outcome('REJECTED')])).toBe(
      'PARTIAL',
    );
    expect(deriveBatchStatus([outcome('REVIEW_REQUIRED')])).toBe('PARTIAL');
  });
});
