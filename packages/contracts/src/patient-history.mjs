// Public read-only history contract. This module is browser-safe (no I/O or code generation).
const text = { type: 'string', maxLength: 4000 };
const nullableText = { type: ['string', 'null'], maxLength: 4000 };
const number = { type: ['number', 'null'] };
const boolean = { type: ['boolean', 'null'] };
const uuid = { type: 'string', format: 'uuid' };
const instant = { type: 'string', format: 'date-time' };
const date = { type: 'string', format: 'date' };
const integer = { type: 'integer', minimum: 1 };
const object = (properties) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const array = (items, maxItems = 100) => ({ type: 'array', maxItems, items });
const fields = (names, schema = nullableText) =>
  Object.fromEntries(names.split(' ').map((name) => [name, schema]));
const actor = object({ practitionerId: uuid, displayName: text });
const nullableActor = { anyOf: [actor, { type: 'null' }] };
const status = {
  type: 'string',
  enum: ['DRAFT', 'COMPLETED', 'AMENDED', 'VOID'],
};
const reviewStatus = {
  type: 'string',
  enum: ['OPEN', 'RESOLVED', 'DISMISSED'],
};
const event = object({
  sequenceNumber: integer,
  fromStatus: nullableText,
  toStatus: text,
  changeReason: nullableText,
});
const baseline = (properties) =>
  object({ id: uuid, version: integer, ...properties });
