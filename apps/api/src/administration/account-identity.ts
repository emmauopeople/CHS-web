import { randomBytes } from 'node:crypto';

export class AccountIdentityError extends Error {
  constructor(
    readonly code = 'IDENTITY_SERVICE_UNAVAILABLE',
    readonly statusCode = 503,
  ) {
    super(code);
  }
}

export type AccountIdentity = {
  create(
    username: string,
    displayName: string,
    email: string | null,
    password: string,
  ): Promise<string>;
  enable(subject: string, enabled: boolean): Promise<void>;
  resetPassword(subject: string, password: string): Promise<void>;
  remove(subject: string): Promise<void>;
};

export const temporaryPassword = () =>
  `${randomBytes(24).toString('base64url')}aA1!`;

export function createAccountIdentity(
  config: {
    baseUrl: string;
    realm: string;
    clientId: string;
    clientSecret: string;
  },
  fetcher: typeof fetch = fetch,
): AccountIdentity {
  const realm = encodeURIComponent(config.realm);
  async function request(path: string, method: string, body?: unknown) {
    // Credentials and responses are deliberately excluded from exception messages and logs.
    try {
      const tokenResponse = await fetcher(
        `${config.baseUrl}/realms/${realm}/protocol/openid-connect/token`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: config.clientId,
            client_secret: config.clientSecret,
          }),
        },
      );
      if (!tokenResponse.ok) throw new AccountIdentityError();
      const token = (await tokenResponse.json()) as { access_token?: string };
      if (!token.access_token) throw new AccountIdentityError();
      const response = await fetcher(
        `${config.baseUrl}/admin/realms/${realm}/${path}`,
        {
          method,
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
          headers: {
            authorization: `Bearer ${token.access_token}`,
            'content-type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      if (response.status === 409)
        throw new AccountIdentityError('ACCOUNT_USERNAME_UNAVAILABLE', 409);
      if (!response.ok) throw new AccountIdentityError();
      return response;
    } catch (error) {
      if (error instanceof AccountIdentityError) throw error;
      throw new AccountIdentityError();
    }
  }
  const userPath = (subject: string) => `users/${encodeURIComponent(subject)}`;
  return {
    async create(username, displayName, email, password) {
      const response = await request('users', 'POST', {
        username,
        firstName: displayName,
        ...(email ? { email } : {}),
        enabled: false,
        emailVerified: false,
        requiredActions: ['UPDATE_PASSWORD'],
        credentials: [{ type: 'password', value: password, temporary: true }],
      });
      const subject = response.headers.get('location')?.split('/').at(-1);
      if (!subject || !/^[a-f0-9-]{36}$/i.test(subject))
        throw new AccountIdentityError();
      return subject;
    },
    async enable(subject, enabled) {
      await request(userPath(subject), 'PUT', { enabled });
      if (!enabled) await request(`${userPath(subject)}/logout`, 'POST');
    },
    async resetPassword(subject, password) {
      await request(`${userPath(subject)}/reset-password`, 'PUT', {
        type: 'password',
        value: password,
        temporary: true,
      });
      await request(`${userPath(subject)}/logout`, 'POST');
    },
    async remove(subject) {
      await request(userPath(subject), 'DELETE');
    },
  };
}
