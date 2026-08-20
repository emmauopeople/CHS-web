import { describe, expect, it } from 'vitest';

import {
  parseRevokeInstallationCredentialInput,
  parseRotateInstallationCredentialInput,
} from '../src/administration/installation-credential-lifecycle.js';

const now = new Date('2026-08-19T12:00:00.000Z');
const rotationInput = {
  installationId: '20000000-0000-4000-8000-000000000081',
  expectedCredentialId: '21000000-0000-4000-8000-000000000081',
  credentialLabel: '  Scheduled replacement  ',
  credentialExpiresAt: '2027-08-19T12:00:00+00:00',
  operatorIdentifier: '  platform-admin@example.test  ',
  reasonCode: 'SCHEDULED_ROTATION',
};
const revocationInput = {
  installationId: '20000000-0000-4000-8000-000000000081',
  credentialId: '21000000-0000-4000-8000-000000000082',
  operatorIdentifier: 'platform-admin@example.test',
  reasonCode: 'DEVICE_RETIRED',
  confirmation: 'REVOKE_INSTALLATION_CREDENTIAL',
};

describe('installation credential lifecycle input', () => {
  it('normalizes a guarded rotation request', () => {
    expect(parseRotateInstallationCredentialInput(rotationInput, now)).toEqual({
      ...rotationInput,
      credentialLabel: 'Scheduled replacement',
      credentialExpiresAt: '2027-08-19T12:00:00.000Z',
      operatorIdentifier: 'platform-admin@example.test',
    });
  });

  it('requires an explicit destructive confirmation for revocation', () => {
    expect(parseRevokeInstallationCredentialInput(revocationInput)).toEqual(
      revocationInput,
    );
    expect(() =>
      parseRevokeInstallationCredentialInput({
        ...revocationInput,
        confirmation: 'yes',
      }),
    ).toThrow('confirmation must be exactly');
  });

  it.each([
    [{ ...rotationInput, expectedCredentialId: 'unknown' }, 'valid UUID'],
    [{ ...rotationInput, credentialExpiresAt: 'August 20, 2027' }, 'ISO 8601'],
    [
      { ...rotationInput, credentialExpiresAt: '2026-08-19T12:00:00Z' },
      'later than the issuance time',
    ],
    [{ ...rotationInput, reasonCode: 'scheduled rotation' }, 'upper snake case'],
    [{ ...rotationInput, unknown: true }, 'Unexpected rotation field'],
  ])('rejects unsafe rotation input', (input, message) => {
    expect(() => parseRotateInstallationCredentialInput(input, now)).toThrow(
      message,
    );
  });
});
