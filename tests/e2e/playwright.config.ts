import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  outputDir: resolve('tests/e2e/test-results'),
  use: {
    ...devices['Desktop Chrome'],
    browserName: 'chromium',
    ...(process.env.E2E_USE_SYSTEM_CHROME === '1' ? { channel: 'chrome' as const } : {}),
    trace: 'retain-on-failure',
  },
});
