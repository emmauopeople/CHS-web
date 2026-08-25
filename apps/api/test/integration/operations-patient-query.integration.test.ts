import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateWithClient } from '../../../../packages/database/src/migration-runner.mjs';
import {
  getCanonicalPatientDetail,
  listCanonicalPatients,
} from '../../src/operations/patient-query.js';

const connectionString = process.env.DATABASE_TEST_URL;
const runIntegration = connectionString ? describe : describe.skip;

const org1 = '10000000-0000-4000-8000-000000000001';
const org2 = '10000000-0000-4000-8000-000000000002';
const patientA = '40000000-0000-4000-8000-000000000001';
const patientB = '40000000-0000-4000-8000-000000000002';
const patientC = '40000000-0000-4000-8000-000000000003';
const now = '2026-08-19T12:00:00.000Z';
const hash = 'a'.repeat(64);

runIntegration('canonical patient query service', () => {
  const schema = `chs_patient_viewer_${randomUUID().replaceAll('-', '')}`;
  let administrationPool: pg.Pool;
  let servicePool: pg.Pool;

  beforeAll(async () => {
    administrationPool = new pg.Pool({ connectionString });
    const migrationClient = await administrationPool.connect();
    await migrationClient.query(`CREATE SCHEMA "${schema}"`);
    await migrationClient.query(`SET search_path TO "${schema}"`);
    await migrateWithClient({ client: migrationClient, logger: { info() {} } });
    migrationClient.release();

    servicePool = new pg.Pool({
      connectionString,
      options: `-c search_path=${schema}`,
    });
    await seedCanonicalViewerData(servicePool);
  });

  afterAll(async () => {
    await servicePool.end();
    await administrationPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await administrationPool.end();
  });

  it('lists only canonical patients within scope with safe search and pagination', async () => {
    const scope = { kind: 'ORGANIZATIONS' as const, organizationIds: [org1] };
    const firstPage = await listCanonicalPatients(servicePool, scope, {
      page: 1,
      pageSize: 1,
    });
    expect(firstPage).toMatchObject({
      page: 1,
      pageSize: 1,
      totalItems: 2,
      totalPages: 2,
    });
    expect(firstPage.items).toEqual([
      expect.objectContaining({
        personId: patientA,
        chsMedicalId: 'CHS-AAAA-BBBB-CCCC',
        displayName: 'Alpha Example',
        dateOfBirth: '1980-01-02',
        lastScreeningStatus: 'COMPLETED',
        lastLocationName: 'Synthetic Site One',
      }),
    ]);

    const byName = await listCanonicalPatients(servicePool, scope, {
      search: 'Beta',
    });
    expect(byName.totalItems).toBe(1);
    expect(byName.items[0]?.personId).toBe(patientB);

    const byMedicalId = await listCanonicalPatients(servicePool, scope, {
      search: 'chs-aaaa-bbbb-cccc',
    });
    expect(byMedicalId.items.map((item) => item.personId)).toEqual([patientA]);

    const byBirthDate = await listCanonicalPatients(servicePool, scope, {
      dateOfBirth: '1980-01-02',
    });
    expect(byBirthDate.items.map((item) => item.personId)).toEqual([patientA]);

    const global = await listCanonicalPatients(
      servicePool,
      { kind: 'GLOBAL' },
      { pageSize: 10 },
    );
    expect(global.totalItems).toBe(3);
    expect(global.items.map((item) => item.personId)).toEqual([
      patientA,
      patientB,
      patientC,
    ]);
  });

  it('returns scoped clinical relationships and excludes voided encounters', async () => {
    const scope = { kind: 'ORGANIZATIONS' as const, organizationIds: [org1] };
    const detail = await getCanonicalPatientDetail(
      servicePool,
      scope,
      patientA,
    );
    expect(detail).toMatchObject({
      personId: patientA,
      chsMedicalId: 'CHS-AAAA-BBBB-CCCC',
      displayName: 'Alpha Example',
      phone: '+237600000001',
      screeningHistory: {
        totalItems: 1,
        totalPages: 1,
      },
    });
    expect(detail?.screeningHistory.items).toEqual([
      expect.objectContaining({
        encounterId: '51000000-0000-4000-8000-000000000001',
        status: 'COMPLETED',
        organizationName: 'Synthetic Program One',
        locationName: 'Synthetic Site One',
        recordedByPractitionerName: 'Synthetic Nurse One',
        vitals: expect.objectContaining({
          status: 'VITALS_COMPLETE',
          weightKg: 70.5,
          waistCm: 85.2,
          readings: [
            expect.objectContaining({
              sequenceNumber: 1,
              systolicMmhg: 122,
              diastolicMmhg: 78,
              pulseBpm: 72,
              measurementLocalDate: '2026-08-18',
              measurementLocalTime: '12:12',
              measurementTimezone: 'Africa/Douala',
              measuredAt: '2026-08-18T11:12:00.000Z',
            }),
          ],
        }),
        lifestyle: {
          lifestyleAssessmentId: '55000000-0000-4000-8000-000000000001',
          status: 'COMPLETE',
          periodStart: '2026-08-12',
          periodEnd: '2026-08-18',
          completedAt: '2026-08-18T11:25:00.000Z',
          recordedByPractitionerName: 'Synthetic Nurse One',
          baselines: {
            alcohol: expect.objectContaining({
              baselineId: '55100000-0000-4000-8000-000000000001',
              version: 1,
              status: 'CURRENT',
              commonBeverageTypes: ['BEER'],
            }),
            tobacco: expect.objectContaining({
              baselineId: '55200000-0000-4000-8000-000000000001',
              version: 1,
              status: 'CURRENT_SOME_DAYS',
              productTypes: ['CIGARETTE'],
            }),
            work: expect.objectContaining({
              baselineId: '55300000-0000-4000-8000-000000000001',
              version: 1,
              status: 'FARMING',
              typicalHoursPerWorkday: 6.5,
            }),
          },
          alcohol: expect.objectContaining({
            weeklyResponse: 'YES',
            drinkingDays: 2,
            totalStandardizedDrinks: 3,
            commonBeverageTypes: ['BEER'],
          }),
          tobacco: {
            weeklyResponse: 'YES',
            products: [
              expect.objectContaining({
                sequenceNumber: 1,
                productType: 'CIGARETTE',
                averageQuantityPerUseDay: 3,
              }),
            ],
          },
          physicalActivity: {
            weeklyResponse: 'YES',
            sedentaryTimeResponse: 'RECORDED',
            sedentaryMinutesPerDay: 240,
            activities: [
              expect.objectContaining({
                sequenceNumber: 1,
                activityDomain: 'WORK_OR_FARMING',
                averageMinutesPerActiveDay: 60,
              }),
            ],
          },
          work: { weeklyResponse: 'USUAL' },
          otherActivity: {
            weeklyResponse: 'YES',
            activities: [
              expect.objectContaining({
                sequenceNumber: 1,
                category: 'COMMUNITY',
                averageMinutesPerDay: 45,
              }),
            ],
          },
        },
      }),
    ]);
    const serializedDetail = JSON.stringify(detail);
    expect(serializedDetail).not.toContain(
      '55010000-0000-4000-8000-000000000001',
    );
    expect(serializedDetail).not.toContain(
      '55110000-0000-4000-8000-000000000001',
    );
    expect(serializedDetail).not.toContain('localLifestyleId');
    expect(serializedDetail).not.toContain('sourceContentHash');

    await expect(
      getCanonicalPatientDetail(servicePool, scope, patientC),
    ).resolves.toBeNull();
    const globalDetail = await getCanonicalPatientDetail(
      servicePool,
      { kind: 'GLOBAL' },
      patientC,
    );
    expect(globalDetail?.screeningHistory.items[0]).toMatchObject({
      organizationName: 'Synthetic Program Two',
      locationName: 'Synthetic Site Two',
      lifestyle: null,
    });
  });
});