export const historyDataSchemas = {
  SCREENING_ENCOUNTER: object({
    startedAt: instant,
    completedAt: { type: ['string', 'null'], format: 'date-time' },
    ...fields('amendmentOfEncounterId amendmentReason voidReason'),
    clinicalTime: {
      anyOf: [
        object({ localDate: date, localTime: text, timezone: text }),
        { type: 'null' },
      ],
    },
    session: object({ sessionId: uuid, sessionDate: date, status: text }),
    protocol: object({ protocolId: uuid, key: text, version: text }),
  }),
  VITALS: object({
    status: { type: 'string', enum: ['DRAFT', 'VITALS_COMPLETE'] },
    weightKg: number,
    waistCm: number,
    notes: nullableText,
    readings: array(
      object({
        id: uuid,
        sequenceNumber: integer,
        ...fields('systolicMmhg diastolicMmhg pulseBpm', number),
        ...fields(
          'measurementSite patientPosition measurementLocalTime measuredAt',
        ),
        measurementLocalDate: date,
        measurementTimezone: text,
      }),
    ),
  }),
  LIFESTYLE: object({
    status: { const: 'COMPLETE' },
    periodStart: date,
    periodEnd: date,
    baselines: object({
      alcohol: baseline({
        ...fields('status everConsumed consumedPast12Months', text),
        otherBeverageDescription: nullableText,
        beverageTypes: array(text, 6),
      }),
      tobacco: baseline({
        ...fields('status everRegularlyUsed currentUseFrequency', text),
        ...fields('formerUseApproximateStopDate otherProductDescription'),
        productTypes: array(text, 8),
      }),
      work: baseline({
        status: text,
        ...fields(
          'occupationJobTitle usualPhysicalDemand shiftPattern description',
        ),
        ...fields('typicalWorkdaysPerWeek typicalHoursPerWorkday', number),
      }),
    }),
    alcohol: object({
      weeklyResponse: text,
      ...fields(
        'drinkingDays totalStandardizedDrinks largestOneDayAmount daysAtLargestAmount',
        number,
      ),
      otherBeverageDescription: nullableText,
      beverageTypes: array(text, 6),
    }),
    tobacco: object({
      weeklyResponse: text,
      products: array(
        object({
          id: uuid,
          sequenceNumber: integer,
          ...fields('productType unit', text),
          ...fields('daysUsed averageQuantityPerUseDay', number),
          secondhandSmokeExposure: boolean,
          ...fields('otherProductDescription otherUnitDescription'),
        }),
      ),
    }),
    physicalActivity: object({
      weeklyResponse: text,
      sedentaryTimeResponse: text,
      sedentaryMinutesPerDay: number,
      activities: array(
        object({
          id: uuid,
          sequenceNumber: integer,
          ...fields('activityDomain intensity', text),
          description: nullableText,
          ...fields('daysInPastSevenDays averageMinutesPerActiveDay', number),
        }),
      ),
    }),
    work: object({ weeklyResponse: text }),
    otherActivity: object({
      weeklyResponse: text,
      activities: array(
        object({
          id: uuid,
          sequenceNumber: integer,
          category: text,
          ...fields('description intensity'),
          ...fields('daysInPastSevenDays averageMinutesPerDay', number),
        }),
      ),
    }),
  }),
  FOOD: object({
    response: nullableText,
    periodStart: nullableText,
    periodEnd: nullableText,
    rows: array(
      object({
        sequenceNumber: integer,
        foodName: text,
        ...fields('foodCode frequencyCode preparationNote'),
        sourceType: { const: 'PATIENT_REPORTED' },
        author: actor,
        recordedAt: instant,
      }),
    ),
  }),
  OTC: object({
    response: nullableText,
    periodStart: nullableText,
    periodEnd: nullableText,
    rows: array(
      object({
        sequenceNumber: integer,
        productName: text,
        reasonForUse: text,
        ...fields('doseText frequencyText durationText sourceOfMedication'),
        currentlyTaking: boolean,
        sourceType: { const: 'PATIENT_REPORTED' },
        author: actor,
        recordedAt: instant,
      }),
    ),
  }),
  REFERRAL: object({
    reasonCodes: array(text, 20),
    ...fields('reasonText destinationName dueDate closureReason closedAt'),
    urgency: { enum: ['STANDARD', 'URGENT'] },
    status: {
      enum: ['OPEN', 'CONTACTED', 'SEEN', 'UNABLE_TO_CONFIRM', 'CLOSED'],
    },
    createdAt: instant,
    updatedAt: instant,
    createdBy: actor,
    updatedBy: actor,
    closedBy: nullableActor,
  }),
  REFERRAL_STATUS: event,
  REFERRAL_FOLLOWUP: object({
    contactDate: date,
    ...fields('contactMethod informationSource sourceType', text),
    providerSeen: boolean,
    ...fields(
      'facilityName dateSeen reportedOutcome reportedMedicationsOrAdvice nextAction nextFollowupDate',
    ),
    treatmentActions: array(
      object({ sequenceNumber: integer, actionCode: text }),
      3,
    ),
    medicationChanges: array(
      object({
        sequenceNumber: integer,
        changeType: text,
        medicationName: text,
        ...fields('dosage frequency'),
      }),
      20,
    ),
  }),
  ENCOUNTER_ADDENDUM: object({
    noteText: { type: 'string', minLength: 1, maxLength: 2000 },
  }),
  ENCOUNTER_REVIEW_FLAG: object({
    category: {
      enum: [
        'POSSIBLE_DATA_ERROR',
        'MISSING_INFORMATION',
        'WRONG_PATIENT',
        'DUPLICATE_ENCOUNTER',
        'OTHER',
      ],
    },
    description: { type: 'string', minLength: 1, maxLength: 1000 },
    currentStatus: reviewStatus,
    latestSequenceNumber: { type: 'integer', minimum: 0 },
    lastChangedAt: instant,
    lastChangedBy: actor,
    lastChangeReason: nullableText,
  }),
  ENCOUNTER_REVIEW_STATUS: object({
    category: text,
    description: text,
    sequenceNumber: integer,
    fromStatus: {
      type: ['string', 'null'],
      enum: [null, 'OPEN', 'RESOLVED', 'DISMISSED'],
    },
    toStatus: reviewStatus,
    changeReason: nullableText,
  }),
};
export const historyResourceTypes = Object.freeze(
  Object.keys(historyDataSchemas),
);
export const historyReasonCodes = Object.freeze([
  'CARE_DELIVERY',
  'CARE_COORDINATION',
  'PATIENT_REQUEST',
  'QUALITY_IMPROVEMENT',
  'OPERATIONS_SUPPORT',
]);
const properties = {
  contractVersion: { const: '1.0' },
  personId: uuid,
  reasonCode: { enum: historyReasonCodes },
  fromDate: date,
  toDate: date,
  resourceTypes: {
    ...array({ enum: historyResourceTypes }, 11),
    minItems: 1,
    uniqueItems: true,
  },
  limit: { type: 'integer', minimum: 1, maximum: 50 },
  cursor: uuid,
};
export const operationsHistoryRequestSchema = {
  ...object(properties),
  required: ['contractVersion', 'personId', 'reasonCode', 'fromDate', 'toDate'],
};
export const installationHistoryRequestSchema = {
  ...object({
    ...properties,
    localPatientId: uuid,
    requesterLocalActorId: uuid,
  }),
  required: [
    ...operationsHistoryRequestSchema.required,
    'localPatientId',
    'requesterLocalActorId',
  ],
};
const common = {
  resourceId: uuid,
  parentResourceId: { type: ['string', 'null'], format: 'uuid' },
  sourceRevision: integer,
  occurredAt: instant,
  receivedAt: instant,
  author: actor,
  encounter: object({
    encounterId: uuid,
    status,
    startedAt: instant,
    ...fields('amendmentOfEncounterId amendmentReason voidReason'),
  }),
  source: object({
    organizationId: uuid,
    organizationName: text,
    locationId: uuid,
    locationName: text,
    installationId: uuid,
    deploymentName: text,
  }),
};
export const historyPatientSchema = object({
  personId: uuid,
  chsMedicalId: text,
  displayName: text,
  givenName: nullableText,
  familyName: nullableText,
  ...fields(
    'otherNames dateOfBirth ageAsOfDate phone alternateContactName alternateContactPhone village quarter residenceNotes',
  ),
  approximateAgeYears: number,
  sex: text,
  status: text,
  acknowledgmentStatus: text,
  lastUpdatedAt: instant,
});
export const historyPageSchema = object({
  patient: historyPatientSchema,
  contractVersion: { const: '1.0' },
  personId: uuid,
  retrievedAt: instant,
  fromDate: date,
  toDate: date,
  nextCursor: { type: ['string', 'null'], format: 'uuid' },
  items: array(
    {
      oneOf: historyResourceTypes.map((type) =>
        object({
          ...common,
          resourceType: { const: type },
          data: historyDataSchemas[type],
        }),
      ),
    },
    50,
  ),
});

