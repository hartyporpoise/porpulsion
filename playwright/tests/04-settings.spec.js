/**
 * Settings page tests — view settings, verify agent name and selfUrl are shown.
 */

const { test, expect, AGENT_A } = require('./fixtures');

test.describe('Settings', () => {
  test('settings page loads', async ({ pageA }) => {
    await pageA.goto('/settings');
    await expect(pageA).toHaveURL(/\/settings/);
    await expect(pageA.locator('#settings-panel-agent')).toBeVisible();
  });

  test('shows the agent name', async ({ pageA, apiA }) => {
    const resp = await apiA.get('/api/invite');
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    const agentName = body.agent;
    expect(agentName).toBeTruthy();

    await pageA.goto('/settings');
    // Agent name is rendered server-side in the first .stg-row-val.mono
    await expect(
      pageA.locator('#settings-panel-agent .stg-row-val.mono').first()
    ).toContainText(agentName);
  });

  test('shows selfUrl', async ({ pageA }) => {
    await pageA.goto('/settings');
    // selfUrl is loaded via JS into #about-url — wait for it to populate (not the dash placeholder)
    await expect.poll(
      async () => pageA.locator('#about-url').textContent(),
      { timeout: 10_000 }
    ).not.toMatch(/^[—\s]*$/);
  });

  test('executing panel has the inbound workloads toggle', async ({ pageA }) => {
    await pageA.goto('/settings');
    await pageA.locator('.stg-tab[data-section="executing"]').click();
    await expect(pageA.locator('#settings-panel-executing #setting-inbound-apps')).toBeAttached();
  });
});
