import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13), build-order item 22. Reads the real
 * identifiers `scripts/e2e-server.ts` wrote after seeding real backends — every spec asserts against these
 * real ids, never a hardcoded guess.
 */
export interface E2eFixtures {
  readonly baseUrl: string; readonly tenantA: string; readonly tenantB: string; readonly password: string;
  readonly heldActionId: string; readonly heldActionForApprovalId: string; readonly blockedActionId: string; readonly streamId: string; readonly assessmentId: string;
  readonly promotedGenerationId: string; readonly rejectedGenerationId: string; readonly secondPromotedGenerationId: string;
  readonly internalSystemId: string; readonly driftedToolId: string; readonly mcpServerId: string;
  readonly xssToolId: string; readonly xssMcpServerId: string;
}

export function loadFixtures(): E2eFixtures {
  return JSON.parse(readFileSync(resolve('e2e-fixtures.json'), 'utf8')) as E2eFixtures;
}

export async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/');
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForSelector('.sidebar');
}
