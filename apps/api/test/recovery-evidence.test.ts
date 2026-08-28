import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  assertSafeRecoveryDatabaseUrl,
  assertSafeRecoverySchema,
} from './recovery/sync-recovery-evidence.js';

describe('synchronization recovery evidence command', () => {
  it('limits destructive schema cleanup to generated recovery schemas', () => {
    expect(() =>
      assertSafeRecoverySchema(
        'chs_recovery_0123456789abcdef0123456789abcdef',
      ),
    ).not.toThrow();
    expect(() => assertSafeRecoverySchema('public')).toThrow();
    expect(() => assertSafeRecoverySchema('chs_recovery_test')).toThrow();
    expect(() =>
      assertSafeRecoverySchema(
        'chs_recovery_0123456789abcdef0123456789abcdef_extra',
      ),
    ).toThrow();
  });

  it('refuses a database URL that is not explicitly test-named', () => {
    expect(() =>
      assertSafeRecoveryDatabaseUrl(
        'postgresql://chs:local-only@localhost:5432/chs_test',
      ),
    ).not.toThrow();
    expect(() =>
      assertSafeRecoveryDatabaseUrl(
        'postgresql://chs:local-only@localhost:5432/chs',
      ),
    ).toThrow();
    expect(() =>
      assertSafeRecoveryDatabaseUrl(
        'postgresql://chs:local-only@localhost:5432/postgres',
      ),
    ).toThrow();
    expect(() =>
      assertSafeRecoveryDatabaseUrl(
        'postgresql://chs:local-only@localhost:5432/chs_test_prod',
      ),
    ).toThrow();
  });

  it('exposes the dedicated PostgreSQL-backed recovery command', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts['test:recovery']).toContain(
      'test/recovery/sync-recovery-evidence.ts',
    );
  });
});
