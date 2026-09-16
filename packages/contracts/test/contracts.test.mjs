import assert from 'node:assert/strict'
import test from 'node:test'

import { validateContracts } from './validate-contracts.mjs'

test('HSD-SYNC-001 and HSD-SYNC-005B contracts remain compatible', () => {
  assert.deepEqual(validateContracts(), {
    schemas: 13,
    validFixtures: 14,
    invalidFixtures: 46,
    openApiOperations: 5,
    lifestyleResponseBranches: 37
  })
})

import { readFileSync } from 'node:fs'
import { validateSyncBatchRequest } from '../src/sync-validation.mjs'
const intakeFixture = () =>
  JSON.parse(
    readFileSync(
      new URL(
        '../fixtures/sync/v1/valid/food-otc-batch-request.json',
        import.meta.url
      ),
      'utf8'
    )
  )

test('Food and OTC preserve optional values and reject identity, row and provenance corruption', () => {
  assert.equal(validateSyncBatchRequest(intakeFixture()).valid, true)
  const mutations = [
    (r) => {
      r.records[0].payload.rows[0].unexpected = 'blocked'
    },
    (r) => {
      r.records[0].payload.rows.push({ ...r.records[0].payload.rows[0] })
    },
    (r) => {
      r.records[0].payload.rows[0].recordedByLocalActorId =
        'ffffffff-ffff-4fff-8fff-ffffffffffff'
    },
    (r) => {
      r.records[0].sourceRevision = 2
    },
    (r) => {
      r.records[0].payload.localEncounterId =
        'ffffffff-ffff-4fff-8fff-ffffffffffff'
    },
    (r) => {
      r.records[0].payload.response = 'DECLINED'
    },
    (r) => {
      r.records[0].payload.periodStart = '2026-08-21'
    },
    (r) => {
      r.records[0].payload.rows[0].recordedAt = '2026-08-21T00:00:00.000Z'
    },
    (r) => {
      r.records[1].payload.rows[0].currentlyTaking = 'YES'
    },
    (r) => {
      r.records[1].payload.rows[0].productName = ' '
    },
    (r) => {
      r.records[1].payload.rows[0].reasonForUse = 'x'.repeat(501)
    }
  ]
  for (const mutate of mutations) {
    const request = intakeFixture()
    mutate(request)
    assert.equal(validateSyncBatchRequest(request).valid, false)
  }
})

test('Food/OTC represent explicit negative answers and unknown legacy metadata without inventing values', () => {
  const request = intakeFixture()
  request.records[0].payload.response = 'DECLINED'
  request.records[0].payload.rows = []
  request.records[1].payload.response = 'NONE_REPORTED'
  request.records[1].payload.rows = []
  assert.equal(validateSyncBatchRequest(request).valid, true)
  for (const record of request.records) {
    record.payload.response = null
    record.payload.periodStart = null
    record.payload.periodEnd = null
  }
  assert.equal(validateSyncBatchRequest(request).valid, true)
})


test('clinical time is an optional strict encounter extension while legacy payloads remain valid', () => {
  const request = JSON.parse(readFileSync(new URL('../fixtures/sync/v1/valid/batch-request.json', import.meta.url), 'utf8'))
  assert.equal(validateSyncBatchRequest(request).valid, true)
  const encounter = request.records.find(r => r.resourceType === 'SCREENING_ENCOUNTER')
  encounter.payload.clinicalTime = {localDate:'2026-08-17',localTime:'09:15',timezone:'Africa/Douala'}
  encounter.payload.startedAt = '2026-08-17T08:15:00.000Z'
  assert.equal(validateSyncBatchRequest(request).valid, true)
  encounter.payload.clinicalTime.extra = 'unexpected'
  assert.equal(validateSyncBatchRequest(request).valid, false)
  delete encounter.payload.clinicalTime.extra
  encounter.payload.clinicalTime.localTime = '25:00'
  assert.equal(validateSyncBatchRequest(request).valid, false)
})
