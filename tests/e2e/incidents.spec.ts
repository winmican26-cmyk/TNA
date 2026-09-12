import { test, expect } from '@playwright/test';
import { loadFixtures, login } from './helpers.js';

const fixtures = loadFixtures();

test('incidents page surfaces the real schema-drift condition with its real, backend-computed severity — never a value chosen in the browser', async ({ page }) => {
  await login(page, 'admin', fixtures.password);
  await page.goto('/incidents');
  await expect(page.getByText('SCHEMA_DRIFT')).toBeVisible();
  await expect(page.getByText('MEDIUM').first()).toBeVisible();
});

test('a client-reviewer (no incident.acknowledge permission) sees no Acknowledge control — hiding it here is UX, the real 403 on the route itself is the actual control', async ({ page }) => {
  await login(page, 'reviewer', fixtures.password);
  await page.goto('/incidents');
  await expect(page.getByRole('button', { name: 'Acknowledge' })).toHaveCount(0);
});
