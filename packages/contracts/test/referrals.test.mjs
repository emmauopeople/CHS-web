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
        '../fixtures/sync/v1/valid/referral-batch-request.json',
        import.meta.url,
      ),
      'utf8',
    ),
  )
test('referrals and late follow-ups are accepted with original occurrence/recording dates', () => {
  const request = fixture()
  assert.equal(validateSyncBatchRequest(request).valid, true)
  assert.equal(request.records[2].payload.contactDate, '2026-08-26')
  assert.equal(
    request.records[2].payload.recordedAt,
    '2026-08-27T10:30:00.000Z',
  )
  assert.equal(
    validateSyncBatchResponse({
      contractVersion: '1.0',
      batchId: request.batchId,
      batchStatus: 'ACCEPTED',
      receivedAt: request.createdAt,
      completedAt: request.createdAt,
      outcomes: request.records.map((r) => ({
        recordId: r.recordId,
        resourceType: r.resourceType,
        localResourceId: r.localResourceId,
        sourceRevision: r.sourceRevision,
        status: 'ACCEPTED',
        canonicalResourceId: r.localResourceId,
        centralPersonId: null,
        chsMedicalId: null,
        medicalIdStatus: null,
        errors: [],
      })),
    }).valid,
    true,
  )
})
for (const [name, mutate] of [
  [
    'unknown author',
    (r) => {
      r.records[2].payload.recordedByLocalActorId =
        '99999999-9999-4999-8999-999999999999'
    },
  ],
  [
    'mutation actor mismatch',
    (r) => {
      r.records[0].sourceActorLocalId = r.actors[1].localActorId
    },
  ],
  [
    'incorrect recorded timestamp',
    (r) => {
      r.records[2].capturedAt = r.records[0].capturedAt
    },
  ],
  [
    'invalid closing state',
    (r) => {
      r.records[0].payload.status = 'CLOSED'
    },
  ],
  [
    'invalid first history state',
    (r) => {
      r.records[1].payload.fromStatus = 'SEEN'
    },
  ],
  [
    'immutable event revision',
    (r) => {
      r.records[2].sourceRevision = 2
    },
  ],
  [
    'duplicate treatment IDs',
    (r) => {
      r.records[2].payload.treatmentActions.push(
        r.records[2].payload.treatmentActions[0],
      )
    },
  ],
  [
    'medication without matching action',
    (r) => {
      r.records[2].payload.treatmentActions = []
    },
  ],
  [
    'broken medication order',
    (r) => {
      r.records[2].payload.medicationChanges[0].sequenceNumber = 2
    },
  ],
  [
    'oversized follow-up',
    (r) => {
      r.records[2].payload.reportedOutcome = 'x'.repeat(2001)
    },
  ],
  [
    'unknown property',
    (r) => {
      r.records[2].payload.untrustedField = 'discard me'
    },
  ],
])
  test(`rejects ${name}`, () => {
    const request = fixture()
    mutate(request)
    assert.equal(validateSyncBatchRequest(request).valid, false)
  })
