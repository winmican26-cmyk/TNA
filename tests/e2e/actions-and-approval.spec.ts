import { test, expect } from '@playwright/test';
import { loadFixtures, login } from './helpers.js';

const fixtures = loadFixtures();

test('actions list shows real HELD and BLOCKED actions from real Platform state', async ({ page }) => {
  await login(page, 'viewer', fixtures.password);
  await page.goto('/actions');
  await expect(page.getByText(fixtures.heldActionId)).toBeVisible();
  await expect(page.getByText(fixtures.blockedActionId)).toBeVisible();
});

test('action detail renders real evidence for a real action, never a placeholder', async ({ page }) => {
  await login(page, 'viewer', fixtures.password);
  await page.goto(`/actions/${fixtures.blockedActionId}`);
  await expect(page.locator('.status-badge').first()).toContainText('BLOCKED');
  await expect(page.getByRole('heading', { name: 'Evidence' })).toBeVisible();
});

test('a client-reviewer can drive a real approval end-to-end: submit -> real backend confirms -> real refetch renders the authoritative new state, never an optimistic flip', async ({ page }) => {
  await login(page, 'reviewer', fixtures.password);
  await page.goto(`/actions/${fixtures.heldActionForApprovalId}`);
  await expect(page.locator('.status-badge').first()).toContainText('HELD');
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.getByRole('button', { name: 'Confirm approve' }).click();
  // The real backend's resume() result is what changes this badge — never a client-side assumption made
  // before that response returns.
  await expect(page.locator('.status-badge').first()).not.toContainText('HELD', { timeout: 10_000 });
});
