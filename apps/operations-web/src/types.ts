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
