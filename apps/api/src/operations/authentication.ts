import { createPublicKey, verify as verifySignature } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';

import type { AppConfig } from '../config.js';

const maximumTokenLength = 16_384;
const maximumJwksLength = 1_048_576;
const defaultJwksCacheMilliseconds = 300_000;
const maximumJwksCacheMilliseconds = 3_600_000;

type JsonObject = Record<string, unknown>;

export type VerifiedOperationsIdentity = Readonly<{
  issuer: string;
  subject: string;
  sessionId: string | null;
  authorizedParty: string | null;
}>;

export type OperationsTokenVerifier = Readonly<{
  verify(authorizationHeader: string | undefined): Promise<VerifiedOperationsIdentity>;
}>;

export type OperationsAuthenticationErrorCode =
  | 'OPERATIONS_TOKEN_REQUIRED'
  | 'INVALID_OPERATIONS_TOKEN'
  | 'OPERATIONS_AUTH_NOT_CONFIGURED'
  | 'OPERATIONS_IDENTITY_PROVIDER_UNAVAILABLE';

export class OperationsAuthenticationError extends Error {
  constructor(
    readonly code: OperationsAuthenticationErrorCode,
    readonly statusCode: 401 | 503,
  ) {
    super('Operations authentication failed');
    this.name = 'OperationsAuthenticationError';
  }
}

type VerifierDependencies = Readonly<{
  fetch: typeof fetch;
  now: () => Date;
}>;

type CachedJwks = Readonly<{
  expiresAt: number;
  keys: ReadonlyMap<string, KeyObject>;
}>;

function invalidToken(): OperationsAuthenticationError {
  return new OperationsAuthenticationError('INVALID_OPERATIONS_TOKEN', 401);
}

function jsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeJsonSegment(segment: string): JsonObject {
  try {
    const decoded = Buffer.from(segment, 'base64url').toString('utf8');
    const value: unknown = JSON.parse(decoded);
    if (!jsonObject(value)) throw invalidToken();
    return value;
  } catch (error) {
    if (error instanceof OperationsAuthenticationError) throw error;
    throw invalidToken();
  }
}

function bearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader) {
    throw new OperationsAuthenticationError('OPERATIONS_TOKEN_REQUIRED', 401);
  }
  const match = /^Bearer ([^\s]+)$/i.exec(authorizationHeader);
  const token = match?.[1];
  if (!token || token.length > maximumTokenLength) throw invalidToken();
  return token;
}

function cacheMilliseconds(cacheControl: string | null): number {
  const maxAge = /(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/i.exec(cacheControl ?? '')?.[1];
  if (!maxAge) return defaultJwksCacheMilliseconds;
  return Math.min(Number(maxAge) * 1_000, maximumJwksCacheMilliseconds);
}

function stringClaim(value: unknown, maximumLength: number): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength
    ? value
    : null;
}

function audienceMatches(value: unknown, expected: string): boolean {
  if (typeof value === 'string') return value === expected;
  return (
    Array.isArray(value) &&
    value.every((candidate) => typeof candidate === 'string') &&
    value.includes(expected)
  );
}

