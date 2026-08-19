import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import pg from 'pg';

import { migrateWithClient } from '../../src/migration-runner.mjs';

const connectionString = process.env.DATABASE_TEST_URL;

test(
  'migration creates an idempotent FHIR-ready canonical schema',
  { skip: !connectionString },
  async () => {
    const client = new pg.Client({ connectionString });
    const schema = `chs_test_${randomUUID().replaceAll('-', '')}`;
    const now = '2026-08-18T12:00:00.000Z';
    const hash = 'a'.repeat(64);

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);

      const firstRun = await migrateWithClient({
        client,
        logger: { info() {} },
      });
      const secondRun = await migrateWithClient({
        client,
        logger: { info() {} },
      });

      assert.deepEqual(firstRun.applied, [
        '0001_canonical_screening_foundation.sql',
      ]);
      assert.deepEqual(secondRun.applied, []);

      const tableResult = await client.query(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
        [schema],
      );
      const tableNames = tableResult.rows.map((row) => row.table_name);
      assert.equal(tableNames.length, 23);
      assert.ok(tableNames.includes('schema_migrations'));
      assert.ok(tableNames.includes('screening_encounters'));
      assert.ok(tableNames.includes('vital_readings'));
      assert.ok(tableNames.includes('sync_batch_actors'));

      await assert.rejects(
        client.query(
          `INSERT INTO persons (
             id, display_name, name_normalized, sex, acknowledgment_status,
             date_of_birth, approximate_age_years, age_as_of_date, status,
             created_at, updated_at
           ) VALUES ($1, 'Invalid Person', 'invalid person', 'UNKNOWN',
             'NOT_REQUESTED', DATE '1990-01-01', 36, DATE '2026-08-18',
             'ACTIVE', $2, $2)`,
          ['40000000-0000-4000-8000-000000000099', now],
        ),
        /ck_persons_birth_or_approximate_age/,
      );

      await seedCanonicalScreening({ client, now, hash });

      await assert.rejects(
        client.query(
          `INSERT INTO person_identifiers (
             id, person_id, identifier_system, identifier_value,
             identifier_type_code, status, is_primary, valid_from, created_at
           ) VALUES ($1, $2, 'https://chs.example/id/medical-id', 'CHS-00000001',
             'CHS_MEDICAL_ID', 'ACTIVE', true, $3, $3)`,
          [
            '41000000-0000-4000-8000-000000000002',
            '40000000-0000-4000-8000-000000000002',
            now,
          ],
        ),
        /uq_person_identifiers_value/,
      );

      await assert.rejects(
        insertEncounter({
          client,
          encounterId: '51000000-0000-4000-8000-000000000099',
          localEncounterId: '51100000-0000-4000-8000-000000000099',
          practitionerRoleId: '62000000-0000-4000-8000-000000000002',
          now,
          hash,
        }),
        /fk_screening_encounters_practitioner_role/,
      );

      const clinicalContext = await client.query(
        `SELECT
           p.id AS person_id,
           o.name AS organization_name,
           l.name AS location_name,
           pr.display_name AS practitioner_name,
           role.code AS practitioner_role,
           e.id AS encounter_id,
           vs.id AS vital_set_id,
           vr.systolic_mmhg,
           vr.diastolic_mmhg,
           vr.pulse_bpm
         FROM screening_encounters e
         JOIN persons p ON p.id = e.person_id
         JOIN organizations o ON o.id = e.organization_id
         JOIN locations l ON l.id = e.location_id
         JOIN practitioners pr ON pr.id = e.recorded_by_practitioner_id
         JOIN practitioner_roles role ON role.id = e.practitioner_role_id
         JOIN screening_vital_sets vs ON vs.encounter_id = e.id
         JOIN vital_readings vr ON vr.vital_set_id = vs.id
         WHERE e.id = $1`,
        ['51000000-0000-4000-8000-000000000001'],
      );

      assert.deepEqual(clinicalContext.rows[0], {
        person_id: '40000000-0000-4000-8000-000000000001',
        organization_name: 'Synthetic Screening Program',
        location_name: 'Synthetic Mobile Site',
        practitioner_name: 'Synthetic Screener',
        practitioner_role: 'NURSE',
        encounter_id: '51000000-0000-4000-8000-000000000001',
        vital_set_id: '52000000-0000-4000-8000-000000000001',
        systolic_mmhg: 120,
        diastolic_mmhg: 80,
        pulse_bpm: 70,
      });
    } finally {
      await client.query('SET search_path TO public');
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  },
);

