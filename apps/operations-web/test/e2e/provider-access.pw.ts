import { test, expect } from '@playwright/test';
import { patientListPage } from './fixtures';
test('approves a hospital, issues a credential once and explicitly authorizes patient access', async ({
  page,
}) => {
  const id = '11111111-1111-4111-8111-111111111111',
    org = '22222222-2222-4222-8222-222222222222',
    client = '33333333-3333-4333-8333-333333333333',
    patient = '44444444-4444-4444-8444-444444444444';
  const secret = 'browser-synthetic-secret-' + 'A'.repeat(32);
  let approved = false,
    grants = 0,
    rotations = 0;
  await page.addInitScript(() =>
    sessionStorage.setItem(
      'chs.operations.session',
      JSON.stringify({
        accessToken: 'browser-test',
        expiresAt: Date.now() + 900000,
      }),
    ),
  );
  await page.route('**/api/v1/operations/providers/*', async (route) => {
    const action = route.request().url().split('/').pop();
    const body = route.request().postDataJSON();
    expect(body.reasonCode).toBe('PROVIDER_ADMINISTRATION');
    let result: unknown;
    if (action === 'search')
      result = {
        items: [
          {
            id,
            organizationName: 'Pilot Hospital',
            registrationIdentifier: 'TEST-123',
            contactEmail: 'provider@example.test',
            purpose: 'Authorized continuity of care',
            status: approved ? 'APPROVED' : 'PENDING',
            createdAt: new Date().toISOString(),
            clientId: approved ? client : null,
            oauthClientId: approved ? 'hospital-client' : null,
            clientStatus: approved ? 'ACTIVE' : null,
            scopes: approved ? ['fhir:read', 'history:read'] : null,
            expiresAt: null,
            organizationIds: approved ? [org] : [],
          },
        ],
        page: 1,
        hasMore: false,
        organizations: [{ id: org, name: 'Pilot Program' }],
      };
    else if (action === 'review') {
      expect(body.organizationIds).toEqual([org]);
      expect(body.confirmed).toBe(true);
      approved = true;
      result = {
        id,
        clientId: client,
        oauthClientId: 'hospital-client',
        clientSecret: secret,
        tokenEndpoint:
          'https://auth-chs.servicecam.org/realms/chs/protocol/openid-connect/token',
      };
    } else if (action === 'credentials') {
      rotations++;
      expect(body.confirmed).toBe(true);
      result = {
        clientId: client,
        oauthClientId: 'hospital-client',
        clientSecret: secret,
        tokenEndpoint:
          'https://auth-chs.servicecam.org/realms/chs/protocol/openid-connect/token',
      };
    } else {
      grants++;
      expect(body.personId).toBe(patient);
      expect(body.action).toBe('GRANT');
      result = { clientId: client, personId: patient, active: true };
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(result),
    });
  });
  await page.route('**/api/v1/operations/patients/search', async (route) => {
    expect(route.request().postDataJSON().reasonCode).toBe('CARE_COORDINATION');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ...patientListPage,
        items: patientListPage.items.map((p) => ({ ...p, personId: patient })),
      }),
    });
  });
  await page.route('**/api/v1/operations/fhir/status', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        counts: [{ status: 'PUBLISHED', count: 2 }],
        failures: [],
      }),
    }),
  );
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Provider Access', exact: true })
    .click();
  await page.getByRole('button', { name: 'Load provider requests' }).click();
  await page
    .getByRole('button', { name: 'Review request', exact: true })
    .click();
  await page.getByRole('checkbox', { name: 'Pilot Program' }).check();
  await page
    .getByLabel('Review reason', { exact: true })
    .fill('Verified hospital and signed access agreement');
  await page
    .getByRole('button', { name: 'Approve and issue credential' })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Client secret', exact: true }),
  ).toHaveValue(secret);
  expect(grants).toBe(0);
  await page.getByRole('button', { name: 'Dismiss credential' }).click();
  await expect(
    page.getByRole('textbox', { name: 'Client secret', exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel('Approved provider', { exact: true })
    .selectOption(client);
  await page
    .getByLabel('Medical ID for patient lookup', { exact: true })
    .fill('CHS-AAAA-BBBB-CCCC');
  await page.getByRole('button', { name: 'Find patient reference' }).click();
  await expect(
    page.getByLabel('Canonical patient UUID', { exact: true }),
  ).toHaveValue(patient);
  await page
    .getByLabel('Authorization basis', { exact: true })
    .fill('Verified patient authorization for continuity of care');
  await page
    .getByRole('button', { name: 'Grant patient access', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText(
    'Patient-sharing grant saved',
  );
  expect(grants).toBe(1);
  await page
    .getByRole('button', { name: 'Rotate credential', exact: true })
    .click();
  await page.getByRole('button', { name: 'Confirm credential action' }).click();
  await expect(
    page.getByRole('textbox', { name: 'Client secret', exact: true }),
  ).toHaveValue(secret);
  expect(rotations).toBe(1);
  await page.getByRole('button', { name: 'Accounts', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'Client secret', exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ local: localStorage, session: sessionStorage }),
    ),
  ).not.toContain(secret);
});
