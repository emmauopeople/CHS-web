import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  authenticateInstallation,
  extractInstallationToken,
  InstallationAuthenticationError,
  installationTokenHash,
  installationTokenPrefix,
} from '../src/sync/installation-auth.js';

const token = `chs_inst_v1_${'A'.repeat(43)}`;

describe('desktop installation authentication', () => {
  it('extracts only a strict opaque bearer token', () => {
    expect(extractInstallationToken(`Bearer ${token}`)).toBe(token);
    expect(extractInstallationToken(`bearer ${token}`)).toBe(token);
    expect(() => extractInstallationToken(undefined)).toThrowError(
      InstallationAuthenticationError,
    );
    expect(() => extractInstallationToken('Bearer not-valid')).toThrowError(
      InstallationAuthenticationError,
    );

    try {
      extractInstallationToken(undefined);
    } catch (error) {
      expect(error).toMatchObject({ code: 'INSTALLATION_TOKEN_REQUIRED' });
    }
    try {
      extractInstallationToken('Bearer not-valid');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_INSTALLATION_TOKEN' });
    }
  });

  it('derives only a non-secret prefix and SHA-256 digest for persistence', () => {
    expect(installationTokenPrefix(token)).toBe('chs_inst_v1_AAAAAAAA');
    expect(installationTokenHash(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(installationTokenHash(token)).not.toContain(token);
  });

  it('returns the active installation context without querying by raw token', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          installation_id: '20000000-0000-4000-8000-000000000001',
          organization_id: '10000000-0000-4000-8000-000000000001',
          configured_location_id: '30000000-0000-4000-8000-000000000001',
          timezone: 'Africa/Douala',
        },
      ],
    });
    const database = { query } as unknown as Pick<Pool, 'query'>;

    await expect(
      authenticateInstallation(
        database,
        `Bearer ${token}`,
        new Date('2026-08-19T12:00:00.000Z'),
      ),
    ).resolves.toEqual({
      installationId: '20000000-0000-4000-8000-000000000001',
      organizationId: '10000000-0000-4000-8000-000000000001',
      configuredLocationId: '30000000-0000-4000-8000-000000000001',
      timezone: 'Africa/Douala',
    });

    expect(query).toHaveBeenCalledOnce();
    const parameters = query.mock.calls[0]?.[1] as unknown[];
    expect(parameters).toContain(installationTokenHash(token));
    expect(parameters).toContain(installationTokenPrefix(token));
    expect(parameters).not.toContain(token);
  });

  it('uses the same generic rejection for an unknown, expired, or revoked token', async () => {
    const database = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Pick<Pool, 'query'>;

    await expect(
      authenticateInstallation(database, `Bearer ${token}`),
    ).rejects.toMatchObject({ code: 'INVALID_INSTALLATION_TOKEN' });
  });
});
