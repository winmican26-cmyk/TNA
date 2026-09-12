import { test, expect } from '@playwright/test';
import { loadFixtures, login } from './helpers.js';

const fixtures = loadFixtures();

test('evidence explorer finds the real seeded Ledger event by stream id and verifies its real hash-chain integrity', async ({ page }) => {
  await login(page, 'viewer', fixtures.password);
  await page.goto('/evidence');
  await page.getByLabel('Stream ID').fill(fixtures.streamId);
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText(fixtures.streamId).first()).toBeVisible();
  await page.getByRole('button', { name: 'check' }).first().click();
  await expect(page.getByText('VERIFIED', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
});

test('audit page shows the real assessment and the mandatory non-certification disclaimer', async ({ page }) => {
  await login(page, 'reviewer', fixtures.password);
  await page.goto('/audit');
  await expect(page.getByText('does not certify legal, regulatory, contractual, or industry compliance')).toBeVisible();
  await expect(page.getByText('Control Center integration test assessment')).toBeVisible();
});
