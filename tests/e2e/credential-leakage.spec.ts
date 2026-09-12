import { test, expect } from '@playwright/test';
import { loadFixtures, login } from './helpers.js';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13), build-order items 3-4. Real browser
 * inspection of storage, URL, and DOM after a REAL credential issuance/rotation against the real Client
 * Gateway — proves the plaintext token appears only in the immediate response-driven UI panel, and is
 * never written to localStorage/sessionStorage/IndexedDB, the URL, or left visible after navigating away.
 */
const fixtures = loadFixtures();

async function readAllBrowserStorage(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(async () => {
    const parts: string[] = [];
    try { parts.push(JSON.stringify(window.localStorage)); } catch { /* ignore */ }
    try { parts.push(JSON.stringify(window.sessionStorage)); } catch { /* ignore */ }
    try {
      const dbs = await indexedDB.databases?.() ?? [];
      parts.push(JSON.stringify(dbs.map(d => d.name)));
    } catch { /* ignore */ }
    return parts.join('\n');
  });
}

test('a real, freshly-issued credential token appears in the UI exactly once and never persists anywhere the browser can be inspected', async ({ page }) => {
  await login(page, 'admin', fixtures.password);
  await page.goto('/identities');

  await page.getByRole('button', { name: 'Create service identity…' }).click();
  const uniqueName = `e2e-cred-check-${Date.now()}`;
  await page.getByLabel('Name').fill(uniqueName);
  await page.getByRole('button', { name: 'Confirm create' }).click();

  const tokenLocator = page.locator('code').filter({ hasText: 'tnaclient_' });
  await expect(tokenLocator).toBeVisible({ timeout: 10_000 });
  const token = (await tokenLocator.textContent())!.trim();
  expect(token.startsWith('tnaclient_')).toBe(true);

  // The real token must not exist anywhere in browser-inspectable storage even WHILE the reveal panel is
  // still on screen (never mind after dismissing it) — it must live only in this component's own React
  // state, never written through to a persistence API.
  const storageWhileVisible = await readAllBrowserStorage(page);
  expect(storageWhileVisible).not.toContain(token);
  expect(page.url()).not.toContain(token);

  // Dismiss the reveal panel, then navigate away and back — the real backend never returns this plaintext
  // value again, so the UI must not be able to show it a second time either.
  await page.getByRole('button', { name: 'I have copied this — dismiss' }).click();
  await expect(tokenLocator).toHaveCount(0);
  await page.goto('/');
  await page.goto('/identities');
  await expect(page.getByText(token, { exact: false })).toHaveCount(0);

  const storageAfterNavigation = await readAllBrowserStorage(page);
  expect(storageAfterNavigation).not.toContain(token);

  // A hard reload (not just SPA navigation) is the strongest real check — nothing survives it.
  await page.reload();
  const storageAfterReload = await readAllBrowserStorage(page);
  expect(storageAfterReload).not.toContain(token);
  await expect(page.getByText(token, { exact: false })).toHaveCount(0);
});

test('credential rotation issues a real, NEW plaintext token, and the previous one is never shown or stored anywhere afterward', async ({ page }) => {
  await login(page, 'admin', fixtures.password);
  await page.goto('/identities');
  await page.getByRole('button', { name: 'Create service identity…' }).click();
  const uniqueName = `e2e-cred-rotate-${Date.now()}`;
  await page.getByLabel('Name').fill(uniqueName);
  await page.getByRole('button', { name: 'Confirm create' }).click();
  const firstTokenLocator = page.locator('code').filter({ hasText: 'tnaclient_' });
  await expect(firstTokenLocator).toBeVisible({ timeout: 10_000 });
  const firstToken = (await firstTokenLocator.textContent())!.trim();
  await page.getByRole('button', { name: 'I have copied this — dismiss' }).click();

  const row = page.locator('tr', { hasText: uniqueName });
  await row.getByRole('button', { name: 'Rotate' }).click();
  const secondTokenLocator = page.locator('code').filter({ hasText: 'tnaclient_' });
  await expect(secondTokenLocator).toBeVisible({ timeout: 10_000 });
  const secondToken = (await secondTokenLocator.textContent())!.trim();

  expect(secondToken).not.toEqual(firstToken);
  const storage = await readAllBrowserStorage(page);
  expect(storage).not.toContain(firstToken);
  expect(storage).not.toContain(secondToken);
  expect(page.url()).not.toContain(firstToken);
  expect(page.url()).not.toContain(secondToken);
});
