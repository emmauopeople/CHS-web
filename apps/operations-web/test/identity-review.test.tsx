import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { OperationsApi } from '../src/api';
import { IdentityReview } from '../src/IdentityReview';

describe('identity review workspace', () => {
  it('renders a deliberate, masked initial state without loading protected evidence', () => {
    const api = {
      searchIdentityReviews: vi.fn(),
      getIdentityReviewDetail: vi.fn(),
      resolveIdentityReview: vi.fn(),
    } as unknown as OperationsApi;

    const html = renderToStaticMarkup(
      <IdentityReview api={api} onUnauthorized={vi.fn()} />,
    );

    expect(html).toContain('Evidence state');
    expect(html).toContain('Installation ID');
    expect(html).toContain('Opened from');
    expect(html).toContain('Load review cases');
    expect(html).toContain('No identity review query has been run');
    expect(html).toContain('Queue results are masked');
    expect(html).not.toContain('submitted-evidence');
    expect(api.searchIdentityReviews).not.toHaveBeenCalled();
    expect(api.getIdentityReviewDetail).not.toHaveBeenCalled();
    expect(api.resolveIdentityReview).not.toHaveBeenCalled();
  });
});
