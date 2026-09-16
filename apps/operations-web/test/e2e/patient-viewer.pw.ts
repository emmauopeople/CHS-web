import { expect, test, type Page, type Request, type Route } from '@playwright/test';

import {
  emptyPatientListPage,
  patientDetail,
  patientListPage,
  patientReferralDetail,
  syntheticPersonId,
} from './fixtures';

const sessionKey = 'chs.operations.session';

async function seedAuthenticatedSession(page: Page): Promise<void> {
  await page.addInitScript(({ key }) => {
    sessionStorage.setItem(
      key,
      JSON.stringify({
        accessToken: 'browser-test-token',
        expiresAt: Date.now() + 15 * 60 * 1000,
      }),
    );
  }, { key: sessionKey });
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  return request.postDataJSON() as Record<string, unknown>;
}

async function fulfillJson(
  route: Route,
  body: unknown,
  status = 200,
): Promise<void> {
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: 'application/json',
    status,
  });
}

test('protects the operations workspace until a browser session exists', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Clinical Operations' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in securely' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Patient Viewer' })).toHaveCount(0);
});

test('requires an access reason and completes the canonical patient workflow', async ({
  page,
}) => {
  await seedAuthenticatedSession(page);

  let searchRequest: Request | null = null;
  let detailRequest: Request | null = null;
  let referralRequest: Request | null = null;
  await page.route('**/api/v1/operations/patients/search', async (route) => {
    searchRequest = route.request();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await fulfillJson(route, patientListPage);
  });
  await page.route('**/api/v1/operations/patients/detail', async (route) => {
    detailRequest = route.request();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await fulfillJson(route, patientDetail);
  });
  await page.route('**/api/v1/operations/patients/referrals/detail', async (route) => {
    referralRequest = route.request();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fulfillJson(route, patientReferralDetail);
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Patient Viewer' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No patient search has been run' })).toBeVisible();

  const searchButton = page.getByRole('button', { name: 'Search', exact: true });
  await expect(searchButton).toBeDisabled();
  await expect(page.getByText('Select a reason for access before searching.')).toBeVisible();

  await page.getByLabel('Reason for access').selectOption('CARE_COORDINATION');
  await page.getByLabel('Name or CHS Medical ID').fill('Alpha');
  await searchButton.click();

  await expect(page.getByRole('status').filter({ hasText: 'Searching…' })).toBeVisible();
  await expect(page.getByRole('cell', { name: /Alpha Example/ })).toBeVisible();
  await expect(page.getByText('CHS-AAAA-BBBB-CCCC')).toBeVisible();

  expect(searchRequest).not.toBeNull();
  expect(searchRequest!.method()).toBe('POST');
  expect(searchRequest!.headers().authorization).toBe('Bearer browser-test-token');
  await expect.poll(async () => jsonBody(searchRequest!)).toEqual({
    reasonCode: 'CARE_COORDINATION',
    search: 'Alpha',
    status: 'ACTIVE',
    page: 1,
    pageSize: 25,
  });
  expect(page.url()).not.toContain('Alpha');
  expect(page.url()).not.toContain(syntheticPersonId);

  await page.getByRole('button', { name: 'View', exact: true }).click();
  await expect(
    page
      .getByRole('complementary', { name: 'Patient details' })
      .getByRole('status')
      .filter({ hasText: 'Loading canonical patient record…' }),
  ).toBeVisible();
  const panel = page.getByRole('complementary', { name: 'Patient details' });
  await expect(panel.getByRole('heading', { name: 'Alpha Example' })).toBeVisible();
  await expect(panel.getByText('Identity review required')).toBeVisible();
  await expect(panel.getByText('Acknowledgment: Acknowledged')).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Referral history' })).toBeVisible();
  await expect(panel.getByText('Bp Screening Referral')).toBeVisible();
  await expect(panel.getByText('North District Clinic')).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Screening history' })).toBeVisible();
  await expect(panel.getByText(/122\/78/)).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Lifestyle' })).toBeVisible();
  await expect(panel.getByText('Finalized canonical assessment')).toBeVisible();

  await panel.getByText('Source provenance', { exact: true }).click();
  await expect(panel.getByText('Desktop North')).toBeVisible();
  await expect(panel.getByText('Revision 4')).toBeVisible();
  await expect(panel.getByText('Source updated').first()).toBeVisible();
  await expect(panel.getByText('Last received').first()).toBeVisible();

  await panel.getByRole('button', { name: 'View history' }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'Loading referral history…' })).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Status history' })).toBeVisible();
  await expect(panel.getByText('Patient reached by phone')).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Follow-up history' })).toBeVisible();
  await expect(panel.getByText('Amlodipine')).toBeVisible();

  expect(detailRequest).not.toBeNull();
  expect(detailRequest!.method()).toBe('POST');
  expect(detailRequest!.headers().authorization).toBe('Bearer browser-test-token');
  await expect.poll(async () => jsonBody(detailRequest!)).toEqual({
    reasonCode: 'CARE_COORDINATION',
    personId: syntheticPersonId,
    page: 1,
    pageSize: 10,
    referralPage: 1,
    referralPageSize: 5,
  });
  expect(referralRequest).not.toBeNull();
  expect(referralRequest!.method()).toBe('POST');
  expect(referralRequest!.headers().authorization).toBe('Bearer browser-test-token');
  await expect.poll(async () => jsonBody(referralRequest!)).toEqual({
    reasonCode: 'CARE_COORDINATION',
    personId: syntheticPersonId,
    referralId: '44000000-0000-4000-8000-000000000001',
    statusPage: 1,
    statusPageSize: 10,
    followupPage: 1,
    followupPageSize: 5,
  });
  expect(page.url()).not.toContain('Alpha');
  expect(page.url()).not.toContain(syntheticPersonId);
  expect(page.url()).not.toContain('44000000');
});

test('renders bounded empty and service-error states', async ({ page }) => {
  await seedAuthenticatedSession(page);
  await page.route('**/api/v1/operations/patients/search', async (route) => {
    const body = await jsonBody(route.request());
    if (body.search === 'Unavailable') {
      await fulfillJson(
        route,
        {
          title: 'Service unavailable',
          status: 503,
          code: 'PATIENT_SERVICE_UNAVAILABLE',
          requestId: 'browser-test-request',
        },
        503,
      );
      return;
    }
    await fulfillJson(route, emptyPatientListPage);
  });

  await page.goto('/');
  await page.getByLabel('Reason for access').selectOption('CARE_DELIVERY');
  const patientSearch = page.getByLabel('Name or CHS Medical ID');
  const searchButton = page.getByRole('button', { name: 'Search', exact: true });

  await patientSearch.fill('No Match');
  await searchButton.click();
  await expect(page.getByRole('heading', { name: 'No patients found' })).toBeVisible();

  await patientSearch.fill('Unavailable');
  await searchButton.click();
  await expect(page.getByRole('alert')).toHaveText(
    'The patient service is temporarily unavailable.',
  );
  expect(page.url()).not.toContain('Unavailable');
});
