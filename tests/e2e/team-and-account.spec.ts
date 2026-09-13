import { test, expect } from '@playwright/test';
import { loadFixtures, login } from './helpers.js';

/**
 * TNA Client Control Center & Assurance UI v0.1. Real-browser signup and password-reset flows: a
 * client-admin generates a real, single-use link through the real UI; a separate (logged-out) browser
 * context redeems it against the real backend. No email is involved anywhere — the link itself is copied
 * directly out of the admin's own screen, exactly as a real operator would deliver it out of band.
 */
const fixtures = loadFixtures();

test('signup: a client-admin invites a teammate, and the real invite link lets that teammate create their own account and sign in', async ({ page, context }) => {
  await login(page, 'admin', fixtures.password);
  await page.goto('/team');
  await page.getByRole('button', { name: 'Invite teammate…' }).click();
  const uniqueUsername = `e2e-teammate-${Date.now()}`;
  await page.getByLabel('Username').fill(uniqueUsername);
  await page.getByRole('button', { name: 'Confirm invite' }).click();

  const linkLocator = page.locator('code').filter({ hasText: '/signup?token=' });
  await expect(linkLocator).toBeVisible({ timeout: 10_000 });
  const signupUrl = (await linkLocator.textContent())!.trim();
  await page.getByRole('button', { name: 'I have copied this — dismiss' }).click();

  // A separate, logged-out browser context — the invitee never sees the admin's own session.
  const invitee = await context.browser()!.newContext();
  const inviteePage = await invitee.newPage();
  await inviteePage.goto(signupUrl);
  const newPassword = 'a-real-chosen-password-1';
  await inviteePage.getByLabel('Password', { exact: true }).fill(newPassword);
  await inviteePage.getByLabel('Confirm password').fill(newPassword);
  await inviteePage.getByRole('button', { name: 'Create account' }).click();
  await expect(inviteePage.getByText('Account created')).toBeVisible();
  await inviteePage.getByRole('button', { name: 'Continue to sign in' }).click();

  await inviteePage.locator('#username').fill(uniqueUsername);
  await inviteePage.locator('#password').fill(newPassword);
  await inviteePage.getByRole('button', { name: 'Sign in' }).click();
  await expect(inviteePage.locator('.sidebar')).toContainText(uniqueUsername);
  await invitee.close();
});

test('password reset: a client-admin creates a real reset link for an existing teammate, and redeeming it signs the teammate out of their prior session', async ({ page, context }) => {
  // Seed a real teammate via a real invite first (reusing the real signup path above).
  await login(page, 'admin', fixtures.password);
  await page.goto('/team');
  await page.getByRole('button', { name: 'Invite teammate…' }).click();
  const uniqueUsername = `e2e-resettarget-${Date.now()}`;
  await page.getByLabel('Username').fill(uniqueUsername);
  await page.getByRole('button', { name: 'Confirm invite' }).click();
  const inviteLinkLocator = page.locator('code').filter({ hasText: '/signup?token=' });
  await expect(inviteLinkLocator).toBeVisible({ timeout: 10_000 });
  const signupUrl = (await inviteLinkLocator.textContent())!.trim();
  await page.getByRole('button', { name: 'I have copied this — dismiss' }).click();

  const originalPassword = 'the-original-real-password-1';
  const teammateCtx = await context.browser()!.newContext();
  const teammatePage = await teammateCtx.newPage();
  await teammatePage.goto(signupUrl);
  await teammatePage.getByLabel('Password', { exact: true }).fill(originalPassword);
  await teammatePage.getByLabel('Confirm password').fill(originalPassword);
  await teammatePage.getByRole('button', { name: 'Create account' }).click();
  await teammatePage.getByRole('button', { name: 'Continue to sign in' }).click();
  await teammatePage.locator('#username').fill(uniqueUsername);
  await teammatePage.locator('#password').fill(originalPassword);
  await teammatePage.getByRole('button', { name: 'Sign in' }).click();
  await expect(teammatePage.locator('.sidebar')).toBeVisible();

  // Admin creates a real reset link for that teammate.
  await page.reload();
  const row = page.locator('tr', { hasText: uniqueUsername });
  await row.getByRole('button', { name: 'Create reset link' }).click();
  const resetLinkLocator = page.locator('code').filter({ hasText: '/reset-password?token=' });
  await expect(resetLinkLocator).toBeVisible({ timeout: 10_000 });
  const resetUrl = (await resetLinkLocator.textContent())!.trim();
  await page.getByRole('button', { name: 'I have copied this — dismiss' }).click();

  // Redeem it in a THIRD, unrelated context.
  const resetterCtx = await context.browser()!.newContext();
  const resetterPage = await resetterCtx.newPage();
  await resetterPage.goto(resetUrl);
  const newPassword = 'a-brand-new-real-password-1';
  await resetterPage.getByLabel('New password', { exact: true }).fill(newPassword);
  await resetterPage.getByLabel('Confirm new password').fill(newPassword);
  await resetterPage.getByRole('button', { name: 'Reset password' }).click();
  await expect(resetterPage.getByText('Password reset')).toBeVisible();

  // The teammate's ORIGINAL session (still open in its own browser context) must now be real dead —
  // reloading it must bounce back to the login page, never keep working.
  await teammatePage.reload();
  await expect(teammatePage.locator('#username')).toBeVisible();

  await teammateCtx.close();
  await resetterCtx.close();
});
