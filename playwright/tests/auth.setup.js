/**
 * Auth setup — runs once before the test suite for each agent.
 *
 * Logs in via the browser UI (handles CSRF correctly) and saves
 * the resulting session cookie to disk. All subsequent tests load
 * this storageState instead of logging in again.
 *
 * Two setup projects run this file:
 *   setup-a  (baseURL = AGENT_A)  -> .auth/agent-a.json
 *   setup-b  (baseURL = AGENT_B)  -> .auth/agent-b.json
 */

const { test: setup, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const USERNAME = process.env.PLAYWRIGHT_USERNAME || 'admin';
const PASSWORD = process.env.PLAYWRIGHT_PASSWORD || 'adminpass1';

// Derive which auth file to write based on the configured baseURL
setup('authenticate', async ({ page, baseURL }) => {
  const agentLabel = baseURL.includes('cluster-b') || baseURL.includes('8002') ? 'agent-b' : 'agent-a';
  const authFile = path.join(__dirname, '..', '.auth', `${agentLabel}.json`);

  // Ensure the .auth directory exists
  fs.mkdirSync(path.dirname(authFile), { recursive: true });

  // -----------------------------------------------------------------
  // First-run: if redirected to /signup, create the user
  // -----------------------------------------------------------------
  await page.goto('/signup');
  const url = page.url();

  if (!url.includes('/login')) {
    // /signup is showing — create the admin user
    await page.locator('#username').fill(USERNAME);
    await page.locator('#password').fill(PASSWORD);
    await page.locator('#confirm').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    // First-run signup auto-logs in and redirects to /
    await expect(page).not.toHaveURL(/\/signup/, { timeout: 15_000 });
  } else {
    // User already exists — just log in
    await page.locator('#username').fill(USERNAME);
    await page.locator('#password').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  }

  // Save session state (cookies + localStorage) for reuse by all tests
  await page.context().storageState({ path: authFile });
});
