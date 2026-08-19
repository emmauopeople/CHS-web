import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const root = new URL('../', import.meta.url)

const schemaLocations = Object.freeze({
  common: 'schemas/sync/v1/common.schema.json',
  syncRequest: 'schemas/sync/v1/sync-batch-request.schema.json',
  syncResponse: 'schemas/sync/v1/sync-batch-response.schema.json',
  problem: 'schemas/sync/v1/problem-details.schema.json',
  recoveryRequest: 'schemas/identity/v1/medical-id-recovery-request.schema.json',
  recoveryResponse: 'schemas/identity/v1/medical-id-recovery-response.schema.json'
})

const validFixtureCases = Object.freeze([
  ['syncRequest', 'fixtures/sync/v1/valid/batch-request.json'],
  ['syncRequest', 'fixtures/sync/v1/valid/closed-session-request.json'],
  ['syncResponse', 'fixtures/sync/v1/valid/batch-response.json'],
  ['recoveryRequest', 'fixtures/identity/v1/valid/recovery-request.json'],
  ['recoveryResponse', 'fixtures/identity/v1/valid/recovery-response-match.json'],
  ['recoveryResponse', 'fixtures/identity/v1/valid/recovery-response-no-match.json'],
  ['recoveryResponse', 'fixtures/identity/v1/valid/recovery-response-review.json']
])

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, root), 'utf8'))
}

function formatErrors(errors) {
  return JSON.stringify(errors ?? [], null, 2)
}

function createAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  addFormats(ajv)

  for (const relativePath of Object.values(schemaLocations)) {
    const schema = readJson(relativePath)
    if (!ajv.validateSchema(schema)) {
      throw new Error(`Invalid JSON Schema ${relativePath}: ${formatErrors(ajv.errors)}`)
    }
    ajv.addSchema(schema)
  }

  return ajv
}

function getTarget(document, pointer) {
  const segments = pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
  const key = segments.pop()
  let parent = document

  for (const segment of segments) {
    parent = parent[segment]
  }

  return { parent, key }
}

function applyMutation(document, mutation) {
  const mutated = structuredClone(document)
  const { parent, key } = getTarget(mutated, mutation.path)

  if (mutation.operation === 'remove') {
    delete parent[key]
  } else if (mutation.operation === 'add' || mutation.operation === 'replace') {
    parent[key] = mutation.value
  } else {
    throw new Error(`Unsupported fixture mutation: ${mutation.operation}`)
  }

  return mutated
}

function assertRequestSemantics(request) {
  const actorIds = new Set()
  for (const actor of request.actors) {
    if (actorIds.has(actor.localActorId)) {
      throw new Error(`Duplicate source actor: ${actor.localActorId}`)
    }
    actorIds.add(actor.localActorId)
  }

  const recordIds = new Set()
  const snapshotKeys = new Set()
  for (const record of request.records) {
    const actorReferences = [['sourceActorLocalId', record.sourceActorLocalId]]

    if (record.resourceType === 'SCREENING_SESSION') {
      actorReferences.push(
        ['payload.openedByLocalActorId', record.payload.openedByLocalActorId],
        ['payload.closedByLocalActorId', record.payload.closedByLocalActorId]
      )
    } else if (record.resourceType === 'SCREENING_ENCOUNTER') {
      actorReferences.push([
        'payload.recordedByLocalActorId',
        record.payload.recordedByLocalActorId
      ])
    } else if (record.resourceType === 'VITALS') {
      actorReferences.push([
        'payload.performedByLocalActorId',
        record.payload.performedByLocalActorId
      ])
      const readingIds = new Set()
      const sequences = new Set()
      for (const reading of record.payload.readings) {
        if (readingIds.has(reading.localReadingId)) {
          throw new Error(`Duplicate vitals reading ID: ${reading.localReadingId}`)
        }
        if (sequences.has(reading.sequenceNumber)) {
          throw new Error(`Duplicate vitals reading sequence: ${reading.sequenceNumber}`)
        }
        if (reading.measurementTimezone !== request.installationTimezone) {
          throw new Error(
            `Vitals reading timezone differs from installation: ${reading.localReadingId}`
          )
        }
        readingIds.add(reading.localReadingId)
        sequences.add(reading.sequenceNumber)
      }
      const orderedSequences = [...sequences].sort((left, right) => left - right)
      if (orderedSequences.some((sequence, index) => sequence !== index + 1)) {
        throw new Error(`Vitals reading sequence is not contiguous: ${record.recordId}`)
      }
    }

    for (const [field, actorId] of actorReferences) {
      if (actorId !== null && !actorIds.has(actorId)) {
        throw new Error(`Record ${record.recordId} has unknown actor at ${field}`)
      }
    }
    if (recordIds.has(record.recordId)) {
      throw new Error(`Duplicate record ID: ${record.recordId}`)
    }
    recordIds.add(record.recordId)

    const snapshotKey = [record.resourceType, record.localResourceId, record.sourceRevision].join(':')
    if (snapshotKeys.has(snapshotKey)) {
      throw new Error(`Duplicate source snapshot: ${snapshotKey}`)
    }
    snapshotKeys.add(snapshotKey)
  }
}

