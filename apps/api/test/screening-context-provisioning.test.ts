import { describe, expect, it } from 'vitest';

import { parseScreeningContextProvisioningInput } from '../src/administration/screening-context-provisioning.js';

const validInput = {
  organizationIdentifierSystem: 'https://chs.example/id/organization',
  organizationIdentifierValue: '  ORG-BAMENDA-01  ',
  organizationName: '  Northwest Screening Program  ',
  organizationTypeCode: 'SCREENING_PROGRAM',
  locationIdentifierSystem: 'urn:chs:screening-location',
  locationIdentifierValue: '  LOC-BAFOUSSAM-01  ',
  locationName: '  Bafoussam Community Site  ',
  locationTypeCode: 'SCREENING_SITE',
  physicalTypeCode: 'MOBILE',
  village: '  Bafoussam  ',
  subdivision: null,
  region: '  West  ',
  directions: null,
  operatorIdentifier: '  platform-admin@example.test  ',
  reasonCode: 'INITIAL_PROVISIONING',
};

describe('screening context provisioning input', () => {
  it('validates and normalizes canonical organization and location data', () => {
    expect(parseScreeningContextProvisioningInput(validInput)).toEqual({
      ...validInput,
      organizationIdentifierValue: 'ORG-BAMENDA-01',
      organizationName: 'Northwest Screening Program',
      locationIdentifierValue: 'LOC-BAFOUSSAM-01',
      locationName: 'Bafoussam Community Site',
      village: 'Bafoussam',
      region: 'West',
      operatorIdentifier: 'platform-admin@example.test',
    });
  });

  it.each([
    [
      { ...validInput, organizationIdentifierSystem: 'relative/path' },
      'absolute HTTPS or URN',
    ],
    [
      { ...validInput, locationIdentifierSystem: 'http://example.test/id' },
      'absolute HTTPS or URN',
    ],
    [{ ...validInput, organizationTypeCode: 'screening program' }, 'upper snake case'],
    [{ ...validInput, locationName: 'Site\nInjected' }, '1 to 200 characters'],
    [{ ...validInput, unexpected: true }, 'Unexpected screening context field'],
  ])('rejects unsafe provisioning input', (input, message) => {
    expect(() => parseScreeningContextProvisioningInput(input)).toThrow(message);
  });
});
