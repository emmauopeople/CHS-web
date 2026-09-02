import type {
  IdentityReviewCaseDetail,
  IdentityReviewQueuePage,
  IdentityReviewResolutionResult,
  MedicalIdRecoveryRevealResult,
  MedicalIdRecoverySearchResult,
  PatientDetail,
  PatientListPage,
  SyncBatchMonitoringDetail,
  SyncBatchMonitoringPage,
} from '../../src/types';
import { lifestyleAssessmentFixture } from '../lifestyle-fixture';
import { patientAssuranceFixture } from '../patient-assurance-fixture';

export const syntheticPersonId = '40000000-0000-4000-8000-000000000001';

export const patientListPage = {
  page: 1,
  pageSize: 25,
  totalItems: 1,
  totalPages: 1,
  items: [
    {
      personId: syntheticPersonId,
      chsMedicalId: 'CHS-AAAA-BBBB-CCCC',
      displayName: 'Alpha Example',
      dateOfBirth: '1982-03-14',
      approximateAgeYears: null,
      ageAsOfDate: null,
      sex: 'FEMALE',
      status: 'ACTIVE',
      village: 'Example Village',
      quarter: 'North Quarter',
      lastScreeningAt: '2026-08-18T11:25:00.000Z',
      lastScreeningStatus: 'COMPLETED',
      lastLocationName: 'North Mobile Site',
    },
  ],
} satisfies PatientListPage;

export const patientDetail = {
  personId: syntheticPersonId,
  chsMedicalId: 'CHS-AAAA-BBBB-CCCC',
  displayName: 'Alpha Example',
  givenName: 'Alpha',
  familyName: 'Example',
  otherNames: null,
  dateOfBirth: '1982-03-14',
  approximateAgeYears: null,
  ageAsOfDate: null,
  sex: 'FEMALE',
  phone: '+00000000001',
  alternateContactName: 'Synthetic Contact',
  alternateContactPhone: '+00000000002',
  village: 'Example Village',
  quarter: 'North Quarter',
  residenceNotes: null,
  status: 'ACTIVE',
  ...patientAssuranceFixture,
  screeningHistory: {
    page: 1,
    pageSize: 10,
    totalItems: 1,
    totalPages: 1,
    items: [
      {
        encounterId: '41000000-0000-4000-8000-000000000001',
        status: 'COMPLETED',
        startedAt: '2026-08-18T10:45:00.000Z',
        completedAt: '2026-08-18T11:25:00.000Z',
        sessionDate: '2026-08-18',
        organizationName: 'Community Screening Program',
        locationName: 'North Mobile Site',
        protocolKey: 'release-1-screening',
        protocolVersionLabel: 'Release 1 v1',
        recordedByPractitionerName: 'Synthetic Nurse One',
        amendmentOfEncounterId: null,
        amendmentReason: null,
        vitals: {
          vitalSetId: '42000000-0000-4000-8000-000000000001',
          status: 'VITALS_COMPLETE',
          weightKg: 67.4,
          waistCm: 82,
          notes: null,
          recordedByPractitionerName: 'Synthetic Nurse One',
          readings: [
            {
              readingId: '43000000-0000-4000-8000-000000000001',
              sequenceNumber: 1,
              systolicMmhg: 122,
              diastolicMmhg: 78,
              pulseBpm: 71,
              measurementSite: 'RIGHT_ARM',
              patientPosition: 'SITTING',
              measurementLocalDate: '2026-08-18',
              measurementLocalTime: '11:02',
              measurementTimezone: 'Africa/Blantyre',
              measuredAt: '2026-08-18T09:02:00.000Z',
            },
          ],
        },
        lifestyle: lifestyleAssessmentFixture,
      },
    ],
  },
} satisfies PatientDetail;

export const emptyPatientListPage = {
  page: 1,
  pageSize: 25,
  totalItems: 0,
  totalPages: 0,
  items: [],
} satisfies PatientListPage;

export const recoveryEvidence = {
  fullName: 'Beta Testperson',
  dateOfBirth: '1984-06-16',
  caseReference: '50000000-0000-4000-8000-000000000001',
  candidateReference: '50000000-0000-4000-8000-000000000002',
  recoveryToken: 'r'.repeat(43),
} as const;

export const recoveryCandidateResult = {
  status: 'CANDIDATE_FOUND',
  caseReference: recoveryEvidence.caseReference,
  recoveryToken: recoveryEvidence.recoveryToken,
  expiresAt: '2026-09-02T16:05:00.000Z',
  candidates: [
    {
      candidateReference: recoveryEvidence.candidateReference,
      maskedName: 'B••• T•••••••••',
      maskedDateOfBirth: '****-**-16',
      sex: 'MALE',
      maskedResidence: 'S•••• Q••••••',
    },
  ],
} satisfies MedicalIdRecoverySearchResult;

export const recoveryRevealResult = {
  status: 'REVEALED',
  chsMedicalId: 'CHS-DDDD-EEEE-FFFF',
} satisfies MedicalIdRecoveryRevealResult;

export const syncEvidence = {
  batchReference: '51000000-0000-4000-8000-000000000001',
  sourceBatchId: '52000000-0000-4000-8000-000000000001',
  installationId: '53000000-0000-4000-8000-000000000001',
} as const;

