import assert from 'node:assert/strict'
import test from 'node:test'

import { validateContracts } from './validate-contracts.mjs'

test('HSD-SYNC-001 and HSD-SYNC-005B contracts remain compatible', () => {
  assert.deepEqual(validateContracts(), {
    schemas: 11,
    validFixtures: 13,
    invalidFixtures: 46,
    openApiOperations: 5,
    lifestyleResponseBranches: 37
  })
})
