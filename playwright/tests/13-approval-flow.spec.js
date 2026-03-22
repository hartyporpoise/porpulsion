/**
 * Approval flow tests — enable require_remoteapp_approval on Agent B, deploy
 * an app from Agent A, then approve it via the Agent B UI and confirm it reaches Ready.
 *
 * Precondition: A and B are peered (02-peering ran first).
 * All state is restored in afterAll.
 */

const { test, expect, AGENT_A, AGENT_B } = require('./fixtures');
const {
  setDeploySpecValue,
  deleteApps,
  resolvePeerBName,
  waitForExecutingApp,
  waitForSubmittedAppReady,
  confirmDialog,
} = require('./helpers');

let PEER_B_NAME;

test.describe('Approval flow', () => {
  test.beforeAll(async ({ request, apiB }) => {
    // Clean up any stale apps from a previous run
    await deleteApps(request, AGENT_A, ['playwright-approval', 'playwright-reject']);

    // Set Agent B to require approval before any tests run
    await apiB.post('/api/settings', {
      allow_inbound_remoteapps: true,
      require_remoteapp_approval: true,
      allowed_images: '',
      blocked_images: '',
    });

    // Verify it took
    const { expect: pwExpect } = require('@playwright/test');
    await pwExpect.poll(
      async () => {
        const r = await apiB.get('/api/settings');
        const b = await r.json();
        return b.require_remoteapp_approval;
      },
      { timeout: 10_000 }
    ).toBe(true);

    PEER_B_NAME = await resolvePeerBName(request);
  });

  test('confirms Agent B has require_remoteapp_approval=true via API', async ({ apiB }) => {
    const resp = await apiB.get('/api/settings');
    const body = await resp.json();
    expect(body.require_remoteapp_approval).toBe(true);
  });

  test('deploys an app to a peer that requires approval', async ({ pageA }) => {
    await pageA.goto('/deploy');
    await pageA.locator('[data-mode="yaml"]').click();
    await expect(pageA.locator('#deploy-yaml-wrap')).toBeVisible();

    await setDeploySpecValue(pageA, [
      'apiVersion: porpulsion.io/v1alpha1',
      'kind: RemoteApp',
      'metadata:',
      '  name: playwright-approval',
      'spec:',
      '  image: nginx:alpine',
      '  replicas: 1',
      `  targetPeer: ${PEER_B_NAME}`,
    ].join('\n'));

    await pageA.locator('#deploy-submit-btn-yaml').click();
    await expect(pageA).toHaveURL(/\/workloads/, { timeout: 15_000 });
  });

  test('app appears in the submitted table on Agent A', async ({ pageA }) => {
    await pageA.goto('/workloads');
    await expect(pageA.locator('#submitted-body')).toContainText('playwright-approval', { timeout: 15_000 });
  });

  test('app does NOT reach executing on Agent B within a short window (held for approval)', async ({ pageB }) => {
    await pageB.waitForTimeout(8000);
    await pageB.goto(`${AGENT_B}/workloads`);
    await expect(pageB.locator('#executing-body')).not.toContainText('playwright-approval');
  });

  // ----------------------------------------------------------------
  // Approve via Agent B UI
  // ----------------------------------------------------------------
  test('approval banner appears on Agent B workloads page', async ({ pageB }) => {
    await pageB.goto(`${AGENT_B}/workloads`);
    await expect(pageB.locator('#approval-banner')).toBeVisible({ timeout: 15_000 });
    await expect(pageB.locator('.approval-item').first()).toBeVisible({ timeout: 10_000 });
    await expect(pageB.locator('.approval-item-name')).toContainText('playwright-approval');
  });

  test('clicking Approve on Agent B makes the app proceed to Ready', async ({ pageB, request }) => {
    await pageB.goto(`${AGENT_B}/workloads`);

    // Find the approval item for playwright-approval and click Approve
    await pageB.locator('.approval-item').filter({ hasText: 'playwright-approval' })
      .locator('[data-approve-app]')
      .click({ timeout: 15_000 });

    // Toast should confirm approval
    await expect(pageB.locator('#toast.show')).toBeVisible({ timeout: 8_000 });
    const toastText = await pageB.locator('#toast').textContent();
    expect(/approved/i.test(toastText)).toBe(true);

    // Wait for it to reach Ready on Agent B
    test.setTimeout(150_000);
    await waitForExecutingApp(request, 'playwright-approval', ['Ready', 'Running'], 18, 5000);
  });

  test('app also shows as Running on Agent A submitted list', async ({ pageA, request }) => {
    test.setTimeout(150_000);
    await waitForSubmittedAppReady(request, 'playwright-approval', 18, 5000);
    await pageA.goto('/workloads');
    const row = pageA.locator('#submitted-body tr').filter({ hasText: 'playwright-approval' });
    await expect(row.locator('td:nth-child(3)')).toContainText('Ready', { timeout: 10_000 });
  });

  // ----------------------------------------------------------------
  // Reject flow — deploy a second app and reject it
  // ----------------------------------------------------------------
  test.describe('Reject flow', () => {
    test('deploys a second app to be rejected', async ({ pageA }) => {
      await pageA.goto('/deploy');
      await pageA.locator('[data-mode="yaml"]').click();
      await setDeploySpecValue(pageA, [
        'apiVersion: porpulsion.io/v1alpha1',
        'kind: RemoteApp',
        'metadata:',
        '  name: playwright-reject',
        'spec:',
        '  image: nginx:alpine',
        '  replicas: 1',
        `  targetPeer: ${PEER_B_NAME}`,
      ].join('\n'));
      await pageA.locator('#deploy-submit-btn-yaml').click();
      await expect(pageA).toHaveURL(/\/workloads/, { timeout: 15_000 });
    });

    test('rejection banner shows playwright-reject on Agent B', async ({ pageB }) => {
      await pageB.goto(`${AGENT_B}/workloads`);
      await expect(pageB.locator('.approval-item-name')).toContainText('playwright-reject', { timeout: 15_000 });
    });

    test('clicking Reject marks the app as Rejected on Agent A', async ({ pageA, pageB }) => {
      await pageB.goto(`${AGENT_B}/workloads`);
      await pageB.locator('.approval-item').filter({ hasText: 'playwright-reject' })
        .locator('[data-reject-app]')
        .click({ timeout: 15_000 });
      await confirmDialog(pageB);
      await expect(pageB.locator('#toast.show')).toBeVisible({ timeout: 8_000 });
      const toastText = await pageB.locator('#toast').textContent();
      expect(/reject/i.test(toastText)).toBe(true);

      // Agent A should reflect Rejected status
      await pageA.goto('/workloads');
      const row = pageA.locator('#submitted-body tr').filter({ hasText: 'playwright-reject' });
      await expect(row.locator('td:nth-child(3)')).toContainText('Rejected', { timeout: 30_000 });
    });

    test.afterAll(async ({ request }) => {
      await deleteApps(request, AGENT_A, ['playwright-reject']);
    });
  });

  test.afterAll(async ({ request, apiB }) => {
    // Restore Agent B to auto-approve
    await apiB.post('/api/settings', { require_remoteapp_approval: false });
    await deleteApps(request, AGENT_A, ['playwright-approval']);
  });
});
