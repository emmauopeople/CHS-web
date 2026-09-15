export type OperationsWebConfig = Readonly<{
  apiBaseUrl: string;
  oidc: Readonly<{
    authorizationEndpoint: string;
    tokenEndpoint: string;
    endSessionEndpoint: string | null;
    clientId: string;
    scope: string;
    redirectUri: string;
  }>;
}>;

export class LocalPortalAddressError extends Error {
  readonly portalUrl = 'http://127.0.0.1:4173/';
  constructor() {
    super('Open the registered local portal address before signing in.');
  }
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function absoluteHttpsUrl(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  const localhost = ['localhost', '127.0.0.1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(import.meta.env.DEV && localhost)) {
    throw new Error(`${name} must use HTTPS`);
  }
  return parsed.toString();
}

export function loadConfig(location: Location = window.location): OperationsWebConfig {
  const authorizationEndpoint = absoluteHttpsUrl(
    required(
      import.meta.env.VITE_OPERATIONS_OIDC_AUTHORIZATION_ENDPOINT,
      'VITE_OPERATIONS_OIDC_AUTHORIZATION_ENDPOINT',
    ),
    'VITE_OPERATIONS_OIDC_AUTHORIZATION_ENDPOINT',
  );
  const tokenEndpoint = absoluteHttpsUrl(
    required(
      import.meta.env.VITE_OPERATIONS_OIDC_TOKEN_ENDPOINT,
      'VITE_OPERATIONS_OIDC_TOKEN_ENDPOINT',
    ),
    'VITE_OPERATIONS_OIDC_TOKEN_ENDPOINT',
  );
  if (
    import.meta.env.DEV &&
    authorizationEndpoint === 'http://127.0.0.1:18080/realms/chs-local/protocol/openid-connect/auth' &&
    `${location.origin}${location.pathname}` !== 'http://127.0.0.1:4173/'
  ) {
    // Do not send a callback to another origin: the PKCE transaction is kept
    // in this origin's sessionStorage. Let the user open the correct origin first.
    throw new LocalPortalAddressError();
  }
  const endSessionValue =
    import.meta.env.VITE_OPERATIONS_OIDC_END_SESSION_ENDPOINT?.trim();
  const apiBaseUrl = import.meta.env.VITE_CHS_API_BASE_URL?.trim() ?? '';
  if (apiBaseUrl) absoluteHttpsUrl(apiBaseUrl, 'VITE_CHS_API_BASE_URL');

  return {
    apiBaseUrl: apiBaseUrl.replace(/\/$/, ''),
    oidc: {
      authorizationEndpoint,
      tokenEndpoint,
      endSessionEndpoint: endSessionValue
        ? absoluteHttpsUrl(
            endSessionValue,
            'VITE_OPERATIONS_OIDC_END_SESSION_ENDPOINT',
          )
        : null,
      clientId: required(
        import.meta.env.VITE_OPERATIONS_OIDC_CLIENT_ID,
        'VITE_OPERATIONS_OIDC_CLIENT_ID',
      ),
      scope:
        import.meta.env.VITE_OPERATIONS_OIDC_SCOPE?.trim() ||
        'openid profile',
      redirectUri: `${location.origin}${location.pathname}`,
    },
  };
}
