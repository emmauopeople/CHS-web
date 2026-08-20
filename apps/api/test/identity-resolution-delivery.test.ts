import { describe, expect, it, vi } from 'vitest';

import {
  acknowledgeIdentityResolution,
  pullPendingIdentityResolutions,
} from '../src/sync/identity-resolution-delivery.js';

const installation = {
  installationId: '10000000-0000-4000-8000-000000000001',
  organizationId: '20000000-0000-4000-8000-000000000001',
  configuredLocationId: '30000000-0000-4000-8000-000000000001',
  timezone: 'Africa/Douala',
};

describe('identity resolution delivery validation', () => {
  it.each([0, 101, 1.5])(
    'rejects invalid pull limit %s before acquiring PostgreSQL',
    async (limit) => {
      const database = { connect: vi.fn() };

      await expect(
        pullPendingIdentityResolutions(database as never, installation, limit),
      ).rejects.toMatchObject({
        code: 'INVALID_IDENTITY_RESOLUTION_LIMIT',
        statusCode: 400,
      });
      expect(database.connect).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      contractVersion: '2.0',
      acknowledgmentId: '40000000-0000-4000-8000-000000000001',
      resolutionReference: '50000000-0000-4000-8000-000000000001',
      appliedAt: '2026-08-20T12:00:00.000Z',
    },
    {
      contractVersion: '1.0',
      acknowledgmentId: 'bad',
      resolutionReference: '50000000-0000-4000-8000-000000000001',
      appliedAt: '2026-08-20T12:00:00.000Z',
    },
    {
      contractVersion: '1.0',
      acknowledgmentId: '40000000-0000-4000-8000-000000000001',
      resolutionReference: 'bad',
      appliedAt: '2026-08-20T12:00:00.000Z',
    },
    {
      contractVersion: '1.0',
      acknowledgmentId: '40000000-0000-4000-8000-000000000001',
      resolutionReference: '50000000-0000-4000-8000-000000000001',
      appliedAt: '2026-08-20',
    },
  ])('rejects malformed acknowledgment before acquiring PostgreSQL', async (input) => {
    const database = { connect: vi.fn() };

    await expect(
      acknowledgeIdentityResolution(
        database as never,
        installation,
        input as never,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_IDENTITY_RESOLUTION_ACKNOWLEDGMENT',
      statusCode: 400,
    });
    expect(database.connect).not.toHaveBeenCalled();
  });
});
