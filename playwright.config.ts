import { defineConfig } from '@playwright/test';

/**
 * TNA Client Control Center & Assurance UI v0.1 (Volume 13), build-order item 22. Real-browser E2E.
 * `webServer` starts the REAL fixture server (`scripts/e2e-server.ts`, compiled) — the real packaged BFF,
 * serving the real compiled frontend bundle, in front of real in-process backends — and every spec in
 * `tests/e2e/` drives it with a real Chromium browser. No route interception, no fixture JSON responses.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node dist/scripts/e2e-server.js',
    url: 'http://127.0.0.1:4173/ready',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
