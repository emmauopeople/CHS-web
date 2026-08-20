import { describe, expect, it, vi } from 'vitest';

import {
  getIdentityReviewCaseDetail,
  IdentityReviewQueryError,
  listIdentityReviewCases,
} from '../src/operations/identity-review.js';

const organizationId = '10000000-0000-4000-8000-000000000001';
const installationId = '20000000-0000-4000-8000-000000000001';
const caseReference = '30000000-0000-4000-8000-000000000001';
const personReference = '40000000-0000-4000-8000-000000000001';
const sourceRecordReference = '50000000-0000-4000-8000-000000000001';
const timestamp = new Date('2026-08-20T12:00:00.000Z');

describe('identity review query service', () => {
  it.each([
    [{ evidenceState: 'UNKNOWN' }, 'INVALID_EVIDENCE_STATE'],
    [{ installationId: 'not-a-uuid' }, 'INVALID_INSTALLATION_ID'],
    [{ openedFrom: '2026-08-20' }, 'INVALID_OPENED_PERIOD'],
    [
      {
        openedFrom: '2026-08-21T00:00:00Z',
        openedTo: '2026-08-20T00:00:00Z',
      },
      'INVALID_OPENED_PERIOD',
    ],
    [{ page: 0 }, 'INVALID_PAGE'],
    [{ pageSize: 101 }, 'INVALID_PAGE_SIZE'],
  ])('rejects invalid queue input before querying PostgreSQL', async (query, code) => {
    const database = { query: vi.fn() };
    await expect(
      listIdentityReviewCases(
        database as never,
        { kind: 'ORGANIZATIONS', organizationIds: [organizationId] },
        query as never,
      ),
    ).rejects.toMatchObject({ code });
    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects an empty organization scope before querying PostgreSQL', async () => {
    const database = { query: vi.fn() };
    await expect(
      listIdentityReviewCases(
        database as never,
        { kind: 'ORGANIZATIONS', organizationIds: [] },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_SCOPE' });
    expect(database.query).not.toHaveBeenCalled();
  });

  it('returns masked queue hints and marks legacy evidence as pending', async () => {
    const database = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            total_items: '2',
            case_reference: caseReference,
            status: 'OPEN',
            organization_name: 'Community Program',
            location_name: 'Central Clinic',
            installation_id: installationId,
            deployment_name: 'Front Desk',
            opened_at: timestamp,
            updated_at: timestamp,
            candidate_count: 2,
            evidence_id: '60000000-0000-4000-8000-000000000001',
            source_revision: 3,
            captured_at: timestamp,
            local_patient_code: 'PT-000101',
            display_name: 'Sensitive Alpha Example',
            date_of_birth: '1991-02-03',
            approximate_age_years: null,
            age_as_of_date: null,
          },
          {
            total_items: '2',
            case_reference: '30000000-0000-4000-8000-000000000002',
            status: 'OPEN',
            organization_name: 'Community Program',
            location_name: 'Central Clinic',
            installation_id: installationId,
            deployment_name: 'Front Desk',
            opened_at: timestamp,
            updated_at: timestamp,
            candidate_count: 0,
            evidence_id: null,
            source_revision: null,
            captured_at: null,
            local_patient_code: null,
            display_name: null,
            date_of_birth: null,
            approximate_age_years: null,
            age_as_of_date: null,
          },
        ],
      }),
    };

    const result = await listIdentityReviewCases(
      database as never,
      { kind: 'ORGANIZATIONS', organizationIds: [organizationId] },
      { evidenceState: 'ALL', installationId, page: 1, pageSize: 10 },
    );

    expect(result).toMatchObject({ totalItems: 2, totalPages: 1 });
    expect(result.items[0]).toMatchObject({
      evidenceState: 'AVAILABLE',
      maskedSubmittedName: 'S••••• A•••• E•••••',
      submittedBirthEvidence: {
        kind: 'DATE_OF_BIRTH',
        maskedDate: '****-**-03',
      },
    });
    expect(result.items[1]).toMatchObject({
      evidenceState: 'EVIDENCE_PENDING',
      maskedSubmittedName: null,
      submittedBirthEvidence: null,
    });
    expect(JSON.stringify(result)).not.toContain('Sensitive Alpha Example');
    expect(database.query.mock.calls[0]?.[1]).toEqual([
      false,
      [organizationId],
      null,
      installationId,
      null,
      null,
      10,
      0,
    ]);
  });

  it('returns exact submitted evidence but masks every candidate identity', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.startsWith('SELECT') && sql.includes('FROM identity_review_cases')) {
          return {
            rows: [
              {
                case_reference: caseReference,
                status: 'OPEN',
                organization_id: organizationId,
                organization_name: 'Community Program',
                location_id: '70000000-0000-4000-8000-000000000001',
                location_name: 'Central Clinic',
                installation_id: installationId,
                deployment_name: 'Front Desk',
                local_patient_id: '80000000-0000-4000-8000-000000000001',
                opened_at: timestamp,
                updated_at: timestamp,
                evidence_id: '60000000-0000-4000-8000-000000000001',
                source_record_id: sourceRecordReference,
                source_revision: 3,
                schema_version: '1.0',
                captured_at: timestamp,
                local_patient_code: 'PT-000101',
                claimed_chs_medical_id: 'CHS-1234-5678-9012',
                display_name: 'Submitted Patient',
                given_name: 'Submitted',
                family_name: 'Patient',
                other_names: null,
                date_of_birth: '1991-02-03',
                approximate_age_years: null,
                age_as_of_date: null,
                sex: 'FEMALE',
                phone: '+237612345678',
                village: 'Submitted Village',
                quarter: 'Submitted Quarter',
                acknowledgment_status: 'ACKNOWLEDGED',
                patient_status: 'ACTIVE',
                source_created_at: timestamp,
                source_updated_at: timestamp,
                received_at: timestamp,
              },
            ],
          };
        }
        if (sql.startsWith('SELECT') && sql.includes('FROM identity_review_candidates')) {
          return {
            rows: [
              {
                person_id: personReference,
                score: 91,
                matched_on: ['NAME', 'DATE_OF_BIRTH'],
                identifier_value: 'CHS-9999-8888-7777',
                display_name: 'Candidate Secret Person',
                date_of_birth: '1991-02-03',
                approximate_age_years: null,
                age_as_of_date: null,
                sex: 'FEMALE',
                phone: '+237698765432',
                village: 'Candidate Village',
                quarter: 'Candidate Quarter',
              },
            ],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const database = { connect: vi.fn().mockResolvedValue(client) };

    const result = await getIdentityReviewCaseDetail(
      database as never,
      { kind: 'ORGANIZATIONS', organizationIds: [organizationId] },
      caseReference,
    );

    expect(result.evidence).toMatchObject({
      displayName: 'Submitted Patient',
      dateOfBirth: '1991-02-03',
      acknowledgmentStatus: 'ACKNOWLEDGED',
      patientStatus: 'ACTIVE',
      maskedClaimedChsMedicalId: 'CHS-••••••••-9012',
    });
    expect(result.candidates[0]).toMatchObject({
      personReference,
      maskedName: 'C••••• S••••• P•••••',
      maskedChsMedicalId: 'CHS-••••••••-7777',
      birthEvidence: { kind: 'DATE_OF_BIRTH', maskedDate: '****-**-03' },
      maskedPhone: '••••••••••32',
      maskedResidence: 'C••••• Q•••••, C••••• V•••••',
    });
    const serialized = JSON.stringify(result.candidates);
    expect(serialized).not.toContain('Candidate Secret Person');
    expect(serialized).not.toContain('CHS-9999-8888-7777');
    expect(serialized).not.toContain('+237698765432');
    expect(queries.at(-1)).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('makes missing and out-of-scope detail indistinguishable', async () => {
    const client = {
      query: vi.fn(async (sql: string) =>
        sql.startsWith('SELECT') ? { rows: [] } : { rows: [] },
      ),
      release: vi.fn(),
    };
    const database = { connect: vi.fn().mockResolvedValue(client) };

    await expect(
      getIdentityReviewCaseDetail(
        database as never,
        { kind: 'ORGANIZATIONS', organizationIds: [organizationId] },
        caseReference,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<IdentityReviewQueryError>>({
        code: 'IDENTITY_REVIEW_CASE_NOT_FOUND',
        statusCode: 404,
      }),
    );
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rejects an invalid detail reference before acquiring a connection', async () => {
    const database = { connect: vi.fn() };
    await expect(
      getIdentityReviewCaseDetail(
        database as never,
        { kind: 'GLOBAL' },
        'not-a-uuid',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CASE_REFERENCE' });
    expect(database.connect).not.toHaveBeenCalled();
  });
});
