import { defineConfig, devices } from '@playwright/test';

// End-to-end tests for the console. These drive a real browser against a running
// web + API stack, so they are kept out of the unit `test` script and run via:
//   npm i -D @playwright/test && npx playwright install chromium
//   npx playwright test            (needs web on :3000 and API on :3001)
//
// In CI the stack is booted first (see .github/workflows/ci.yml, e2e job).
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
