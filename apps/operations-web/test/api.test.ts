import { describe, expect, it, vi } from 'vitest';

import { ApiError, createOperationsApi } from '../src/api';

describe('operations patient API client', () => {
  it('keeps search values out of the URL and sends the bearer token only in a header', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          page: 1,
          pageSize: 25,
          totalItems: 0,
          totalPages: 0,
          items: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const api = createOperationsApi('/internal', 'secret-access-token', fetchImplementation);

    await api.searchPatients({
      reasonCode: 'CARE_DELIVERY',
      search: 'CHS-000001',
      dateOfBirth: '1980-01-01',
      status: 'ACTIVE',
    });

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe('/internal/api/v1/operations/patients/search');
    expect(String(url)).not.toContain('CHS-000001');
    expect(String(url)).not.toContain('1980-01-01');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer secret-access-token' });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      reasonCode: 'CARE_DELIVERY',
      search: 'CHS-000001',
      dateOfBirth: '1980-01-01',
    });
    expect(init?.cache).toBe('no-store');
  });

  it('returns only a structurally valid canonical patient page', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          page: 1,
          pageSize: 25,
          totalItems: 1,
          totalPages: 1,
          items: [{ personId: 'person-1', chsMedicalId: 'CHS-1', displayName: 'Test Patient' }],
        }),
        { status: 200 },
      ),
    );
    const result = await createOperationsApi('', 'token', fetchImplementation)
      .searchPatients({ reasonCode: 'PATIENT_REQUEST' });

    expect(result.totalItems).toBe(1);
    expect(result.items[0]?.displayName).toBe('Test Patient');
  });

  it('surfaces safe problem details and rejects malformed success bodies', async () => {
    const deniedFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: 'Patient access is not permitted',
          status: 403,
          code: 'OPERATIONS_ACCESS_DENIED',
          requestId: 'request-1',
        }),
        { status: 403 },
      ),
    );
    await expect(
      createOperationsApi('', 'token', deniedFetch).searchPatients({
        reasonCode: 'CARE_COORDINATION',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        status: 403,
        code: 'OPERATIONS_ACCESS_DENIED',
        requestId: 'request-1',
      }),
    );

    const malformedFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    await expect(
      createOperationsApi('', 'token', malformedFetch).searchPatients({
        reasonCode: 'CARE_DELIVERY',
      }),
    ).rejects.toMatchObject({ status: 502, code: 'INVALID_API_RESPONSE' });
  });
});