async function seedCanonicalViewerData(pool: pg.Pool) {
  for (const [organizationId, suffix] of [
    [org1, 'One'],
    [org2, 'Two'],
  ]) {
    await pool.query(
      `INSERT INTO organizations (
         id, identifier_system, identifier_value, name, organization_type_code,
         created_at, updated_at
       ) VALUES ($1, 'urn:synthetic:organization', $2, $3, 'PROGRAM', $4, $4)`,
      [organizationId, `ORG-${suffix}`, `Synthetic Program ${suffix}`, now],
    );
  }

  for (const [locationId, organizationId, suffix] of [
    ['30000000-0000-4000-8000-000000000001', org1, 'One'],
    ['30000000-0000-4000-8000-000000000002', org2, 'Two'],
  ]) {
    await pool.query(
      `INSERT INTO locations (
         id, organization_id, identifier_system, identifier_value, name,
         location_type_code, physical_type_code, created_at, updated_at
       ) VALUES ($1, $2, 'urn:synthetic:location', $3, $4,
         'SCREENING_SITE', 'MOBILE', $5, $5)`,
      [locationId, organizationId, `LOC-${suffix}`, `Synthetic Site ${suffix}`, now],
    );
  }

  for (const [installationId, organizationId, locationId, suffix] of [
    [
      '20000000-0000-4000-8000-000000000001',
      org1,
      '30000000-0000-4000-8000-000000000001',
      'One',
    ],
    [
      '20000000-0000-4000-8000-000000000002',
      org2,
      '30000000-0000-4000-8000-000000000002',
      'Two',
    ],
  ]) {
    await pool.query(
      `INSERT INTO desktop_installations (
         id, organization_id, configured_location_id, deployment_name, timezone,
         status, enrolled_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'Africa/Douala', 'ACTIVE', $5, $5, $5)`,
      [installationId, organizationId, locationId, `Desktop ${suffix}`, now],
    );
    await pool.query(
      `INSERT INTO location_source_links (
         id, location_id, installation_id, organization_id, source_location_id,
         first_observed_at, last_observed_at
       ) VALUES ($1, $2, $3, $4, $2, $5, $5)`,
      [randomUUID(), locationId, installationId, organizationId, now],
    );
  }

  for (const [practitionerId, displayName] of [
    ['60000000-0000-4000-8000-000000000001', 'Synthetic Nurse One'],
    ['60000000-0000-4000-8000-000000000002', 'Synthetic Nurse Two'],
  ]) {
    await pool.query(
      `INSERT INTO practitioners (id, display_name, created_at, updated_at)
       VALUES ($1, $2, $3, $3)`,
      [practitionerId, displayName, now],
    );
  }

  for (const [protocolId, organizationId, suffix] of [
    ['80000000-0000-4000-8000-000000000001', org1, 'one'],
    ['80000000-0000-4000-8000-000000000002', org2, 'two'],
  ]) {
    await pool.query(
      `INSERT INTO screening_protocols (
         id, organization_id, protocol_key, version_label, checksum, status,
         effective_at, created_at, updated_at
       ) VALUES ($1, $2, 'community-screening', '2026.1', $3, 'ACTIVE', $4, $4, $4)`,
      [protocolId, organizationId, `sha256:${suffix}`, now],
    );
  }

  for (const [linkId, protocolId, installationId, organizationId] of [
    [
      '81000000-0000-4000-8000-000000000001',
      '80000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      org1,
    ],
    [
      '81000000-0000-4000-8000-000000000002',
      '80000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000002',
      org2,
    ],
  ]) {
    await pool.query(
      `INSERT INTO protocol_source_links (
         id, protocol_id, installation_id, organization_id,
         local_protocol_version_id, first_observed_at, last_observed_at
       ) VALUES ($1, $2, $3, $4, $2, $5, $5)`,
      [linkId, protocolId, installationId, organizationId, now],
    );
  }

  for (const [sessionId, installationId, organizationId, locationId, protocolId, practitionerId] of [
    [
      '70000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      org1,
      '30000000-0000-4000-8000-000000000001',
      '80000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
    ],
    [
      '70000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000002',
      org2,
      '30000000-0000-4000-8000-000000000002',
      '80000000-0000-4000-8000-000000000002',
      '60000000-0000-4000-8000-000000000002',
    ],
  ]) {
    await pool.query(
      `INSERT INTO screening_sessions (
         id, installation_id, organization_id, location_id, protocol_id,
         local_session_id, source_location_id, source_protocol_version_id,
         session_date, status, opened_by_practitioner_id, opened_at,
         source_revision, source_content_hash, source_created_at, source_updated_at,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $1, $4, $5, '2026-08-18', 'OPEN',
         $6, '2026-08-18T09:00:00.000Z', 1, $7,
         '2026-08-18T09:00:00.000Z', '2026-08-18T09:00:00.000Z', $8, $8)`,
      [
        sessionId,
        installationId,
        organizationId,
        locationId,
        protocolId,
        practitionerId,
        hash,
        now,
      ],
    );
  }

  for (const person of [
    {
      id: patientA,
      name: 'Alpha Example',
      normalized: 'alpha example',
      birth: '1980-01-02',
      phone: '+237600000001',
      medicalId: 'CHS-AAAA-BBBB-CCCC',
      installationId: '20000000-0000-4000-8000-000000000001',
      code: 'PT-000001',
    },
    {
      id: patientB,
      name: 'Beta Example',
      normalized: 'beta example',
      birth: '1990-03-04',
      phone: null,
      medicalId: 'CHS-DDDD-EEEE-FFFF',
      installationId: '20000000-0000-4000-8000-000000000001',
      code: 'PT-000002',
    },
    {
      id: patientC,
      name: 'Gamma Example',
      normalized: 'gamma example',
      birth: '1975-05-06',
      phone: null,
      medicalId: 'CHS-GGGG-HHHH-JJJJ',
      installationId: '20000000-0000-4000-8000-000000000002',
      code: 'PT-000001',
    },
  ]) {
    await pool.query(
      `INSERT INTO persons (
         id, display_name, name_normalized, sex, acknowledgment_status,
         date_of_birth, phone, status, created_at, updated_at
       ) VALUES ($1, $2, $3, 'UNKNOWN', 'ACKNOWLEDGED', $4, $5, 'ACTIVE', $6, $6)`,
      [person.id, person.name, person.normalized, person.birth, person.phone, now],
    );
    await pool.query(
      `INSERT INTO person_identifiers (
         id, person_id, identifier_system, identifier_value,
         identifier_type_code, status, is_primary, valid_from, created_at
       ) VALUES ($1, $2, 'urn:chs:id:medical-id:v1', $3,
         'CHS_MEDICAL_ID', 'ACTIVE', true, $4, $4)`,
      [randomUUID(), person.id, person.medicalId, now],
    );
    await pool.query(
      `INSERT INTO patient_source_links (
         id, person_id, installation_id, local_patient_id, local_patient_code,
         last_source_revision, last_content_hash, source_created_at,
         source_updated_at, first_observed_at, last_observed_at
       ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $7, $7, $7)`,
      [
        randomUUID(),
        person.id,
        person.installationId,
        randomUUID(),
        person.code,
        hash,
        now,
      ],
    );
  }

  await insertEncounter(pool, {
    id: '51000000-0000-4000-8000-000000000001',
    personId: patientA,
    sessionId: '70000000-0000-4000-8000-000000000001',
    installationId: '20000000-0000-4000-8000-000000000001',
    organizationId: org1,
    locationId: '30000000-0000-4000-8000-000000000001',
    protocolId: '80000000-0000-4000-8000-000000000001',
    practitionerId: '60000000-0000-4000-8000-000000000001',
    status: 'COMPLETED',
    startedAt: '2026-08-18T11:00:00.000Z',
    completedAt: '2026-08-18T11:30:00.000Z',
  });
  await insertEncounter(pool, {
    id: '51000000-0000-4000-8000-000000000002',
    personId: patientA,
    sessionId: '70000000-0000-4000-8000-000000000001',
    installationId: '20000000-0000-4000-8000-000000000001',
    organizationId: org1,
    locationId: '30000000-0000-4000-8000-000000000001',
    protocolId: '80000000-0000-4000-8000-000000000001',
    practitionerId: '60000000-0000-4000-8000-000000000001',
    status: 'VOID',
    startedAt: '2026-08-18T12:00:00.000Z',
    completedAt: null,
  });
  await insertEncounter(pool, {
    id: '51000000-0000-4000-8000-000000000003',
    personId: patientC,
    sessionId: '70000000-0000-4000-8000-000000000002',
    installationId: '20000000-0000-4000-8000-000000000002',
    organizationId: org2,
    locationId: '30000000-0000-4000-8000-000000000002',
    protocolId: '80000000-0000-4000-8000-000000000002',
    practitionerId: '60000000-0000-4000-8000-000000000002',
    status: 'COMPLETED',
    startedAt: '2026-08-18T13:00:00.000Z',
    completedAt: '2026-08-18T13:30:00.000Z',
  });

  await pool.query(
    `INSERT INTO screening_vital_sets (
       id, encounter_id, person_id, installation_id, local_vitals_id, status,
       weight_kg, waist_cm, notes, recorded_by_practitioner_id, source_revision,
       source_content_hash, source_created_at, source_updated_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'VITALS_COMPLETE', 70.5, 85.2,
       'Synthetic completed vitals', $6, 1, $7, $8, $8, $9, $9)`,
    [
      '52000000-0000-4000-8000-000000000001',
      '51000000-0000-4000-8000-000000000001',
      patientA,
      '20000000-0000-4000-8000-000000000001',
      '52100000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      hash,
      '2026-08-18T11:05:00.000Z',
      now,
    ],
  );
  await pool.query(
    `INSERT INTO vital_readings (
       id, vital_set_id, local_reading_id, sequence_number, systolic_mmhg,
       diastolic_mmhg, pulse_bpm, measurement_site, patient_position,
       measurement_local_date, measurement_local_time, measurement_timezone,
       measured_at, source_created_at, source_updated_at, created_at, updated_at
     ) VALUES ($1, $2, $3, 1, 122, 78, 72, 'RIGHT_ARM', 'SITTING',
       '2026-08-18', '12:12', 'Africa/Douala', '2026-08-18T11:12:00.000Z',
       '2026-08-18T11:12:00.000Z', '2026-08-18T11:12:00.000Z', $4, $4)`,
    [
      '53000000-0000-4000-8000-000000000001',
      '52000000-0000-4000-8000-000000000001',
      '53100000-0000-4000-8000-000000000001',
      now,
    ],
  );

  await insertLifestyle(pool);

  await pool.query(
    `INSERT INTO identity_review_cases (
       id, installation_id, local_patient_id, status, opened_at, created_at, updated_at
     ) VALUES ($1, $2, $3, 'OPEN', $4, $4, $4)`,
    [
      '54000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      '54100000-0000-4000-8000-000000000001',
      now,
    ],
  );
  await pool.query(
    `INSERT INTO identity_review_candidates (
       review_case_id, person_id, score, matched_on, created_at
     ) VALUES ($1, $2, 80, ARRAY['NAME'], $3)`,
    ['54000000-0000-4000-8000-000000000001', patientA, now],
  );
}

