import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const defaultMigrationsDirectory = fileURLToPath(
  new URL('./migrations/', import.meta.url),
);

const migrationNamePattern = /^(\d{4})_([a-z][a-z0-9_]*)\.sql$/;

export async function discoverMigrations(
  migrationsDirectory = defaultMigrationsDirectory,
) {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();

  if (filenames.length === 0) {
    throw new Error(`No SQL migrations found in ${migrationsDirectory}`);
  }

  const versions = new Set();
  const migrations = [];

  for (const filename of filenames) {
    const match = migrationNamePattern.exec(filename);
    if (!match) {
      throw new Error(`Invalid migration filename: ${filename}`);
    }

    const version = match[1];
    if (versions.has(version)) {
      throw new Error(`Duplicate migration version: ${version}`);
    }
    versions.add(version);

    const sql = await readFile(join(migrationsDirectory, filename), 'utf8');
    if (sql.trim().length === 0) {
      throw new Error(`Migration is empty: ${filename}`);
    }

    migrations.push({
      version,
      filename,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }

  return migrations;
}
