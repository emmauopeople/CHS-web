import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const { Pool } = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
)('pg');
if (!process.env.DATABASE_URL || !process.env.FHIR_TEST_BASE_URL)
  throw new Error(
    'Run inside the private interoperability-check Compose service.',
  );
const url = new URL(process.env.DATABASE_URL);
const database = 'chs_interoperability_test';
const admin = new Pool({ connectionString: url.href });
try {
  if (
    !(
      await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [
        database,
      ])
    ).rowCount
  )
    await admin.query('CREATE DATABASE chs_interoperability_test');
} finally {
  await admin.end();
}
url.pathname = `/${database}`;
const metadata = await fetch(`${process.env.FHIR_TEST_BASE_URL}/metadata`, {
  headers: { accept: 'application/fhir+json' },
  signal: AbortSignal.timeout(30000),
});
if (!metadata.ok || (await metadata.json()).fhirVersion !== '4.0.1')
  throw new Error('Expected a private FHIR R4 server.');
console.info(
  'Private FHIR R4 metadata verified; using an isolated test database and synthetic records.',
);
const startedAt = new Date().toISOString();
const result = spawnSync(
  'pnpm',
  [
    '--filter',
    '@chs/api',
    'exec',
    'vitest',
    'run',
    'test/integration/provider-fhir-pilot.integration.test.ts',
    'test/integration/patient-history.integration.test.ts',
    '--no-file-parallelism',
    '--reporter=default',
    '--reporter=json',
    '--outputFile.json=/tmp/chs-pilot-tests.json',
  ],
  { stdio: 'inherit', env: { ...process.env, DATABASE_TEST_URL: url.href } },
);
process.exitCode = result.status ?? 1;
let tests = null;
try {
  const data = JSON.parse(readFileSync('/tmp/chs-pilot-tests.json', 'utf8'));
  tests = {
    passed: data.numPassedTests,
    failed: data.numFailedTests,
    total: data.numTotalTests,
  };
} catch {}
const fingerprints = {};
for (const dir of ['providers', 'fhir'])
  for (const name of readdirSync(
    new URL(`../../apps/api/src/${dir}/`, import.meta.url),
  ).sort()) {
    const path = `apps/api/src/${dir}/${name}`;
    fingerprints[path] = createHash('sha256')
      .update(readFileSync(new URL(`../../${path}`, import.meta.url)))
      .digest('hex');
  }
mkdirSync('/evidence', { recursive: true });
writeFileSync(
  '/evidence/interoperability-acceptance.json',
  JSON.stringify(
    {
      status:
        result.status === 0
          ? 'AUTOMATED_PASSED_MANUAL_PENDING'
          : 'AUTOMATED_FAILED',
      startedAt,
      finishedAt: new Date().toISOString(),
      fhirVersion: '4.0.1',
      tests,
      physicalTwoPcAcceptance: 'NOT_EXECUTED',
      sourceFingerprints: fingerprints,
    },
    null,
    2,
  ) + '\n',
);
