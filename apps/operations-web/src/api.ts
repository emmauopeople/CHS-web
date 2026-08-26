import type {
  PatientAccessReason,
  PatientDetail,
  PatientListPage,
  MedicalIdRecoveryRevealResult,
  MedicalIdRecoverySearchResult,
  IdentityReviewCaseDetail,
  IdentityReviewQueuePage,
  IdentityReviewResolutionResult,
  PersonStatus,
  ProblemDetails,
  SyncBatchMonitoringDetail,
  SyncBatchMonitoringPage,
  SyncBatchStatus,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId: string | null,
  ) {
    super('The patient service request failed');
    this.name = 'ApiError';
  }
}

export type PatientSearchInput = Readonly<{
  reasonCode: PatientAccessReason;
  search?: string;
  dateOfBirth?: string;
  status?: PersonStatus | 'ALL';
  page?: number;
  pageSize?: number;
}>;

export type PatientDetailInput = Readonly<{
  reasonCode: PatientAccessReason;
  personId: string;
  page?: number;
  pageSize?: number;
}>;

export type MedicalIdRecoverySearchInput = Readonly<{
  reasonCode: PatientAccessReason;
  fullName: string;
  dateOfBirth: string;
}>;

export type MedicalIdRecoveryRevealInput = Readonly<{
  reasonCode: PatientAccessReason;
  recoveryToken: string;
  candidateReference: string;
  confirmed: true;
}>;

export type SyncBatchMonitoringSearchInput = Readonly<{
  reasonCode: 'OPERATIONS_SUPPORT';
  status?: SyncBatchStatus | 'ALL';
  installationId?: string;
  receivedFrom?: string;
  receivedTo?: string;
  page?: number;
  pageSize?: number;
}>;

export type SyncBatchMonitoringDetailInput = Readonly<{
  reasonCode: 'OPERATIONS_SUPPORT';
  batchReference: string;
}>;

export type IdentityReviewSearchInput = Readonly<{
  reasonCode: 'IDENTITY_RECONCILIATION';
  evidenceState?: 'AVAILABLE' | 'EVIDENCE_PENDING' | 'ALL';
  installationId?: string;
  openedFrom?: string;
  openedTo?: string;
  page?: number;
  pageSize?: number;
}>;

export type IdentityReviewDetailInput = Readonly<{
  reasonCode: 'IDENTITY_RECONCILIATION';
  caseReference: string;
}>;

export type IdentityReviewResolutionInput = Readonly<{
  reasonCode: 'IDENTITY_RECONCILIATION';
  resolutionRequestId: string;
  caseReference: string;
  expectedUpdatedAt: string;
  resolutionNote: string;
  resolution:
    | Readonly<{
        kind: 'LINK_EXISTING';
        candidatePersonReference: string;
      }>
    | Readonly<{ kind: 'CREATE_NEW' }>;
}>;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const medicalIdPattern = /^CHS-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;
const safeErrorCodePattern = /^[A-Z][A-Z0-9_]{0,99}$/;
const syncBatchStatuses = ['PROCESSING', 'ACCEPTED', 'PARTIAL', 'REJECTED', 'FAILED'];
const syncAttentionStates = ['HEALTHY', 'ATTENTION', 'STALLED'];
const syncResourceTypes = [
  'PATIENT',
  'SCREENING_SESSION',
  'SCREENING_ENCOUNTER',
  'VITALS',
  'LIFESTYLE',
];
const syncOutcomeStatuses = [
  'PROCESSING',
  'ACCEPTED',
  'UNCHANGED',
  'REVIEW_REQUIRED',
  'REJECTED',
  'RETRY',
];
const identityEvidenceStates = ['AVAILABLE', 'EVIDENCE_PENDING'];
const identitySexValues = ['FEMALE', 'MALE', 'OTHER', 'UNKNOWN'];
const yesNoResponses = ['YES', 'NO', 'UNKNOWN', 'DECLINED'];
const weeklyResponses = [
  ...yesNoResponses,
  'NOT_APPLICABLE',
  'PREFER_NOT_TO_ANSWER',
];
const beverageTypes = [
  'BEER',
  'WINE',
  'SPIRITS',
  'COCKTAILS',
  'FORTIFIED_WINE',
  'OTHER',
];
const tobaccoProductTypes = [
  'CIGARETTE',
  'ROLLED_TOBACCO',
  'CIGAR_PIPE',
  'SMOKELESS',
  'SNUFF',
  'HOOKAH',
  'VAPE',
  'OTHER',
];

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 40 &&
    /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function nullableString(value: unknown, maximum = 500): boolean {
  return value === null || (typeof value === 'string' && value.length <= maximum);
}

