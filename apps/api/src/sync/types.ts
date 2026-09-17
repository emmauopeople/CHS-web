export type DesktopActorRole = 'LOCAL_ADMIN' | 'NURSE' | 'TRAINED_SCREENER';

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

export type PatientSyncRecord = Omit<
  SyncRecordSnapshot,
  'payload' | 'resourceType'
> &
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

export type ScreeningSessionPayload = Readonly<{
  localLocationId: string;
  localProtocolVersionId: string;
  protocolKey: string;
  protocolVersionLabel: string;
  protocolChecksum: string;
  sessionDate: string;
  status: 'OPEN' | 'CLOSED';
  notes: string | null;
  openedByLocalActorId: string;
  closedByLocalActorId: string | null;
  openedAt: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type ScreeningSessionSyncRecord = Omit<
  SyncRecordSnapshot,
  'payload' | 'resourceType'
> &
  Readonly<{
    resourceType: 'SCREENING_SESSION';
    payload: ScreeningSessionPayload;
  }>;

export type ScreeningSessionRecordOutcome = Readonly<{
  recordId: string;
  resourceType: 'SCREENING_SESSION';
  localResourceId: string;
  sourceRevision: number;
  status: 'ACCEPTED' | 'UNCHANGED' | 'REJECTED' | 'RETRY';
  canonicalResourceId: string | null;
  centralPersonId: null;
  chsMedicalId: null;
  medicalIdStatus: null;
  errors: readonly SyncRecordError[];
}>;

export type ScreeningEncounterPayload = Readonly<{
  clinicalTime?: Readonly<{localDate: string; localTime: string; timezone: string}>;
  localPatientId: string;
  localScreeningSessionId: string;
  localLocationId: string;
  localProtocolVersionId: string;
  recordedByLocalActorId: string;
  status: 'DRAFT' | 'COMPLETED' | 'AMENDED' | 'VOID';
  startedAt: string;
  completedAt: string | null;
  sourceType: 'LOCAL';
  amendmentOfLocalEncounterId: string | null;
  amendmentReason: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type ScreeningEncounterSyncRecord = Omit<
  SyncRecordSnapshot,
  'payload' | 'resourceType'
> &
  Readonly<{
    resourceType: 'SCREENING_ENCOUNTER';
    payload: ScreeningEncounterPayload;
  }>;

export type ScreeningEncounterRecordOutcome = Readonly<{
  recordId: string;
  resourceType: 'SCREENING_ENCOUNTER';
  localResourceId: string;
  sourceRevision: number;
  status: 'ACCEPTED' | 'UNCHANGED' | 'REJECTED' | 'RETRY';
  canonicalResourceId: string | null;
  centralPersonId: null;
  chsMedicalId: null;
  medicalIdStatus: null;
  errors: readonly SyncRecordError[];
}>;

export type VitalsReadingPayload = Readonly<{
  localReadingId: string;
  sequenceNumber: number;
  systolic: number | null;
  diastolic: number | null;
  pulse: number | null;
  measurementSite: 'RIGHT_ARM' | 'LEFT_ARM' | 'LEFT_LEG' | 'RIGHT_LEG' | null;
  patientPosition: 'LYING' | 'STANDING' | 'SITTING' | null;
  measurementLocalDate: string;
  measurementLocalTime: string | null;
  measurementTimezone: string;
  createdAt: string;
  updatedAt: string;
}>;

export type VitalsPayload = Readonly<{
  localEncounterId: string;
  performedByLocalActorId: string;
  status: 'DRAFT' | 'VITALS_COMPLETE';
  weightKg: number | null;
  waistCm: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  readings: readonly VitalsReadingPayload[];
}>;

export type VitalsSyncRecord = Omit<
  SyncRecordSnapshot,
  'payload' | 'resourceType'
> &
  Readonly<{
    resourceType: 'VITALS';
    payload: VitalsPayload;
  }>;

export type VitalsRecordOutcome = Readonly<{
  recordId: string;
  resourceType: 'VITALS';
  localResourceId: string;
  sourceRevision: number;
  status: 'ACCEPTED' | 'UNCHANGED' | 'REJECTED' | 'RETRY';
  canonicalResourceId: string | null;
  centralPersonId: null;
  chsMedicalId: null;
  medicalIdStatus: null;
  errors: readonly SyncRecordError[];
}>;

export type LifestyleBeverageType =
  'BEER' | 'WINE' | 'SPIRITS' | 'COCKTAILS' | 'FORTIFIED_WINE' | 'OTHER';

export type LifestyleTobaccoProductType =
  | 'CIGARETTE'
  | 'ROLLED_TOBACCO'
  | 'CIGAR_PIPE'
  | 'SMOKELESS'
  | 'SNUFF'
  | 'HOOKAH'
  | 'VAPE'
  | 'OTHER';

export type LifestyleProvenance = Readonly<{
  createdByLocalActorId: string;
  createdAt: string;
  updatedByLocalActorId: string;
  updatedAt: string;
}>;

export type LifestyleAlcoholBaseline = LifestyleProvenance &
  Readonly<{
    localBaselineVersionId: string;
    version: number;
    status: 'CURRENT' | 'FORMER' | 'NEVER' | 'UNKNOWN' | 'DECLINED';
    everConsumed: 'YES' | 'NO' | 'UNKNOWN' | 'DECLINED';
    consumedPast12Months: 'YES' | 'NO' | 'UNKNOWN' | 'DECLINED';
    commonBeverageTypes: readonly LifestyleBeverageType[];
    otherBeverageDescription: string | null;
  }>;

export type LifestyleTobaccoBaseline = LifestyleProvenance &
  Readonly<{
    localBaselineVersionId: string;
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
      'EVERY_DAY' | 'SOME_DAYS' | 'NOT_AT_ALL' | 'UNKNOWN' | 'DECLINED';
    productTypes: readonly LifestyleTobaccoProductType[];
    otherProductDescription: string | null;
  }>;

export type LifestyleWorkBaseline = LifestyleProvenance &
  Readonly<{
    localBaselineVersionId: string;
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

export type LifestyleAlcoholWeekly = LifestyleProvenance &
  Readonly<{
    localWeeklyRecordId: string;
    weeklyResponse:
      | 'YES'
      | 'NO'
      | 'UNKNOWN'
      | 'DECLINED'
      | 'NOT_APPLICABLE'
      | 'PREFER_NOT_TO_ANSWER';
    drinkingDays: number | null;
    totalStandardizedDrinks: number | null;
    largestOneDayAmount: number | null;
    daysAtLargestAmount: number | null;
    commonBeverageTypes: readonly LifestyleBeverageType[];
    otherBeverageDescription: string | null;
  }>;

export type LifestyleTobaccoProduct = LifestyleProvenance &
  Readonly<{
    localProductRowId: string;
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
  }>;

export type LifestyleTobaccoWeekly = LifestyleProvenance &
  Readonly<{
    localWeeklyRecordId: string;
    weeklyResponse:
      | 'YES'
      | 'NO'
      | 'UNKNOWN'
      | 'DECLINED'
      | 'NOT_APPLICABLE'
      | 'PREFER_NOT_TO_ANSWER';
    products: readonly LifestyleTobaccoProduct[];
  }>;

export type LifestylePhysicalActivity = LifestyleProvenance &
  Readonly<{
    localActivityRowId: string;
    sequenceNumber: number;
    activityDomain: 'WORK_OR_FARMING' | 'TRANSPORT' | 'HOUSEHOLD' | 'EXERCISE';
    description: string | null;
    intensity: 'LIGHT' | 'MODERATE' | 'VIGOROUS';
    daysInPastSevenDays: number;
    averageMinutesPerActiveDay: number;
  }>;

export type LifestylePhysicalActivityWeekly = LifestyleProvenance &
  Readonly<{
    localWeeklyRecordId: string;
    weeklyResponse:
      | 'YES'
      | 'NO'
      | 'UNKNOWN'
      | 'DECLINED'
      | 'NOT_APPLICABLE'
      | 'UNABLE_TO_ANSWER'
      | 'PREFER_NOT_TO_ANSWER';
    sedentaryTimeResponse:
      | 'RECORDED'
      | 'UNKNOWN'
      | 'UNABLE_TO_ANSWER'
      | 'DECLINED'
      | 'PREFER_NOT_TO_ANSWER';
    sedentaryMinutesPerDay: number | null;
    activities: readonly LifestylePhysicalActivity[];
  }>;

export type LifestyleWorkWeekly = LifestyleProvenance &
  Readonly<{
    localWeeklyRecordId: string;
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

export type LifestyleOtherActivity = LifestyleProvenance &
  Readonly<{
    localActivityRowId: string;
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
  }>;

export type LifestylePayload = LifestyleProvenance &
  Readonly<{
    localPatientId: string;
    localEncounterId: string;
    localScreeningSessionId: string;
    localLocationId: string;
    status: 'COMPLETE';
    periodStart: string;
    periodEnd: string;
    baselines: Readonly<{
      alcohol: LifestyleAlcoholBaseline;
      tobacco: LifestyleTobaccoBaseline;
      work: LifestyleWorkBaseline;
    }>;
    alcohol: LifestyleAlcoholWeekly;
    tobacco: LifestyleTobaccoWeekly;
    physicalActivity: LifestylePhysicalActivityWeekly;
    work: LifestyleWorkWeekly;
    otherActivity: Readonly<{
      weeklyResponse:
        'YES' | 'NO' | 'UNKNOWN' | 'DECLINED' | 'PREFER_NOT_TO_ANSWER';
      activities: readonly LifestyleOtherActivity[];
    }>;
  }>;

export type LifestyleSyncRecord = Omit<
  SyncRecordSnapshot,
  'payload' | 'resourceType'
> &
  Readonly<{
    resourceType: 'LIFESTYLE';
    payload: LifestylePayload;
  }>;

export type LifestyleRecordOutcome = Readonly<{
  recordId: string;
  resourceType: 'LIFESTYLE';
  localResourceId: string;
  sourceRevision: number;
  status: 'ACCEPTED' | 'UNCHANGED' | 'REJECTED' | 'RETRY';
  canonicalResourceId: string | null;
  centralPersonId: null;
  chsMedicalId: null;
  medicalIdStatus: null;
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

export type SyncRecordOutcome =
  | PatientRecordOutcome
  | ScreeningSessionRecordOutcome
  | ScreeningEncounterRecordOutcome
  | VitalsRecordOutcome
  | LifestyleRecordOutcome
  | ReportedIntakeOutcome
  | ReferralOutcome
  | EncounterHistoryOutcome;

export type SyncBatchStatus = 'ACCEPTED' | 'PARTIAL' | 'REJECTED';

export type SyncBatchResponse = Readonly<{
  contractVersion: '1.0';
  batchId: string;
  batchStatus: SyncBatchStatus;
  receivedAt: string;
  completedAt: string;
  outcomes: readonly SyncRecordOutcome[];
}>;

export type ReportedIntakeRow = Readonly<{
  localRowId: string;
  recordedByLocalActorId: string;
  recordedAt: string;
  sourceType: 'PATIENT_REPORTED';
}>;
export type FoodRow = ReportedIntakeRow &
  Readonly<{
    foodCode: string | null;
    foodName: string;
    frequencyCode: '1_DAY' | '2_TO_3_DAYS' | '4_TO_6_DAYS' | 'EVERY_DAY' | null;
    preparationNote: string | null;
  }>;
export type OtcRow = ReportedIntakeRow &
  Readonly<{
    productName: string;
    reasonForUse: string;
    doseText: string | null;
    frequencyText: string | null;
    durationText: string | null;
    sourceOfMedication: string | null;
    currentlyTaking: boolean | null;
  }>;
export type ReportedIntakePayload = Readonly<{
  localEncounterId: string;
  completedAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  response:
    | 'REPORTED'
    | 'NONE_REPORTED'
    | 'UNKNOWN'
    | 'DECLINED'
    | 'PREFER_NOT_TO_ANSWER'
    | null;
  recordedByLocalActorId: string;
  rows: readonly (FoodRow | OtcRow)[];
}>;
export type ReportedIntakeRecord = Omit<
  SyncRecordSnapshot,
  'payload' | 'resourceType'
> &
  Readonly<{ resourceType: 'FOOD' | 'OTC'; payload: ReportedIntakePayload }>;
export type ReportedIntakeOutcome = Omit<VitalsRecordOutcome, 'resourceType'> &
  Readonly<{ resourceType: 'FOOD' | 'OTC' }>;

export type ReferralPayload = Readonly<{
  localPatientId: string;
  localEncounterId: string;
  localProtocolVersionId: string;
  reasonCodes: readonly string[];
  reasonText: string | null;
  urgency: 'STANDARD' | 'URGENT';
  destinationName: string | null;
  dueDate: string | null;
  status: 'OPEN' | 'CONTACTED' | 'SEEN' | 'UNABLE_TO_CONFIRM' | 'CLOSED';
  createdByLocalActorId: string;
  createdAt: string;
  updatedByLocalActorId: string;
  updatedAt: string;
  closedByLocalActorId: string | null;
  closedAt: string | null;
  closureReason: string | null;
}>;

export type ReferralStatusPayload = Readonly<{
  localReferralId: string;
  sequenceNumber: number;
  fromStatus:
    'OPEN' | 'CONTACTED' | 'SEEN' | 'UNABLE_TO_CONFIRM' | 'CLOSED' | null;
  toStatus: 'OPEN' | 'CONTACTED' | 'SEEN' | 'UNABLE_TO_CONFIRM' | 'CLOSED';
  changeReason: string | null;
  changedByLocalActorId: string;
  changedAt: string;
}>;

export type ReferralFollowupPayload = Readonly<{
  localReferralId: string;
  contactDate: string;
  contactMethod: string;
  informationSource: string;
  providerSeen: boolean | null;
  facilityName: string | null;
  dateSeen: string | null;
  reportedOutcome: string | null;
  reportedMedicationsOrAdvice: string | null;
  nextAction: string | null;
  nextFollowupDate: string | null;
  sourceType: string;
  recordedByLocalActorId: string;
  recordedAt: string;
  treatmentActions: readonly Readonly<{
    localActionId: string;
    sequenceNumber: number;
    actionCode: 'TREATMENT_INITIATED' | 'TREATMENT_MODIFIED' | 'NEW_MEDICATION';
  }>[];
  medicationChanges: readonly Readonly<{
    localMedicationChangeId: string;
    sequenceNumber: number;
    changeType: 'NEW_MEDICATION' | 'TREATMENT_MODIFIED';
    medicationName: string;
    dosage: string | null;
    frequency: string | null;
  }>[];
}>;

export type ReferralRecord = Omit<
  SyncRecordSnapshot,
  'payload' | 'resourceType'
> &
  (
    | Readonly<{ resourceType: 'REFERRAL'; payload: ReferralPayload }>
    | Readonly<{
        resourceType: 'REFERRAL_STATUS';
        payload: ReferralStatusPayload;
      }>
    | Readonly<{
        resourceType: 'REFERRAL_FOLLOWUP';
        payload: ReferralFollowupPayload;
      }>
  );
export type ReferralOutcome = Omit<VitalsRecordOutcome, 'resourceType'> &
  Readonly<{ resourceType: ReferralRecord['resourceType'] }>;

export type ReviewFlagStatus = 'OPEN' | 'RESOLVED' | 'DISMISSED';
export type EncounterHistoryRecord = Omit<
  SyncRecordSnapshot, 'payload' | 'resourceType'
> & (
  | Readonly<{
      resourceType: 'ENCOUNTER_ADDENDUM';
      payload: Readonly<{
        localEncounterId: string;
        noteText: string;
        createdByLocalActorId: string;
        createdAt: string;
      }>;
    }>
  | Readonly<{
      resourceType: 'ENCOUNTER_REVIEW_FLAG';
      payload: Readonly<{
        localEncounterId: string;
        category: 'POSSIBLE_DATA_ERROR' | 'MISSING_INFORMATION' | 'WRONG_PATIENT'
          | 'DUPLICATE_ENCOUNTER' | 'OTHER';
        description: string;
        openedByLocalActorId: string;
        openedAt: string;
      }>;
    }>
  | Readonly<{
      resourceType: 'ENCOUNTER_REVIEW_STATUS';
      payload: Readonly<{
        localFlagId: string;
        sequenceNumber: number;
        fromStatus: ReviewFlagStatus | null;
        toStatus: ReviewFlagStatus;
        changeReason: string | null;
        changedByLocalActorId: string;
        changedAt: string;
      }>;
    }>
);
export type EncounterHistoryOutcome = Omit<VitalsRecordOutcome, 'resourceType'> & {
  readonly resourceType: EncounterHistoryRecord['resourceType'];
};
