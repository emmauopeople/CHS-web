import { Pool } from 'pg';

import type { AppConfig } from './config.js';

export type Database = Readonly<{
  pool: Pool;
  check: () => Promise<void>;
  close: () => Promise<void>;
}>;

export function createDatabase(config: AppConfig): Database {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    application_name: 'chs-api',
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
  });

  return {
    pool,
    async check() {
      await pool.query('select 1');
    },
    async close() {
      await pool.end();
    },
  };
}
