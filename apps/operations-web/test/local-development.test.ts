import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'vite';
import { loadConfig, LocalPortalAddressError } from '../src/config';

function localSettings(): void {
  vi.stubEnv('DEV', true);
  vi.stubEnv('VITE_OPERATIONS_OIDC_AUTHORIZATION_ENDPOINT', 'http://127.0.0.1:18080/realms/chs-local/protocol/openid-connect/auth');
  vi.stubEnv('VITE_OPERATIONS_OIDC_TOKEN_ENDPOINT', 'http://127.0.0.1:18080/realms/chs-local/protocol/openid-connect/token');
  vi.stubEnv('VITE_OPERATIONS_OIDC_CLIENT_ID', 'chs-operations-web');
}

function locationAt(url: string): Location {
  return new URL(url) as unknown as Location;
}

beforeEach(() => {
  vi.stubEnv('VITE_CHS_API_BASE_URL', '');
  vi.stubEnv('VITE_OPERATIONS_OIDC_END_SESSION_ENDPOINT', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('local portal sign-in address', () => {
  it('keeps the registered callback during initial load and authorization return', () => {
    localSettings();
    for (const suffix of ['', '?code=test-code&state=test-state']) {
      expect(loadConfig(locationAt(`http://127.0.0.1:4173/${suffix}`)).oidc.redirectUri)
        .toBe('http://127.0.0.1:4173/');
    }
  });

  it.each(['http://localhost:4173/', 'http://127.0.0.1:4174/', 'http://127.0.0.1:4173/index.html'])(
    'stops an unregistered callback from %s before starting PKCE', (url) => {
      localSettings();
      expect(() => loadConfig(locationAt(url))).toThrow(LocalPortalAddressError);
    },
  );

  it('preserves configured hosted provider paths and production HTTPS validation', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_OPERATIONS_OIDC_AUTHORIZATION_ENDPOINT', 'https://identity.example.org/auth');
    vi.stubEnv('VITE_OPERATIONS_OIDC_TOKEN_ENDPOINT', 'https://identity.example.org/token');
    vi.stubEnv('VITE_OPERATIONS_OIDC_CLIENT_ID', 'hosted-client');
    expect(loadConfig(locationAt('https://portal.example.org/operations')).oidc.redirectUri)
      .toBe('https://portal.example.org/operations');
    vi.stubEnv('VITE_OPERATIONS_OIDC_TOKEN_ENDPOINT', 'http://127.0.0.1:18080/token');
    expect(() => loadConfig(locationAt('https://portal.example.org/'))).toThrow('HTTPS');
  });
});

it('serves development styles and local token connections while retaining the production HTML policy', async () => {
  const source = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const server = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  });
  try {
    expect(server.config.server.strictPort).toBe(true);
    const served = await server.transformIndexHtml('/', source);
    expect(served).toContain("style-src 'self' 'unsafe-inline';");
    expect(served).toContain("connect-src 'self' https: http://127.0.0.1:18080");
    expect(served).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(source).toContain("style-src 'self';");
    expect(source).not.toContain('http://127.0.0.1:18080');
    expect(source).not.toContain('unsafe-inline');
  } finally {
    await server.close();
  }
});
