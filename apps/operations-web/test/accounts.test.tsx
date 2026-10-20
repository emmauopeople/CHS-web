import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Accounts } from '../src/Accounts';
import { accountPage, accountResult } from '../src/account-contract';
import type { OperationsApi } from '../src/api';
describe('portal accounts', () => {
  it('starts without credentials and requires an authorized load before creation', () => {
    const api = {
      searchAccounts: vi.fn(),
      createAccount: vi.fn(),
    } as unknown as OperationsApi;
    const html = renderToStaticMarkup(
      <Accounts api={api} onUnauthorized={vi.fn()} />,
    );
    expect(html).toContain('Load accounts');
    expect(html).not.toContain('Save this temporary password');
    expect(html).not.toContain('account-username');
    expect(api.createAccount).not.toHaveBeenCalled();
  });
  it('validates bounded role and credential response contracts', () => {
    const id = 'e61d40a4-8f18-40ef-ad32-a4f0ad0082b4';
    expect(
      accountPage({
        items: [],
        organizations: [],
        page: 1,
        hasMore: false,
        actorId: id,
        actorRole: 'ADMIN',
      }),
    ).toBe(true);
    expect(
      accountPage({
        items: [],
        organizations: [],
        page: 1,
        hasMore: false,
        actorId: id,
        actorRole: 'STAFF',
      }),
    ).toBe(false);
    expect(
      accountResult({
        id,
        username: 'staff',
        temporaryPassword: 'short',
        requiresPasswordChange: true,
      }),
    ).toBe(false);
    expect(
      accountResult({
        id,
        username: 'staff',
        temporaryPassword: 'x'.repeat(32),
        requiresPasswordChange: true,
      }),
    ).toBe(true);
  });
});