function numericDate(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

export function createDisabledOperationsTokenVerifier(): OperationsTokenVerifier {
  return {
    async verify() {
      throw new OperationsAuthenticationError(
        'OPERATIONS_AUTH_NOT_CONFIGURED',
        503,
      );
    },
  };
}

export function createOidcOperationsTokenVerifier(
  configuration: NonNullable<AppConfig['operationsOidc']>,
  dependencies: VerifierDependencies = { fetch, now: () => new Date() },
): OperationsTokenVerifier {
  let cache: CachedJwks | null = null;
  let pendingRefresh: Promise<CachedJwks> | null = null;

  async function refreshJwks(): Promise<CachedJwks> {
    if (pendingRefresh) return pendingRefresh;
    pendingRefresh = (async () => {
      try {
        const response = await dependencies.fetch(configuration.jwksUrl, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) throw new Error('JWKS response was unsuccessful');
        const body = await response.text();
        if (body.length > maximumJwksLength) throw new Error('JWKS is too large');
        const parsed: unknown = JSON.parse(body);
        if (!jsonObject(parsed) || !Array.isArray(parsed.keys)) {
          throw new Error('JWKS body is invalid');
        }
        const keys = new Map<string, KeyObject>();
        for (const candidate of parsed.keys) {
          if (
            !jsonObject(candidate) ||
            candidate.kty !== 'RSA' ||
            typeof candidate.kid !== 'string' ||
            candidate.kid.length === 0 ||
            candidate.kid.length > 200 ||
            (candidate.alg !== undefined && candidate.alg !== 'RS256') ||
            (candidate.use !== undefined && candidate.use !== 'sig')
          ) {
            continue;
          }
          try {
            keys.set(
              candidate.kid,
              createPublicKey({
                key: candidate as unknown as JsonWebKey,
                format: 'jwk',
              }),
            );
          } catch {
            // A malformed key is ignored; the set must still contain a usable key.
          }
        }
        if (keys.size === 0) throw new Error('JWKS has no usable RS256 keys');
        cache = {
          keys,
          expiresAt:
            dependencies.now().getTime() +
            cacheMilliseconds(response.headers.get('cache-control')),
        };
        return cache;
      } catch {
        throw new OperationsAuthenticationError(
          'OPERATIONS_IDENTITY_PROVIDER_UNAVAILABLE',
          503,
        );
      } finally {
        pendingRefresh = null;
      }
    })();
    return pendingRefresh;
  }

  async function keyFor(kid: string): Promise<KeyObject> {
    const now = dependencies.now().getTime();
    let current = cache;
    if (!current || current.expiresAt <= now) current = await refreshJwks();
    const key = current.keys.get(kid);
    if (!key) throw invalidToken();
    return key;
  }

  return {
    async verify(authorizationHeader) {
      const token = bearerToken(authorizationHeader);
      const segments = token.split('.');
      if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
        throw invalidToken();
      }
      const [encodedHeader, encodedPayload, encodedSignature] = segments as [
        string,
        string,
        string,
      ];
      if (!segments.every((segment) => /^[A-Za-z0-9_-]+$/.test(segment))) {
        throw invalidToken();
      }
      const header = decodeJsonSegment(encodedHeader);
      const payload = decodeJsonSegment(encodedPayload);
      if (
        header.alg !== 'RS256' ||
        header.crit !== undefined ||
        header.b64 === false
      ) {
        throw invalidToken();
      }
      const kid = stringClaim(header.kid, 200);
      if (!kid) throw invalidToken();
      const key = await keyFor(kid);

      let signature: Buffer;
      try {
        signature = Buffer.from(encodedSignature, 'base64url');
      } catch {
        throw invalidToken();
      }
      let verified = false;
      try {
        verified = verifySignature(
          'RSA-SHA256',
          Buffer.from(`${encodedHeader}.${encodedPayload}`),
          key,
          signature,
        );
      } catch {
        throw invalidToken();
      }
      if (!verified) throw invalidToken();

      const now = Math.floor(dependencies.now().getTime() / 1_000);
      const tolerance = configuration.clockToleranceSeconds;
      const subject = stringClaim(payload.sub, 255);
      const expiresAt = numericDate(payload.exp);
      const notBefore = payload.nbf === undefined ? null : numericDate(payload.nbf);
      const issuedAt = payload.iat === undefined ? null : numericDate(payload.iat);
      if (
        payload.iss !== configuration.issuer ||
        !audienceMatches(payload.aud, configuration.audience) ||
        !subject ||
        expiresAt === null ||
        expiresAt <= now - tolerance ||
        (payload.nbf !== undefined && (notBefore === null || notBefore > now + tolerance)) ||
        (payload.iat !== undefined && (issuedAt === null || issuedAt > now + tolerance))
      ) {
        throw invalidToken();
      }

      return {
        issuer: configuration.issuer,
        subject,
        sessionId: stringClaim(payload.sid, 255),
        authorizedParty: stringClaim(payload.azp, 255),
      };
    },
  };
}
