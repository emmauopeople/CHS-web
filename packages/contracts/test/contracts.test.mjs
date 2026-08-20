import assert from 'node:assert/strict'
import test from 'node:test'

import { validateContracts } from './validate-contracts.mjs'

test('HSD-SYNC-001 schemas, fixtures, and OpenAPI remain compatible', () => {
  assert.deepEqual(validateContracts(), {
    schemas: 10,
    validFixtures: 11,
    invalidFixtures: 17,
    openApiOperations: 5
  })
})
