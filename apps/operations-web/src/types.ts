export type PatientAccessReason =
  | 'CARE_DELIVERY'
  | 'CARE_COORDINATION'
  | 'PATIENT_REQUEST'
  | 'QUALITY_IMPROVEMENT'
  | 'OPERATIONS_SUPPORT';

export type PersonStatus = 'ACTIVE' | 'INACTIVE' | 'DECEASED';

export type PatientListItem = Readonly<{
  personId: string;
  chsMedicalId: string;
  displayName: string;
  dateOfBirth: string | null;
  approximateAgeYears: number | null;
  ageAsOfDate: string | null;
  sex: 'FEMALE' | 'MALE' | 'OTHER' | 'UNKNOWN';
  status: PersonStatus;
  village: string | null;
  quarter: string | null;
  lastScreeningAt: string | null;
  lastScreeningStatus: 'DRAFT' | 'COMPLETED' | 'AMENDED' | null;
  lastLocationName: string | null;
}>;

export type PatientListPage = Readonly<{
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  items: readonly PatientListItem[];
}>;

export type VitalReadingView = Readonly<{
  readingId: string;
  sequenceNumber: number;
  systolicMmhg: number | null;
  diastolicMmhg: number | null;
  pulseBpm: number | null;
  measurementSite: 'RIGHT_ARM' | 'LEFT_ARM' | 'LEFT_LEG' | 'RIGHT_LEG' | null;
  patientPosition: 'LYING' | 'STANDING' | 'SITTING' | null;
  measurementLocalDate: string;
  measurementLocalTime: string | null;
  measurementTimezone: string;
  measuredAt: string | null;
}>;

export type PatientScreeningView = Readonly<{
  encounterId: string;
  status: 'DRAFT' | 'COMPLETED' | 'AMENDED';
  startedAt: string;
  completedAt: string | null;
  sessionDate: string;
  organizationName: string;
  locationName: string;
  protocolKey: string;
  protocolVersionLabel: string;
  recordedByPractitionerName: string;
  amendmentOfEncounterId: string | null;
  amendmentReason: string | null;
  vitals: null | Readonly<{
    vitalSetId: string;
    status: 'DRAFT' | 'VITALS_COMPLETE';
    weightKg: number | null;
    waistCm: number | null;
    notes: string | null;
    recordedByPractitionerName: string;
    readings: readonly VitalReadingView[];
  }>;
}>;

export type PatientDetail = Readonly<{
  personId: string;
  chsMedicalId: string;
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
  status: PersonStatus;
  screeningHistory: Readonly<{
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
    items: readonly PatientScreeningView[];
  }>;
}>;

export type ProblemDetails = Readonly<{
  title?: string;
  status?: number;
  code?: string;
  requestId?: string;
}>;

export type MedicalIdRecoveryCandidate = Readonly<{
  candidateReference: string;
  maskedName: string;
  maskedDateOfBirth: string;
  sex: 'FEMALE' | 'MALE' | 'OTHER' | 'UNKNOWN';
  maskedResidence: string | null;
}>;

export type MedicalIdRecoverySearchResult =
  | Readonly<{ status: 'NOT_RESOLVED' }>
  | Readonly<{
      status: 'CANDIDATE_FOUND';
      caseReference: string;
      recoveryToken: string;
      expiresAt: string;
      candidates: readonly [MedicalIdRecoveryCandidate];
    }>
  | Readonly<{
      status: 'REVIEW_REQUIRED';
      caseReference: string;
      candidateCount: number;
      candidates: readonly MedicalIdRecoveryCandidate[];
    }>;

export type MedicalIdRecoveryRevealResult = Readonly<{
  status: 'REVEALED';
  chsMedicalId: string;
}>;

export type SyncBatchStatus =
  | 'PROCESSING'
  | 'ACCEPTED'
  | 'PARTIAL'
  | 'REJECTED'
  | 'FAILED';

export type SyncBatchAttentionState = 'HEALTHY' | 'ATTENTION' | 'STALLED';

export type SyncBatchMonitoringItem = Readonly<{
  batchReference: string;
  sourceBatchId: string;
  installationId: string;
  deploymentName: string;
  organizationName: string;
  locationName: string;
  status: SyncBatchStatus;
  attentionState: SyncBatchAttentionState;
  contractVersion: string;
  desktopApplicationVersion: string;
  desktopSchemaVersion: number;
  sourceCreatedAt: string;
  receivedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  counts: Readonly<{
    accepted: number;
    unchanged: number;
    reviewRequired: number;
    rejected: number;
    retry: number;
  }>;
}>;

