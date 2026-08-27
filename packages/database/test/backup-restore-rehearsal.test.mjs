import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  assertSafeArchivePath,
  assertSafeContainerId,
  assertSafeRehearsalDatabaseName,
  databaseUrlFor,
} from '../scripts/backup-restore-rehearsal.mjs';

test('backup rehearsal limits destructive targets to generated names', () => {
  assert.doesNotThrow(() =>
    assertSafeRehearsalDatabaseName('chs_rehearsal_source_012345abcdef'),
  );
  assert.doesNotThrow(() =>
    assertSafeRehearsalDatabaseName('chs_rehearsal_restore_012345abcdef'),
  );
  assert.throws(() => assertSafeRehearsalDatabaseName('chs'));
  assert.throws(() => assertSafeRehearsalDatabaseName('postgres'));
  assert.throws(() =>
    assertSafeRehearsalDatabaseName('chs_rehearsal_source_012345abcdef_extra'),
  );

  assert.doesNotThrow(() =>
    assertSafeArchivePath('/tmp/chs-rehearsal-012345abcdef.dump'),
  );
  assert.throws(() => assertSafeArchivePath('/tmp/chs.dump'));
  assert.throws(() => assertSafeArchivePath('/var/lib/postgresql/data'));
});

test('backup rehearsal validates container IDs and changes only the database URL path', () => {
  assert.doesNotThrow(() => assertSafeContainerId('0123456789abcdef'));
  assert.throws(() => assertSafeContainerId('postgres'));
  assert.throws(() => assertSafeContainerId('--privileged'));

  const result = databaseUrlFor(
    'postgresql://chs:local-only@localhost:5432/chs_test?sslmode=disable',
    'chs_rehearsal_source_012345abcdef',
  );
  const parsed = new URL(result);
  assert.equal(parsed.pathname, '/chs_rehearsal_source_012345abcdef');
  assert.equal(parsed.username, 'chs');
  assert.equal(parsed.password, 'local-only');
  assert.equal(parsed.searchParams.get('sslmode'), 'disable');
});

test('database package exposes the dedicated backup/restore command', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(
    packageJson.scripts['test:backup-restore'],
    'node --env-file-if-exists=../../.env scripts/backup-restore-rehearsal.mjs',
  );
});
