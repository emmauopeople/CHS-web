import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export function setupLocalFhir(root = repositoryRoot) {
  const directory = resolve(root, '.local-fhir');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const content = [
    'POSTGRES_DB=hapi_fhir',
    'POSTGRES_USER=fhir',
    `POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}`,
    '',
  ].join('\n');

  try {
    writeFileSync(resolve(directory, 'postgres.env'), content, {
      flag: 'wx',
      mode: 0o600,
    });
    return 'CREATED';
  } catch (error) {
    if (error.code === 'EEXIST') return 'PRESERVED';
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = setupLocalFhir();
  console.log(result === 'CREATED'
    ? 'Created local FHIR database credentials in .local-fhir/postgres.env.'
    : 'Preserved existing local FHIR database credentials.');
  console.log('Start the separate database with: pnpm local:fhir:up');
}
