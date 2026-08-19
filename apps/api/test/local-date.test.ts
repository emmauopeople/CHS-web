import { describe, expect, it } from 'vitest';

import { localDateAtInstant } from '../src/sync/local-date.js';

describe('synchronization local-date conversion', () => {
  it('derives the installation date across a UTC day boundary', () => {
    expect(localDateAtInstant('2026-08-18T23:30:00.000Z', 'Africa/Douala')).toBe(
      '2026-08-19',
    );
    expect(localDateAtInstant('2026-08-18T23:30:00.000Z', 'America/Chicago')).toBe(
      '2026-08-18',
    );
  });

  it('rejects invalid timestamps and timezones', () => {
    expect(() => localDateAtInstant('not-a-date', 'Africa/Douala')).toThrow(
      'Invalid synchronization timestamp',
    );
    expect(() => localDateAtInstant('2026-08-18T12:00:00.000Z', 'Invalid/Zone')).toThrow(
      RangeError,
    );
  });
});
