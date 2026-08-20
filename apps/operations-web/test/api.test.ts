import { describe, expect, it, vi } from 'vitest';

import { ApiError, createOperationsApi } from '../src/api';

describe('operations API client', () => {
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

  it('keeps synchronization filters and batch references out of URLs', async () => {
    const batch = {
      batchReference: '11000000-0000-4000-8000-000000000001',
      sourceBatchId: '21000000-0000-4000-8000-000000000001',
      installationId: '31000000-0000-4000-8000-000000000001',
      deploymentName: 'Desktop One',
      organizationName: 'Program One',
      locationName: 'Site One',
      status: 'PARTIAL',
      attentionState: 'ATTENTION',
      contractVersion: '1.0',
      desktopApplicationVersion: '0.1.0',
      desktopSchemaVersion: 14,
      sourceCreatedAt: '2026-08-20T12:00:00.000Z',
      receivedAt: '2026-08-20T12:00:01.000Z',
      completedAt: '2026-08-20T12:00:02.000Z',
      durationMs: 1000,
      counts: { accepted: 1, unchanged: 0, reviewRequired: 0, rejected: 1, retry: 0 },
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          page: 1,
          pageSize: 25,
          totalItems: 1,
          totalPages: 1,
          items: [batch],
        }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          ...batch,
          outcomeCounts: [{ resourceType: 'VITALS', status: 'RETRY', count: 1 }],
          errorCodeCounts: [{ code: 'DEPENDENCY_NOT_AVAILABLE', retryable: true, count: 1 }],
        }), { status: 200 }),
      );
    const api = createOperationsApi('/internal', 'access-token', fetchImplementation);

    await api.searchSyncBatches({
      reasonCode: 'OPERATIONS_SUPPORT',
      status: 'PARTIAL',
      installationId: batch.installationId,
      receivedFrom: '2026-08-20T00:00:00.000Z',
    });
    await api.getSyncBatchDetail({
      reasonCode: 'OPERATIONS_SUPPORT',
      batchReference: batch.batchReference,
    });

    const [searchUrl, searchInit] = fetchImplementation.mock.calls[0]!;
    const [detailUrl, detailInit] = fetchImplementation.mock.calls[1]!;
    expect(searchUrl).toBe('/internal/api/v1/operations/sync/batches/search');
    expect(String(searchUrl)).not.toContain(batch.installationId);
    expect(JSON.parse(String(searchInit?.body))).toMatchObject({
      reasonCode: 'OPERATIONS_SUPPORT',
      installationId: batch.installationId,
    });
    expect(detailUrl).toBe('/internal/api/v1/operations/sync/batches/detail');
    expect(String(detailUrl)).not.toContain(batch.batchReference);
    expect(JSON.parse(String(detailInit?.body))).toMatchObject({
      batchReference: batch.batchReference,
    });
    expect(detailInit?.cache).toBe('no-store');
  });

  it('fails closed for malformed synchronization monitoring responses', async () => {
    const malformedPage = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        page: 1,
        pageSize: 25,
        totalItems: 1,
        totalPages: 1,
        items: [{ batchReference: 'not-a-uuid', response_body: { patient: 'leak' } }],
      }), { status: 200 }),
    );
    await expect(
      createOperationsApi('', 'token', malformedPage).searchSyncBatches({
        reasonCode: 'OPERATIONS_SUPPORT',
      }),
    ).rejects.toMatchObject({ status: 502, code: 'INVALID_API_RESPONSE' });

    const malformedDetail = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        batchReference: '11000000-0000-4000-8000-000000000001',
        errorCodeCounts: [{ code: 'patient name leaked', retryable: false, count: 1 }],
      }), { status: 200 }),
    );
    await expect(
      createOperationsApi('', 'token', malformedDetail).getSyncBatchDetail({
        reasonCode: 'OPERATIONS_SUPPORT',
        batchReference: '11000000-0000-4000-8000-000000000001',
      }),
    ).rejects.toMatchObject({ status: 502, code: 'INVALID_API_RESPONSE' });
  });

  it('keeps identity evidence, case references, and resolution decisions out of URLs', async () => {
    const ids = {
      review: '11000000-0000-4000-8000-000000000001',
      installation: '21000000-0000-4000-8000-000000000001',
      organization: '31000000-0000-4000-8000-000000000001',
      location: '41000000-0000-4000-8000-000000000001',
      patient: '51000000-0000-4000-8000-000000000001',
      source: '61000000-0000-4000-8000-000000000001',
      candidate: '71000000-0000-4000-8000-000000000001',
      resolution: '81000000-0000-4000-8000-000000000001',
    };
    const queueItem = {
      caseReference: ids.review,
      status: 'OPEN',
      evidenceState: 'AVAILABLE',
      organizationName: 'Program One',
      locationName: 'Site One',
      installationId: ids.installation,
      deploymentName: 'Desktop One',
      openedAt: '2026-08-20T12:00:00.000Z',
      updatedAt: '2026-08-20T12:01:00.000Z',
      candidateCount: 1,
      latestSourceRevision: 2,
      sourceCapturedAt: '2026-08-20T11:59:00.000Z',
      localPatientCode: 'PT-000001',
      maskedSubmittedName: 'A•••• E••••',
      submittedBirthEvidence: { kind: 'DATE_OF_BIRTH', maskedDate: '****-**-01' },
    };
    const detail = {
      caseReference: ids.review,
      status: 'OPEN',
      evidenceState: 'AVAILABLE',
      organization: { id: ids.organization, name: 'Program One' },
      location: { id: ids.location, name: 'Site One' },
      installation: { id: ids.installation, deploymentName: 'Desktop One' },
      localPatientReference: ids.patient,
      openedAt: queueItem.openedAt,
      updatedAt: queueItem.updatedAt,
      evidence: {
        sourceRecordReference: ids.source,
        sourceRevision: 2,
        schemaVersion: '1.0',
        capturedAt: '2026-08-20T11:59:00.000Z',
        localPatientCode: 'PT-000001',
        maskedClaimedChsMedicalId: null,
        displayName: 'Alpha Example',
        givenName: 'Alpha',
        familyName: 'Example',
        otherNames: null,
        dateOfBirth: '1980-01-01',
        approximateAgeYears: null,
        ageAsOfDate: null,
        sex: 'FEMALE',
        acknowledgmentStatus: 'ACKNOWLEDGED',
        patientStatus: 'ACTIVE',
        phone: '+237600000000',
        village: 'Village One',
        quarter: 'Quarter One',
        sourceCreatedAt: '2026-08-20T11:58:00.000Z',
        sourceUpdatedAt: '2026-08-20T11:59:00.000Z',
        receivedAt: '2026-08-20T12:00:00.000Z',
      },
      candidates: [{
        personReference: ids.candidate,
        score: 85,
        matchedOn: ['NAME', 'DATE_OF_BIRTH'],
        maskedChsMedicalId: 'CHS-****-****-CCCC',
        maskedName: 'A•••• E••••',
        birthEvidence: { kind: 'DATE_OF_BIRTH', maskedDate: '****-**-01' },
        sex: 'FEMALE',
        maskedPhone: '+237*******00',
        maskedResidence: 'Q••••, V••••',
      }],
    };
    const resolution = {
      resolutionRequestId: ids.resolution,
      caseReference: ids.review,
      resolutionStatus: 'RESOLVED_EXISTING',
      resolvedPersonReference: ids.candidate,
      chsMedicalId: 'CHS-AAAA-BBBB-CCCC',
      installationId: ids.installation,
      localPatientReference: ids.patient,
      localPatientCode: 'PT-000001',
      sourceRevision: 2,
      resolvedAt: '2026-08-20T12:10:00.000Z',
      replayed: false,
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        page: 1, pageSize: 25, totalItems: 1, totalPages: 1, items: [queueItem],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(resolution), { status: 200 }));
    const api = createOperationsApi('/internal', 'access-token', fetchImplementation);

    await api.searchIdentityReviews({
      reasonCode: 'IDENTITY_RECONCILIATION',
      evidenceState: 'AVAILABLE',
      installationId: ids.installation,
    });
    await api.getIdentityReviewDetail({
      reasonCode: 'IDENTITY_RECONCILIATION',
      caseReference: ids.review,
    });
    await api.resolveIdentityReview({
      reasonCode: 'IDENTITY_RECONCILIATION',
      resolutionRequestId: ids.resolution,
      caseReference: ids.review,
      expectedUpdatedAt: queueItem.updatedAt,
      resolutionNote: 'Evidence confirms the selected existing person.',
      resolution: { kind: 'LINK_EXISTING', candidatePersonReference: ids.candidate },
    });

    const [searchUrl, searchInit] = fetchImplementation.mock.calls[0]!;
    const [detailUrl, detailInit] = fetchImplementation.mock.calls[1]!;
    const [resolveUrl, resolveInit] = fetchImplementation.mock.calls[2]!;
    expect(searchUrl).toBe('/internal/api/v1/operations/identity-reviews/search');
    expect(detailUrl).toBe('/internal/api/v1/operations/identity-reviews/detail');
    expect(resolveUrl).toBe('/internal/api/v1/operations/identity-reviews/resolve');
    expect([searchUrl, detailUrl, resolveUrl].join('')).not.toContain(ids.review);
    expect(JSON.parse(String(searchInit?.body))).toMatchObject({ installationId: ids.installation });
    expect(JSON.parse(String(detailInit?.body))).toMatchObject({ caseReference: ids.review });
    expect(JSON.parse(String(resolveInit?.body))).toMatchObject({
      resolutionRequestId: ids.resolution,
      caseReference: ids.review,
      resolution: { kind: 'LINK_EXISTING', candidatePersonReference: ids.candidate },
    });
    expect(resolveInit?.cache).toBe('no-store');
  });

  it('fails closed for malformed identity review responses', async () => {
    const malformedPage = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        page: 1,
        pageSize: 25,
        totalItems: 1,
        totalPages: 1,
        items: [{ caseReference: 'not-a-uuid', displayName: 'patient leak' }],
      }), { status: 200 }),
    );
    await expect(
      createOperationsApi('', 'token', malformedPage).searchIdentityReviews({
        reasonCode: 'IDENTITY_RECONCILIATION',
      }),
    ).rejects.toMatchObject({ status: 502, code: 'INVALID_API_RESPONSE' });

    const malformedDetail = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        caseReference: '11000000-0000-4000-8000-000000000001',
        status: 'OPEN',
        evidenceState: 'AVAILABLE',
        evidence: { displayName: 'incomplete protected evidence' },
        candidates: [],
      }), { status: 200 }),
    );
    await expect(
      createOperationsApi('', 'token', malformedDetail).getIdentityReviewDetail({
        reasonCode: 'IDENTITY_RECONCILIATION',
        caseReference: '11000000-0000-4000-8000-000000000001',
      }),
    ).rejects.toMatchObject({ status: 502, code: 'INVALID_API_RESPONSE' });

    const malformedResolution = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        resolutionStatus: 'RESOLVED_NEW',
        chsMedicalId: 'not-a-medical-id',
      }), { status: 200 }),
    );
    await expect(
      createOperationsApi('', 'token', malformedResolution).resolveIdentityReview({
        reasonCode: 'IDENTITY_RECONCILIATION',
        resolutionRequestId: '81000000-0000-4000-8000-000000000001',
        caseReference: '11000000-0000-4000-8000-000000000001',
        expectedUpdatedAt: '2026-08-20T12:01:00.000Z',
        resolutionNote: 'Create a new identity after evidence comparison.',
        resolution: { kind: 'CREATE_NEW' },
      }),
    ).rejects.toMatchObject({ status: 502, code: 'INVALID_API_RESPONSE' });
  });
});