const syncBatch = {
  batchReference: syncEvidence.batchReference,
  sourceBatchId: syncEvidence.sourceBatchId,
  installationId: syncEvidence.installationId,
  deploymentName: 'Synthetic Desktop One',
  organizationName: 'Community Screening Program',
  locationName: 'North Mobile Site',
  status: 'PARTIAL',
  attentionState: 'ATTENTION',
  contractVersion: '1.0',
  desktopApplicationVersion: '0.1.0',
  desktopSchemaVersion: 14,
  sourceCreatedAt: '2026-09-02T14:00:00.000Z',
  receivedAt: '2026-09-02T14:00:01.000Z',
  completedAt: '2026-09-02T14:00:02.000Z',
  durationMs: 1000,
  counts: {
    accepted: 3,
    unchanged: 0,
    reviewRequired: 0,
    rejected: 1,
    retry: 0,
  },
} as const;

export const syncMonitoringPage = {
  page: 1,
  pageSize: 25,
  totalItems: 1,
  totalPages: 1,
  items: [syncBatch],
} satisfies SyncBatchMonitoringPage;

export const syncMonitoringDetail = {
  ...syncBatch,
  outcomeCounts: [
    { resourceType: 'PATIENT', status: 'ACCEPTED', count: 1 },
    { resourceType: 'VITALS', status: 'REJECTED', count: 1 },
  ],
  errorCodeCounts: [
    { code: 'UNSUPPORTED_UNIT', retryable: false, count: 1 },
  ],
} satisfies SyncBatchMonitoringDetail;

export const identityEvidence = {
  review: '61000000-0000-4000-8000-000000000001',
  installation: '62000000-0000-4000-8000-000000000001',
  organization: '63000000-0000-4000-8000-000000000001',
  location: '64000000-0000-4000-8000-000000000001',
  patient: '65000000-0000-4000-8000-000000000001',
  source: '66000000-0000-4000-8000-000000000001',
  candidate: '67000000-0000-4000-8000-000000000001',
} as const;

const identityQueueItem = {
  caseReference: identityEvidence.review,
  status: 'OPEN',
  evidenceState: 'AVAILABLE',
  organizationName: 'Community Screening Program',
  locationName: 'North Mobile Site',
  installationId: identityEvidence.installation,
  deploymentName: 'Synthetic Desktop One',
  openedAt: '2026-09-02T14:00:00.000Z',
  updatedAt: '2026-09-02T14:01:00.000Z',
  candidateCount: 1,
  latestSourceRevision: 2,
  sourceCapturedAt: '2026-09-02T13:59:00.000Z',
  localPatientCode: 'PT-000001',
  maskedSubmittedName: 'A•••• E••••',
  submittedBirthEvidence: {
    kind: 'DATE_OF_BIRTH',
    maskedDate: '****-**-01',
  },
} as const;

export const identityReviewQueue = {
  page: 1,
  pageSize: 25,
  totalItems: 1,
  totalPages: 1,
  items: [identityQueueItem],
} satisfies IdentityReviewQueuePage;

export const identityReviewDetail = {
  caseReference: identityEvidence.review,
  status: 'OPEN',
  evidenceState: 'AVAILABLE',
  organization: {
    id: identityEvidence.organization,
    name: 'Community Screening Program',
  },
  location: {
    id: identityEvidence.location,
    name: 'North Mobile Site',
  },
  installation: {
    id: identityEvidence.installation,
    deploymentName: 'Synthetic Desktop One',
  },
  localPatientReference: identityEvidence.patient,
  openedAt: identityQueueItem.openedAt,
  updatedAt: identityQueueItem.updatedAt,
  evidence: {
    sourceRecordReference: identityEvidence.source,
    sourceRevision: 2,
    schemaVersion: '1.0',
    capturedAt: '2026-09-02T13:59:00.000Z',
    localPatientCode: 'PT-000001',
    maskedClaimedChsMedicalId: null,
    displayName: 'Alpha Example',
    givenName: 'Alpha',
    familyName: 'Example',
    otherNames: null,
    dateOfBirth: '1980-01-01',
    approximateAgeYears: null,
    ageAsOfDate: null,
    sex: 'FEMALE',
    acknowledgmentStatus: 'ACKNOWLEDGED',
    patientStatus: 'ACTIVE',
    phone: '+237600000000',
    village: 'Example Village',
    quarter: 'North Quarter',
    sourceCreatedAt: '2026-09-02T13:58:00.000Z',
    sourceUpdatedAt: '2026-09-02T13:59:00.000Z',
    receivedAt: '2026-09-02T14:00:00.000Z',
  },
  candidates: [
    {
      personReference: identityEvidence.candidate,
      score: 85,
      matchedOn: ['NAME', 'DATE_OF_BIRTH'],
      maskedChsMedicalId: 'CHS-****-****-CCCC',
      maskedName: 'A•••• E••••',
      birthEvidence: {
        kind: 'DATE_OF_BIRTH',
        maskedDate: '****-**-01',
      },
      sex: 'FEMALE',
      maskedPhone: '+237*******00',
      maskedResidence: 'N•••• Q••••••, E•••••• V••••••',
    },
  ],
} satisfies IdentityReviewCaseDetail;

export const identityResolutionResult = {
  resolutionRequestId: '68000000-0000-4000-8000-000000000001',
  caseReference: identityEvidence.review,
  resolutionStatus: 'RESOLVED_EXISTING',
  resolvedPersonReference: identityEvidence.candidate,
  chsMedicalId: 'CHS-AAAA-BBBB-CCCC',
  installationId: identityEvidence.installation,
  localPatientReference: identityEvidence.patient,
  localPatientCode: 'PT-000001',
  sourceRevision: 2,
  resolvedAt: '2026-09-02T14:10:00.000Z',
  replayed: false,
} satisfies IdentityReviewResolutionResult;
