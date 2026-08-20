import type {
  PatientAccessReason,
  PatientDetail,
  PatientListPage,
  MedicalIdRecoveryRevealResult,
  MedicalIdRecoverySearchResult,
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

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const medicalIdPattern = /^CHS-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;
const safeErrorCodePattern = /^[A-Z][A-Z0-9_]{0,99}$/;
const syncBatchStatuses = ['PROCESSING', 'ACCEPTED', 'PARTIAL', 'REJECTED', 'FAILED'];
const syncAttentionStates = ['HEALTHY', 'ATTENTION', 'STALLED'];
const syncResourceTypes = ['PATIENT', 'SCREENING_SESSION', 'SCREENING_ENCOUNTER', 'VITALS'];
const syncOutcomeStatuses = [
  'PROCESSING',
  'ACCEPTED',
  'UNCHANGED',
  'REVIEW_REQUIRED',
  'REJECTED',
  'RETRY',
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
    Array.isArray(value.screeningHistory.items)
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
  };
}

export type OperationsApi = ReturnType<typeof createOperationsApi>;
