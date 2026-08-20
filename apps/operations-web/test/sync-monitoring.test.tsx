import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { OperationsApi } from '../src/api';
import { SyncMonitoring } from '../src/SyncMonitoring';

describe('synchronization monitoring workspace', () => {
  it('renders an explicit, keyboard-operable initial state without making a request', () => {
    const api = {
      searchSyncBatches: vi.fn(),
      getSyncBatchDetail: vi.fn(),
    } as unknown as OperationsApi;

    const html = renderToStaticMarkup(
      <SyncMonitoring api={api} onUnauthorized={vi.fn()} />,
    );

    expect(html).toContain('Batch status');
    expect(html).toContain('Installation ID');
    expect(html).toContain('Received from');
    expect(html).toContain('Load batches');
    expect(html).toContain('No monitoring query has been run');
    expect(html).toContain('Operational metadata only');
    expect(html).not.toContain('patient name');
    expect(api.searchSyncBatches).not.toHaveBeenCalled();
    expect(api.getSyncBatchDetail).not.toHaveBeenCalled();
  });
});
