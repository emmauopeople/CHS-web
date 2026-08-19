import { discoverMigrations } from './migration-files.mjs';

const migrations = await discoverMigrations();
console.info(
  `Validated ${migrations.length} database migration(s): ${migrations
    .map((migration) => migration.filename)
    .join(', ')}`,
);
