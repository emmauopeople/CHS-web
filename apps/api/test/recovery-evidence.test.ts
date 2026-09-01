import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  assertSafeRecoveryDatabaseUrl,
  assertSafeRecoverySchema,
  markBatchFailedForRecoveryDrill,
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

  it('accepts only a test-named or exact local Compose database URL', () => {
    expect(() =>
      assertSafeRecoveryDatabaseUrl(
        'postgresql://chs:local-only@localhost:5432/chs_test',
      ),
    ).not.toThrow();
    expect(() =>
      assertSafeRecoveryDatabaseUrl(
        'postgresql://chs:chs-local-only@localhost:5432/chs',
      ),
    ).not.toThrow();
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
    expect(() =>
      assertSafeRecoveryDatabaseUrl(
        'postgresql://chs:wrong-password@localhost:5432/chs',
      ),
    ).toThrow();
    expect(() =>
      assertSafeRecoveryDatabaseUrl(
        'postgresql://chs:chs-local-only@database.example/chs',
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

  it('records a constraint-valid completion time for a controlled failed batch', async () => {
    const failedAt = new Date('2026-08-27T00:00:01.000Z');
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const database = {
      async query(text: string, values: unknown[]) {
        calls.push({ text, values });
        return {
          rowCount: 1,
          rows: [
            {
              status: 'FAILED',
              completedAt: failedAt,
              responseBody: null,
            },
          ],
        };
      },
    };

    await markBatchFailedForRecoveryDrill(
      database as never,
      '10000000-0000-4000-8000-000000000042',
      failedAt,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("SET status = 'FAILED'");
    expect(calls[0]?.text).toContain('completed_at = $2');
    expect(calls[0]?.text).toContain("status = 'PROCESSING'");
    expect(calls[0]?.values).toEqual([
      '10000000-0000-4000-8000-000000000042',
      failedAt,
    ]);
  });
});
