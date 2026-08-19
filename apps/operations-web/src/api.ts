import type {
  PatientAccessReason,
  PatientDetail,
  PatientListPage,
  PersonStatus,
  ProblemDetails,
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

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  };
}
