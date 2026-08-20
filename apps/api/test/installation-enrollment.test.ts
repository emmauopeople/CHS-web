import { describe, expect, it } from 'vitest';

import {
  generateInstallationToken,
  parseDesktopInstallationEnrollmentInput,
} from '../src/administration/installation-enrollment.js';

const now = new Date('2026-08-19T12:00:00.000Z');
const validInput = {
  installationId: '20000000-0000-4000-8000-000000000011',
  organizationId: '10000000-0000-4000-8000-000000000011',
  configuredLocationId: '30000000-0000-4000-8000-000000000011',
  sourceLocationId: '32000000-0000-4000-8000-000000000011',
  deploymentName: '  Bafoussam screening desktop  ',
  timezone: 'Africa/Douala',
  credentialLabel: '  Initial enrollment  ',
  credentialExpiresAt: '2027-08-19T12:00:00+00:00',
  operatorIdentifier: '  platform-admin@example.test  ',
  reasonCode: 'INITIAL_ENROLLMENT',
};

describe('desktop installation enrollment', () => {
  it('generates 256-bit base64url installation credentials', () => {
    const first = generateInstallationToken();
    const second = generateInstallationToken();

    expect(first).toMatch(/^chs_inst_v1_[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^chs_inst_v1_[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
  });

  it('validates and normalizes controlled enrollment input', () => {
    expect(parseDesktopInstallationEnrollmentInput(validInput, now)).toEqual({
      ...validInput,
      deploymentName: 'Bafoussam screening desktop',
      credentialLabel: 'Initial enrollment',
      credentialExpiresAt: '2027-08-19T12:00:00.000Z',
      operatorIdentifier: 'platform-admin@example.test',
    });
  });

  it.each([
    [{ ...validInput, installationId: 'not-a-uuid' }, 'valid UUID'],
    [{ ...validInput, timezone: 'Africa/Not_A_Zone' }, 'IANA timezone'],
    [{ ...validInput, reasonCode: 'initial enrollment' }, 'upper snake case'],
    [{ ...validInput, credentialExpiresAt: 'August 20, 2027' }, 'ISO 8601'],
    [{ ...validInput, unexpected: true }, 'Unexpected enrollment field'],
    [
      { ...validInput, credentialExpiresAt: '2026-08-19T11:59:59Z' },
      'later than the issuance time',
    ],
  ])('rejects unsafe enrollment input', (input, message) => {
    expect(() => parseDesktopInstallationEnrollmentInput(input, now)).toThrow(
      message,
    );
  });
});
