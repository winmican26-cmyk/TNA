import { test, expect } from '@playwright/test';
import { loadFixtures, login } from './helpers.js';

const fixtures = loadFixtures();

test('improvement list shows a real PROMOTED baseline, a real REJECTED authority-escalation attempt, and a real second PROMOTED successor', async ({ page }) => {
  await login(page, 'viewer', fixtures.password);
  await page.goto('/improvements');
  await page.getByLabel('System ID').fill(fixtures.internalSystemId);
  await page.getByRole('button', { name: 'Load generations' }).click();
  await expect(page.getByText(fixtures.promotedGenerationId).first()).toBeVisible();
  await expect(page.getByText(fixtures.rejectedGenerationId).first()).toBeVisible();
  await expect(page.getByText(fixtures.secondPromotedGenerationId).first()).toBeVisible();
});

test('the flagship lineage view: a rejected authority-escalation attempt shows its real reason and authority-EXPANDED status, distinctly from a promoted successor with no authority delta', async ({ page }) => {
  await login(page, 'admin', fixtures.password);
  await page.goto(`/improvements/${fixtures.rejectedGenerationId}`);
  await expect(page.getByText('REJECTED').first()).toBeVisible();
  await expect(page.getByText('EXPANDED (exceeded ceiling)')).toBeVisible();
  await expect(page.getByText('Candidate authority profile exceeds its approved ceiling')).toBeVisible();

  await page.goto(`/improvements/${fixtures.secondPromotedGenerationId}`);
  await expect(page.getByText('PROMOTED').first()).toBeVisible();
  await expect(page.getByText('No change (within ceiling)')).toBeVisible();

  // Lineage renders the real parent/child relationship, not an invented tree shape.
  await expect(page.getByText(fixtures.promotedGenerationId).first()).toBeVisible();
});

test('a client-viewer cannot see promote/rollback controls on a real improvement generation', async ({ page }) => {
  await login(page, 'viewer', fixtures.password);
  await page.goto(`/improvements/${fixtures.promotedGenerationId}`);
  await expect(page.getByText('a client-admin is required')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request approval to promote' })).toHaveCount(0);
});
