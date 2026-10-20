import { createHash } from 'node:crypto';
export function collectionUrl(type: string, id: string) {
  // UUIDv8 permits this application-defined SHA-256 namespace; these are references, not credentials.
  const bytes = createHash('sha256')
    .update(`urn:chs:fhir:${type}/${id}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 128;
  bytes[8] = (bytes[8]! & 63) | 128;
  const h = bytes.toString('hex');
  return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function collectionResource(
  resource: Record<string, unknown>,
): Record<string, unknown> {
  const convert = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(convert);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, v]) => {
          if (
            key === 'reference' &&
            typeof v === 'string' &&
            /^[A-Za-z]+\/chs-[a-f0-9-]+$/.test(v)
          ) {
            const [type, id] = v.split('/');
            return [key, collectionUrl(type!, id!)];
          }
          return [key, convert(v)];
        }),
      );
    return value;
  };
  return convert(resource) as Record<string, unknown>;
}
