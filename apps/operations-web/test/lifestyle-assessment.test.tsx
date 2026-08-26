import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LifestyleAssessment } from '../src/LifestyleAssessment';
import { lifestyleAssessmentFixture } from './lifestyle-fixture';

describe('canonical Lifestyle assessment viewer', () => {
  it('renders all weekly domains and exact immutable baseline references', () => {
    const html = renderToStaticMarkup(
      <LifestyleAssessment assessment={lifestyleAssessmentFixture} />,
    );

    expect(html).toContain('Finalized canonical assessment');
    expect(html).toContain('Lifestyle');
    expect(html).toContain('Alcohol');
    expect(html).toContain('Tobacco');
    expect(html).toContain('Physical activity');
    expect(html).toContain('Work');
    expect(html).toContain('Other activity');
    expect(html).toContain('Crop farmer');
    expect(html).toContain('Choir rehearsal');
    expect(html).toContain('Version 1');
    expect(html).toContain('Version 2');
    expect(html).toContain('Version 3');
    expect(html).toContain(lifestyleAssessmentFixture.baselines.alcohol.baselineId);
    expect(html).toContain(lifestyleAssessmentFixture.lifestyleAssessmentId);
    expect(html).not.toContain('localBaselineVersionId');
    expect(html).not.toContain('sourceContentHash');
    expect(html).not.toContain('raw payload');
  });

  it('renders a bounded empty state without implying a draft is complete', () => {
    const html = renderToStaticMarkup(<LifestyleAssessment assessment={null} />);

    expect(html).toContain('No finalized canonical Lifestyle assessment');
    expect(html).not.toContain('Finalized canonical assessment');
    expect(html).not.toContain('Complete');
  });
});
