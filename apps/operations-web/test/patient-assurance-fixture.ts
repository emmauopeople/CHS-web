import type { PatientDetail } from '../src/types';

export const patientAssuranceFixture = {
  identityAssurance: {
    acknowledgmentStatus: 'ACKNOWLEDGED',
    reviewState: 'REVIEW_REQUIRED',
    openReviewCaseCount: 1,
  },
  sourceProvenance: {
    sourceCount: 2,
    lastSynchronizedAt: '2026-08-20T12:00:00.000Z',
    sources: [
      {
        deploymentName: 'Desktop North',
        organizationName: 'Community Screening Program',
        locationName: 'North Mobile Site',
        lastSourceRevision: 4,
        sourceUpdatedAt: '2026-08-20T11:58:00.000Z',
        firstObservedAt: '2026-08-01T09:00:00.000Z',
        lastObservedAt: '2026-08-20T12:00:00.000Z',
      },
      {
        deploymentName: 'Desktop Central',
        organizationName: 'Community Screening Program',
        locationName: 'Central Church Site',
        lastSourceRevision: 2,
        sourceUpdatedAt: '2026-08-18T15:25:00.000Z',
        firstObservedAt: '2026-08-10T13:00:00.000Z',
        lastObservedAt: '2026-08-18T15:30:00.000Z',
      },
    ],
  },
} satisfies Pick<PatientDetail, 'identityAssurance' | 'sourceProvenance'>;