async function insertLifestyle(pool: pg.Pool) {
  const installationId = '20000000-0000-4000-8000-000000000001';
  const encounterId = '51000000-0000-4000-8000-000000000001';
  const practitionerId = '60000000-0000-4000-8000-000000000001';
  const alcoholBaselineId = '55100000-0000-4000-8000-000000000001';
  const tobaccoBaselineId = '55200000-0000-4000-8000-000000000001';
  const workBaselineId = '55300000-0000-4000-8000-000000000001';
  const lifestyleId = '55000000-0000-4000-8000-000000000001';

  await pool.query(
    `INSERT INTO lifestyle_alcohol_baselines (
       id, person_id, installation_id, local_baseline_version_id,
       source_version, status, ever_consumed, consumed_past_12_months,
       other_beverage_description, created_by_practitioner_id,
       updated_by_practitioner_id, source_content_hash, source_created_at,
       source_updated_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 1, 'CURRENT', 'YES', 'YES', NULL,
       $5, $5, $6, '2026-08-18T09:30:00.000Z',
       '2026-08-18T09:30:00.000Z', $7, $7)`,
    [
      alcoholBaselineId,
      patientA,
      installationId,
      '55110000-0000-4000-8000-000000000001',
      practitionerId,
      hash,
      now,
    ],
  );
  await pool.query(
    `INSERT INTO lifestyle_alcohol_baseline_beverages (
       baseline_id, beverage_type
     ) VALUES ($1, 'BEER')`,
    [alcoholBaselineId],
  );
  await pool.query(
    `INSERT INTO lifestyle_alcohol_baselines (
       id, person_id, installation_id, local_baseline_version_id,
       source_version, status, ever_consumed, consumed_past_12_months,
       other_beverage_description, created_by_practitioner_id,
       updated_by_practitioner_id, source_content_hash, source_created_at,
       source_updated_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 2, 'CURRENT', 'YES', 'YES', NULL,
       $5, $5, $6, '2026-08-18T11:20:00.000Z',
       '2026-08-18T11:20:00.000Z', $7, $7)`,
    [
      '55100000-0000-4000-8000-000000000002',
      patientA,
      installationId,
      '55110000-0000-4000-8000-000000000002',
      practitionerId,
      hash,
      now,
    ],
  );
  await pool.query(
    `INSERT INTO lifestyle_alcohol_baseline_beverages (
       baseline_id, beverage_type
     ) VALUES ($1, 'WINE')`,
    ['55100000-0000-4000-8000-000000000002'],
  );
  await pool.query(
    `INSERT INTO lifestyle_tobacco_baselines (
       id, person_id, installation_id, local_baseline_version_id,
       source_version, status, ever_regularly_used,
       former_use_approximate_stop_date, current_use_frequency,
       other_product_description, created_by_practitioner_id,
       updated_by_practitioner_id, source_content_hash, source_created_at,
       source_updated_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 1, 'CURRENT_SOME_DAYS', 'YES', NULL,
       'SOME_DAYS', NULL, $5, $5, $6, '2026-08-18T09:31:00.000Z',
       '2026-08-18T09:31:00.000Z', $7, $7)`,
    [
      tobaccoBaselineId,
      patientA,
      installationId,
      '55210000-0000-4000-8000-000000000001',
      practitionerId,
      hash,
      now,
    ],
  );
  await pool.query(
    `INSERT INTO lifestyle_tobacco_baseline_products (
       baseline_id, product_type
     ) VALUES ($1, 'CIGARETTE')`,
    [tobaccoBaselineId],
  );
  await pool.query(
    `INSERT INTO lifestyle_work_baselines (
       id, person_id, installation_id, local_baseline_version_id,
       source_version, status, occupation_job_title, usual_physical_demand,
       typical_workdays_per_week, typical_hours_per_workday, shift_pattern,
       description, created_by_practitioner_id, updated_by_practitioner_id,
       source_content_hash, source_created_at, source_updated_at,
       created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 1, 'FARMING', 'Synthetic crop farmer',
       'MODERATE_LABOR', 5, 6.5, 'DAY', NULL, $5, $5, $6,
       '2026-08-18T09:32:00.000Z', '2026-08-18T09:32:00.000Z', $7, $7)`,
    [
      workBaselineId,
      patientA,
      installationId,
      '55310000-0000-4000-8000-000000000001',
      practitionerId,
      hash,
      now,
    ],
  );
  await pool.query(
    `INSERT INTO lifestyle_assessments (
       id, encounter_id, person_id, screening_session_id, installation_id,
       organization_id, location_id, protocol_id, local_lifestyle_id,
       source_location_id, status, period_start, period_end,
       alcohol_baseline_id, tobacco_baseline_id, work_baseline_id,
       created_by_practitioner_id, updated_by_practitioner_id,
       source_revision, source_content_hash, source_created_at,
       source_updated_at, created_at, updated_at
     ) VALUES ($1, $2, $3, '70000000-0000-4000-8000-000000000001', $4,
       $5, '30000000-0000-4000-8000-000000000001',
       '80000000-0000-4000-8000-000000000001', $6,
       '30000000-0000-4000-8000-000000000001', 'COMPLETE',
       '2026-08-12', '2026-08-18', $7, $8, $9, $10, $10, 1, $11,
       '2026-08-18T09:30:00.000Z', '2026-08-18T11:25:00.000Z', $12, $12)`,
    [
      lifestyleId,
      encounterId,
      patientA,
      installationId,
      org1,
      '55010000-0000-4000-8000-000000000001',
      alcoholBaselineId,
      tobaccoBaselineId,
      workBaselineId,
      practitionerId,
      hash,
      now,
    ],
  );
  await pool.query(
    `INSERT INTO lifestyle_alcohol_weekly (
       lifestyle_assessment_id, local_weekly_record_id, weekly_response,
       drinking_days, total_standardized_drinks, largest_one_day_amount,
       days_at_largest_amount, other_beverage_description,
       created_by_practitioner_id, updated_by_practitioner_id,
       source_created_at, source_updated_at, created_at, updated_at
     ) VALUES ($1, $2, 'YES', 2, 3, 2, 1, NULL, $3, $3,
       '2026-08-18T10:00:00.000Z', '2026-08-18T10:00:00.000Z', $4, $4)`,
    [
      lifestyleId,
      '55400000-0000-4000-8000-000000000001',
      practitionerId,
      now,
    ],
  );
  await pool.query(
    `INSERT INTO lifestyle_alcohol_weekly_beverages (
       lifestyle_assessment_id, beverage_type
     ) VALUES ($1, 'BEER')`,
    [lifestyleId],
  );
  await pool.query(
    `INSERT INTO lifestyle_tobacco_weekly (
       lifestyle_assessment_id, local_weekly_record_id, weekly_response,
       created_by_practitioner_id, updated_by_practitioner_id,
       source_created_at, source_updated_at, created_at, updated_at
     ) VALUES ($1, $2, 'YES', $3, $3,
       '2026-08-18T10:05:00.000Z', '2026-08-18T10:05:00.000Z', $4, $4)`,
    [
      lifestyleId,
      '55500000-0000-4000-8000-000000000001',
      practitionerId,
      now,
    ],
  );
  await pool.query(
    `INSERT INTO lifestyle_tobacco_products (
       id, lifestyle_assessment_id, local_product_row_id, sequence_number,
       product_type, days_used, average_quantity_per_use_day, unit,
       secondhand_smoke_exposure, other_product_description,
       other_unit_description, created_by_practitioner_id,
       updated_by_practitioner_id, source_created_at, source_updated_at,
       created_at, updated_at
     ) VALUES ($1, $2, $3, 1, 'CIGARETTE', 2, 3, 'STICKS_CIGARETTES',
       false, NULL, NULL, $4, $4, '2026-08-18T10:05:00.000Z',
       '2026-08-18T10:05:00.000Z', $5, $5)`,
    [
      '55600000-0000-4000-8000-000000000001',
      lifestyleId,
      '55610000-0000-4000-8000-000000000001',
      practitionerId,
      now,
    ],
  );
  await pool.query(
    `INSERT INTO lifestyle_physical_activity_weekly (
       lifestyle_assessment_id, local_weekly_record_id, weekly_response,
       sedentary_time_response, sedentary_minutes_per_day,
       created_by_practitioner_id, updated_by_practitioner_id,
       source_created_at, source_updated_at, created_at, updated_at
     ) VALUES ($1, $2, 'YES', 'RECORDED', 240, $3, $3,
       '2026-08-18T10:10:00.000Z', '2026-08-18T10:10:00.000Z', $4, $4)`,
    [
      lifestyleId,
      '55700000-0000-4000-8000-000000000001',
      practitionerId,
      now,
    ],
  );
  await pool.query(
    `INSERT INTO lifestyle_physical_activities (
       id, lifestyle_assessment_id, local_activity_row_id, sequence_number,
       activity_domain, description, intensity, days_in_past_seven_days,
       average_minutes_per_active_day, created_by_practitioner_id,
       updated_by_practitioner_id, source_created_at, source_updated_at,
       created_at, updated_at
     ) VALUES ($1, $2, $3, 1, 'WORK_OR_FARMING', NULL, 'MODERATE', 5, 60,
       $4, $4, '2026-08-18T10:10:00.000Z',
       '2026-08-18T10:10:00.000Z', $5, $5)`,
    [
      '55800000-0000-4000-8000-000000000001',
      lifestyleId,
      '55810000-0000-4000-8000-000000000001',
      practitionerId,
      now,
    ],
  );
  await pool.query(
    `INSERT INTO lifestyle_work_weekly (
       lifestyle_assessment_id, local_weekly_record_id, weekly_response,
       created_by_practitioner_id, updated_by_practitioner_id,
       source_created_at, source_updated_at, created_at, updated_at
     ) VALUES ($1, $2, 'USUAL', $3, $3,
       '2026-08-18T10:15:00.000Z', '2026-08-18T10:15:00.000Z', $4, $4)`,
    [
      lifestyleId,
      '55900000-0000-4000-8000-000000000001',
      practitionerId,
      now,
    ],
  );
  await pool.query(
    `INSERT INTO lifestyle_other_activity_weekly (
       lifestyle_assessment_id, weekly_response
     ) VALUES ($1, 'YES')`,
    [lifestyleId],
  );
  await pool.query(
    `INSERT INTO lifestyle_other_activities (
       id, lifestyle_assessment_id, local_activity_row_id, sequence_number,
       category, description, days_in_past_seven_days,
       average_minutes_per_day, intensity, created_by_practitioner_id,
       updated_by_practitioner_id, source_created_at, source_updated_at,
       created_at, updated_at
     ) VALUES ($1, $2, $3, 1, 'COMMUNITY', 'Synthetic choir rehearsal',
       2, 45, 'LIGHT', $4, $4, '2026-08-18T10:20:00.000Z',
       '2026-08-18T10:20:00.000Z', $5, $5)`,
    [
      '55a00000-0000-4000-8000-000000000001',
      lifestyleId,
      '55a10000-0000-4000-8000-000000000001',
      practitionerId,
      now,
    ],
  );
}

