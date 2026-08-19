import { createHash } from 'node:crypto';

function canonicalize(value: unknown): string {
  if (value === null) return 'null';

  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON cannot contain a non-finite number');
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON accepts only plain objects');
    }

    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => {
        if (record[key] === undefined) {
          throw new TypeError('Canonical JSON cannot contain undefined');
        }
        return `${JSON.stringify(key)}:${canonicalize(record[key])}`;
      })
      .join(',')}}`;
  }

  throw new TypeError(`Canonical JSON does not support ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function canonicalJsonSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