async function seedCanonicalScreening({ client, now, hash }) {
  await client.query(
    `INSERT INTO organizations (
       id, identifier_system, identifier_value, name, organization_type_code,
       created_at, updated_at
     ) VALUES ($1, 'https://chs.example/id/organization', 'ORG-001',
       'Synthetic Screening Program', 'PROGRAM', $2, $2)`,
    ['10000000-0000-4000-8000-000000000001', now],
  );
  await client.query(
    `INSERT INTO locations (
       id, organization_id, identifier_system, identifier_value, name,
       location_type_code, physical_type_code, created_at, updated_at
     ) VALUES ($1, $2, 'https://chs.example/id/location', 'LOC-001',
       'Synthetic Mobile Site', 'SCREENING_SITE', 'MOBILE', $3, $3)`,
    [
      '30000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      now,
    ],
  );
  await client.query(
    `INSERT INTO desktop_installations (
       id, organization_id, configured_location_id, deployment_name, timezone,
       status, enrolled_at, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Synthetic Desktop', 'Africa/Douala', 'ACTIVE',
       $4, $4, $4)`,
    [
      '20000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      now,
    ],
  );
  await client.query(
    `INSERT INTO location_source_links (
       id, location_id, installation_id, organization_id, source_location_id,
       first_observed_at, last_observed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [
      '31000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '32000000-0000-4000-8000-000000000001',
      now,
    ],
  );

  for (const [id, name] of [
    ['60000000-0000-4000-8000-000000000001', 'Synthetic Screener'],
    ['60000000-0000-4000-8000-000000000002', 'Different Screener'],
  ]) {
    await client.query(
      `INSERT INTO practitioners (id, display_name, created_at, updated_at)
       VALUES ($1, $2, $3, $3)`,
      [id, name, now],
    );
  }

  for (const [id, practitionerId, sourceActorId, displayName] of [
    [
      '61000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      '61100000-0000-4000-8000-000000000001',
      'Synthetic Screener',
    ],
    [
      '61000000-0000-4000-8000-000000000002',
      '60000000-0000-4000-8000-000000000002',
      '61100000-0000-4000-8000-000000000002',
      'Different Screener',
    ],
  ]) {
    await client.query(
      `INSERT INTO practitioner_source_links (
         id, practitioner_id, installation_id, source_actor_local_id,
         source_display_name, source_role_code, source_active, source_updated_at,
         first_observed_at, last_observed_at
       ) VALUES ($1, $2, $3, $4, $5, 'NURSE', true, $6, $6, $6)`,
      [
        id,
        practitionerId,
        '20000000-0000-4000-8000-000000000001',
        sourceActorId,
        displayName,
        now,
      ],
    );
  }

  for (const [id, practitionerId] of [
    [
      '62000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
    ],
    [
      '62000000-0000-4000-8000-000000000002',
      '60000000-0000-4000-8000-000000000002',
    ],
  ]) {
    await client.query(
      `INSERT INTO practitioner_roles (
         id, practitioner_id, organization_id, location_id, code_system, code,
         display, period_start, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'https://chs.example/codes/desktop-role',
         'NURSE', 'Nurse', $5, $5, $5)`,
      [
        id,
        practitionerId,
        '10000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001',
        now,
      ],
    );
  }

  await client.query(
    `INSERT INTO screening_protocols (
       id, organization_id, protocol_key, version_label, checksum, status,
       effective_at, created_at, updated_at
     ) VALUES ($1, $2, 'adult-screening', '1.0', $3, 'ACTIVE', $4, $4, $4)`,
    [
      '70000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      hash,
      now,
    ],
  );
  await client.query(
    `INSERT INTO protocol_source_links (
       id, protocol_id, installation_id, organization_id,
       local_protocol_version_id, first_observed_at, last_observed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [
      '71000000-0000-4000-8000-000000000001',
      '70000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '71100000-0000-4000-8000-000000000001',
      now,
    ],
  );

  for (const [id, displayName] of [
    ['40000000-0000-4000-8000-000000000001', 'Synthetic Patient'],
    ['40000000-0000-4000-8000-000000000002', 'Second Synthetic Patient'],
  ]) {
    await client.query(
      `INSERT INTO persons (
         id, display_name, name_normalized, sex, acknowledgment_status,
         date_of_birth, status, created_at, updated_at
       ) VALUES ($1, $2, lower($2), 'UNKNOWN', 'ACKNOWLEDGED',
         DATE '1990-01-01', 'ACTIVE', $3, $3)`,
      [id, displayName, now],
    );
  }
  await client.query(
    `INSERT INTO person_identifiers (
       id, person_id, identifier_system, identifier_value,
       identifier_type_code, status, is_primary, valid_from, created_at
     ) VALUES ($1, $2, 'https://chs.example/id/medical-id', 'CHS-00000001',
       'CHS_MEDICAL_ID', 'ACTIVE', true, $3, $3)`,
    [
      '41000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      now,
    ],
  );
  await client.query(
    `INSERT INTO screening_sessions (
       id, installation_id, organization_id, location_id, protocol_id,
       local_session_id, source_location_id, source_protocol_version_id,
       session_date, status,
       opened_by_practitioner_id, opened_at, source_revision,
       source_content_hash, source_created_at, source_updated_at,
       created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, DATE '2026-08-18', 'OPEN',
       $9, $10, 1, $11, $10, $10, $10, $10)`,
    [
      '50000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      '70000000-0000-4000-8000-000000000001',
      '50100000-0000-4000-8000-000000000001',
      '32000000-0000-4000-8000-000000000001',
      '71100000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      now,
      hash,
    ],
  );
  await insertEncounter({
    client,
    encounterId: '51000000-0000-4000-8000-000000000001',
    localEncounterId: '51100000-0000-4000-8000-000000000001',
    practitionerRoleId: '62000000-0000-4000-8000-000000000001',
    now,
    hash,
  });
  await client.query(
    `INSERT INTO screening_vital_sets (
       id, encounter_id, person_id, installation_id, local_vitals_id, status,
       weight_kg, waist_cm, recorded_by_practitioner_id, source_revision,
       source_content_hash, source_created_at, source_updated_at,
       created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'VITALS_COMPLETE', 70.25, 84.50,
       $6, 1, $7, $8, $8, $8, $8)`,
    [
      '52000000-0000-4000-8000-000000000001',
      '51000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      '52100000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
      hash,
      now,
    ],
  );
  await client.query(
    `INSERT INTO vital_readings (
       id, vital_set_id, local_reading_id, sequence_number, systolic_mmhg,
       diastolic_mmhg, pulse_bpm, measurement_site, patient_position,
       measurement_local_date, measurement_local_time, measurement_timezone,
       measured_at, source_created_at, source_updated_at, created_at, updated_at
     ) VALUES ($1, $2, $3, 1, 120, 80, 70, 'RIGHT_ARM', 'SITTING',
       DATE '2026-08-18', TIME '13:00', 'Africa/Douala', $4, $4, $4, $4, $4)`,
    [
      '53000000-0000-4000-8000-000000000001',
      '52000000-0000-4000-8000-000000000001',
      '53100000-0000-4000-8000-000000000001',
      now,
    ],
  );
}

function insertEncounter({
  client,
  encounterId,
  localEncounterId,
  practitionerRoleId,
  now,
  hash,
}) {
  return client.query(
    `INSERT INTO screening_encounters (
       id, person_id, screening_session_id, installation_id, organization_id,
       location_id, protocol_id, local_encounter_id, source_location_id,
       source_protocol_version_id, status, started_at, completed_at,
       recorded_by_practitioner_id,
       practitioner_role_id, source_type, source_revision, source_content_hash,
       source_created_at, source_updated_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'COMPLETED',
       $11, $11, $12, $13, 'LOCAL', 1, $14, $11, $11, $11, $11)`,
    [
      encounterId,
      '40000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      '70000000-0000-4000-8000-000000000001',
      localEncounterId,
      '32000000-0000-4000-8000-000000000001',
      '71100000-0000-4000-8000-000000000001',
      now,
      '60000000-0000-4000-8000-000000000001',
      practitionerRoleId,
      hash,
    ],
  );
}
