import pg from 'pg';

import { discoverMigrations } from './migration-files.mjs';

const migrationLockId = '20260818001';

const createMigrationsTable = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    filename text NOT NULL UNIQUE,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_schema_migrations_version CHECK (version ~ '^[0-9]{4}$'),
    CONSTRAINT ck_schema_migrations_checksum CHECK (checksum ~ '^[0-9a-f]{64}$')
  )
`;

export async function migrateWithClient({
  client,
  migrationsDirectory,
  logger = console,
}) {
  const migrations = await discoverMigrations(migrationsDirectory);
  const localByVersion = new Map(
    migrations.map((migration) => [migration.version, migration]),
  );

  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [
      migrationLockId,
    ]);
    await client.query(createMigrationsTable);

    const appliedResult = await client.query(
      'SELECT version, filename, checksum FROM schema_migrations ORDER BY version',
    );

    for (const applied of appliedResult.rows) {
      const local = localByVersion.get(applied.version);
      if (!local) {
        throw new Error(
          `Applied migration ${applied.version} is missing from this release`,
        );
      }
      if (local.filename !== applied.filename) {
        throw new Error(
          `Migration ${applied.version} filename mismatch: database=${applied.filename} local=${local.filename}`,
        );
      }
      if (local.checksum !== applied.checksum) {
        throw new Error(
          `Migration ${applied.version} checksum mismatch; applied migrations are immutable`,
        );
      }
    }

    const appliedVersions = new Set(
      appliedResult.rows.map((migration) => migration.version),
    );
    const pending = migrations.filter(
      (migration) => !appliedVersions.has(migration.version),
    );

    for (const migration of pending) {
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO schema_migrations (version, filename, checksum)
         VALUES ($1, $2, $3)`,
        [migration.version, migration.filename, migration.checksum],
      );
      logger.info?.(`Applied database migration ${migration.filename}`);
    }

    await client.query('COMMIT');
    return {
      applied: pending.map((migration) => migration.filename),
      total: migrations.length,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function runMigrations({
  connectionString,
  migrationsDirectory,
  logger = console,
}) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await migrateWithClient({ client, migrationsDirectory, logger });
  } finally {
    await client.end();
  }
}
