export type AppConfig = Readonly<{
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  databasePoolMax: number;
  buildCommit: string;
  buildTime: string;
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

  return {
    nodeEnv: nodeEnv as AppConfig['nodeEnv'],
    host: environment.HOST?.trim() || '0.0.0.0',
    port: integer(environment, 'PORT', 3000),
    logLevel: environment.LOG_LEVEL?.trim() || 'info',
    databaseUrl: required(environment, 'DATABASE_URL'),
    databasePoolMax: integer(environment, 'DATABASE_POOL_MAX', 10),
    buildCommit: environment.BUILD_COMMIT?.trim() || 'local',
    buildTime: environment.BUILD_TIME?.trim() || 'unknown',
  };
}
