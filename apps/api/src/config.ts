export type AppConfig = Readonly<{
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  databasePoolMax: number;
  buildCommit: string;
  buildTime: string;
  trustedProxyCidrs: readonly string[];
  operationsOidc: null | Readonly<{
    issuer: string;
    audience: string;
    jwksUrl: string;
    clockToleranceSeconds: number;
  }>;
}>;

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function integer(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;

  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const nodeEnv = environment.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }

  const trustedProxyCidrs = (environment.TRUSTED_PROXY_CIDRS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (trustedProxyCidrs.length > 20) {
    throw new Error('TRUSTED_PROXY_CIDRS must contain at most 20 entries');
  }

  const oidcIssuer = environment.OPERATIONS_OIDC_ISSUER?.trim() || null;
  const oidcAudience = environment.OPERATIONS_OIDC_AUDIENCE?.trim() || null;
  const oidcJwksUrl = environment.OPERATIONS_OIDC_JWKS_URL?.trim() || null;
  const configuredOidcValues = [oidcIssuer, oidcAudience, oidcJwksUrl].filter(
    (value) => value !== null,
  ).length;
  if (configuredOidcValues !== 0 && configuredOidcValues !== 3) {
    throw new Error(
      'OPERATIONS_OIDC_ISSUER, OPERATIONS_OIDC_AUDIENCE, and OPERATIONS_OIDC_JWKS_URL must be configured together',
    );
  }

  let operationsOidc: AppConfig['operationsOidc'] = null;
  if (oidcIssuer && oidcAudience && oidcJwksUrl) {
    const issuerUrl = new URL(oidcIssuer);
    const jwksUrl = new URL(oidcJwksUrl);
    if (
      nodeEnv === 'production' &&
      (issuerUrl.protocol !== 'https:' || jwksUrl.protocol !== 'https:')
    ) {
      throw new Error('Operations OIDC URLs must use HTTPS in production');
    }
    operationsOidc = {
      issuer: issuerUrl.href,
      audience: oidcAudience,
      jwksUrl: jwksUrl.href,
      clockToleranceSeconds: integer(
        environment,
        'OPERATIONS_OIDC_CLOCK_TOLERANCE_SECONDS',
        30,
      ),
    };
  }

  return {
    nodeEnv: nodeEnv as AppConfig['nodeEnv'],
    host: environment.HOST?.trim() || '0.0.0.0',
    port: integer(environment, 'PORT', 3000),
    logLevel: environment.LOG_LEVEL?.trim() || 'info',
    databaseUrl: required(environment, 'DATABASE_URL'),
    databasePoolMax: integer(environment, 'DATABASE_POOL_MAX', 10),
    buildCommit: environment.BUILD_COMMIT?.trim() || 'local',
    buildTime: environment.BUILD_TIME?.trim() || 'unknown',
    trustedProxyCidrs,
    operationsOidc,
  };
}
