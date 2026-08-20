import { describe, expect, it, vi } from 'vitest';

import { resolveIdentityReviewCase } from '../src/operations/identity-review-resolution.js';

const organizationId = '10000000-0000-4000-8000-000000000001';
const operationsUserId = '20000000-0000-4000-8000-000000000001';
const caseReference = '30000000-0000-4000-8000-000000000001';
const candidatePersonReference = '40000000-0000-4000-8000-000000000001';
const resolutionRequestId = '50000000-0000-4000-8000-000000000001';

const validInput = {
  resolutionRequestId,
  caseReference,
  expectedUpdatedAt: '2026-08-20T12:00:00.000Z',
  resolutionNote: 'Reviewed the submitted evidence against the candidate.',
  resolution: {
    kind: 'LINK_EXISTING' as const,
    candidatePersonReference,
  },
};

const audit = {
  requestId: 'request-1',
  sourceIp: '127.0.0.1',
  userAgent: 'vitest',
  sessionId: 'session-1',
  authorizedParty: 'operations-web',
};

describe('identity review resolution validation', () => {
  it.each([
    [
      { ...validInput, resolutionRequestId: 'bad' },
      'INVALID_RESOLUTION_REQUEST_ID',
    ],
    [{ ...validInput, caseReference: 'bad' }, 'INVALID_CASE_REFERENCE'],
    [
      { ...validInput, expectedUpdatedAt: '2026-08-20' },
      'INVALID_EXPECTED_UPDATED_AT',
    ],
    [{ ...validInput, resolutionNote: 'too short' }, 'INVALID_RESOLUTION_NOTE'],
    [
      {
        ...validInput,
        resolution: {
          kind: 'LINK_EXISTING' as const,
          candidatePersonReference: 'bad',
        },
      },
      'INVALID_CANDIDATE_REFERENCE',
    ],
  ])('rejects malformed input before acquiring PostgreSQL', async (input, code) => {
    const database = { connect: vi.fn() };

    await expect(
      resolveIdentityReviewCase(
        database as never,
        { kind: 'ORGANIZATIONS', organizationIds: [organizationId] },
        operationsUserId,
        input,
        audit,
      ),
    ).rejects.toMatchObject({ code, statusCode: 400 });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('rejects an empty organization scope before acquiring PostgreSQL', async () => {
    const database = { connect: vi.fn() };

    await expect(
      resolveIdentityReviewCase(
        database as never,
        { kind: 'ORGANIZATIONS', organizationIds: [] },
        operationsUserId,
        validInput,
        audit,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_SCOPE', statusCode: 400 });
    expect(database.connect).not.toHaveBeenCalled();
  });
});
