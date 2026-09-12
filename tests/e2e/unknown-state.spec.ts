import { test, expect } from '@playwright/test';
import { loadFixtures, login } from './helpers.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13), build-order item 6/TNA-85 ("Unknown Must
 * Never Render as Safe"). Every other spec in this directory is a real acceptance path (real backend, no
 * interception). This file is deliberately the ONE exception: it proves how the UI behaves for an enum
 * value NO accepted backend can currently produce (a genuinely future/unknown state) — by construction,
 * that scenario cannot be reproduced with a real backend today, so route interception is the only way to
 * exercise it. This is a defensive-robustness test, not a claim about current backend behavior.
 */
const fixtures = loadFixtures();

test('an unrecognized real-shaped action state renders as neutral/UNKNOWN styling, never as a positive-looking status by fallback', async ({ page }) => {
  await page.route('**/api/actions?*', async route => {
    const res = await route.fetch();
    const json = await res.json() as { items: { state: string }[] };
    json.items = json.items.map(i => ({ ...i, state: 'FUTURE_STATE' }));
    await route.fulfill({ response: res, json });
  });
  await login(page, 'viewer', fixtures.password);
  await page.goto('/actions');
  const badge = page.locator('.status-badge', { hasText: 'FUTURE_STATE' }).first();
  await expect(badge).toBeVisible();
  await expect(badge).toHaveClass(/status-UNKNOWN/);
  await expect(badge).not.toHaveClass(/status-AVAILABLE|status-COMPLETED|status-VERIFIED|status-HEALTHY/);
});

test('an unrecognized real-shaped improvement generation status renders as neutral/UNKNOWN, never as PROMOTED-looking', async ({ page }) => {
  await page.route('**/api/improvements?*', async route => {
    const res = await route.fetch();
    const json = await res.json() as { items: { status: string }[] };
    json.items = json.items.map(i => ({ ...i, status: 'SOMETHING_NEW' }));
    await route.fulfill({ response: res, json });
  });
  await login(page, 'viewer', fixtures.password);
  await page.goto('/improvements');
  await page.getByLabel('System ID').fill(fixtures.internalSystemId);
  await page.getByRole('button', { name: 'Load generations' }).click();
  const badge = page.locator('.status-badge', { hasText: 'SOMETHING_NEW' }).first();
  await expect(badge).toBeVisible();
  await expect(badge).toHaveClass(/status-UNKNOWN/);
  await expect(badge).not.toHaveClass(/status-AVAILABLE/);
});

test('an unrecognized real-shaped Ledger integrity verification result never renders as VERIFIED by fallback', async ({ page }) => {
  await page.route('**/api/evidence/streams/*/verify', async route => {
    const res = await route.fetch();
    const json = await res.json() as Record<string, unknown>;
    delete json.valid; // simulate a future response shape that no longer carries the boolean this UI expects
    await route.fulfill({ response: res, json });
  });
  await login(page, 'viewer', fixtures.password);
  await page.goto('/evidence');
  await page.getByLabel('Stream ID').fill(fixtures.streamId);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: 'check' }).first().click();
  // `valid` is now `undefined` -> `check === true ? 'VERIFIED' : 'CORRUPT'` would be WRONG (undefined is
  // falsy, so a naive `? :` would show CORRUPT, which is at least never a false positive, but the real
  // component explicitly treats a missing/malformed result as UNKNOWN rather than guessing either way).
  const badge = page.locator('.status-badge').filter({ hasText: /VERIFIED|CORRUPT|UNKNOWN|UNAVAILABLE/ }).first();
  await expect(badge).toBeVisible();
  await expect(badge).not.toHaveText('VERIFIED');
});
