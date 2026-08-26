import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*.pw.ts',
  outputDir: './test-results',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [
        ['line'],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
      ]
    : 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
    viewport: { width: 1440, height: 1000 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'vite --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      VITE_CHS_API_BASE_URL: '',
      VITE_OPERATIONS_OIDC_AUTHORIZATION_ENDPOINT:
        'http://127.0.0.1:4173/test-oidc/authorize',
      VITE_OPERATIONS_OIDC_TOKEN_ENDPOINT:
        'http://127.0.0.1:4173/test-oidc/token',
      VITE_OPERATIONS_OIDC_CLIENT_ID: 'operations-browser-test',
      VITE_OPERATIONS_OIDC_SCOPE: 'openid profile',
    },
  },
});
