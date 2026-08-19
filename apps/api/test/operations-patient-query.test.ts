import { describe, expect, it } from 'vitest';

import {
  getCanonicalPatientDetail,
  listCanonicalPatients,
} from '../src/operations/patient-query.js';

const unavailableDatabase = {
  connect(): never {
    throw new Error('Database must not be reached for invalid input');
  },
};

describe('canonical patient query validation', () => {
  it('rejects an empty or malformed organization scope before querying', async () => {
    await expect(
      listCanonicalPatients(unavailableDatabase, {
        kind: 'ORGANIZATIONS',
        organizationIds: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_SCOPE' });

    await expect(
      listCanonicalPatients(unavailableDatabase, {
        kind: 'ORGANIZATIONS',
        organizationIds: ['not-a-uuid'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_SCOPE' });
  });

  it('rejects unsafe pagination and impossible local dates', async () => {
    await expect(
      listCanonicalPatients(unavailableDatabase, { kind: 'GLOBAL' }, { page: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_PAGE' });
    await expect(
      listCanonicalPatients(
        unavailableDatabase,
        { kind: 'GLOBAL' },
        { pageSize: 101 },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PAGE_SIZE' });
    await expect(
      listCanonicalPatients(
        unavailableDatabase,
        { kind: 'GLOBAL' },
        { dateOfBirth: '2026-02-30' },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_DATE_OF_BIRTH' });
  });

  it('rejects malformed canonical person IDs before querying history', async () => {
    await expect(
      getCanonicalPatientDetail(
        unavailableDatabase,
        { kind: 'GLOBAL' },
        'not-a-person-id',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PATIENT_ID' });
  });
});
