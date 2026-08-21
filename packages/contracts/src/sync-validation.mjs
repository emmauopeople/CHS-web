import { readFileSync } from 'node:fs'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const contractRoot = new URL('../', import.meta.url)

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, contractRoot), 'utf8'))
}

const schemaPaths = Object.freeze([
  'schemas/sync/v1/common.schema.json',
  'schemas/sync/v1/lifestyle.schema.json',
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

function appendProvenanceActorReferences(actorReferences, prefix, value) {
  actorReferences.push(
    [`${prefix}/createdByLocalActorId`, value.createdByLocalActorId],
    [`${prefix}/updatedByLocalActorId`, value.updatedByLocalActorId]
  )
}

function lifestyleActorReferences(payload) {
  const actorReferences = []
  appendProvenanceActorReferences(actorReferences, 'payload', payload)

  for (const domain of ['alcohol', 'tobacco', 'work']) {
    appendProvenanceActorReferences(
      actorReferences,
      `payload/baselines/${domain}`,
      payload.baselines[domain]
    )
  }

  appendProvenanceActorReferences(actorReferences, 'payload/alcohol', payload.alcohol)
  appendProvenanceActorReferences(actorReferences, 'payload/tobacco', payload.tobacco)
  for (const [index, product] of payload.tobacco.products.entries()) {
    appendProvenanceActorReferences(
      actorReferences,
      `payload/tobacco/products/${index}`,
      product
    )
  }

  appendProvenanceActorReferences(
    actorReferences,
    'payload/physicalActivity',
    payload.physicalActivity
  )
  for (const [index, activity] of payload.physicalActivity.activities.entries()) {
    appendProvenanceActorReferences(
      actorReferences,
      `payload/physicalActivity/activities/${index}`,
      activity
    )
  }

  appendProvenanceActorReferences(actorReferences, 'payload/work', payload.work)
  for (const [index, activity] of payload.otherActivity.activities.entries()) {
    appendProvenanceActorReferences(
      actorReferences,
      `payload/otherActivity/activities/${index}`,
      activity
    )
  }
  return actorReferences
}

function registerLifestyleId(ids, value, path, issues) {
  if (ids.has(value)) {
    issues.push({ code: 'DUPLICATE_LIFESTYLE_CHILD_ID', path })
  }
  ids.add(value)
}

function checkLifestyleRows(rows, idField, path, ids, issues) {
  const sequences = new Set()
  let previousSequence = 0

  for (const [index, row] of rows.entries()) {
    const rowPath = `${path}/${index}`
    registerLifestyleId(ids, row[idField], `${rowPath}/${idField}`, issues)
    if (sequences.has(row.sequenceNumber)) {
      issues.push({
        code: 'DUPLICATE_LIFESTYLE_SEQUENCE',
        path: `${rowPath}/sequenceNumber`
      })
    }
    if (row.sequenceNumber <= previousSequence) {
      issues.push({
        code: 'LIFESTYLE_SEQUENCE_ORDER_INVALID',
        path: `${rowPath}/sequenceNumber`
      })
    }
    sequences.add(row.sequenceNumber)
    previousSequence = row.sequenceNumber
  }
}

function decimalParts(value) {
  const [coefficient, exponentText = '0'] = String(value).toLowerCase().split('e')
  const exponent = Number(exponentText)
  const [whole, fraction = ''] = coefficient.split('.')
  let integer = BigInt(`${whole}${fraction}`)
  let scale = fraction.length - exponent
  if (scale < 0) {
    integer *= 10n ** BigInt(-scale)
    scale = 0
  }
  return { integer, scale }
}

function compareDecimalProduct(total, amount, multiplier) {
  const totalParts = decimalParts(total)
  const amountParts = decimalParts(amount)
  const scale = Math.max(totalParts.scale, amountParts.scale)
  const scaledTotal = totalParts.integer * 10n ** BigInt(scale - totalParts.scale)
  const scaledProduct =
    amountParts.integer * BigInt(multiplier) * 10n ** BigInt(scale - amountParts.scale)
  return scaledTotal === scaledProduct ? 0 : scaledTotal < scaledProduct ? -1 : 1
}

function lifestyleSemanticIssues(request, record, recordIndex) {
  const payload = record.payload
  const issues = []
  const path = `/records/${recordIndex}/payload`

  if (payload.localLocationId !== request.locationId) {
    issues.push({
      code: 'LIFESTYLE_LOCATION_MISMATCH',
      path: `${path}/localLocationId`
    })
  }

  const periodStart = Date.parse(`${payload.periodStart}T00:00:00.000Z`)
  const periodEnd = Date.parse(`${payload.periodEnd}T00:00:00.000Z`)
  if (periodEnd - periodStart !== 6 * 24 * 60 * 60 * 1000) {
    issues.push({ code: 'LIFESTYLE_PERIOD_INVALID', path: `${path}/periodStart` })
  }

  const ids = new Set()
  for (const domain of ['alcohol', 'tobacco', 'work']) {
    registerLifestyleId(
      ids,
      payload.baselines[domain].localBaselineVersionId,
      `${path}/baselines/${domain}/localBaselineVersionId`,
      issues
    )
  }
  for (const domain of ['alcohol', 'tobacco', 'physicalActivity', 'work']) {
    registerLifestyleId(
      ids,
      payload[domain].localWeeklyRecordId,
      `${path}/${domain}/localWeeklyRecordId`,
      issues
    )
  }

  checkLifestyleRows(
    payload.tobacco.products,
    'localProductRowId',
    `${path}/tobacco/products`,
    ids,
    issues
  )
  checkLifestyleRows(
    payload.physicalActivity.activities,
    'localActivityRowId',
    `${path}/physicalActivity/activities`,
    ids,
    issues
  )
  checkLifestyleRows(
    payload.otherActivity.activities,
    'localActivityRowId',
    `${path}/otherActivity/activities`,
    ids,
    issues
  )

  const productTypes = new Set()
  for (const [index, product] of payload.tobacco.products.entries()) {
    if (productTypes.has(product.productType)) {
      issues.push({
        code: 'DUPLICATE_LIFESTYLE_TOBACCO_PRODUCT_TYPE',
        path: `${path}/tobacco/products/${index}/productType`
      })
    }
    productTypes.add(product.productType)
  }

  if (payload.alcohol.weeklyResponse === 'YES') {
    const alcohol = payload.alcohol
    if (alcohol.largestOneDayAmount > alcohol.totalStandardizedDrinks) {
      issues.push({
        code: 'LIFESTYLE_ALCOHOL_LARGEST_EXCEEDS_TOTAL',
        path: `${path}/alcohol/largestOneDayAmount`
      })
    }
    if (alcohol.daysAtLargestAmount > alcohol.drinkingDays) {
      issues.push({
        code: 'LIFESTYLE_ALCOHOL_LARGEST_DAYS_EXCEED_DRINKING_DAYS',
        path: `${path}/alcohol/daysAtLargestAmount`
      })
    }
    const subtotalComparison = compareDecimalProduct(
      alcohol.totalStandardizedDrinks,
      alcohol.largestOneDayAmount,
      alcohol.daysAtLargestAmount
    )
    if (
      subtotalComparison < 0 ||
      (alcohol.drinkingDays === alcohol.daysAtLargestAmount && subtotalComparison !== 0) ||
      (alcohol.drinkingDays > alcohol.daysAtLargestAmount && subtotalComparison <= 0)
    ) {
      issues.push({
        code: 'LIFESTYLE_ALCOHOL_TOTAL_INCONSISTENT',
        path: `${path}/alcohol/totalStandardizedDrinks`
      })
    }
  }
  return issues
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
    } else if (record.resourceType === 'LIFESTYLE') {
      actorReferences.push(...lifestyleActorReferences(record.payload))
      issues.push(...lifestyleSemanticIssues(request, record, recordIndex))
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
