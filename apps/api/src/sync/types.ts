export type DesktopActorRole =
  | 'LOCAL_ADMIN'
  | 'NURSE'
  | 'TRAINED_SCREENER';

export type SyncActorSnapshot = Readonly<{
  localActorId: string;
  displayName: string;
  role: DesktopActorRole;
  active: boolean;
  updatedAt: string;
}>;

export type SyncResourceType =
  | 'PATIENT'
  | 'SCREENING_SESSION'
  | 'SCREENING_ENCOUNTER'
  | 'VITALS';

export type SyncRecordSnapshot = Readonly<{
  recordId: string;
  resourceType: SyncResourceType;
  localResourceId: string;
  sourceRevision: number;
  schemaVersion: string;
  operation: 'UPSERT';
  capturedAt: string;
  sourceActorLocalId: string;
  payload: unknown;
}>;

export type PatientPayload = Readonly<{
  localPatientCode: string;
  knownChsMedicalId: string | null;
  displayName: string;
  givenName: string | null;
  familyName: string | null;
  otherNames: string | null;
  dateOfBirth: string | null;
  approximateAgeYears: number | null;
  ageAsOfDate: string | null;
  sex: 'FEMALE' | 'MALE' | 'OTHER' | 'UNKNOWN';
  phone: string | null;
  alternateContactName: string | null;
  alternateContactPhone: string | null;
  village: string | null;
  quarter: string | null;
  residenceNotes: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  acknowledgmentStatus: 'ACKNOWLEDGED' | 'DECLINED' | 'NOT_REQUESTED';
  createdAt: string;
  updatedAt: string;
}>;

export type PatientSyncRecord = Omit<SyncRecordSnapshot, 'payload' | 'resourceType'> &
  Readonly<{
    resourceType: 'PATIENT';
    payload: PatientPayload;
  }>;

export type SyncRecordError = Readonly<{
  code: string;
  path: string;
  retryable: boolean;
}>;

export type PatientRecordOutcome = Readonly<{
  recordId: string;
  resourceType: 'PATIENT';
  localResourceId: string;
  sourceRevision: number;
  status: 'ACCEPTED' | 'UNCHANGED' | 'REVIEW_REQUIRED' | 'REJECTED' | 'RETRY';
  canonicalResourceId: string | null;
  centralPersonId: string | null;
  chsMedicalId: string | null;
  medicalIdStatus: 'ASSIGNED' | 'CONFIRMED' | 'PENDING_REVIEW' | null;
  errors: readonly SyncRecordError[];
}>;

export type SyncBatchRequest = Readonly<{
  contractVersion: '1.0';
  batchId: string;
  installationId: string;
  locationId: string;
  installationTimezone: string;
  desktopApplicationVersion: string;
  desktopSchemaVersion: number;
  createdAt: string;
  actors: readonly SyncActorSnapshot[];
  records: readonly SyncRecordSnapshot[];
}>;

export type InstallationContext = Readonly<{
  installationId: string;
  organizationId: string;
  configuredLocationId: string;
  timezone: string;
}>;
