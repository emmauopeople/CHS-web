import { describe, it, expect, vi } from 'vitest';
import { createFhirTransport } from '../src/fhir/publication.js';
describe('FHIR transaction acknowledgment', () => {
  it('requires one successful response per requested entry', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            resourceType: 'Bundle',
            type: 'transaction-response',
            entry: [],
          }),
        ),
    );
    const client = createFhirTransport('http://private-fhir/fhir', fetcher);
    await expect(
      client.transaction({
        resourceType: 'Bundle',
        type: 'transaction',
        entry: [{ request: { method: 'PUT', url: 'Patient/chs-test' } }],
      }),
    ).rejects.toThrow('FHIR_TRANSACTION_REJECTED');
  });
  it('rejects redirects and unsafe resource paths', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 302 }));
    const client = createFhirTransport('http://private-fhir/fhir', fetcher);
    await expect(client.read('Patient', '../admin')).rejects.toThrow(
      'FHIR_RESOURCE_INVALID',
    );
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      client.read('Patient', 'chs-11111111-1111-4111-8111-111111111111'),
    ).rejects.toThrow('FHIR_SERVER_UNAVAILABLE');
  });
});
