import { describe, expect, it } from 'vitest';

import { parseOperationsAccessProvisioningInput } from '../src/administration/operations-access-provisioning.js';

const now = new Date('2026-08-20T12:00:00.000Z');
const organizationId = '10000000-0000-4000-8000-000000000101';
const validInput = {
  oidcIssuer: ' https://identity.example.test ',
  oidcSubject: ' operations-user-101 ',
  displayName: ' Operations Nurse ',
  email: ' Nurse.Operations@Example.Test ',
  grants: [
    {
      permissionCode: 'SYNC_MONITOR',
      scopeKind: 'ORGANIZATION',
      organizationId,
      expiresAt: null,
    },
    {
      permissionCode: 'PATIENT_READ',
      scopeKind: 'GLOBAL',
      organizationId: null,
      expiresAt: '2027-08-20T12:00:00+00:00',
    },
  ],
  operatorIdentifier: ' platform-admin@example.test ',
  reasonCode: ' INITIAL_ACCESS ',
};

describe('operations access provisioning input', () => {
  it('normalizes the OIDC principal and deterministically orders grants', () => {
    expect(parseOperationsAccessProvisioningInput(validInput, now)).toEqual({
      oidcIssuer: 'https://identity.example.test/',
      oidcSubject: 'operations-user-101',
      displayName: 'Operations Nurse',
      email: 'nurse.operations@example.test',
      grants: [
        {
          permissionCode: 'PATIENT_READ',
          scopeKind: 'GLOBAL',
          organizationId: null,
          expiresAt: '2027-08-20T12:00:00.000Z',
        },
        {
          permissionCode: 'SYNC_MONITOR',
          scopeKind: 'ORGANIZATION',
          organizationId,
          expiresAt: null,
        },
      ],
      operatorIdentifier: 'platform-admin@example.test',
      reasonCode: 'INITIAL_ACCESS',
    });
  });

  it.each([
    [{ ...validInput, oidcIssuer: 'http://identity.example.test' }, 'absolute HTTPS'],
    [{ ...validInput, email: 'not-an-email' }, 'valid bounded address'],
    [
      {
        ...validInput,
        grants: [{ ...validInput.grants[0], permissionCode: 'AUDIT_READ' }],
      },
      'permissionCode must be',
    ],
    [
      {
        ...validInput,
        grants: [
          validInput.grants[0],
          { ...validInput.grants[0] },
        ],
      },
      'duplicate scopes',
    ],
    [
      {
        ...validInput,
        grants: [
          validInput.grants[1],
          {
            ...validInput.grants[1],
            scopeKind: 'ORGANIZATION',
            organizationId,
          },
        ],
      },
      'cannot mix global and organization scopes',
    ],
    [
      {
        ...validInput,
        grants: [{ ...validInput.grants[1], organizationId }],
      },
      'GLOBAL grants require organizationId to be null',
    ],
    [
      {
        ...validInput,
        grants: [
          {
            ...validInput.grants[0],
            expiresAt: '2026-08-20T12:00:00Z',
          },
        ],
      },
      'must be in the future',
    ],
    [{ ...validInput, unexpected: true }, 'Unexpected operations access field'],
  ])('rejects unsafe operations access input', (input, message) => {
    expect(() => parseOperationsAccessProvisioningInput(input, now)).toThrow(
      message,
    );
  });
});
