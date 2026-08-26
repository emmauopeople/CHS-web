import type { PatientDetail, PatientListPage } from '../../src/types';
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
