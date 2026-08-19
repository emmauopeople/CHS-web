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

  it('keeps recovery evidence and one-time tokens out of URLs', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'CANDIDATE_FOUND',
            caseReference: '11000000-0000-4000-8000-000000000001',
            recoveryToken: 'r'.repeat(43),
            expiresAt: '2026-08-20T12:05:00.000Z',
            candidates: [
              {
                candidateReference: '21000000-0000-4000-8000-000000000001',
                maskedName: 'A•••• E••••',
                maskedDateOfBirth: '****-**-01',
                sex: 'FEMALE',
                maskedResidence: 'Q••••',
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 'REVEALED', chsMedicalId: 'CHS-AAAA-BBBB-CCCC' }),
          { status: 200 },
        ),
      );
    const api = createOperationsApi('/internal', 'access-token', fetchImplementation);

    const search = await api.searchMedicalIdRecovery({
      reasonCode: 'PATIENT_REQUEST',
      fullName: 'Alpha Example',
      dateOfBirth: '1980-01-01',
    });
    expect(search.status).toBe('CANDIDATE_FOUND');

    await api.revealMedicalId({
      reasonCode: 'PATIENT_REQUEST',
      recoveryToken: 'r'.repeat(43),
      candidateReference: '21000000-0000-4000-8000-000000000001',
      confirmed: true,
    });

    const [searchUrl, searchInit] = fetchImplementation.mock.calls[0]!;
    const [revealUrl, revealInit] = fetchImplementation.mock.calls[1]!;
    expect(searchUrl).toBe('/internal/api/v1/operations/medical-id-recovery/search');
    expect(String(searchUrl)).not.toContain('Alpha');
    expect(String(searchUrl)).not.toContain('1980-01-01');
    expect(JSON.parse(String(searchInit?.body))).toMatchObject({
      fullName: 'Alpha Example',
      dateOfBirth: '1980-01-01',
    });
    expect(revealUrl).toBe('/internal/api/v1/operations/medical-id-recovery/reveal');
    expect(String(revealUrl)).not.toContain('r'.repeat(43));
    expect(JSON.parse(String(revealInit?.body))).toMatchObject({
      recoveryToken: 'r'.repeat(43),
      confirmed: true,
    });
  });

  it('rejects malformed recovery responses', async () => {
    const malformedSearch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'CANDIDATE_FOUND',
          recoveryToken: 'token-without-a-masked-candidate',
          candidates: [],
        }),
        { status: 200 },
      ),
    );
    await expect(
      createOperationsApi('', 'token', malformedSearch).searchMedicalIdRecovery({
        reasonCode: 'PATIENT_REQUEST',
        fullName: 'Alpha Example',
        dateOfBirth: '1980-01-01',
      }),
    ).rejects.toMatchObject({ status: 502, code: 'INVALID_API_RESPONSE' });

    const malformedReveal = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: 'REVEALED' }), { status: 200 }),
    );
    await expect(
      createOperationsApi('', 'token', malformedReveal).revealMedicalId({
        reasonCode: 'PATIENT_REQUEST',
        recoveryToken: 'r'.repeat(43),
        candidateReference: '21000000-0000-4000-8000-000000000001',
        confirmed: true,
      }),
    ).rejects.toMatchObject({ status: 502, code: 'INVALID_API_RESPONSE' });
  });
});
