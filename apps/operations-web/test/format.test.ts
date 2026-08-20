import { describe, expect, it } from 'vitest';

import {
  displayValue,
  formatDate,
  formatDuration,
  formatInstant,
  humanize,
} from '../src/format';

describe('patient display formatting', () => {
  it('formats local dates without changing their calendar day', () => {
    expect(formatDate('2026-08-19')).toBe('08/19/2026');
    expect(formatDate('not-a-date')).toBe('—');
    expect(formatDate(null)).toBe('—');
  });

  it('renders missing and coded values consistently', () => {
    expect(displayValue(null)).toBe('—');
    expect(displayValue(0)).toBe('0');
    expect(humanize('VITALS_COMPLETE')).toBe('Vitals Complete');
    expect(humanize(null)).toBe('—');
  });

  it('does not display an invalid clinical instant', () => {
    expect(formatInstant('invalid')).toBe('—');
    expect(formatInstant(null)).toBe('—');
  });

  it('formats synchronization durations without inventing precision', () => {
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(42_900)).toBe('42 sec');
    expect(formatDuration(125_000)).toBe('2 min 5 sec');
    expect(formatDuration(7_500_000)).toBe('2 hr 5 min');
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(null)).toBe('—');
  });
});
