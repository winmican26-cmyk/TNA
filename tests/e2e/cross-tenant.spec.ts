import { test, expect } from '@playwright/test';
import { loadFixtures, login } from './helpers.js';

const fixtures = loadFixtures();

test('URL tampering across tenants: a tenant-B session cannot reach a real tenant-A action by guessing/pasting its real id', async ({ page }) => {
  await login(page, 'viewer-b', fixtures.password);
  await page.goto(`/actions/${fixtures.heldActionId}`);
  // Tenant B's own real Platform instance has no such action — the real backend, not a frontend guess,
  // is what refuses this: `tenantEntry()` always resolves tenant B's own registry entry from the session,
  // so this request can never physically reach tenant A's backend at all.
  await expect(page.getByText('Could not load this action from the backend.')).toBeVisible();
});
