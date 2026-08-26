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

export type LifestyleBeverageType =
  | 'BEER'
  | 'WINE'
  | 'SPIRITS'
  | 'COCKTAILS'
  | 'FORTIFIED_WINE'
  | 'OTHER';

export type LifestyleAssessmentView = Readonly<{
  lifestyleAssessmentId: string;
  status: 'COMPLETE';
  periodStart: string;
  periodEnd: string;
  completedAt: string;
  recordedByPractitionerName: string;
  baselines: Readonly<{
    alcohol: Readonly<{
      baselineId: string;
      version: number;
      status: 'CURRENT' | 'FORMER' | 'NEVER' | 'UNKNOWN' | 'DECLINED';
      everConsumed: 'YES' | 'NO' | 'UNKNOWN' | 'DECLINED';
      consumedPast12Months: 'YES' | 'NO' | 'UNKNOWN' | 'DECLINED';
      commonBeverageTypes: readonly LifestyleBeverageType[];
      otherBeverageDescription: string | null;
    }>;
    tobacco: Readonly<{
      baselineId: string;
      version: number;
      status:
        | 'CURRENT_DAILY'
        | 'CURRENT_SOME_DAYS'
        | 'FORMER'
        | 'NEVER'
        | 'UNKNOWN'
        | 'DECLINED';
      everRegularlyUsed: 'YES' | 'NO' | 'UNKNOWN' | 'DECLINED';
      formerUseApproximateStopDate: string | null;
      currentUseFrequency:
        | 'EVERY_DAY'
        | 'SOME_DAYS'
        | 'NOT_AT_ALL'
        | 'UNKNOWN'
        | 'DECLINED';
      productTypes: readonly LifestyleTobaccoProductType[];
      otherProductDescription: string | null;
    }>;
    work: Readonly<{
      baselineId: string;
      version: number;
      status:
        | 'EMPLOYED'
        | 'SELF_EMPLOYED'
        | 'FARMING'
        | 'STUDENT'
        | 'HOMEMAKER_CAREGIVER'
        | 'UNEMPLOYED'
        | 'RETIRED'
        | 'UNABLE_TO_WORK'
        | 'OTHER'
        | 'DECLINED';
      occupationJobTitle: string | null;
      usualPhysicalDemand:
        | 'SITTING'
        | 'STANDING'
        | 'WALKING'
        | 'MODERATE_LABOR'
        | 'HEAVY_LABOR'
        | 'VARIES'
        | null;
      typicalWorkdaysPerWeek: number | null;
      typicalHoursPerWorkday: number | null;
      shiftPattern:
        | 'DAY'
        | 'EVENING'
        | 'NIGHT'
        | 'ROTATING'
        | 'IRREGULAR'
        | 'NOT_APPLICABLE'
        | 'UNKNOWN'
        | 'DECLINED'
        | null;
      description: string | null;
    }>;
  }>;
  alcohol: Readonly<{
    weeklyResponse: LifestyleWeeklyResponse;
    drinkingDays: number | null;
    totalStandardizedDrinks: number | null;
    largestOneDayAmount: number | null;
    daysAtLargestAmount: number | null;
    commonBeverageTypes: readonly LifestyleBeverageType[];
    otherBeverageDescription: string | null;
  }>;
  tobacco: Readonly<{
    weeklyResponse: LifestyleWeeklyResponse;
    products: readonly Readonly<{
      productId: string;
      sequenceNumber: number;
      productType: LifestyleTobaccoProductType;
      daysUsed: number;
      averageQuantityPerUseDay: number;
      unit:
        | 'STICKS_CIGARETTES'
        | 'SESSIONS'
        | 'PORTIONS'
        | 'PINS'
        | 'PODS_CARTRIDGES'
        | 'OTHER';
      secondhandSmokeExposure: boolean | null;
      otherProductDescription: string | null;
      otherUnitDescription: string | null;
    }>[];
  }>;
  physicalActivity: Readonly<{
    weeklyResponse:
      | LifestyleWeeklyResponse
      | 'UNABLE_TO_ANSWER';
    sedentaryTimeResponse:
      | 'RECORDED'
      | 'UNKNOWN'
      | 'UNABLE_TO_ANSWER'
      | 'DECLINED'
      | 'PREFER_NOT_TO_ANSWER';
    sedentaryMinutesPerDay: number | null;
    activities: readonly Readonly<{
      activityId: string;
      sequenceNumber: number;
      activityDomain: 'WORK_OR_FARMING' | 'TRANSPORT' | 'HOUSEHOLD' | 'EXERCISE';
      description: string | null;
      intensity: 'LIGHT' | 'MODERATE' | 'VIGOROUS';
      daysInPastSevenDays: number;
      averageMinutesPerActiveDay: number;
    }>[];
  }>;
  work: Readonly<{
    weeklyResponse:
      | 'USUAL'
      | 'LESS_THAN_USUAL'
      | 'MORE_THAN_USUAL'
      | 'NO_WORK'
      | 'NOT_APPLICABLE'
      | 'UNKNOWN'
      | 'DECLINED'
      | 'PREFER_NOT_TO_ANSWER';
  }>;
  otherActivity: Readonly<{
    weeklyResponse: Exclude<LifestyleWeeklyResponse, 'NOT_APPLICABLE'>;
    activities: readonly Readonly<{
      activityId: string;
      sequenceNumber: number;
      category:
        | 'FARMING_GARDENING'
        | 'HOUSEHOLD'
        | 'CAREGIVING'
        | 'COMMUNITY'
        | 'COMMUTE'
        | 'SPORT'
        | 'OTHER';
      description: string | null;
      daysInPastSevenDays: number;
      averageMinutesPerDay: number;
      intensity: 'LIGHT' | 'MODERATE' | 'VIGOROUS';
    }>[];
  }>;
}>;

type LifestyleWeeklyResponse =
  | 'YES'
  | 'NO'
  | 'UNKNOWN'
  | 'DECLINED'
  | 'NOT_APPLICABLE'
  | 'PREFER_NOT_TO_ANSWER';

type LifestyleTobaccoProductType =
  | 'CIGARETTE'
  | 'ROLLED_TOBACCO'
  | 'CIGAR_PIPE'
  | 'SMOKELESS'
  | 'SNUFF'
  | 'HOOKAH'
  | 'VAPE'
  | 'OTHER';

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
  lifestyle: LifestyleAssessmentView | null;
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