function assertOpenApi() {
  const openApiPath = 'openapi/sync-v1.openapi.json'
  const document = readJson(openApiPath)

  if (document.openapi !== '3.1.0' || document.info?.version !== '1.0.0') {
    throw new Error('OpenAPI document must declare OpenAPI 3.1.0 and API version 1.0.0')
  }

  const expectedOperations = new Map([
    ['/api/v1/sync/batches:post', ['submitSyncBatchV1', 'installationBearer']],
    ['/api/v1/sync/batches/{batchId}:get', ['getSyncBatchV1', 'installationBearer']],
    [
      '/api/v1/identity/medical-id-recovery:post',
      ['recoverMedicalIdV1', 'operationsBearer']
    ]
  ])

  for (const [key, [operationId, securityScheme]] of expectedOperations) {
    const [path, method] = key.split(':')
    const operation = document.paths?.[path]?.[method]
    if (operation?.operationId !== operationId) {
      throw new Error(`OpenAPI operation missing or renamed: ${operationId}`)
    }
    if (!operation.security?.some((requirement) => securityScheme in requirement)) {
      throw new Error(`OpenAPI operation ${operationId} must require ${securityScheme}`)
    }
  }

  const externalRefs = []
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (value === null || typeof value !== 'object') return

    if (typeof value.$ref === 'string' && !value.$ref.startsWith('#')) {
      externalRefs.push(value.$ref)
    }
    Object.values(value).forEach(visit)
  }
  visit(document)

  for (const reference of externalRefs) {
    const referenceUrl = new URL(reference, new URL(openApiPath, root))
    readFileSync(referenceUrl)
  }
}

export function validateContracts() {
  const ajv = createAjv()

  for (const [schemaName, fixturePath] of validFixtureCases) {
    const schemaId = readJson(schemaLocations[schemaName]).$id
    const validate = ajv.getSchema(schemaId)
    const fixture = readJson(fixturePath)

    if (!validate(fixture)) {
      throw new Error(`Fixture ${fixturePath} is invalid: ${formatErrors(validate.errors)}`)
    }
    if (schemaName === 'syncRequest') {
      assertRequestSemantics(fixture)
    }
  }

  const requestSchemaId = readJson(schemaLocations.syncRequest).$id
  const validateRequest = ajv.getSchema(requestSchemaId)
  const validRequest = readJson('fixtures/sync/v1/valid/batch-request.json')
  const invalidCases = readJson('fixtures/sync/v1/invalid/request-cases.json')

  for (const invalidCase of invalidCases) {
    const invalidRequest = applyMutation(validRequest, invalidCase)
    let semanticsValid = true
    try {
      assertRequestSemantics(invalidRequest)
    } catch {
      semanticsValid = false
    }
    if (validateRequest(invalidRequest) && semanticsValid) {
      throw new Error(`Invalid fixture was accepted: ${invalidCase.name}`)
    }
  }

  assertOpenApi()

  return Object.freeze({
    schemas: Object.keys(schemaLocations).length,
    validFixtures: validFixtureCases.length,
    invalidFixtures: invalidCases.length,
    openApiOperations: 3
  })
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null
if (invokedPath === import.meta.url) {
  const result = validateContracts()
  process.stdout.write(`Validated HSD-SYNC-001 contracts: ${JSON.stringify(result)}\n`)
}
