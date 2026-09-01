import { readdir, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

type Endpoint = Readonly<{
  method: string;
  path: string;
  audience: string;
  authentication: string;
  permission: string | null;
  cache: string;
  purpose: string;
}>;

async function sourceFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: URL[] = [];
  for (const entry of entries) {
    const url = new URL(entry.name, directory);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(new URL(`${entry.name}/`, directory))));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(url);
    }
  }
  return files;
}

async function loadCatalog(): Promise<{
  schemaVersion: number;
  release: string;
  endpointCount: number;
  endpoints: Endpoint[];
}> {
  return JSON.parse(
    await readFile(
      new URL('../../../docs/api/release-1-catalog.json', import.meta.url),
      'utf8',
    ),
  ) as {
    schemaVersion: number;
    release: string;
    endpointCount: number;
    endpoints: Endpoint[];
  };
}

describe('Release 1 API documentation', () => {
  it('covers every registered route literal exactly once', async () => {
    const [catalog, guide, files] = await Promise.all([
      loadCatalog(),
      readFile(new URL('../../../docs/api/release-1.md', import.meta.url), 'utf8'),
      sourceFiles(new URL('../src/', import.meta.url)),
    ]);
    const source = (
      await Promise.all(files.map((file) => readFile(file, 'utf8')))
    ).join('\n');
    const routePattern =
      /app\.(get|post|put|patch|delete)(?:<[\s\S]*?>)?\(\s*['"]((?:\/api\/v1|\/health\/)[^'"]+|\/(?:metrics|version))['"]/g;
    const registeredEndpoints = [
      ...new Set(
        [...source.matchAll(routePattern)].map(
          (match) => `${match[1]?.toUpperCase()} ${match[2]}`,
        ),
      ),
    ].sort();
    const documentedEndpoints = catalog.endpoints
      .map((endpoint) => `${endpoint.method} ${endpoint.path}`)
      .sort();

    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.release).toBe('1');
    expect(catalog.endpointCount).toBe(catalog.endpoints.length);
    expect(new Set(documentedEndpoints).size).toBe(documentedEndpoints.length);
    expect(documentedEndpoints).toEqual(registeredEndpoints);

    for (const endpoint of catalog.endpoints) {
      expect(guide).toContain(`\`${endpoint.method} ${endpoint.path}\``);
    }
  });

  it('records bounded authentication, permissions, caching, and purposes', async () => {
    const catalog = await loadCatalog();
    const methods = new Set(['GET', 'POST']);
    const audiences = new Set(['platform', 'installation', 'operations']);
    const authentication = new Set(['NONE', 'INSTALLATION_BEARER', 'OIDC_BEARER']);
    const permissions = new Set([
      'PATIENT_READ',
      'MEDICAL_ID_RECOVER',
      'IDENTITY_REVIEW',
      'IDENTITY_REVIEW_RESOLVE',
      'SYNC_MONITOR',
    ]);

    for (const endpoint of catalog.endpoints) {
      expect(methods.has(endpoint.method)).toBe(true);
      expect(endpoint.path).toMatch(/^\//);
      expect(audiences.has(endpoint.audience)).toBe(true);
      expect(authentication.has(endpoint.authentication)).toBe(true);
      expect(endpoint.cache).toBe('NO_STORE');
      expect(endpoint.purpose).toMatch(/^[A-Z].*[.]$/);

      if (endpoint.audience === 'operations') {
        expect(endpoint.authentication).toBe('OIDC_BEARER');
        expect(permissions.has(endpoint.permission ?? '')).toBe(true);
      } else {
        expect(endpoint.permission).toBeNull();
      }
      if (endpoint.audience === 'installation') {
        expect(endpoint.authentication).toBe('INSTALLATION_BEARER');
      }
    }
  });
});
