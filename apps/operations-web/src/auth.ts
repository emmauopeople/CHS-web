import type { OperationsWebConfig } from './config';

const transactionKey = 'chs.operations.oidc.transaction';
const sessionKey = 'chs.operations.session';

type AuthorizationTransaction = Readonly<{
  state: string;
  codeVerifier: string;
  createdAt: number;
}>;

export type AuthSession = Readonly<{
  accessToken: string;
  expiresAt: number;
}>;

type TokenResponse = Readonly<{
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
}>;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function randomValue(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function getAuthSession(now = Date.now()): AuthSession | null {
  const stored = parseJson<Partial<AuthSession>>(sessionStorage.getItem(sessionKey));
  if (
    typeof stored?.accessToken !== 'string' ||
    stored.accessToken.length === 0 ||
    stored.accessToken.length > 16_384 ||
    typeof stored.expiresAt !== 'number' ||
    !Number.isSafeInteger(stored.expiresAt) ||
    stored.expiresAt <= now + 30_000
  ) {
    sessionStorage.removeItem(sessionKey);
    return null;
  }
  return { accessToken: stored.accessToken, expiresAt: stored.expiresAt };
}

export function clearAuthSession(): void {
  sessionStorage.removeItem(sessionKey);
  sessionStorage.removeItem(transactionKey);
}

export async function startSignIn(
  config: OperationsWebConfig['oidc'],
): Promise<void> {
  const state = randomValue(32);
  const codeVerifier = randomValue(64);
  const transaction: AuthorizationTransaction = {
    state,
    codeVerifier,
    createdAt: Date.now(),
  };
  sessionStorage.setItem(transactionKey, JSON.stringify(transaction));

  const authorizationUrl = new URL(config.authorizationEndpoint);
  authorizationUrl.searchParams.set('client_id', config.clientId);
  authorizationUrl.searchParams.set('redirect_uri', config.redirectUri);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('scope', config.scope);
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set(
    'code_challenge',
    await codeChallenge(codeVerifier),
  );
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  window.location.assign(authorizationUrl);
}

function readTransaction(now = Date.now()): AuthorizationTransaction | null {
  const transaction = parseJson<Partial<AuthorizationTransaction>>(
    sessionStorage.getItem(transactionKey),
  );
  if (
    typeof transaction?.state !== 'string' ||
    typeof transaction.codeVerifier !== 'string' ||
    typeof transaction.createdAt !== 'number' ||
    transaction.createdAt < now - 10 * 60 * 1_000 ||
    transaction.createdAt > now + 30_000
  ) {
    return null;
  }
  return transaction as AuthorizationTransaction;
}

export function hasAuthorizationResponse(location: Location = window.location): boolean {
  const query = new URLSearchParams(location.search);
  return query.has('code') || query.has('error');
}

export async function completeSignIn(
  config: OperationsWebConfig['oidc'],
  location: Location = window.location,
  fetchImplementation: typeof fetch = fetch,
): Promise<AuthSession> {
  const query = new URLSearchParams(location.search);
  const error = query.get('error');
  if (error) throw new Error('The identity provider did not complete sign-in');
  const code = query.get('code');
  const state = query.get('state');
  const transaction = readTransaction();
  sessionStorage.removeItem(transactionKey);
  if (!code || code.length > 4_096 || !state || state !== transaction?.state) {
    throw new Error('The sign-in response could not be verified');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code,
    code_verifier: transaction.codeVerifier,
    redirect_uri: config.redirectUri,
  });
  const response = await fetchImplementation(config.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    credentials: 'omit',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('The identity provider rejected sign-in');
  const token = (await response.json()) as TokenResponse;
  if (
    typeof token.access_token !== 'string' ||
    token.access_token.length === 0 ||
    token.access_token.length > 16_384 ||
    typeof token.token_type !== 'string' ||
    token.token_type.toLowerCase() !== 'bearer' ||
    typeof token.expires_in !== 'number' ||
    !Number.isSafeInteger(token.expires_in) ||
    token.expires_in < 60 ||
    token.expires_in > 86_400
  ) {
    throw new Error('The identity provider returned an invalid token response');
  }
  const session = {
    accessToken: token.access_token,
    expiresAt: Date.now() + token.expires_in * 1_000,
  };
  sessionStorage.setItem(sessionKey, JSON.stringify(session));
  return session;
}

export function finishAuthorizationNavigation(): void {
  window.history.replaceState(null, '', window.location.pathname);
}

export function signOut(config: OperationsWebConfig['oidc']): void {
  clearAuthSession();
  if (!config.endSessionEndpoint) {
    window.location.reload();
    return;
  }
  const url = new URL(config.endSessionEndpoint);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('post_logout_redirect_uri', config.redirectUri);
  window.location.assign(url);
}
