import { describe, expect, it } from 'vitest';

import { generateChsMedicalId } from '../src/sync/medical-id.js';

describe('CHS medical ID generation', () => {
  it('generates opaque, human-readable identifiers without ambiguous letters', () => {
    const values = new Set(Array.from({ length: 100 }, generateChsMedicalId));

    expect(values.size).toBe(100);
    for (const value of values) {
      expect(value).toMatch(/^CHS-[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
      expect(value).not.toMatch(/[ILOU]/);
    }
  });
});