// A small interpreter for this contract's closed schema vocabulary. It avoids eval
// in browsers with a strict CSP; contract tests also compile these schemas with AJV.
function matches(value, schema) {
  if (schema.anyOf) return schema.anyOf.some((s) => matches(value, s));
  if (schema.oneOf)
    return schema.oneOf.filter((s) => matches(value, s)).length === 1;
  if ('const' in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  const kind =
    value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (
      !types.includes(kind) &&
      !(
        kind === 'number' &&
        types.includes('integer') &&
        Number.isSafeInteger(value)
      )
    )
      return false;
  }
  if (
    kind === 'number' &&
    (!Number.isFinite(value) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity))
  )
    return false;
  if (kind === 'string') {
    if (
      value.length < (schema.minLength ?? 0) ||
      value.length > (schema.maxLength ?? Infinity)
    )
      return false;
    if (
      schema.format === 'uuid' &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      )
    )
      return false;
    if (
      schema.format === 'date' &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value)
    )
      return false;
    if (
      schema.format === 'date-time' &&
      (!/^\d{4}-\d{2}-\d{2}T/.test(value) ||
        !Number.isFinite(Date.parse(value)))
    )
      return false;
  }
  if (kind === 'array') {
    if (
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? Infinity)
    )
      return false;
    if (
      schema.uniqueItems &&
      new Set(value.map((v) => JSON.stringify(v))).size !== value.length
    )
      return false;
    return value.every((v) => matches(v, schema.items));
  }
  if (kind === 'object') {
    if (schema.required?.some((key) => !(key in value))) return false;
    if (
      schema.additionalProperties === false &&
      Object.keys(value).some((key) => !(key in schema.properties))
    )
      return false;
    return Object.entries(schema.properties ?? {}).every(
      ([key, s]) => !(key in value) || matches(value[key], s),
    );
  }
  return true;
}
export function isHistoryPage(value) {
  try {
    if (!matches(value, historyPageSchema)) return false;
    const keys = value.items.map(
      (item) => item.resourceType + ':' + item.resourceId,
    );
    return (
      new Set(keys).size === keys.length &&
      value.patient.personId === value.personId &&
      value.fromDate <= value.toDate
    );
  } catch {
    return false;
  }
}
export function isHistoryRequest(value, installation = false) {
  try {
    return matches(
      value,
      installation
        ? installationHistoryRequestSchema
        : operationsHistoryRequestSchema,
    );
  } catch {
    return false;
  }
}
