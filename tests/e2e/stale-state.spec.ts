import { test, expect } from '@playwright/test';
import { loadFixtures, login } from './helpers.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13), build-order item 5. Every consequential
 * mutation must be submit -> real backend response -> refetch -> render — never an optimistic flip to
 * ENABLED/PROMOTED/APPROVED/ROLLED_BACK/ACTIVE before the real response returns. Approval and rollback are
 * already proven this way in `actions-and-approval.spec.ts`/node:test suites; this file covers the
 * remaining consequential mutations: tool enable and incident acknowledgment.
 */
const fixtures = loadFixtures();

test('tool enable never optimistically shows ENABLED before the real Client Gateway response confirms it', async ({ page }) => {
  await login(page, 'admin', fixtures.password);
  await page.goto('/tools');
  const xssRow = page.locator('.panel', { hasText: 'xss.probe' });
  await xssRow.getByRole('button', { name: 'Enable…' }).click();
  await xssRow.getByLabel('Policy ID').fill('e2e-stale-policy');

  // Intercept the real enable call to delay its response — if the UI were optimistic, the DISABLED badge
  // would flip to ENABLED immediately on click, before this delayed real response ever arrives.
  await page.route('**/api/tools/*/enable', async route => {
    await new Promise(r => setTimeout(r, 600));
    await route.continue();
  });
  await xssRow.getByRole('button', { name: 'Confirm enable' }).click();
  await expect(xssRow.getByText('DISABLED').first()).toBeVisible();
  await expect(xssRow.getByText('ENABLED', { exact: true })).toHaveCount(0);
  await expect(xssRow.getByText('ENABLED', { exact: true }).first()).toBeVisible({ timeout: 5_000 });
});

test('incident acknowledgment never optimistically shows an acknowledgment before the real BFF response confirms it', async ({ page }) => {
  await login(page, 'admin', fixtures.password);
  await page.goto('/incidents');
  const row = page.locator('tr', { hasText: 'SCHEMA_DRIFT' });
  await page.route('**/api/incidents/*/acknowledge', async route => {
    await new Promise(r => setTimeout(r, 600));
    await route.continue();
  });
  const ackButton = row.getByRole('button', { name: 'Acknowledge' });
  if (await ackButton.count() > 0) {
    await ackButton.click();
    await expect(row.getByText('—', { exact: true })).toBeVisible();
    await expect(ackButton).toHaveCount(0, { timeout: 5_000 });
  }
});
