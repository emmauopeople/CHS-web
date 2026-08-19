import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

import type { InstallationContext } from './types.js';

const tokenPattern = /^chs_inst_v1_[A-Za-z0-9_-]{43}$/;

type AuthenticationDatabase = Pick<Pool, 'query'>;

type InstallationRow = Readonly<{
  installation_id: string;
  organization_id: string;
  configured_location_id: string;
  timezone: string;
}>;

export type InstallationAuthenticationErrorCode =
  | 'INSTALLATION_TOKEN_REQUIRED'
  | 'INVALID_INSTALLATION_TOKEN';

export class InstallationAuthenticationError extends Error {
  readonly statusCode = 401;

  constructor(readonly code: InstallationAuthenticationErrorCode) {
    super('Installation authentication failed');
    this.name = 'InstallationAuthenticationError';
  }
}

export function extractInstallationToken(
  authorizationHeader: string | undefined,
): string {
  if (!authorizationHeader) {
    throw new InstallationAuthenticationError('INSTALLATION_TOKEN_REQUIRED');
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorizationHeader);
  const token = match?.[1];
  if (!token || !tokenPattern.test(token)) {
    throw new InstallationAuthenticationError('INVALID_INSTALLATION_TOKEN');
  }

  return token;
}

export function installationTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function installationTokenPrefix(token: string): string {
  return token.slice(0, 20);
}

export async function authenticateInstallation(
  database: AuthenticationDatabase,
  authorizationHeader: string | undefined,
  now: Date = new Date(),
): Promise<InstallationContext> {
  const token = extractInstallationToken(authorizationHeader);
  const result = await database.query<InstallationRow>(
    `SELECT
       installation.id AS installation_id,
       installation.organization_id,
       installation.configured_location_id,
       installation.timezone
     FROM desktop_installation_credentials AS credential
     JOIN desktop_installations AS installation
       ON installation.id = credential.installation_id
     WHERE credential.token_hash = $1
       AND credential.token_prefix = $2
       AND credential.status = 'ACTIVE'
       AND credential.revoked_at IS NULL
       AND (credential.expires_at IS NULL OR credential.expires_at > $3)
       AND installation.status = 'ACTIVE'`,
    [installationTokenHash(token), installationTokenPrefix(token), now.toISOString()],
  );

  const row = result.rows[0];
  if (!row) {
    throw new InstallationAuthenticationError('INVALID_INSTALLATION_TOKEN');
  }

  return {
    installationId: row.installation_id,
    organizationId: row.organization_id,
    configuredLocationId: row.configured_location_id,
    timezone: row.timezone,
  };
}
