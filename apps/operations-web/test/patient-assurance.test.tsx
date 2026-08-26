import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PatientAssurance } from '../src/PatientAssurance';
import { patientAssuranceFixture } from './patient-assurance-fixture';

describe('patient identity assurance and source provenance', () => {
  it('renders the bounded review warning and approved source context', () => {
    const html = renderToStaticMarkup(
      <PatientAssurance {...patientAssuranceFixture} />,
    );

    expect(html).toContain('Acknowledgment: Acknowledged');
    expect(html).toContain('Identity review required');
    expect(html).toContain('1 open identity review case');
    expect(html).toContain('2 sources');
    expect(html).toContain('Desktop North');
    expect(html).toContain('North Mobile Site');
    expect(html).toContain('Revision 4');
    expect(html).toContain('Source updated');
    expect(html).toContain('First received');
    expect(html).toContain('Last received');
    expect(html).not.toContain('localPatientId');
    expect(html).not.toContain('localPatientCode');
    expect(html).not.toContain('sourceContentHash');
    expect(html).not.toContain('reviewCaseId');
  });

  it('renders a scoped clear state and bounded source empty state', () => {
    const html = renderToStaticMarkup(
      <PatientAssurance
        identityAssurance={{
          acknowledgmentStatus: 'NOT_REQUESTED',
          reviewState: 'CLEAR',
          openReviewCaseCount: 0,
        }}
        sourceProvenance={{
          sourceCount: 0,
          lastSynchronizedAt: null,
          sources: [],
        }}
      />,
    );

    expect(html).toContain('Acknowledgment: Not Requested');
    expect(html).toContain('No open identity-review warnings');
    expect(html).toContain('No source context is available');
    expect(html).not.toContain('Identity review required');
  });
});
