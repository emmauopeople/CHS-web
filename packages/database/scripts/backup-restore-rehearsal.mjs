import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import pg from 'pg';

import { migrateWithClient, runMigrations } from '../src/migration-runner.mjs';

const rehearsalNamePattern =
  /^chs_rehearsal_(?:source|restore)_[0-9a-f]{12}$/;
const containerIdPattern = /^[a-f0-9]{12,64}$/i;
const archivePathPattern = /^\/tmp\/chs-rehearsal-[0-9a-f]{12}\.dump$/;

export function databaseUrlFor(connectionString, databaseName) {
  assertSafeRehearsalDatabaseName(databaseName);
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function assertSafeRehearsalDatabaseName(databaseName) {
  if (!rehearsalNamePattern.test(databaseName)) {
    throw new Error('Unsafe backup/restore rehearsal database name');
  }
}

export function assertSafeContainerId(containerId) {
  if (!containerIdPattern.test(containerId)) {
    throw new Error('Invalid PostgreSQL rehearsal container ID');
  }
}

export function assertSafeArchivePath(archivePath) {
  if (!archivePathPattern.test(archivePath)) {
    throw new Error('Unsafe backup/restore rehearsal archive path');
  }
}

async function runCommand(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} ${args[0] ?? ''} failed with exit code ${code ?? 'unknown'}${
            stderr.trim() ? `: ${stderr.trim()}` : ''
          }`,
        ),
      );
    });
  });
}

async function resolveContainerId() {
  const configured = process.env.DATABASE_REHEARSAL_CONTAINER_ID?.trim();
  if (configured) {
    assertSafeContainerId(configured);
    return configured;
  }

  const result = await runCommand('docker', [
    'compose',
    'ps',
    '-q',
    'postgres',
  ], { cwd: new URL('../../../', import.meta.url) });
  const containerId = result.stdout.trim();
  assertSafeContainerId(containerId);
  return containerId;
}

async function dockerExec(containerId, args) {
  assertSafeContainerId(containerId);
  return await runCommand('docker', ['exec', containerId, ...args]);
}

async function createDatabase(administrationPool, databaseName) {
  assertSafeRehearsalDatabaseName(databaseName);
  await administrationPool.query(`CREATE DATABASE "${databaseName}"`);
}

async function dropDatabase(administrationPool, databaseName) {
  assertSafeRehearsalDatabaseName(databaseName);
  await administrationPool.query(
    `SELECT pg_terminate_backend(pid)
     FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [databaseName],
  );
  await administrationPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
}

async function seedSyntheticEvidence(connectionString) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const timestamp = '2026-08-27T00:00:00.000Z';
    await client.query(
      `INSERT INTO organizations (
         id, identifier_system, identifier_value, name, organization_type_code,
         created_at, updated_at
       ) VALUES ($1, 'https://chs.example/id/organization', 'ORG-RESTORE-001',
         'Synthetic Restore Program', 'PROGRAM', $2, $2)`,
      ['10000000-0000-4000-8000-000000000041', timestamp],
    );
  } finally {
    await client.end();
  }
}

async function databaseSnapshot(connectionString) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const [tables, constraints, indexes, migrations, organizations, version] =
      await Promise.all([
        client.query(
          `SELECT table_name
           FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
           ORDER BY table_name`,
        ),
        client.query(
          `SELECT count(*)::integer AS count
           FROM pg_constraint AS constraint_record
           JOIN pg_namespace AS namespace
             ON namespace.oid = constraint_record.connamespace
           WHERE namespace.nspname = 'public'`,
        ),
        client.query(
          `SELECT indexname
           FROM pg_indexes
           WHERE schemaname = 'public'
           ORDER BY indexname`,
        ),
        client.query(
          `SELECT version, filename, checksum
           FROM schema_migrations
           ORDER BY version`,
        ),
        client.query(
          `SELECT id, identifier_system, identifier_value, name,
                  organization_type_code
           FROM organizations
           ORDER BY id`,
        ),
        client.query('SHOW server_version'),
      ]);

    return {
      serverVersion: version.rows[0]?.server_version,
      tables: tables.rows.map((row) => row.table_name),
      constraintCount: constraints.rows[0]?.count,
      indexes: indexes.rows.map((row) => row.indexname),
      migrations: migrations.rows,
      organizations: organizations.rows,
    };
  } finally {
    await client.end();
  }
}

function snapshotFingerprint(snapshot) {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

async function verifyRestoredMigrations(connectionString) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const result = await migrateWithClient({
      client,
      logger: { info() {} },
    });
    assert.deepEqual(result.applied, []);
    return result.total;
  } finally {
    await client.end();
  }
}

