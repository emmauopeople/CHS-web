import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  validateSyncBatchRequest,
  validateSyncBatchResponse,
} from '../src/sync-validation.mjs'
const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL(
        '../fixtures/sync/v1/valid/encounter-history-batch-request.json',
        import.meta.url,
      ),
      'utf8',
    ),
  )
test('accepts immutable late addenda, flag opening and closure with original authors', () => {
  const r = fixture()
  assert.deepEqual(validateSyncBatchRequest(r), { valid: true, issues: [] })
  assert.equal(
    validateSyncBatchResponse({
      contractVersion: '1.0',
      batchId: r.batchId,
      batchStatus: 'ACCEPTED',
      receivedAt: r.createdAt,
      completedAt: r.createdAt,
      outcomes: r.records.map((v) => ({
        recordId: v.recordId,
        resourceType: v.resourceType,
        localResourceId: v.localResourceId,
        sourceRevision: 1,
        status: 'ACCEPTED',
        canonicalResourceId: v.localResourceId,
        centralPersonId: null,
        chsMedicalId: null,
        medicalIdStatus: null,
        errors: [],
      })),
    }).valid,
    true,
  )
})
test('represents reopening as a new reasoned event', () => {
  const r = fixture()
  Object.assign(r.records[3].payload, {
    sequenceNumber: 3,
    fromStatus: 'RESOLVED',
    toStatus: 'OPEN',
  })
  assert.equal(validateSyncBatchRequest(r).valid, true)
})
for (const [name, mutate] of [
  [
    'unknown author',
    (r) => {
      r.records[0].payload.createdByLocalActorId =
        '99999999-9999-4999-8999-999999999999'
    },
  ],
  [
    'different mutation author',
    (r) => {
      r.records[0].sourceActorLocalId = r.actors[1].localActorId
    },
  ],
  [
    'changed capture time',
    (r) => {
      r.records[0].capturedAt = r.createdAt
    },
  ],
  [
    'mutable revision',
    (r) => {
      r.records[0].sourceRevision = 2
    },
  ],
  [
    'oversized note',
    (r) => {
      r.records[0].payload.noteText = 'x'.repeat(2001)
    },
  ],
  [
    'blank note',
    (r) => {
      r.records[0].payload.noteText = '  '
    },
  ],
  [
    'oversized description',
    (r) => {
      r.records[1].payload.description = 'x'.repeat(1001)
    },
  ],
  [
    'invalid category',
    (r) => {
      r.records[1].payload.category = 'UNKNOWN'
    },
  ],
  [
    'initial closure',
    (r) => {
      r.records[2].payload.toStatus = 'RESOLVED'
    },
  ],
  [
    'initial reason',
    (r) => {
      r.records[2].payload.changeReason = 'Not an opening'
    },
  ],
  [
    'closure without reason',
    (r) => {
      r.records[3].payload.changeReason = null
    },
  ],
  [
    'terminal rewrite',
    (r) => {
      r.records[3].payload.fromStatus = 'DISMISSED'
    },
  ],
  [
    'unchanged status',
    (r) => {
      r.records[3].payload.toStatus = 'OPEN'
    },
  ],
  [
    'missing original encounter',
    (r) => {
      delete r.records[0].payload.localEncounterId
    },
  ],
  [
    'extra payload field',
    (r) => {
      r.records[0].payload.rawAudit = 'Unexpected'
    },
  ],
])
  test(`rejects ${name}`, () => {
    const r = fixture()
    mutate(r)
    assert.equal(validateSyncBatchRequest(r).valid, false)
  })
