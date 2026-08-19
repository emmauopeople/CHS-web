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
