import { runMigrations } from './migration-runner.mjs';

try {
  const result = await runMigrations({
    connectionString: process.env.DATABASE_URL,
  });
  console.info(
    `Database migrations complete: ${result.applied.length} applied, ${result.total} known`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