type EncounterSeed = Readonly<{
  id: string;
  personId: string;
  sessionId: string;
  installationId: string;
  organizationId: string;
  locationId: string;
  protocolId: string;
  practitionerId: string;
  status: 'COMPLETED' | 'VOID';
  startedAt: string;
  completedAt: string | null;
}>;

async function insertEncounter(pool: pg.Pool, encounter: EncounterSeed) {
  await pool.query(
    `INSERT INTO screening_encounters (
       id, person_id, screening_session_id, installation_id, organization_id,
       location_id, protocol_id, local_encounter_id, source_location_id,
       source_protocol_version_id, status, started_at, completed_at,
       recorded_by_practitioner_id, source_type, void_reason, source_revision,
       source_content_hash, source_created_at, source_updated_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $1, $6, $7, $8, $9, $10,
       $11, 'LOCAL', $12, 1, $13, $9, $9, $14, $14)`,
    [
      encounter.id,
      encounter.personId,
      encounter.sessionId,
      encounter.installationId,
      encounter.organizationId,
      encounter.locationId,
      encounter.protocolId,
      encounter.status,
      encounter.startedAt,
      encounter.completedAt,
      encounter.practitionerId,
      encounter.status === 'VOID' ? 'Synthetic void' : null,
      hash,
      now,
    ],
  );
}
