/**
 * Auth tests — login, logout, user management.
 *
 * Login page tests run WITHOUT storageState (unauthenticated context).
 * Authenticated tests use the pageA fixture (pre-loaded session).
 */

const { test, expect, AGENT_A, AUTH_A } = require('./fixtures');
const { confirmDialog } = require('./helpers');

const USERNAME = process.env.PLAYWRIGHT_USERNAME || 'admin';
const PASSWORD = process.env.PLAYWRIGHT_PASSWORD || 'adminpass1';

test.describe('Login page', () => {
  // No storageState — tests an unauthenticated browser
  test.use({ storageState: { cookies: [], origins: [] } });

  test('shows the login form', async ({ page }) => {
    await page.goto(`${AGENT_A}/login`);
    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toContainText('Sign in');
  });

  test('shows an error for wrong credentials', async ({ page }) => {
    await page.goto(`${AGENT_A}/login`);
    await page.locator('#username').fill(USERNAME);
    await page.locator('#password').fill('wrongpassword!');
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('body')).toContainText('Invalid');
  });

  test('logs in with correct credentials and lands on dashboard', async ({ page }) => {
    await page.goto(`${AGENT_A}/login`);
    await page.locator('#username').fill(USERNAME);
    await page.locator('#password').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  });
});

test.describe('Authenticated session', () => {
  test('dashboard loads at /', async ({ pageA }) => {
    await pageA.goto('/');
    await expect(pageA).not.toHaveURL(/\/login/);
  });

  test('redirects to /login when not authenticated', async ({ browser }) => {
    // Create a fresh context with no cookies
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    await page.goto(`${AGENT_A}/`);
    await expect(page).toHaveURL(/\/login/);
    await ctx.close();
  });
});

test.describe('User management', () => {
  test('users page lists the admin user', async ({ pageA }) => {
    await pageA.goto('/users');
    await expect(pageA.locator('body')).toContainText(USERNAME);
  });

  test('can create a new user and see them in the list', async ({ pageA }) => {
    const tmpUser = 'playwright-tmp';
    const tmpPass = 'Tmp-pass-1234!';

    // Pre-cleanup: delete playwright-tmp if it exists from a prior run
    await pageA.goto('/users');
    const existingRow = pageA.locator('.user-list-row').filter({ hasText: tmpUser });
    if (await existingRow.count() > 0) {
      await existingRow.locator('button.btn-icon-danger').click();
      await confirmDialog(pageA);
      await expect(pageA.locator('body')).not.toContainText(tmpUser);
    }

    await pageA.locator('#new-username').fill(tmpUser);
    await pageA.locator('#new-password').fill(tmpPass);
    await pageA.locator('#new-confirm').fill(tmpPass);
    await pageA.locator('form[action="/users/add"] button[type="submit"]').click();
    await expect(pageA.locator('body')).toContainText(tmpUser);
  });

  test('can delete a non-self user', async ({ pageA }) => {
    await pageA.goto('/users');
    const row = pageA.locator('.user-list-row').filter({ hasText: 'playwright-tmp' });
    const count = await row.count();
    if (count > 0) {
      await row.locator('button.btn-icon-danger').click();
      await confirmDialog(pageA);
      await expect(pageA.locator('body')).not.toContainText('playwright-tmp');
    }
  });
});

// Logout test runs last in this file. Flask uses server-side sessions, so logging out
// deletes the session on the server — the cookie in .auth/agent-a.json becomes invalid.
// We re-login after verifying logout to restore a valid session for subsequent spec files.
test.describe('Logout', () => {
  test('logout button ends the session then re-establishes it', async ({ pageA, browser }) => {
    await pageA.goto('/');
    await pageA.locator('#user-menu-btn').click();
    await pageA.locator('form[action="/logout"] button[type="submit"]').click();
    await expect(pageA).toHaveURL(/\/login/);
    await pageA.goto('/');
    await expect(pageA).toHaveURL(/\/login/);

    // Re-login to restore a valid session in .auth/agent-a.json for specs 02+
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, baseURL: AGENT_A });
    const page = await ctx.newPage();
    await page.goto('/login');
    await page.locator('#username').fill(USERNAME);
    await page.locator('#password').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
    await ctx.storageState({ path: AUTH_A });
    await ctx.close();
  });
});
