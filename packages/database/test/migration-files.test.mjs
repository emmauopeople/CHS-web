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

  assert.equal(migrations.length, 1);
  assert.equal(migrations[0].version, '0001');
  assert.equal(
    migrations[0].filename,
    '0001_canonical_screening_foundation.sql',
  );
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