async function main() {
  const administrationUrl = process.env.DATABASE_TEST_URL;
  if (!administrationUrl) {
    throw new Error('DATABASE_TEST_URL is required for backup/restore rehearsal');
  }

  const parsedAdministrationUrl = new URL(administrationUrl);
  const databaseRole = decodeURIComponent(parsedAdministrationUrl.username);
  if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(databaseRole)) {
    throw new Error('DATABASE_TEST_URL must contain a valid PostgreSQL role');
  }

  const suffix = randomBytes(6).toString('hex');
  const sourceDatabase = `chs_rehearsal_source_${suffix}`;
  const restoreDatabase = `chs_rehearsal_restore_${suffix}`;
  const archivePath = `/tmp/chs-rehearsal-${suffix}.dump`;
  assertSafeRehearsalDatabaseName(sourceDatabase);
  assertSafeRehearsalDatabaseName(restoreDatabase);
  assertSafeArchivePath(archivePath);

  const sourceUrl = databaseUrlFor(administrationUrl, sourceDatabase);
  const restoreUrl = databaseUrlFor(administrationUrl, restoreDatabase);
  const administrationPool = new pg.Pool({ connectionString: administrationUrl });
  const containerId = await resolveContainerId();
  const startedAt = performance.now();

  try {
    await createDatabase(administrationPool, sourceDatabase);
    await runMigrations({
      connectionString: sourceUrl,
      logger: { info() {} },
    });
    await seedSyntheticEvidence(sourceUrl);
    const sourceSnapshot = await databaseSnapshot(sourceUrl);

    const dumpVersion = (
      await dockerExec(containerId, ['pg_dump', '--version'])
    ).stdout.trim();
    await dockerExec(containerId, [
      'pg_dump',
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      `--file=${archivePath}`,
      `--username=${databaseRole}`,
      `--dbname=${sourceDatabase}`,
    ]);
    const archiveList = (
      await dockerExec(containerId, ['pg_restore', '--list', archivePath])
    ).stdout;
    assert.match(archiveList, /TABLE DATA public organizations/);
    assert.match(archiveList, /TABLE DATA public schema_migrations/);
    const archiveBytes = Number(
      (
        await dockerExec(containerId, ['stat', '-c', '%s', archivePath])
      ).stdout.trim(),
    );
    assert(Number.isSafeInteger(archiveBytes) && archiveBytes > 0);

    await createDatabase(administrationPool, restoreDatabase);
    await dockerExec(containerId, [
      'pg_restore',
      '--exit-on-error',
      '--no-owner',
      '--no-privileges',
      `--username=${databaseRole}`,
      `--dbname=${restoreDatabase}`,
      archivePath,
    ]);

    const restoredMigrationCount = await verifyRestoredMigrations(restoreUrl);
    const restoredSnapshot = await databaseSnapshot(restoreUrl);
    assert.deepEqual(restoredSnapshot, sourceSnapshot);
    assert.equal(sourceSnapshot.tables.length, 46);
    assert.equal(restoredMigrationCount, 11);
    assert.equal(sourceSnapshot.organizations.length, 1);

    const sourceFingerprint = snapshotFingerprint(sourceSnapshot);
    const restoredFingerprint = snapshotFingerprint(restoredSnapshot);
    assert.equal(restoredFingerprint, sourceFingerprint);

    const evidence = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      syntheticData: true,
      archive: {
        format: 'PostgreSQL custom',
        bytes: archiveBytes,
        toolVersion: dumpVersion,
      },
      restoredDatabase: {
        serverVersion: sourceSnapshot.serverVersion,
        tableCount: sourceSnapshot.tables.length,
        constraintCount: sourceSnapshot.constraintCount,
        indexCount: sourceSnapshot.indexes.length,
        migrationCount: sourceSnapshot.migrations.length,
        syntheticOrganizationCount: sourceSnapshot.organizations.length,
        sourceFingerprint,
        restoredFingerprint,
      },
      status: 'passed',
    };
    const outputPath = new URL(
      process.env.BACKUP_RESTORE_EVIDENCE_PATH ??
        '../rehearsal-results/backup-restore-evidence.json',
      import.meta.url,
    );
    await mkdir(new URL('.', outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } finally {
    await dockerExec(containerId, ['rm', '-f', '--', archivePath]).catch(() => {});
    await dropDatabase(administrationPool, restoreDatabase).catch(() => {});
    await dropDatabase(administrationPool, sourceDatabase).catch(() => {});
    await administrationPool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
