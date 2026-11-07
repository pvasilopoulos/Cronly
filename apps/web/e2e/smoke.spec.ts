import { test, expect } from '@playwright/test';

// Demo-seed credentials (packages/database/prisma/seed.ts). Override via env.
const EMAIL = process.env.E2E_EMAIL ?? 'petros@acme.gr';
const PASSWORD = process.env.E2E_PASSWORD ?? 'petros1234';

async function login(page) {
  await page.goto('/login');
  await page.getByRole('textbox', { name: /email/i }).or(page.locator('input[type="email"]')).first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/jobs');
}

test('owner can sign in and land on the jobs console', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Cron Jobs' })).toBeVisible();
});

test('jobs list supports searching and filtering', async ({ page }) => {
  await login(page);
  const search = page.getByPlaceholder(/search name, handler or group/i);
  await expect(search).toBeVisible();
  await search.fill('zzz-no-such-job');
  await expect(page.getByText(/no jobs match your filters/i)).toBeVisible();
  await search.fill('');
  // The status segmented control narrows to active jobs.
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(page.getByText(/showing \d+ of \d+ jobs/i)).toBeVisible();
});

test('executions page shows the KPI summary and run filters', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Executions' }).click();
  await page.waitForURL('**/runs');
  await expect(page.getByRole('heading', { name: 'Executions' })).toBeVisible();
  // KPI tiles and the status chips are the new addons.
  await expect(page.getByText('Success rate')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Failures' })).toBeVisible();
});

test('settings page exposes entitlements to an owner', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.waitForURL('**/settings');
  await expect(page.getByRole('heading', { name: 'Entitlements' })).toBeVisible();
  await expect(page.getByText(/your effective permissions/i)).toBeVisible();
});
