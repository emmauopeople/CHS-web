import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { discoverMigrations } from '../src/migration-files.mjs';

test('database package uses a cross-platform syntax checker', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );

  assert.equal(packageJson.scripts.lint, 'node scripts/check-syntax.mjs');
  assert.equal(packageJson.scripts.typecheck, 'node scripts/check-syntax.mjs');
});

test('canonical migration is numbered, hashed, and contains the required model', async () => {
  const migrations = await discoverMigrations();

  assert.equal(migrations.length, 11);
  assert.equal(migrations[0].version, '0001');
  assert.equal(
    migrations[0].filename,
    '0001_canonical_screening_foundation.sql',
  );
  assert.equal(
    migrations[1].filename,
    '0002_desktop_installation_credentials.sql',
  );
  assert.match(migrations[1].checksum, /^[0-9a-f]{64}$/);
  assert.match(
    migrations[1].sql,
    /CREATE TABLE desktop_installation_credentials \(/,
  );
  assert.equal(
    migrations[2].filename,
    '0003_patient_identity_matching_indexes.sql',
  );
  assert.match(migrations[2].checksum, /^[0-9a-f]{64}$/);
  assert.match(migrations[2].sql, /ix_persons_identity_name_birth/);
  assert.match(migrations[2].sql, /ix_persons_identity_name_phone/);
  assert.match(migrations[2].sql, /ix_persons_identity_name_approximate_age/);
  assert.match(migrations[2].sql, /ix_person_identifiers_active_lookup/);
  assert.equal(
    migrations[3].filename,
    '0004_patient_viewer_query_indexes.sql',
  );
  assert.match(migrations[3].checksum, /^[0-9a-f]{64}$/);
  assert.match(migrations[3].sql, /ix_persons_viewer_status_name_prefix/);
  assert.match(migrations[3].sql, /ix_screening_encounters_viewer_history/);
  assert.equal(
    migrations[4].filename,
    '0005_operations_access_and_audit.sql',
  );
  assert.match(migrations[4].checksum, /^[0-9a-f]{64}$/);
  assert.match(migrations[4].sql, /CREATE TABLE operations_users/);
  assert.match(migrations[4].sql, /CREATE TABLE operations_access_grants/);
  assert.match(migrations[4].sql, /operations_user_id/);
  assert.match(migrations[4].sql, /outcome_code/);
  assert.equal(
    migrations[5].filename,
    '0006_medical_id_recovery.sql',
  );
  assert.match(migrations[5].checksum, /^[0-9a-f]{64}$/);
  assert.match(migrations[5].sql, /CREATE TABLE medical_id_recovery_cases/);
  assert.match(migrations[5].sql, /CREATE TABLE medical_id_recovery_candidates/);
  assert.match(migrations[5].sql, /REVIEW_REQUIRED/);
  assert.equal(
    migrations[6].filename,
    '0007_sync_operations_monitoring.sql',
  );
  assert.match(migrations[6].checksum, /^[0-9a-f]{64}$/);
  assert.match(migrations[6].sql, /'SYNC_MONITOR'/);
  assert.match(migrations[6].sql, /ix_sync_batches_operations_status_received/);
  assert.match(migrations[6].sql, /ix_sync_records_operations_outcomes/);
  assert.equal(
    migrations[7].filename,
    '0008_identity_review_evidence.sql',
  );
  assert.match(migrations[7].checksum, /^[0-9a-f]{64}$/);
  assert.match(
    migrations[7].sql,
    /CREATE TABLE identity_review_evidence_snapshots/,
  );
  assert.match(migrations[7].sql, /uq_identity_review_evidence_revision/);
  assert.match(migrations[7].sql, /ix_identity_review_evidence_latest/);
  assert.equal(
    migrations[8].filename,
    '0009_identity_review_resolution.sql',
  );
  assert.match(migrations[8].checksum, /^[0-9a-f]{64}$/);
  assert.match(migrations[8].sql, /ADD COLUMN acknowledgment_status/);
  assert.match(migrations[8].sql, /ADD COLUMN patient_status/);
  assert.match(migrations[8].sql, /'IDENTITY_REVIEW_RESOLVE'/);
  assert.match(migrations[8].sql, /CREATE TABLE identity_review_resolutions/);
  assert.match(migrations[8].sql, /uq_identity_review_resolutions_case/);
  assert.equal(
    migrations[9].filename,
    '0010_identity_resolution_delivery.sql',
  );
  assert.match(migrations[9].checksum, /^[0-9a-f]{64}$/);
  assert.match(
    migrations[9].sql,
    /CREATE TABLE identity_resolution_deliveries/,
  );
  assert.match(
    migrations[9].sql,
    /ix_identity_resolution_deliveries_pending/,
  );
  assert.match(migrations[9].sql, /delivery_status = 'PENDING'/);
  assert.equal(
    migrations[10].filename,
    '0011_lifestyle_ingestion.sql',
  );
  assert.match(migrations[10].checksum, /^[0-9a-f]{64}$/);
  assert.match(migrations[10].sql, /CREATE TABLE lifestyle_assessments/);
  assert.match(migrations[10].sql, /CREATE TABLE lifestyle_alcohol_baselines/);
  assert.match(migrations[10].sql, /CREATE TABLE lifestyle_tobacco_products/);
  assert.match(migrations[10].sql, /ADD COLUMN lifestyle_assessment_id/);
  assert.doesNotMatch(migrations[10].sql, /payload\s+jsonb/i);
  assert.match(migrations[0].checksum, /^[0-9a-f]{64}$/);

  const requiredTables = [
    'organizations',
    'locations',
    'desktop_installations',
    'location_source_links',
    'practitioners',
    'practitioner_source_links',
    'practitioner_roles',
    'screening_protocols',
    'protocol_source_links',
    'persons',
    'person_identifiers',
    'patient_source_links',
    'identity_review_cases',
    'identity_review_candidates',
    'screening_sessions',
    'screening_encounters',
    'screening_vital_sets',
    'vital_readings',
    'sync_batches',
    'sync_batch_actors',
    'sync_records',
    'audit_events',
  ];

  for (const table of requiredTables) {
    assert.match(
      migrations[0].sql,
      new RegExp(`CREATE TABLE ${table} \\(`),
      `migration must create ${table}`,
    );
  }
});
