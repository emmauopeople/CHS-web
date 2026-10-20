import { test, expect } from '@playwright/test';
test('super admins create admins and credentials disappear on dismissal and navigation', async ({
  page,
}) => {
  const id = '11111111-1111-4111-8111-111111111111';
  const org = '22222222-2222-4222-8222-222222222222';
  const actorId = '33333333-3333-4333-8333-333333333333';
  const password = 'Temporary-For-Browser-Test-Only!123';
  let created = false,
    suspended = false,
    resets = 0;
  await page.addInitScript(() =>
    sessionStorage.setItem(
      'chs.operations.session',
      JSON.stringify({
        accessToken: 'browser-test-token',
        expiresAt: Date.now() + 900000,
      }),
    ),
  );
  await page.route('**/api/v1/operations/accounts/*', async (route) => {
    const action = route.request().url().split('/').pop();
    const body = route.request().postDataJSON();
    expect(body.reasonCode).toBe('ACCOUNT_ADMINISTRATION');
    let response: unknown;
    if (action === 'search')
      response = {
        items: created
          ? [
              {
                id,
                username: 'pilot-admin',
                displayName: 'Pilot Admin',
                email: null,
                role: 'ADMIN',
                status: suspended ? 'SUSPENDED' : 'ACTIVE',
                organizationIds: [org],
              },
            ]
          : [],
        organizations: [{ id: org, name: 'Pilot Organization' }],
        actorId,
        actorRole: 'SUPER_ADMIN',
        page: 1,
        hasMore: false,
      };
    else if (action === 'create') {
      expect(body.role).toBe('ADMIN');
      expect(body.organizationId).toBe(org);
      created = true;
      response = {
        id,
        username: 'pilot-admin',
        temporaryPassword: password,
        requiresPasswordChange: true,
      };
    } else {
      expect(body.confirmed).toBe(true);
      expect(body.id).toBe(id);
      if (body.action === 'RESET_PASSWORD') {
        resets++;
        response = {
          id,
          username: 'pilot-admin',
          temporaryPassword: password,
          requiresPasswordChange: true,
        };
      } else {
        suspended = body.action === 'SUSPEND';
        response = { id, username: 'pilot-admin' };
      }
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(response),
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Accounts', exact: true }).click();
  await page.getByRole('button', { name: 'Load accounts' }).click();
  await page.getByLabel('Username', { exact: true }).fill('pilot-admin');
  await page.getByLabel('Display name', { exact: true }).fill('Pilot Admin');
  await page.getByLabel('Role', { exact: true }).selectOption('ADMIN');
  await page.getByLabel('Organization', { exact: true }).selectOption(org);
  await page
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Temporary password', exact: true }),
  ).toHaveValue(password);
  await expect(
    page.getByRole('heading', { name: 'Save this temporary password' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss password' }).click();
  await expect(
    page.getByRole('heading', { name: 'Save this temporary password' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Suspend', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(
    page.getByRole('cell', { name: 'SUSPENDED', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Reset password', exact: true })
    .click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Save this temporary password' }),
  ).toBeVisible();
  expect(resets).toBe(1);
  await page
    .getByRole('button', { name: 'Desktop Installations', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Save this temporary password' }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ local: localStorage, session: sessionStorage }),
    ),
  ).not.toContain(password);
});
