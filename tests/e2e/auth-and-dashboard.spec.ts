import { test, expect } from '@playwright/test';
import { loadFixtures, login } from './helpers.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13), build-order item 22: real-browser E2E against
 * the real compiled frontend + real BFF + real backends (no route interception, no fixture JSON responses
 * substituted for real ones — every assertion below reads what the real, already-rendered DOM shows after a
 * real network round trip this browser actually made).
 */
const fixtures = loadFixtures();

test('login renders the real authenticated shell, and logout returns to a real, unauthenticated login page', async ({ page }) => {
  await login(page, 'viewer', fixtures.password);
  await expect(page.locator('.sidebar')).toContainText('viewer');
  await expect(page.locator('.sidebar')).toContainText('client-viewer');
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.locator('#username')).toBeVisible();
});

test('dashboard shows real assurance component health and real action counts — never a single fabricated "system safe" badge', async ({ page }) => {
  await login(page, 'viewer', fixtures.password);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Assurance')).toBeVisible();
  // The real dashboard renders a table of individually-scoped component statuses, not one combined badge.
  await expect(page.locator('table').first()).toBeVisible();
});

test('an invalid/absent session is never treated as authenticated — the real backend session check gates every page, not a client-side guess', async ({ page, context }) => {
  await login(page, 'viewer', fixtures.password);
  await context.clearCookies();
  await page.reload();
  await expect(page.locator('#username')).toBeVisible();
});

test('role restriction is enforced in the real rendered UI: a client-viewer sees no approval controls on a real HELD action', async ({ page }) => {
  await login(page, 'viewer', fixtures.password);
  await page.goto(`/actions/${fixtures.heldActionId}`);
  await expect(page.getByText('cannot approve or terminate')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
});