function nullableLocalDate(value: unknown): boolean {
  return value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function enumValue(value: unknown, values: readonly string[]): boolean {
  return typeof value === 'string' && values.includes(value);
}

function finiteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function nullableNumber(value: unknown): boolean {
  return value === null || finiteNumber(value);
}

function enumArray(value: unknown, values: readonly string[]): boolean {
  return Array.isArray(value) && value.every((item) => enumValue(item, values));
}

function lifestyleAssessment(value: unknown): boolean {
  if (
    !object(value) ||
    typeof value.lifestyleAssessmentId !== 'string' ||
    !uuidPattern.test(value.lifestyleAssessmentId) ||
    value.status !== 'COMPLETE' ||
    !nullableLocalDate(value.periodStart) || value.periodStart === null ||
    !nullableLocalDate(value.periodEnd) || value.periodEnd === null ||
    !validInstant(value.completedAt) ||
    typeof value.recordedByPractitionerName !== 'string' ||
    !object(value.baselines) ||
    !object(value.alcohol) ||
    !object(value.tobacco) ||
    !object(value.physicalActivity) ||
    !object(value.work) ||
    !object(value.otherActivity)
  ) return false;

  const { alcohol, tobacco, work } = value.baselines;
  if (
    !object(alcohol) ||
    typeof alcohol.baselineId !== 'string' || !uuidPattern.test(alcohol.baselineId) ||
    !Number.isSafeInteger(alcohol.version) || Number(alcohol.version) < 1 ||
    !enumValue(alcohol.status, ['CURRENT', 'FORMER', 'NEVER', 'UNKNOWN', 'DECLINED']) ||
    !enumValue(alcohol.everConsumed, yesNoResponses) ||
    !enumValue(alcohol.consumedPast12Months, yesNoResponses) ||
    !enumArray(alcohol.commonBeverageTypes, beverageTypes) ||
    !nullableString(alcohol.otherBeverageDescription) ||
    !object(tobacco) ||
    typeof tobacco.baselineId !== 'string' || !uuidPattern.test(tobacco.baselineId) ||
    !Number.isSafeInteger(tobacco.version) || Number(tobacco.version) < 1 ||
    !enumValue(tobacco.status, [
      'CURRENT_DAILY', 'CURRENT_SOME_DAYS', 'FORMER', 'NEVER', 'UNKNOWN', 'DECLINED',
    ]) ||
    !enumValue(tobacco.everRegularlyUsed, yesNoResponses) ||
    !nullableString(tobacco.formerUseApproximateStopDate, 7) ||
    !enumValue(tobacco.currentUseFrequency, [
      'EVERY_DAY', 'SOME_DAYS', 'NOT_AT_ALL', 'UNKNOWN', 'DECLINED',
    ]) ||
    !enumArray(tobacco.productTypes, tobaccoProductTypes) ||
    !nullableString(tobacco.otherProductDescription) ||
    !object(work) ||
    typeof work.baselineId !== 'string' || !uuidPattern.test(work.baselineId) ||
    !Number.isSafeInteger(work.version) || Number(work.version) < 1 ||
    !enumValue(work.status, [
      'EMPLOYED', 'SELF_EMPLOYED', 'FARMING', 'STUDENT',
      'HOMEMAKER_CAREGIVER', 'UNEMPLOYED', 'RETIRED', 'UNABLE_TO_WORK',
      'OTHER', 'DECLINED',
    ]) ||
    !nullableString(work.occupationJobTitle) ||
    !(work.usualPhysicalDemand === null || enumValue(work.usualPhysicalDemand, [
      'SITTING', 'STANDING', 'WALKING', 'MODERATE_LABOR', 'HEAVY_LABOR', 'VARIES',
    ])) ||
    !nullableNumber(work.typicalWorkdaysPerWeek) ||
    !nullableNumber(work.typicalHoursPerWorkday) ||
    !(work.shiftPattern === null || enumValue(work.shiftPattern, [
      'DAY', 'EVENING', 'NIGHT', 'ROTATING', 'IRREGULAR',
      'NOT_APPLICABLE', 'UNKNOWN', 'DECLINED',
    ])) ||
    !nullableString(work.description)
  ) return false;

  const weeklyAlcohol = value.alcohol;
  const weeklyTobacco = value.tobacco;
  const physicalActivity = value.physicalActivity;
  const weeklyWork = value.work;
  const otherActivity = value.otherActivity;
  return (
    enumValue(weeklyAlcohol.weeklyResponse, weeklyResponses) &&
    nullableNumber(weeklyAlcohol.drinkingDays) &&
    nullableNumber(weeklyAlcohol.totalStandardizedDrinks) &&
    nullableNumber(weeklyAlcohol.largestOneDayAmount) &&
    nullableNumber(weeklyAlcohol.daysAtLargestAmount) &&
    enumArray(weeklyAlcohol.commonBeverageTypes, beverageTypes) &&
    nullableString(weeklyAlcohol.otherBeverageDescription) &&
    enumValue(weeklyTobacco.weeklyResponse, weeklyResponses) &&
    Array.isArray(weeklyTobacco.products) &&
    weeklyTobacco.products.every((product) =>
      object(product) &&
      typeof product.productId === 'string' && uuidPattern.test(product.productId) &&
      Number.isSafeInteger(product.sequenceNumber) && Number(product.sequenceNumber) >= 1 &&
      enumValue(product.productType, tobaccoProductTypes) &&
      Number.isSafeInteger(product.daysUsed) && Number(product.daysUsed) >= 1 &&
      finiteNumber(product.averageQuantityPerUseDay) &&
      enumValue(product.unit, [
        'STICKS_CIGARETTES', 'SESSIONS', 'PORTIONS', 'PINS',
        'PODS_CARTRIDGES', 'OTHER',
      ]) &&
      (product.secondhandSmokeExposure === null ||
        typeof product.secondhandSmokeExposure === 'boolean') &&
      nullableString(product.otherProductDescription) &&
      nullableString(product.otherUnitDescription)
    ) &&
    enumValue(physicalActivity.weeklyResponse, [...weeklyResponses, 'UNABLE_TO_ANSWER']) &&
    enumValue(physicalActivity.sedentaryTimeResponse, [
      'RECORDED', 'UNKNOWN', 'UNABLE_TO_ANSWER', 'DECLINED', 'PREFER_NOT_TO_ANSWER',
    ]) &&
    nullableNumber(physicalActivity.sedentaryMinutesPerDay) &&
    Array.isArray(physicalActivity.activities) &&
    physicalActivity.activities.every((activity) =>
      object(activity) &&
      typeof activity.activityId === 'string' && uuidPattern.test(activity.activityId) &&
      Number.isSafeInteger(activity.sequenceNumber) && Number(activity.sequenceNumber) >= 1 &&
      enumValue(activity.activityDomain, [
        'WORK_OR_FARMING', 'TRANSPORT', 'HOUSEHOLD', 'EXERCISE',
      ]) &&
      nullableString(activity.description) &&
      enumValue(activity.intensity, ['LIGHT', 'MODERATE', 'VIGOROUS']) &&
      Number.isSafeInteger(activity.daysInPastSevenDays) &&
      Number(activity.daysInPastSevenDays) >= 1 &&
      Number.isSafeInteger(activity.averageMinutesPerActiveDay) &&
      Number(activity.averageMinutesPerActiveDay) >= 1
    ) &&
    enumValue(weeklyWork.weeklyResponse, [
      'USUAL', 'LESS_THAN_USUAL', 'MORE_THAN_USUAL', 'NO_WORK',
      'NOT_APPLICABLE', 'UNKNOWN', 'DECLINED', 'PREFER_NOT_TO_ANSWER',
    ]) &&
    enumValue(otherActivity.weeklyResponse, [
      'YES', 'NO', 'UNKNOWN', 'DECLINED', 'PREFER_NOT_TO_ANSWER',
    ]) &&
    Array.isArray(otherActivity.activities) &&
    otherActivity.activities.every((activity) =>
      object(activity) &&
      typeof activity.activityId === 'string' && uuidPattern.test(activity.activityId) &&
      Number.isSafeInteger(activity.sequenceNumber) && Number(activity.sequenceNumber) >= 1 &&
      enumValue(activity.category, [
        'FARMING_GARDENING', 'HOUSEHOLD', 'CAREGIVING', 'COMMUNITY',
        'COMMUTE', 'SPORT', 'OTHER',
      ]) &&
      nullableString(activity.description) &&
      Number.isSafeInteger(activity.daysInPastSevenDays) &&
      Number(activity.daysInPastSevenDays) >= 1 &&
      Number.isSafeInteger(activity.averageMinutesPerDay) &&
      Number(activity.averageMinutesPerDay) >= 1 &&
      enumValue(activity.intensity, ['LIGHT', 'MODERATE', 'VIGOROUS'])
    )
  );
}

function listPage(value: unknown): value is PatientListPage {
  return (
    object(value) &&
    Number.isSafeInteger(value.page) &&
    Number.isSafeInteger(value.pageSize) &&
    Number.isSafeInteger(value.totalItems) &&
    Number.isSafeInteger(value.totalPages) &&
    Array.isArray(value.items) &&
    value.items.every(
      (item) =>
        object(item) &&
        typeof item.personId === 'string' &&
        typeof item.chsMedicalId === 'string' &&
        typeof item.displayName === 'string',
    )
  );
}

function patientDetail(value: unknown): value is PatientDetail {
  return (
    object(value) &&
    typeof value.personId === 'string' &&
    typeof value.chsMedicalId === 'string' &&
    typeof value.displayName === 'string' &&
    object(value.screeningHistory) &&
    Array.isArray(value.screeningHistory.items) &&
    value.screeningHistory.items.every((screening) =>
      object(screening) &&
      (screening.lifestyle === null || lifestyleAssessment(screening.lifestyle))
    )
  );
}

function recoveryCandidate(value: unknown): boolean {
  return (
    object(value) &&
    typeof value.candidateReference === 'string' && uuidPattern.test(value.candidateReference) &&
    typeof value.maskedName === 'string' &&
    /^\*{4}-\*{2}-\d{2}$/.test(String(value.maskedDateOfBirth)) &&
    ['FEMALE', 'MALE', 'OTHER', 'UNKNOWN'].includes(String(value.sex)) &&
    (value.maskedResidence === null || typeof value.maskedResidence === 'string')
  );
}

function recoverySearchResult(
  value: unknown,
): value is MedicalIdRecoverySearchResult {
  if (!object(value) || typeof value.status !== 'string') return false;
  if (value.status === 'NOT_RESOLVED') return true;
  if (value.status === 'CANDIDATE_FOUND') {
    return (
      typeof value.caseReference === 'string' &&
      uuidPattern.test(value.caseReference) &&
      typeof value.recoveryToken === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(value.recoveryToken) &&
      typeof value.expiresAt === 'string' &&
      Number.isFinite(Date.parse(value.expiresAt)) &&
      Array.isArray(value.candidates) &&
      value.candidates.length === 1 &&
      value.candidates.every(recoveryCandidate)
    );
  }
  return (
    value.status === 'REVIEW_REQUIRED' &&
    typeof value.caseReference === 'string' &&
    uuidPattern.test(value.caseReference) &&
    Number.isSafeInteger(value.candidateCount) &&
    Array.isArray(value.candidates) &&
    value.candidates.every(recoveryCandidate)
  );
}

function recoveryRevealResult(
  value: unknown,
): value is MedicalIdRecoveryRevealResult {
  return (
    object(value) &&
    value.status === 'REVEALED' &&
    typeof value.chsMedicalId === 'string' &&
    medicalIdPattern.test(value.chsMedicalId)
  );
}

function syncMonitoringItem(value: unknown): boolean {
  if (!object(value) || !object(value.counts)) return false;
  return (
    typeof value.batchReference === 'string' && uuidPattern.test(value.batchReference) &&
    typeof value.sourceBatchId === 'string' && uuidPattern.test(value.sourceBatchId) &&
    typeof value.installationId === 'string' && uuidPattern.test(value.installationId) &&
    typeof value.deploymentName === 'string' &&
    typeof value.organizationName === 'string' &&
    typeof value.locationName === 'string' &&
    typeof value.status === 'string' && syncBatchStatuses.includes(value.status) &&
    typeof value.attentionState === 'string' && syncAttentionStates.includes(value.attentionState) &&
    typeof value.contractVersion === 'string' &&
    typeof value.desktopApplicationVersion === 'string' &&
    Number.isSafeInteger(value.desktopSchemaVersion) && Number(value.desktopSchemaVersion) >= 1 &&
    validInstant(value.sourceCreatedAt) &&
    validInstant(value.receivedAt) &&
    (value.completedAt === null || validInstant(value.completedAt)) &&
    (value.durationMs === null || safeCount(value.durationMs)) &&
    safeCount(value.counts.accepted) &&
    safeCount(value.counts.unchanged) &&
    safeCount(value.counts.reviewRequired) &&
    safeCount(value.counts.rejected) &&
    safeCount(value.counts.retry)
  );
}

function syncMonitoringPage(value: unknown): value is SyncBatchMonitoringPage {
  return (
    object(value) &&
    Number.isSafeInteger(value.page) && Number(value.page) >= 1 &&
    Number.isSafeInteger(value.pageSize) && Number(value.pageSize) >= 1 && Number(value.pageSize) <= 100 &&
    safeCount(value.totalItems) &&
    safeCount(value.totalPages) &&
    Array.isArray(value.items) &&
    value.items.every(syncMonitoringItem)
  );
}

function syncMonitoringDetail(value: unknown): value is SyncBatchMonitoringDetail {
  return (
    syncMonitoringItem(value) &&
    object(value) &&
    Array.isArray(value.outcomeCounts) &&
    value.outcomeCounts.every(
      (item) =>
        object(item) &&
        typeof item.resourceType === 'string' && syncResourceTypes.includes(item.resourceType) &&
        typeof item.status === 'string' && syncOutcomeStatuses.includes(item.status) &&
        safeCount(item.count),
    ) &&
    Array.isArray(value.errorCodeCounts) &&
    value.errorCodeCounts.every(
      (item) =>
        object(item) &&
        typeof item.code === 'string' && safeErrorCodePattern.test(item.code) &&
        typeof item.retryable === 'boolean' &&
        safeCount(item.count),
    )
  );
}

function maskedBirthEvidence(value: unknown): boolean {
  if (!object(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'DATE_OF_BIRTH') {
    return typeof value.maskedDate === 'string' && /^\*{4}-\*{2}-\d{2}$/.test(value.maskedDate);
  }
  return (
    value.kind === 'APPROXIMATE_AGE' &&
    Number.isSafeInteger(value.ageYears) && Number(value.ageYears) >= 0 && Number(value.ageYears) <= 120 &&
    Number.isSafeInteger(value.asOfYear) && Number(value.asOfYear) >= 1900 && Number(value.asOfYear) <= 2200
  );
}

function identityReviewQueueItem(value: unknown): boolean {
  return (
    object(value) &&
    typeof value.caseReference === 'string' && uuidPattern.test(value.caseReference) &&
    value.status === 'OPEN' &&
    typeof value.evidenceState === 'string' && identityEvidenceStates.includes(value.evidenceState) &&
    typeof value.organizationName === 'string' &&
    typeof value.locationName === 'string' &&
    typeof value.installationId === 'string' && uuidPattern.test(value.installationId) &&
    typeof value.deploymentName === 'string' &&
    validInstant(value.openedAt) &&
    validInstant(value.updatedAt) &&
    safeCount(value.candidateCount) &&
    (value.latestSourceRevision === null ||
      (Number.isSafeInteger(value.latestSourceRevision) && Number(value.latestSourceRevision) >= 1)) &&
    (value.sourceCapturedAt === null || validInstant(value.sourceCapturedAt)) &&
    nullableString(value.localPatientCode, 32) &&
    nullableString(value.maskedSubmittedName, 200) &&
    (value.submittedBirthEvidence === null || maskedBirthEvidence(value.submittedBirthEvidence))
  );
}

function identityReviewQueuePage(value: unknown): value is IdentityReviewQueuePage {
  return (
    object(value) &&
    Number.isSafeInteger(value.page) && Number(value.page) >= 1 &&
    Number.isSafeInteger(value.pageSize) && Number(value.pageSize) >= 1 && Number(value.pageSize) <= 100 &&
    safeCount(value.totalItems) &&
    safeCount(value.totalPages) &&
    Array.isArray(value.items) &&
    value.items.every(identityReviewQueueItem)
  );
}

function identityReviewEvidence(value: unknown): boolean {
  if (!object(value)) return false;
  const validBirth =
    (nullableLocalDate(value.dateOfBirth) && value.dateOfBirth !== null &&
      value.approximateAgeYears === null && value.ageAsOfDate === null) ||
    (value.dateOfBirth === null && Number.isSafeInteger(value.approximateAgeYears) &&
      Number(value.approximateAgeYears) >= 0 && Number(value.approximateAgeYears) <= 120 &&
      nullableLocalDate(value.ageAsOfDate) && value.ageAsOfDate !== null);
  return (
    typeof value.sourceRecordReference === 'string' && uuidPattern.test(value.sourceRecordReference) &&
    Number.isSafeInteger(value.sourceRevision) && Number(value.sourceRevision) >= 1 &&
    typeof value.schemaVersion === 'string' && value.schemaVersion.length > 0 && value.schemaVersion.length <= 50 &&
    validInstant(value.capturedAt) &&
    typeof value.localPatientCode === 'string' && /^PT-\d{6}$/.test(value.localPatientCode) &&
    nullableString(value.maskedClaimedChsMedicalId, 64) &&
    typeof value.displayName === 'string' && value.displayName.length > 0 && value.displayName.length <= 200 &&
    nullableString(value.givenName, 200) && nullableString(value.familyName, 200) &&
    nullableString(value.otherNames, 200) && validBirth &&
    typeof value.sex === 'string' && identitySexValues.includes(value.sex) &&
    (value.acknowledgmentStatus === null ||
      ['ACKNOWLEDGED', 'DECLINED', 'NOT_REQUESTED'].includes(String(value.acknowledgmentStatus))) &&
    (value.patientStatus === null || ['ACTIVE', 'INACTIVE'].includes(String(value.patientStatus))) &&
    nullableString(value.phone, 100) && nullableString(value.village, 200) && nullableString(value.quarter, 200) &&
    validInstant(value.sourceCreatedAt) && validInstant(value.sourceUpdatedAt) && validInstant(value.receivedAt)
  );
}

function identityReviewCandidate(value: unknown): boolean {
  return (
    object(value) &&
    typeof value.personReference === 'string' && uuidPattern.test(value.personReference) &&
    Number.isSafeInteger(value.score) && Number(value.score) >= 1 && Number(value.score) <= 100 &&
    Array.isArray(value.matchedOn) &&
    value.matchedOn.every((item) => typeof item === 'string' && /^[A-Z][A-Z0-9_]{0,49}$/.test(item)) &&
    nullableString(value.maskedChsMedicalId, 64) &&
    typeof value.maskedName === 'string' && value.maskedName.length > 0 && value.maskedName.length <= 200 &&
    maskedBirthEvidence(value.birthEvidence) &&
    typeof value.sex === 'string' && identitySexValues.includes(value.sex) &&
    nullableString(value.maskedPhone, 100) && nullableString(value.maskedResidence, 300)
  );
}

function identityReviewDetail(value: unknown): value is IdentityReviewCaseDetail {
  if (!object(value) || !object(value.organization) || !object(value.location) || !object(value.installation)) {
    return false;
  }
  const stateValid =
    (value.evidenceState === 'AVAILABLE' && identityReviewEvidence(value.evidence)) ||
    (value.evidenceState === 'EVIDENCE_PENDING' && value.evidence === null);
  return (
    typeof value.caseReference === 'string' && uuidPattern.test(value.caseReference) &&
    value.status === 'OPEN' && stateValid &&
    typeof value.organization.id === 'string' && uuidPattern.test(value.organization.id) &&
    typeof value.organization.name === 'string' &&
    typeof value.location.id === 'string' && uuidPattern.test(value.location.id) &&
    typeof value.location.name === 'string' &&
    typeof value.installation.id === 'string' && uuidPattern.test(value.installation.id) &&
    typeof value.installation.deploymentName === 'string' &&
    typeof value.localPatientReference === 'string' && uuidPattern.test(value.localPatientReference) &&
    validInstant(value.openedAt) && validInstant(value.updatedAt) &&
    Array.isArray(value.candidates) && value.candidates.every(identityReviewCandidate)
  );
}

function identityReviewResolution(
  value: unknown,
): value is IdentityReviewResolutionResult {
  return (
    object(value) &&
    typeof value.resolutionRequestId === 'string' && uuidPattern.test(value.resolutionRequestId) &&
    typeof value.caseReference === 'string' && uuidPattern.test(value.caseReference) &&
    ['RESOLVED_EXISTING', 'RESOLVED_NEW'].includes(String(value.resolutionStatus)) &&
    typeof value.resolvedPersonReference === 'string' && uuidPattern.test(value.resolvedPersonReference) &&
    typeof value.chsMedicalId === 'string' && medicalIdPattern.test(value.chsMedicalId) &&
    typeof value.installationId === 'string' && uuidPattern.test(value.installationId) &&
    typeof value.localPatientReference === 'string' && uuidPattern.test(value.localPatientReference) &&
    typeof value.localPatientCode === 'string' && /^PT-\d{6}$/.test(value.localPatientCode) &&
    Number.isSafeInteger(value.sourceRevision) && Number(value.sourceRevision) >= 1 &&
    validInstant(value.resolvedAt) && typeof value.replayed === 'boolean'
  );
}

async function post<T>(
  apiBaseUrl: string,
  path: string,
  accessToken: string,
  body: unknown,
  validate: (value: unknown) => value is T,
  fetchImplementation: typeof fetch,
): Promise<T> {
  const response = await fetchImplementation(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
    credentials: 'same-origin',
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = object(data) ? (data as ProblemDetails) : null;
    throw new ApiError(
      response.status,
      typeof problem?.code === 'string' ? problem.code : 'REQUEST_FAILED',
      typeof problem?.requestId === 'string' ? problem.requestId : null,
    );
  }
  if (!validate(data)) throw new ApiError(502, 'INVALID_API_RESPONSE', null);
  return data;
}

export function createOperationsApi(
  apiBaseUrl: string,
  accessToken: string,
  fetchImplementation: typeof fetch = fetch,
) {
  return {
    searchPatients(input: PatientSearchInput) {
      return post(
        apiBaseUrl,
        '/api/v1/operations/patients/search',
        accessToken,
        input,
        listPage,
        fetchImplementation,
      );
    },
    getPatientDetail(input: PatientDetailInput) {
      return post(
        apiBaseUrl,
        '/api/v1/operations/patients/detail',
        accessToken,
        input,
        patientDetail,
        fetchImplementation,
      );
    },
    searchMedicalIdRecovery(input: MedicalIdRecoverySearchInput) {
      return post(
        apiBaseUrl,
        '/api/v1/operations/medical-id-recovery/search',
        accessToken,
        input,
        recoverySearchResult,
        fetchImplementation,
      );
    },
    revealMedicalId(input: MedicalIdRecoveryRevealInput) {
      return post(
        apiBaseUrl,
        '/api/v1/operations/medical-id-recovery/reveal',
        accessToken,
        input,
        recoveryRevealResult,
        fetchImplementation,
      );
    },
    searchSyncBatches(input: SyncBatchMonitoringSearchInput) {
      return post(
        apiBaseUrl,
        '/api/v1/operations/sync/batches/search',
        accessToken,
        input,
        syncMonitoringPage,
        fetchImplementation,
      );
    },
    getSyncBatchDetail(input: SyncBatchMonitoringDetailInput) {
      return post(
        apiBaseUrl,
        '/api/v1/operations/sync/batches/detail',
        accessToken,
        input,
        syncMonitoringDetail,
        fetchImplementation,
      );
    },
    searchIdentityReviews(input: IdentityReviewSearchInput) {
      return post(
        apiBaseUrl,
        '/api/v1/operations/identity-reviews/search',
        accessToken,
        input,
        identityReviewQueuePage,
        fetchImplementation,
      );
    },
    getIdentityReviewDetail(input: IdentityReviewDetailInput) {
      return post(
        apiBaseUrl,
        '/api/v1/operations/identity-reviews/detail',
        accessToken,
        input,
        identityReviewDetail,
        fetchImplementation,
      );
    },
    resolveIdentityReview(input: IdentityReviewResolutionInput) {
      return post(
        apiBaseUrl,
        '/api/v1/operations/identity-reviews/resolve',
        accessToken,
        input,
        identityReviewResolution,
        fetchImplementation,
      );
    },
  };
}

export type OperationsApi = ReturnType<typeof createOperationsApi>;
