import { readFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

it('runs PostgreSQL integration files serially to avoid migration contention', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { scripts: Record<string, string> };

  expect(packageJson.scripts['test:integration']).toContain(
    '--no-file-parallelism',
  );
});
