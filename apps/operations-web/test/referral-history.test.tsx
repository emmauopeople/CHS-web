import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ReferralHistory } from '../src/App';
import { patientDetail, patientReferralDetail } from './e2e/fixtures';

describe('canonical referral history viewer', () => {
  it('renders normalized summary, immutable history and medication detail', () => {
    const html = renderToStaticMarkup(
      <ReferralHistory
        patient={patientDetail}
        selectedReferralId={patientReferralDetail.referral.referralId}
        referralDetail={patientReferralDetail}
        referralBusy={false}
        referralError={null}
        onOpen={() => undefined}
        onStatusPage={() => undefined}
        onFollowupPage={() => undefined}
      />,
    );

    expect(html).toContain('Bp Screening Referral');
    expect(html).toContain('North District Clinic');
    expect(html).toContain('Status history');
    expect(html).toContain('Patient reached by phone');
    expect(html).toContain('Follow-up history');
    expect(html).toContain('Amlodipine');
    expect(html).toContain('5 mg');
    expect(html).not.toContain('localResourceId');
    expect(html).not.toContain('sourceContentHash');
  });

  it('renders an explicit bounded empty state', () => {
    const html = renderToStaticMarkup(
      <ReferralHistory
        patient={{
          ...patientDetail,
          referralHistory: {
            page: 1,
            pageSize: 5,
            totalItems: 0,
            totalPages: 0,
            items: [],
          },
        }}
        selectedReferralId={null}
        referralDetail={null}
        referralBusy={false}
        referralError={null}
        onOpen={() => undefined}
        onStatusPage={() => undefined}
        onFollowupPage={() => undefined}
      />,
    );

    expect(html).toContain('No canonical referrals are available');
    expect(html).not.toContain('View history');
  });
});
