import { describe, expect, it, vi } from 'vitest';
import {
  createAccountIdentity,
  temporaryPassword,
} from '../src/administration/account-identity.js';
describe('CHS identity account adapter', () => {
  it('creates disabled identities with temporary passwords before activation', async () => {
    const subject = 'e61d40a4-8f18-40ef-ad32-a4f0ad0082b4';
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'test-token' })),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 201,
          headers: {
            location: `http://identity/admin/realms/chs/users/${subject}`,
          },
        }),
      );
    const provider = createAccountIdentity(
      {
        baseUrl: 'http://identity',
        realm: 'chs',
        clientId: 'admin-service',
        clientSecret: 'private-value',
      },
      fetcher,
    );
    expect(
      await provider.create('staff-one', 'Staff One', null, 'temporary-value'),
    ).toBe(subject);
    const body = JSON.parse(fetcher.mock.calls[1]![1].body as string);
    expect(body.enabled).toBe(false);
    expect(body.credentials[0].temporary).toBe(true);
    expect(body.requiredActions).toEqual(['UPDATE_PASSWORD']);
    expect(body.realmRoles).toBeUndefined();
    expect(body.clientRoles).toBeUndefined();
    expect(temporaryPassword()).not.toBe(temporaryPassword());
  });
  it('returns a safe conflict code and never includes credentials in errors', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'test-token' })),
      )
      .mockResolvedValueOnce(
        new Response('private server diagnostics', { status: 409 }),
      );
    const provider = createAccountIdentity(
      {
        baseUrl: 'http://identity',
        realm: 'chs',
        clientId: 'service',
        clientSecret: 'private-value',
      },
      fetcher,
    );
    await expect(
      provider.create('staff', 'Staff', null, 'temporary-value'),
    ).rejects.toMatchObject({
      code: 'ACCOUNT_USERNAME_UNAVAILABLE',
      statusCode: 409,
    });
  });
});
