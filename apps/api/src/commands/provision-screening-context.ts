import { readFile } from 'node:fs/promises';
import process from 'node:process';

import pg from 'pg';

import {
  parseScreeningContextProvisioningInput,
  provisionScreeningContext,
  ScreeningContextProvisioningError,
} from '../administration/screening-context-provisioning.js';

async function main(): Promise<void> {
  const inputPath = parseInputPath(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const rawInput = await readFile(inputPath, 'utf8');
  const input = parseScreeningContextProvisioningInput(JSON.parse(rawInput));
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    application_name: 'chs-screening-context-provisioning',
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 10_000,
    max: 1,
    statement_timeout: 10_000,
  });

  try {
    const result = await provisionScreeningContext(pool, input);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

function parseInputPath(arguments_: string[]): string {
  if (arguments_.length !== 2 || arguments_[0] !== '--input') {
    throw new Error(
      'Usage: pnpm admin:screening-context:provision -- --input <context.json>',
    );
  }
  const inputPath = arguments_[1]?.trim();
  if (!inputPath) throw new Error('The --input path is required');
  return inputPath;
}

main().catch((error: unknown) => {
  const knownError = error instanceof ScreeningContextProvisioningError;
  process.stderr.write(
    `${JSON.stringify({
      code: knownError ? error.code : 'SCREENING_CONTEXT_PROVISIONING_FAILED',
      message: error instanceof Error ? error.message : 'Provisioning failed',
    })}\n`,
  );
  process.exitCode = 1;
});
