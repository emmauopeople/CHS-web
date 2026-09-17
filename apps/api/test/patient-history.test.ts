import { describe, expect, it } from 'vitest';
import { validateHistoryRange } from '../src/history/service.js';
const request = {
  contractVersion: '1.0',
  personId: '10000000-0000-4000-8000-000000000001',
  reasonCode: 'CARE_DELIVERY',
  fromDate: '2026-01-01',
  toDate: '2026-12-31',
};
describe('bounded patient history requests', () => {
  it('allows inclusive windows up to 366 days including leap years', () => {
    expect(validateHistoryRange(request)).toEqual(request);
    expect(
      validateHistoryRange({
        ...request,
        fromDate: '2024-01-01',
        toDate: '2024-12-31',
      }),
    ).toBeTruthy();
  });
  it('rejects invalid dates, reversed windows and unbounded history', () => {
    for (const query of [
      { fromDate: '2026-02-30' },
      { fromDate: '2027-01-01' },
      { toDate: '2027-01-02' },
      { limit: 1000 },
      { resourceTypes: ['PATIENT'] },
      { reasonCode: 'UNCONTROLLED' },
      { organizationIds: ['untrusted'] },
    ])
      expect(() => validateHistoryRange({ ...request, ...query })).toThrow();
  });
  it('requires installation-specific confirmed patient and actor references', () => {
    expect(() => validateHistoryRange(request, true)).toThrow();
    expect(
      validateHistoryRange(
        {
          ...request,
          localPatientId: request.personId,
          requesterLocalActorId: request.personId,
        },
        true,
      ),
    ).toBeTruthy();
  });
});
