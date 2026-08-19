import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceDirectories = ['scripts', 'src', 'test'];

async function findModules(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const modules = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      modules.push(...(await findModules(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      modules.push(entryPath);
    }
  }

  return modules;
}

const modulePaths = (
  await Promise.all(
    sourceDirectories.map((directory) => findModules(join(packageRoot, directory))),
  )
)
  .flat()
  .sort();

if (modulePaths.length === 0) {
  throw new Error('No database JavaScript modules were found for syntax checking');
}

for (const modulePath of modulePaths) {
  const result = spawnSync(process.execPath, ['--check', modulePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
}

process.stdout.write(`Checked syntax for ${modulePaths.length} database modules\n`);
