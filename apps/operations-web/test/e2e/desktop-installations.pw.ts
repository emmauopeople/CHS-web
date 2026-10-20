import { test, expect } from '@playwright/test';
test('enrolls with an authorized location, shows a token once and confirms rotation and revocation', async ({
  page,
}) => {
  const id = '11111111-1111-4111-8111-111111111111';
  const organizationId = '22222222-2222-4222-8222-222222222222';
  const locationId = '33333333-3333-4333-8333-333333333333';
  const credentialId = '44444444-4444-4444-8444-444444444444';
  const token = 'chs_inst_v1_' + 'A'.repeat(43);
  let enrolled = false;
  let rotations = 0;
  let revocations = 0;
  await page.addInitScript(() =>
    sessionStorage.setItem(
      'chs.operations.session',
      JSON.stringify({
        accessToken: 'browser-test-token',
        expiresAt: Date.now() + 900000,
      }),
    ),
  );
  await page.route(
    '**/api/v1/operations/desktop-installations/*',
    async (route) => {
      const action = route.request().url().split('/').pop();
      const body = route.request().postDataJSON();
      expect(route.request().headers().authorization).toBe(
        'Bearer browser-test-token',
      );
      expect(body.reasonCode).toBe('INSTALLATION_ADMINISTRATION');
      let result: unknown;
      if (action === 'search')
        result = {
          items: enrolled
            ? [
                {
                  id,
                  organizationId,
                  organizationName: 'Pilot',
                  configuredLocationId: locationId,
                  locationName: 'Test site',
                  deploymentName: 'Field PC',
                  timezone: 'Africa/Douala',
                  status: 'ACTIVE',
                  enrolledAt: new Date().toISOString(),
                  lastSeenAt: null,
                  credentialId,
                  tokenPrefix: 'chs_inst_v1_AAAAAAAA',
                  credentialExpiresAt: '2027-12-01T00:00:00Z',
                  credentialStatus: 'ACTIVE',
                },
              ]
            : [],
          page: 1,
          hasMore: false,
          locations: [
            {
              id: locationId,
              organizationId,
              name: 'Test site',
              organizationName: 'Pilot',
            },
          ],
          locationsTruncated: false,
        };
      else if (action === 'revoke') {
        revocations++;
        expect(body.confirmation).toBe('REVOKE_INSTALLATION_CREDENTIAL');
        result = {
          kind: 'REVOKED',
          installationId: id,
          credentialId,
          revokedAt: new Date().toISOString(),
        };
      } else {
        if (action === 'enroll') {
          enrolled = true;
          expect(body.organizationId).toBe(organizationId);
        } else {
          rotations++;
          expect(body.confirmation).toBe('ROTATE_INSTALLATION_CREDENTIAL');
        }
        result = {
          installationId: id,
          credentialId,
          credentialExpiresAt: '2027-12-01T00:00:00Z',
          installationToken: token,
          issuedAt: new Date().toISOString(),
        };
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(result),
      });
    },
  );
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Desktop Installations', exact: true })
    .click();
  await page.getByRole('button', { name: 'Load installations' }).click();
  await page
    .getByLabel('Central organization / location')
    .selectOption(locationId);
  await page.getByLabel('Desktop deployment name').fill('Field PC');
  await page.getByLabel('Desktop installation UUID').fill(id);
  await page.getByLabel('Desktop local location UUID').fill(locationId);
  await page
    .getByRole('button', { name: 'Enroll desktop and generate token' })
    .click();
  await expect(
    page.getByRole('region', { name: 'One-time installation token' }),
  ).toBeVisible();
  await expect(
    page.getByLabel('Installation enrollment token', { exact: true }),
  ).toHaveValue(token);
  await page
    .getByRole('button', { name: 'I saved the token — dismiss' })
    .click();
  await expect(
    page.getByRole('region', { name: 'One-time installation token' }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Replace token', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Confirm replacement' }),
  ).toBeDisabled();
  expect(rotations).toBe(0);
  await page
    .getByRole('checkbox', { name: 'I confirm this change for this desktop.' })
    .check();
  await page.getByRole('button', { name: 'Confirm replacement' }).click();
  await expect(
    page.getByLabel('Installation enrollment token', { exact: true }),
  ).toHaveValue(token);
  expect(rotations).toBe(1);
  await page
    .getByRole('button', { name: 'Patient Viewer', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Desktop Installations', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'One-time installation token' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Load installations' }).click();
  await page.getByRole('button', { name: 'Revoke token', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Confirm revocation' }),
  ).toBeDisabled();
  expect(revocations).toBe(0);
  await page
    .getByRole('checkbox', { name: 'I confirm this change for this desktop.' })
    .check();
  await page.getByRole('button', { name: 'Confirm revocation' }).click();
  await expect(
    page.getByText(
      'Credential revoked. This desktop can no longer synchronize.',
    ),
  ).toBeVisible();
  expect(revocations).toBe(1);
});
