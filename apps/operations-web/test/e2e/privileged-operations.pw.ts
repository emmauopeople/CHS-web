import { expect, test, type Page, type Request, type Route } from '@playwright/test';

import {
  identityEvidence,
  identityResolutionResult,
  identityReviewDetail,
  identityReviewQueue,
  recoveryCandidateResult,
  recoveryEvidence,
  recoveryRevealResult,
  syncEvidence,
  syncMonitoringDetail,
  syncMonitoringPage,
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

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: 'application/json',
    status: 200,
  });
}

function expectAuthorizedPost(request: Request): void {
  expect(request.method()).toBe('POST');
  expect(request.headers().authorization).toBe('Bearer browser-test-token');
}

test('recovers an existing Medical ID only after explicit confirmation', async ({ page }) => {
  await seedAuthenticatedSession(page);

  let searchRequest: Request | null = null;
  let revealRequest: Request | null = null;
  await page.route('**/api/v1/operations/medical-id-recovery/search', async (route) => {
    searchRequest = route.request();
    await fulfillJson(route, recoveryCandidateResult);
  });
  await page.route('**/api/v1/operations/medical-id-recovery/reveal', async (route) => {
    revealRequest = route.request();
    await fulfillJson(route, recoveryRevealResult);
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Recover Medical ID' }).click();
  await expect(page.getByRole('heading', { name: 'Medical ID Recovery' })).toBeVisible();

  await page.getByLabel('Reason for access').selectOption('PATIENT_REQUEST');
  await page.getByLabel('Full name').fill(recoveryEvidence.fullName);
  await page.getByLabel('Date of birth').fill(recoveryEvidence.dateOfBirth);
  await page.getByRole('button', { name: 'Find Medical ID' }).click();

  await expect(page.getByRole('heading', { name: 'B••• T•••••••••' })).toBeVisible();
  const revealButton = page.getByRole('button', { name: 'Reveal existing Medical ID once' });
  await expect(revealButton).toBeDisabled();
  await expect(page.getByText(recoveryRevealResult.chsMedicalId)).toHaveCount(0);

  await page.getByRole('checkbox', { name: /I confirm this masked record/ }).check();
  await revealButton.click();
  await expect(page.getByText(recoveryRevealResult.chsMedicalId)).toBeVisible();
  await expect(page.getByText(/does not create a replacement identifier/)).toBeVisible();

  expect(searchRequest).not.toBeNull();
  expectAuthorizedPost(searchRequest!);
  await expect.poll(async () => jsonBody(searchRequest!)).toEqual({
    reasonCode: 'PATIENT_REQUEST',
    fullName: recoveryEvidence.fullName,
    dateOfBirth: recoveryEvidence.dateOfBirth,
  });
  expect(revealRequest).not.toBeNull();
  expectAuthorizedPost(revealRequest!);
  await expect.poll(async () => jsonBody(revealRequest!)).toEqual({
    reasonCode: 'PATIENT_REQUEST',
    recoveryToken: recoveryEvidence.recoveryToken,
    candidateReference: recoveryEvidence.candidateReference,
    confirmed: true,
  });

  for (const sensitiveValue of [
    recoveryEvidence.fullName,
    recoveryEvidence.dateOfBirth,
    recoveryEvidence.recoveryToken,
    recoveryEvidence.candidateReference,
    recoveryRevealResult.chsMedicalId,
  ]) {
    expect(page.url()).not.toContain(sensitiveValue);
  }
});

test('loads redacted synchronization metadata without URL leakage', async ({ page }) => {
  await seedAuthenticatedSession(page);

  let searchRequest: Request | null = null;
  let detailRequest: Request | null = null;
  await page.route('**/api/v1/operations/sync/batches/search', async (route) => {
    searchRequest = route.request();
    await fulfillJson(route, syncMonitoringPage);
  });
  await page.route('**/api/v1/operations/sync/batches/detail', async (route) => {
    detailRequest = route.request();
    await fulfillJson(route, syncMonitoringDetail);
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Sync Monitoring' }).click();
  await expect(page.getByText('Operations support', { exact: true })).toBeVisible();
  await page.getByLabel('Batch status').selectOption('PARTIAL');
  await page.getByLabel('Installation ID').fill(syncEvidence.installationId);
  await page.getByRole('button', { name: 'Load batches' }).click();

  await expect(page.getByText(syncEvidence.sourceBatchId)).toBeVisible();
  await expect(page.getByLabel('Current monitoring page summary')).toContainText('Needs attention1');
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();

  const panel = page.getByRole('complementary', { name: 'Synchronization batch details' });
  await expect(panel.getByRole('heading', { name: 'Synthetic Desktop One' })).toBeVisible();
  await expect(panel.getByText('UNSUPPORTED_UNIT')).toBeVisible();
  await expect(panel.getByText(/raw payloads, hashes, error paths, and error messages are excluded/)).toBeVisible();
  await expect(panel.getByText('Alpha Example')).toHaveCount(0);

  expect(searchRequest).not.toBeNull();
  expectAuthorizedPost(searchRequest!);
  await expect.poll(async () => jsonBody(searchRequest!)).toEqual({
    reasonCode: 'OPERATIONS_SUPPORT',
    status: 'PARTIAL',
    installationId: syncEvidence.installationId,
    page: 1,
    pageSize: 25,
  });
  expect(detailRequest).not.toBeNull();
  expectAuthorizedPost(detailRequest!);
  await expect.poll(async () => jsonBody(detailRequest!)).toEqual({
    reasonCode: 'OPERATIONS_SUPPORT',
    batchReference: syncEvidence.batchReference,
  });

  for (const sensitiveValue of [
    syncEvidence.installationId,
    syncEvidence.batchReference,
    syncEvidence.sourceBatchId,
  ]) {
    expect(page.url()).not.toContain(sensitiveValue);
  }
});

test('resolves an identity review only after evidence comparison and confirmation', async ({
  page,
}) => {
  await seedAuthenticatedSession(page);

  const resolutionNote = 'The submitted evidence matches the selected canonical identity.';
  let searchRequest: Request | null = null;
  let detailRequest: Request | null = null;
  let resolveRequest: Request | null = null;
  await page.route('**/api/v1/operations/identity-reviews/search', async (route) => {
    searchRequest = route.request();
    await fulfillJson(route, identityReviewQueue);
  });
  await page.route('**/api/v1/operations/identity-reviews/detail', async (route) => {
    detailRequest = route.request();
    await fulfillJson(route, identityReviewDetail);
  });
  await page.route('**/api/v1/operations/identity-reviews/resolve', async (route) => {
    resolveRequest = route.request();
    const body = await jsonBody(route.request());
    await fulfillJson(route, {
      ...identityResolutionResult,
      resolutionRequestId: body.resolutionRequestId,
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Identity Review' }).click();
  await expect(page.getByText('Identity reconciliation', { exact: true })).toBeVisible();
  await page.getByLabel('Evidence state').selectOption('AVAILABLE');
  await page.getByLabel('Installation ID').fill(identityEvidence.installation);
  await page.getByRole('button', { name: 'Load review cases' }).click();

  await expect(page.getByText('A•••• E••••')).toBeVisible();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Identity review details' });
  await expect(panel.getByRole('heading', { name: 'Submitted evidence' })).toBeVisible();
  await expect(panel.getByText('Alpha Example')).toBeVisible();
  await panel.getByRole('radio', { name: /A•••• E••••/ }).check();
  await panel.getByLabel('Reviewer note').fill(resolutionNote);

  const resolveButton = panel.getByRole('button', { name: 'Link selected identity' });
  await expect(resolveButton).toBeDisabled();
  await panel.getByRole('checkbox', { name: /I compared the submitted evidence/ }).check();
  await resolveButton.click();

  await expect(panel.getByRole('heading', { name: 'Existing identity linked' })).toBeVisible();
  await expect(panel.getByText(identityResolutionResult.chsMedicalId)).toBeVisible();
  await expect(page.getByText('0 open cases found')).toBeVisible();

  expect(searchRequest).not.toBeNull();
  expectAuthorizedPost(searchRequest!);
  await expect.poll(async () => jsonBody(searchRequest!)).toEqual({
    reasonCode: 'IDENTITY_RECONCILIATION',
    evidenceState: 'AVAILABLE',
    installationId: identityEvidence.installation,
    page: 1,
    pageSize: 25,
  });
  expect(detailRequest).not.toBeNull();
  expectAuthorizedPost(detailRequest!);
  await expect.poll(async () => jsonBody(detailRequest!)).toEqual({
    reasonCode: 'IDENTITY_RECONCILIATION',
    caseReference: identityEvidence.review,
  });
  expect(resolveRequest).not.toBeNull();
  expectAuthorizedPost(resolveRequest!);
  const resolutionBody = await jsonBody(resolveRequest!);
  expect(resolutionBody).toMatchObject({
    reasonCode: 'IDENTITY_RECONCILIATION',
    caseReference: identityEvidence.review,
    expectedUpdatedAt: identityReviewDetail.updatedAt,
    resolutionNote,
    resolution: {
      kind: 'LINK_EXISTING',
      candidatePersonReference: identityEvidence.candidate,
    },
  });
  expect(resolutionBody.resolutionRequestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

  for (const sensitiveValue of [
    identityEvidence.installation,
    identityEvidence.review,
    identityEvidence.candidate,
    resolutionNote,
    identityResolutionResult.chsMedicalId,
  ]) {
    expect(page.url()).not.toContain(sensitiveValue);
  }
});
