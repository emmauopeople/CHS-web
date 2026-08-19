import { describe, expect, it } from 'vitest';

import {
  normalizeIdentityName,
  normalizePhone,
} from '../src/sync/patient-identity-normalization.js';

describe('patient identity normalization', () => {
  it('normalizes case, punctuation, accents, spacing, and token order', () => {
    expect(normalizeIdentityName('  Émile Nfor-Mbah ')).toBe('emile mbah nfor');
    expect(normalizeIdentityName('MBAH, Emile Nfor')).toBe('emile mbah nfor');
  });

  it('keeps only usable phone digits', () => {
    expect(normalizePhone('+237 600-000-001')).toBe('237600000001');
    expect(normalizePhone('600 000 001')).toBe('237600000001');
    expect(normalizePhone('00237 600 000 001')).toBe('237600000001');
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});