export type SyncBatchMonitoringPage = Readonly<{
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  items: readonly SyncBatchMonitoringItem[];
}>;

export type SyncBatchOutcomeCount = Readonly<{
  resourceType:
    | 'PATIENT'
    | 'SCREENING_SESSION'
    | 'SCREENING_ENCOUNTER'
    | 'VITALS'
    | 'LIFESTYLE';
  status:
    | 'PROCESSING'
    | 'ACCEPTED'
    | 'UNCHANGED'
    | 'REVIEW_REQUIRED'
    | 'REJECTED'
    | 'RETRY';
  count: number;
}>;

export type SyncBatchErrorCodeCount = Readonly<{
  code: string;
  retryable: boolean;
  count: number;
}>;

export type SyncBatchMonitoringDetail = SyncBatchMonitoringItem &
  Readonly<{
    outcomeCounts: readonly SyncBatchOutcomeCount[];
    errorCodeCounts: readonly SyncBatchErrorCodeCount[];
  }>;

export type IdentityReviewEvidenceState = 'AVAILABLE' | 'EVIDENCE_PENDING';

export type MaskedBirthEvidence =
  | Readonly<{ kind: 'DATE_OF_BIRTH'; maskedDate: string }>
  | Readonly<{
      kind: 'APPROXIMATE_AGE';
      ageYears: number;
      asOfYear: number;
    }>;

export type IdentityReviewQueueItem = Readonly<{
  caseReference: string;
  status: 'OPEN';
  evidenceState: IdentityReviewEvidenceState;
  organizationName: string;
  locationName: string;
  installationId: string;
  deploymentName: string;
  openedAt: string;
  updatedAt: string;
  candidateCount: number;
  latestSourceRevision: number | null;
  sourceCapturedAt: string | null;
  localPatientCode: string | null;
  maskedSubmittedName: string | null;
  submittedBirthEvidence: MaskedBirthEvidence | null;
}>;

export type IdentityReviewQueuePage = Readonly<{
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  items: readonly IdentityReviewQueueItem[];
}>;

export type IdentityReviewEvidenceDetail = Readonly<{
  sourceRecordReference: string;
  sourceRevision: number;
  schemaVersion: string;
  capturedAt: string;
  localPatientCode: string;
  maskedClaimedChsMedicalId: string | null;
  displayName: string;
  givenName: string | null;
  familyName: string | null;
  otherNames: string | null;
  dateOfBirth: string | null;
  approximateAgeYears: number | null;
  ageAsOfDate: string | null;
  sex: 'FEMALE' | 'MALE' | 'OTHER' | 'UNKNOWN';
  acknowledgmentStatus: 'ACKNOWLEDGED' | 'DECLINED' | 'NOT_REQUESTED' | null;
  patientStatus: 'ACTIVE' | 'INACTIVE' | null;
  phone: string | null;
  village: string | null;
  quarter: string | null;
  sourceCreatedAt: string;
  sourceUpdatedAt: string;
  receivedAt: string;
}>;

export type IdentityReviewCandidate = Readonly<{
  personReference: string;
  score: number;
  matchedOn: readonly string[];
  maskedChsMedicalId: string | null;
  maskedName: string;
  birthEvidence: MaskedBirthEvidence;
  sex: 'FEMALE' | 'MALE' | 'OTHER' | 'UNKNOWN';
  maskedPhone: string | null;
  maskedResidence: string | null;
}>;

export type IdentityReviewCaseDetail = Readonly<{
  caseReference: string;
  status: 'OPEN';
  evidenceState: IdentityReviewEvidenceState;
  organization: Readonly<{ id: string; name: string }>;
  location: Readonly<{ id: string; name: string }>;
  installation: Readonly<{ id: string; deploymentName: string }>;
  localPatientReference: string;
  openedAt: string;
  updatedAt: string;
  evidence: IdentityReviewEvidenceDetail | null;
  candidates: readonly IdentityReviewCandidate[];
}>;

export type IdentityReviewResolutionResult = Readonly<{
  resolutionRequestId: string;
  caseReference: string;
  resolutionStatus: 'RESOLVED_EXISTING' | 'RESOLVED_NEW';
  resolvedPersonReference: string;
  chsMedicalId: string;
  installationId: string;
  localPatientReference: string;
  localPatientCode: string;
  sourceRevision: number;
  resolvedAt: string;
  replayed: boolean;
}>;
