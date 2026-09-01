import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { discoverMigrations } from '../src/migration-files.mjs';

const catalogUrl = new URL(
  '../../../docs/data-dictionary/release-1.json',
  import.meta.url,
);
const guideUrl = new URL(
  '../../../docs/data-dictionary/release-1.md',
  import.meta.url,
);

async function loadCatalog() {
  return JSON.parse(await readFile(catalogUrl, 'utf8'));
}

test('Release 1 data dictionary covers every canonical table exactly once', async () => {
  const [catalog, migrations, guide] = await Promise.all([
    loadCatalog(),
    discoverMigrations(),
    readFile(guideUrl, 'utf8'),
  ]);
  const migrationTables = migrations.flatMap((migration) =>
    [...migration.sql.matchAll(/^CREATE TABLE ([a-z0-9_]+) \(/gm)].map(
      (match) => match[1],
    ),
  );
  const expectedTables = ['schema_migrations', ...migrationTables].sort();
  const documentedTables = catalog.tables.map((entry) => entry.name).sort();

  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.release, '1');
  assert.equal(catalog.migrationCount, migrations.length);
  assert.equal(catalog.tableCount, expectedTables.length);
  assert.equal(new Set(documentedTables).size, documentedTables.length);
  assert.deepEqual(documentedTables, expectedTables);

  for (const table of expectedTables) {
    assert.ok(guide.includes(`| \`${table}\` |`), `${table} is missing from the guide`);
  }
});

test('Release 1 table entries have bounded ownership and exposure metadata', async () => {
  const catalog = await loadCatalog();
  const domains = new Set([
    'migration',
    'platform',
    'operations',
    'identity',
    'clinical',
    'sync',
    'audit',
  ]);
  const classifications = new Set([
    'METADATA',
    'OPERATIONAL',
    'IDENTITY',
    'CLINICAL',
    'SECURITY',
    'AUDIT',
  ]);
  const viewerAccess = new Set([
    'NONE',
    'MASKED_SUPPORT',
    'CANONICAL_PATIENT',
  ]);

  for (const entry of catalog.tables) {
    assert.match(entry.name, /^[a-z][a-z0-9_]*$/);
    assert.ok(domains.has(entry.domain), `${entry.name} has an unknown domain`);
    assert.ok(
      classifications.has(entry.classification),
      `${entry.name} has an unknown classification`,
    );
    assert.ok(
      viewerAccess.has(entry.viewerAccess),
      `${entry.name} has an unknown viewer boundary`,
    );
    assert.match(entry.purpose, /^[A-Z].*[.]$/);
  }
});
