import { randomBytes } from 'node:crypto';
import { AccountIdentityError } from '../administration/account-identity.js';
export type ProviderIdentity = {
  create(
    clientId: string,
  ): Promise<{ identityClientId: string; subject: string; secret: string }>;
  rotate(identityClientId: string): Promise<string>;
  revoke(identityClientId: string): Promise<void>;
  remove(identityClientId: string): Promise<void>;
};
export function createProviderIdentity(
  config: {
    baseUrl: string;
    realm: string;
    clientId: string;
    clientSecret: string;
  },
  fetcher: typeof fetch = fetch,
): ProviderIdentity {
  const realm = encodeURIComponent(config.realm);
  async function call(path: string, method = 'GET', body?: unknown) {
    try {
      const token = await fetcher(
        `${config.baseUrl}/realms/${realm}/protocol/openid-connect/token`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: config.clientId,
            client_secret: config.clientSecret,
          }),
        },
      );
      if (!token.ok) throw new AccountIdentityError();
      const data = (await token.json()) as { access_token: string };
      const r = await fetcher(
        `${config.baseUrl}/admin/realms/${realm}/${path}`,
        {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
          headers: {
            authorization: `Bearer ${data.access_token}`,
            'content-type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      if (!r.ok)
        throw new AccountIdentityError('PROVIDER_IDENTITY_UNAVAILABLE');
      return r;
    } catch {
      throw new AccountIdentityError('PROVIDER_IDENTITY_UNAVAILABLE');
    }
  }
  const json = async (path: string) =>
    (await (await call(path)).json()) as Record<string, unknown>;
  return {
    async create(clientId) {
      const secret = randomBytes(32).toString('base64url');
      const r = await call('clients', 'POST', {
        clientId,
        enabled: false,
        protocol: 'openid-connect',
        publicClient: false,
        standardFlowEnabled: false,
        directAccessGrantsEnabled: false,
        implicitFlowEnabled: false,
        serviceAccountsEnabled: true,
        fullScopeAllowed: false,
        secret,
        defaultClientScopes: [],
        attributes: { 'access.token.lifespan': '300' },
        protocolMappers: [
          {
            name: 'chs-provider-audience',
            protocol: 'openid-connect',
            protocolMapper: 'oidc-audience-mapper',
            config: {
              'included.custom.audience': 'chs-operations-api',
              'access.token.claim': 'true',
              'id.token.claim': 'false',
            },
          },
        ],
      });
      const id = r.headers.get('location')?.split('/').at(-1);
      if (!id || !/^[a-f0-9-]{36}$/i.test(id))
        throw new AccountIdentityError('PROVIDER_IDENTITY_UNAVAILABLE');
      try {
        const user = await json(`clients/${id}/service-account-user`);
        if (typeof user.id !== 'string') throw new AccountIdentityError();
        // No Keycloak administrative roles or CHS operations-user grants are assigned.
        await call(`clients/${id}`, 'PUT', { enabled: true });
        return { identityClientId: id, subject: user.id, secret };
      } catch (error) {
        try {
          await call(`clients/${id}`, 'DELETE');
        } catch {}
        throw error;
      }
    },
    async rotate(id) {
      const r = await call(
        `clients/${encodeURIComponent(id)}/client-secret`,
        'POST',
      );
      const d = (await r.json()) as { value: string };
      if (!d.value) throw new AccountIdentityError();
      return d.value;
    },
    async revoke(id) {
      await call(`clients/${encodeURIComponent(id)}`, 'PUT', {
        enabled: false,
      });
    },
    async remove(id) {
      await call(`clients/${encodeURIComponent(id)}`, 'DELETE');
    },
  };
}
