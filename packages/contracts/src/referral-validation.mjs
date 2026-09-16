// Also used by the processor so direct retries enforce the same provenance rules.
export function referralActorReferences(record) {
  const p = record.payload
  const fields =
    record.resourceType === 'REFERRAL'
      ? [
          'createdByLocalActorId',
          'updatedByLocalActorId',
          'closedByLocalActorId',
        ]
      : record.resourceType === 'REFERRAL_STATUS'
        ? ['changedByLocalActorId']
        : ['recordedByLocalActorId']
  return fields.map((field) => [`payload/${field}`, p[field]])
}

export function referralSemanticIssues(record) {
  const p = record.payload
  const issues = []
  const fail = (code, path = '/payload') => issues.push({ code, path })
  const isReferral = record.resourceType === 'REFERRAL'
  const actor = isReferral
    ? p.updatedByLocalActorId
    : record.resourceType === 'REFERRAL_STATUS'
      ? p.changedByLocalActorId
      : p.recordedByLocalActorId
  const time = isReferral
    ? p.updatedAt
    : record.resourceType === 'REFERRAL_STATUS'
      ? p.changedAt
      : p.recordedAt
  if (
    record.sourceActorLocalId !== actor ||
    record.capturedAt !== time ||
    (!isReferral && record.sourceRevision !== 1)
  )
    fail('REFERRAL_PROVENANCE_INVALID')
  if (isReferral) {
    if (Date.parse(p.createdAt) > Date.parse(p.updatedAt))
      fail('REFERRAL_PERIOD_INVALID')
    if (p.status === 'CLOSED') {
      if (
        !p.closedAt ||
        !p.closedByLocalActorId ||
        !p.closureReason ||
        p.closedAt !== p.updatedAt ||
        p.closedByLocalActorId !== p.updatedByLocalActorId
      )
        fail('REFERRAL_CLOSURE_INVALID')
    } else if (
      p.closedAt !== null ||
      p.closedByLocalActorId !== null ||
      p.closureReason !== null
    )
      fail('REFERRAL_CLOSURE_INVALID')
  } else if (record.resourceType === 'REFERRAL_STATUS') {
    if (
      (p.sequenceNumber === 1 &&
        (p.fromStatus !== null || p.toStatus !== 'OPEN')) ||
      (p.sequenceNumber > 1 &&
        (p.fromStatus === null ||
          p.fromStatus === 'CLOSED' ||
          p.toStatus === 'OPEN' ||
          p.fromStatus === p.toStatus)) ||
      (p.toStatus === 'CLOSED' && !p.changeReason)
    )
      fail('REFERRAL_TRANSITION_INVALID')
  } else {
    const ids = new Set()
    for (const field of ['treatmentActions', 'medicationChanges']) {
      p[field].forEach((row, index) => {
        const id = row.localActionId ?? row.localMedicationChangeId
        if (ids.has(id) || row.sequenceNumber !== index + 1)
          fail('REFERRAL_CHILD_IDENTITY_INVALID', `/payload/${field}`)
        ids.add(id)
      })
    }
    const actions = p.treatmentActions.map((row) => row.actionCode)
    if (
      new Set(actions).size !== actions.length ||
      p.medicationChanges.some((row) => !actions.includes(row.changeType))
    )
      fail('REFERRAL_TREATMENT_ACTION_INVALID')
  }
  return issues
}
