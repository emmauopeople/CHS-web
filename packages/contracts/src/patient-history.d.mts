export type HistoryResourceType =
  | 'SCREENING_ENCOUNTER'
  | 'VITALS'
  | 'LIFESTYLE'
  | 'FOOD'
  | 'OTC'
  | 'REFERRAL'
  | 'REFERRAL_STATUS'
  | 'REFERRAL_FOLLOWUP'
  | 'ENCOUNTER_ADDENDUM'
  | 'ENCOUNTER_REVIEW_FLAG'
  | 'ENCOUNTER_REVIEW_STATUS';
export type HistoryReason =
  | 'CARE_DELIVERY'
  | 'CARE_COORDINATION'
  | 'PATIENT_REQUEST'
  | 'QUALITY_IMPROVEMENT'
  | 'OPERATIONS_SUPPORT';
export type HistoryRequest = Readonly<{
  contractVersion: '1.0';
  personId: string;
  reasonCode: HistoryReason;
  fromDate: string;
  toDate: string;
  resourceTypes?: readonly HistoryResourceType[];
  limit?: number;
  cursor?: string;
}>;
export type InstallationHistoryRequest = HistoryRequest &
  Readonly<{ localPatientId: string; requesterLocalActorId: string }>;
export type HistoryActor = Readonly<{
  practitionerId: string;
  displayName: string;
}>;
export type HistoryItem = Readonly<{
  resourceType: HistoryResourceType;
  resourceId: string;
  parentResourceId: string | null;
  sourceRevision: number;
  occurredAt: string;
  receivedAt: string;
  author: HistoryActor;
  encounter: Readonly<{
    encounterId: string;
    status: 'DRAFT' | 'COMPLETED' | 'AMENDED' | 'VOID';
    startedAt: string;
    amendmentOfEncounterId: string | null;
    amendmentReason: string | null;
    voidReason: string | null;
  }>;
  source: Readonly<{
    organizationId: string;
    organizationName: string;
    locationId: string;
    locationName: string;
    installationId: string;
    deploymentName: string;
  }>;
  data: Readonly<Record<string, unknown>>;
}>;
export type HistoryPage = Readonly<{
  patient: Readonly<Record<string, unknown>>;
  contractVersion: '1.0';
  personId: string;
  retrievedAt: string;
  fromDate: string;
  toDate: string;
  nextCursor: string | null;
  items: readonly HistoryItem[];
}>;
export const historyResourceTypes: readonly HistoryResourceType[];
export const historyReasonCodes: readonly HistoryReason[];
export const historyDataSchemas: Readonly<
  Record<HistoryResourceType, Record<string, unknown>>
>;
export const operationsHistoryRequestSchema: Record<string, unknown>;
export const installationHistoryRequestSchema: Record<string, unknown>;
export const historyPageSchema: Record<string, unknown>;
export function isHistoryPage(value: unknown): value is HistoryPage;
export function isHistoryRequest(
  value: unknown,
  installation?: boolean,
): value is HistoryRequest | InstallationHistoryRequest;

export const historyPatientSchema: Record<string, unknown>;
