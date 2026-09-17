import { expect, test, type Page } from '@playwright/test';
import historyFixture from '../../../../packages/contracts/fixtures/history/v1/patient-history-page.json' with { type: 'json' };
import { patientDetail, patientListPage, syntheticPersonId } from './fixtures';
const cursor = '20000000-0000-4000-8000-000000000001';
async function openPatient(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem(
      'chs.operations.session',
      JSON.stringify({
        accessToken: 'browser-test-token',
        expiresAt: Date.now() + 900000,
      }),
    ),
  );
  await page.route('**/api/v1/operations/patients/search', (route) =>
    route.fulfill({ json: patientListPage }),
  );
  await page.route('**/api/v1/operations/patients/detail', (route) =>
    route.fulfill({ json: patientDetail }),
  );
  await page.goto('/');
  await page.getByLabel('Reason for access').selectOption('CARE_DELIVERY');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Addenda, review, Food and OTC' }),
  ).toBeVisible();
  await page.getByLabel('From date (UTC)').fill('2026-09-01');
  await page.getByLabel('To date (UTC)').fill('2026-09-17');
}
test('renders source history, uses bounded pages, rejects stale continuation and refreshes', async ({
  page,
}) => {
  let stale = false;
  const requests: Record<string, unknown>[] = [];
  await page.route('**/api/v1/operations/patients/history', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers().authorization).toBe(
      'Bearer browser-test-token',
    );
    const body = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(body);
    if (stale && body.cursor) {
      await route.fulfill({
        status: 409,
        json: { code: 'HISTORY_CURSOR_STALE' },
      });
      return;
    }
    await route.fulfill({
      json: {
        ...historyFixture,
        personId: syntheticPersonId,
        patient: { ...historyFixture.patient, personId: syntheticPersonId },
        items: body.cursor
          ? historyFixture.items.slice(2)
          : historyFixture.items.slice(0, 2),
        nextCursor: body.cursor ? null : cursor,
      },
    });
  });
  await openPatient(page);
  const panel = page.getByRole('region', {
    name: 'Addenda, review, Food and OTC history',
  });
  await panel.getByRole('button', { name: 'Load history' }).click();
  await expect(panel.getByText('Synthetic late clarification')).toBeVisible();
  await expect(panel.getByText('Resolved', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(panel.getByText('Rice', { exact: true })).toBeVisible();
  await expect(
    panel.getByText('Local pharmacy', { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText('Synthetic late clarification')).toHaveCount(0);
  await expect(
    panel.getByRole('button', { name: 'Next', exact: true }),
  ).toBeDisabled();
  await panel.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(panel.getByText('Synthetic late clarification')).toHaveCount(1);
  stale = true;
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText(
    'History changed or this page expired',
  );
  await expect(panel.getByText('Synthetic late clarification')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Refresh history' }).click();
  await expect(panel.getByText('Synthetic late clarification')).toHaveCount(1);
  expect(requests[0]).toMatchObject({
    contractVersion: '1.0',
    personId: syntheticPersonId,
    reasonCode: 'CARE_DELIVERY',
    limit: 10,
    fromDate: '2026-09-01',
    toDate: '2026-09-17',
  });
  expect(requests[1]?.cursor).toBe(cursor);
  expect(page.url()).not.toContain(syntheticPersonId);
  expect(page.url()).not.toContain(cursor);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    panel.getByRole('button', { name: 'Refresh history' }),
  ).toBeVisible();
  expect(
    await panel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
});
test('discards a late response after changing history filters', async ({
  page,
}) => {
  let release: () => void = () => {};
  let arrived: () => void = () => {};
  const requested = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/operations/patients/history', async (route) => {
    arrived();
    await pending;
    await route.fulfill({
      json: {
        ...historyFixture,
        personId: syntheticPersonId,
        patient: { ...historyFixture.patient, personId: syntheticPersonId },
      },
    });
  });
  await openPatient(page);
  const panel = page.getByRole('region', {
    name: 'Addenda, review, Food and OTC history',
  });
  await panel.getByRole('button', { name: 'Load history' }).click();
  await requested;
  await page.getByLabel('History type').selectOption('FOOD');
  release();
  await expect(
    panel.getByText('Choose dates and load the patient’s additional history.'),
  ).toBeVisible();
  await expect(panel.getByText('Synthetic late clarification')).toHaveCount(0);
});
