// The HTTP contract and direct processor retries share the same provenance rules.
export function encounterHistoryActorReferences(record) {
  const field =
    record.resourceType === 'ENCOUNTER_ADDENDUM'
      ? 'createdByLocalActorId'
      : record.resourceType === 'ENCOUNTER_REVIEW_FLAG'
        ? 'openedByLocalActorId'
        : 'changedByLocalActorId'
  return [[`payload/${field}`, record.payload[field]]]
}

export function encounterHistorySemanticIssues(record) {
  const p = record.payload
  const time =
    record.resourceType === 'ENCOUNTER_ADDENDUM'
      ? p.createdAt
      : record.resourceType === 'ENCOUNTER_REVIEW_FLAG'
        ? p.openedAt
        : p.changedAt
  const issues = []
  if (
    record.sourceRevision !== 1 ||
    record.capturedAt !== time ||
    record.sourceActorLocalId !== encounterHistoryActorReferences(record)[0][1]
  )
    issues.push({
      code: 'ENCOUNTER_HISTORY_PROVENANCE_INVALID',
      path: '/payload',
    })
  if (record.resourceType === 'ENCOUNTER_REVIEW_STATUS') {
    // A reopened flag is a new immutable event, never a rewrite of its closure.
    const first = p.sequenceNumber === 1
    const valid = first
      ? p.fromStatus === null &&
        p.toStatus === 'OPEN' &&
        p.changeReason === null
      : p.changeReason !== null &&
        ((p.fromStatus === 'OPEN' &&
          ['RESOLVED', 'DISMISSED'].includes(p.toStatus)) ||
          (['RESOLVED', 'DISMISSED'].includes(p.fromStatus) &&
            p.toStatus === 'OPEN'))
    if (!valid)
      issues.push({ code: 'REVIEW_TRANSITION_INVALID', path: '/payload' })
  }
  return issues
}
