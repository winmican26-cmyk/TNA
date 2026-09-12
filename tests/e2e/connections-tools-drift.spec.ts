import { test, expect } from '@playwright/test';
import { loadFixtures, login } from './helpers.js';

const fixtures = loadFixtures();

test('connections page shows the real registered MCP connection with a non-ambiguous status', async ({ page }) => {
  await login(page, 'viewer', fixtures.password);
  await page.goto('/connections');
  await expect(page.getByText('CRM Fixture')).toBeVisible();
  await expect(page.locator('.status-badge').first()).toBeVisible();
});

test('tools page renders the real "TOOL CONTRACT CHANGED" schema-drift banner, sourced from the real backend review_status/enabled fields, not a client-side hash comparison', async ({ page }) => {
  await login(page, 'admin', fixtures.password);
  await page.goto('/tools');
  await expect(page.getByText('TOOL CONTRACT CHANGED')).toBeVisible();
  await expect(page.getByText('POLICY_REVIEW_REQUIRED').first()).toBeVisible();
  await expect(page.getByText('DISABLED').first()).toBeVisible();
});

test('candidate-controlled MCP tool name/description render as inert text — never execute, and never visually stand in for a real TNA decision', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', d => { dialogs.push(d.message()); void d.dismiss(); });

  await login(page, 'admin', fixtures.password);
  await page.goto('/tools');

  // The raw, attacker-shaped strings must be present as literal, escaped TEXT content...
  await expect(page.getByText('<img src=x onerror=alert(1)>', { exact: false })).toBeVisible();
  await expect(page.getByText('TNA VERIFIED — SAFE TO PROMOTE', { exact: false })).toBeVisible();
  // ...clearly labeled as untrusted, provider-supplied content, never rendered as a TNA classification badge.
  await expect(page.getByText('Provider-supplied description (untrusted)').first()).toBeVisible();
  // ...and, most importantly, no script/onerror handler embedded in that text ever actually ran.
  expect(dialogs).toEqual([]);
});
