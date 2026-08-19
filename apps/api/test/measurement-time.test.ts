import { describe, expect, it } from 'vitest';

import { localMeasurementTimeToInstant } from '../src/sync/measurement-time.js';

describe('measurement local-time conversion', () => {
  it('derives the clinical instant using the supplied IANA timezone', () => {
    expect(
      localMeasurementTimeToInstant('2026-08-18', '12:12', 'Africa/Douala'),
    ).toEqual({ kind: 'EXACT', instant: '2026-08-18T11:12:00.000Z' });
    expect(
      localMeasurementTimeToInstant('2026-08-18', '12:12', 'America/Chicago'),
    ).toEqual({ kind: 'EXACT', instant: '2026-08-18T17:12:00.000Z' });
  });

  it('does not guess during daylight-saving gaps or repeated hours', () => {
    expect(
      localMeasurementTimeToInstant('2026-03-08', '02:30', 'America/Chicago'),
    ).toEqual({ kind: 'INVALID' });
    expect(
      localMeasurementTimeToInstant('2026-11-01', '01:30', 'America/Chicago'),
    ).toEqual({ kind: 'AMBIGUOUS' });
  });

  it('rejects impossible local dates and invalid timezone identifiers', () => {
    expect(
      localMeasurementTimeToInstant('2026-02-30', '12:00', 'Africa/Douala'),
    ).toEqual({ kind: 'INVALID' });
    expect(() =>
      localMeasurementTimeToInstant('2026-08-18', '12:00', 'Invalid/Zone'),
    ).toThrow(RangeError);
  });
});
