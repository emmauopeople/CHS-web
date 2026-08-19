import { readFileSync } from 'node:fs'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const contractRoot = new URL('../', import.meta.url)

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, contractRoot), 'utf8'))
}

const schemaPaths = Object.freeze([
  'schemas/sync/v1/common.schema.json',
  'schemas/sync/v1/sync-batch-request.schema.json',
  'schemas/sync/v1/sync-batch-response.schema.json'
])

const schemas = schemaPaths.map(readJson)
const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)
schemas.forEach((schema) => ajv.addSchema(schema))

const requestSchemaId =
  'https://chs.example/contracts/sync/v1/sync-batch-request.schema.json'
const responseSchemaId =
  'https://chs.example/contracts/sync/v1/sync-batch-response.schema.json'
const validateRequestSchema = ajv.getSchema(requestSchemaId)
const validateResponseSchema = ajv.getSchema(responseSchemaId)

if (!validateRequestSchema || !validateResponseSchema) {
  throw new Error('Synchronization contract validator failed to initialize')
}

function schemaIssues(errors) {
  return (errors ?? []).map((error) => ({
    code: `SCHEMA_${error.keyword.toUpperCase()}`,
    path: error.instancePath || ''
  }))
}

function semanticRequestIssues(request) {
  if (request === null || typeof request !== 'object') return []

  const issues = []
  const actorIds = new Set()
  for (const [index, actor] of request.actors.entries()) {
    if (actorIds.has(actor.localActorId)) {
      issues.push({ code: 'DUPLICATE_ACTOR_ID', path: `/actors/${index}/localActorId` })
    }
    actorIds.add(actor.localActorId)
  }

  const recordIds = new Set()
  const snapshotKeys = new Set()
  for (const [recordIndex, record] of request.records.entries()) {
    if (recordIds.has(record.recordId)) {
      issues.push({
        code: 'DUPLICATE_RECORD_ID',
        path: `/records/${recordIndex}/recordId`
      })
    }
    recordIds.add(record.recordId)

    const snapshotKey = [
      record.resourceType,
      record.localResourceId,
      record.sourceRevision
    ].join(':')
    if (snapshotKeys.has(snapshotKey)) {
      issues.push({
        code: 'DUPLICATE_SOURCE_SNAPSHOT',
        path: `/records/${recordIndex}`
      })
    }
    snapshotKeys.add(snapshotKey)

    const actorReferences = [
      ['sourceActorLocalId', record.sourceActorLocalId]
    ]
    if (record.resourceType === 'SCREENING_SESSION') {
      actorReferences.push(
        ['payload/openedByLocalActorId', record.payload.openedByLocalActorId],
        ['payload/closedByLocalActorId', record.payload.closedByLocalActorId]
      )
    } else if (record.resourceType === 'SCREENING_ENCOUNTER') {
      actorReferences.push([
        'payload/recordedByLocalActorId',
        record.payload.recordedByLocalActorId
      ])
    } else if (record.resourceType === 'VITALS') {
      actorReferences.push([
        'payload/performedByLocalActorId',
        record.payload.performedByLocalActorId
      ])
      const readingIds = new Set()
      const sequences = new Set()
      for (const [readingIndex, reading] of record.payload.readings.entries()) {
        if (readingIds.has(reading.localReadingId)) {
          issues.push({
            code: 'DUPLICATE_VITALS_READING_ID',
            path: `/records/${recordIndex}/payload/readings/${readingIndex}/localReadingId`
          })
        }
        if (sequences.has(reading.sequenceNumber)) {
          issues.push({
            code: 'DUPLICATE_VITALS_READING_SEQUENCE',
            path: `/records/${recordIndex}/payload/readings/${readingIndex}/sequenceNumber`
          })
        }
        if (reading.measurementTimezone !== request.installationTimezone) {
          issues.push({
            code: 'VITALS_TIMEZONE_MISMATCH',
            path: `/records/${recordIndex}/payload/readings/${readingIndex}/measurementTimezone`
          })
        }
        readingIds.add(reading.localReadingId)
        sequences.add(reading.sequenceNumber)
      }
      const orderedSequences = [...sequences].sort((left, right) => left - right)
      if (orderedSequences.some((sequence, index) => sequence !== index + 1)) {
        issues.push({
          code: 'VITALS_READING_SEQUENCE_NOT_CONTIGUOUS',
          path: `/records/${recordIndex}/payload/readings`
        })
      }
    }

    for (const [field, actorId] of actorReferences) {
      if (actorId !== null && !actorIds.has(actorId)) {
        issues.push({
          code: 'UNKNOWN_ACTOR_REFERENCE',
          path: `/records/${recordIndex}/${field}`
        })
      }
    }
  }
  return issues
}

function resultFor(validateSchema, value, semanticValidator) {
  if (!validateSchema(value)) {
    return Object.freeze({
      valid: false,
      issues: Object.freeze(schemaIssues(validateSchema.errors))
    })
  }

  const issues = semanticValidator ? semanticValidator(value) : []
  return issues.length === 0
    ? Object.freeze({ valid: true, issues: Object.freeze([]) })
    : Object.freeze({ valid: false, issues: Object.freeze(issues) })
}

export function validateSyncBatchRequest(value) {
  return resultFor(validateRequestSchema, value, semanticRequestIssues)
}

export function validateSyncBatchResponse(value) {
  return resultFor(validateResponseSchema, value)
}
