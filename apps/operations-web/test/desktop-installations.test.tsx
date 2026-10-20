import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DesktopInstallations } from '../src/DesktopInstallations';
import type { OperationsApi } from '../src/api';
import {
  installationPage,
  installationToken,
} from '../src/installation-contract';
describe('desktop installation management', () => {
  it('requires loading authorized locations before enrollment and starts with no token', () => {
    const api = {
      searchDesktopInstallations: vi.fn(),
      enrollDesktop: vi.fn(),
    } as unknown as OperationsApi;
    const html = renderToStaticMarkup(
      <DesktopInstallations api={api} onUnauthorized={vi.fn()} />,
    );
    expect(html).toContain('Load installations');
    expect(html).toContain('Desktop installation UUID');
    expect(html).toContain('Desktop local location UUID');
    expect(html).not.toContain('One-time installation token');
    expect(api.enrollDesktop).not.toHaveBeenCalled();
  });
  it('rejects secret leakage in list responses and malformed issued tokens', () => {
    expect(
      installationPage({
        items: [],
        locations: [],
        page: 1,
        hasMore: false,
        locationsTruncated: false,
      }),
    ).toBe(true);
    expect(
      installationPage({
        items: [{ installationToken: 'secret' }],
        locations: [],
        page: 1,
        hasMore: false,
        locationsTruncated: false,
      }),
    ).toBe(false);
    expect(installationToken({ installationToken: 'invalid' })).toBe(false);
  });
});
