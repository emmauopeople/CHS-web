import { readFile } from 'node:fs/promises';
import process from 'node:process';

import pg from 'pg';

import {
  InstallationCredentialLifecycleError,
  parseRevokeInstallationCredentialInput,
  parseRotateInstallationCredentialInput,
  revokeInstallationCredential,
  rotateInstallationCredential,
} from '../administration/installation-credential-lifecycle.js';

type Operation = 'rotate' | 'revoke';

async function main(): Promise<void> {
  const { operation, inputPath } = parseArguments(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const rawInput = await readFile(inputPath, 'utf8');
  const value: unknown = JSON.parse(rawInput);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    application_name: `chs-installation-credential-${operation}`,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 10_000,
    max: 1,
    statement_timeout: 10_000,
  });

  try {
    if (operation === 'rotate') {
      const input = parseRotateInstallationCredentialInput(value);
      const result = await rotateInstallationCredential(pool, input);
      writeResult({
        warning:
          'Sensitive: transfer the installationToken securely; it cannot be recovered from CHS',
        ...result,
      });
      return;
    }

    const input = parseRevokeInstallationCredentialInput(value);
    writeResult(await revokeInstallationCredential(pool, input));
  } finally {
    await pool.end();
  }
}

function parseArguments(arguments_: string[]): Readonly<{
  operation: Operation;
  inputPath: string;
}> {
  const [operation, inputFlag, inputPath, ...remaining] = arguments_;
  if (
    (operation !== 'rotate' && operation !== 'revoke') ||
    inputFlag !== '--input' ||
    !inputPath?.trim() ||
    remaining.length > 0
  ) {
    throw new Error(
      'Usage: credential command <rotate|revoke> --input <request.json>',
    );
  }
  return { operation, inputPath: inputPath.trim() };
}

function writeResult(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const knownError = error instanceof InstallationCredentialLifecycleError;
  process.stderr.write(
    `${JSON.stringify({
      code: knownError ? error.code : 'INSTALLATION_CREDENTIAL_COMMAND_FAILED',
      message: error instanceof Error ? error.message : 'Credential command failed',
    })}\n`,
  );
  process.exitCode = 1;
});
