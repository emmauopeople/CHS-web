import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  canonicalJsonSha256,
} from '../src/sync/canonical-json.js';

describe('canonical sync JSON', () => {
  it('produces the same hash regardless of object key order', () => {
    const first = { z: 3, nested: { b: true, a: 'value' }, list: [2, 1] };
    const second = { list: [2, 1], nested: { a: 'value', b: true }, z: 3 };

    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(canonicalJsonSha256(first)).toBe(canonicalJsonSha256(second));
    expect(canonicalJsonSha256(first)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('preserves array order', () => {
    expect(canonicalJsonSha256([1, 2])).not.toBe(canonicalJsonSha256([2, 1]));
  });

  it('rejects values that cannot appear in contract JSON', () => {
    expect(() => canonicalJson({ value: undefined })).toThrow('undefined');
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow('non-finite');
    expect(() => canonicalJson(new Date())).toThrow('plain objects');
  });
});
