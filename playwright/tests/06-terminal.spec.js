/**
 * Terminal tests — deploy a long-running container, open the Terminal tab,
 * verify the xterm widget renders and the shell selector exists.
 * Precondition: A and B are peered (02-peering ran first).
 */

const { test, expect, AGENT_A, AGENT_B } = require('./fixtures');
const {
  setDeploySpecValue,
  openAppModal,
  appModalTab,
  deleteApps,
  resolvePeerBName,
  waitForExecutingApp,
  waitForSubmittedAppReady,
} = require('./helpers');

let PEER_B_NAME;

test.describe('Terminal (exec)', () => {
  test.beforeAll(async ({ request }) => {
    const auth = 'Basic ' + Buffer.from(
      `${process.env.PLAYWRIGHT_USERNAME || 'admin'}:${process.env.PLAYWRIGHT_PASSWORD || 'adminpass1'}`
    ).toString('base64');

    // Reset Agent B settings
    await request.post(`${AGENT_B}/api/settings`, {
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      data: { allow_inbound_remoteapps: true, require_remoteapp_approval: false, allowed_images: '', blocked_images: '' },
      failOnStatusCode: false,
    });

    // Clean up leftovers
    await deleteApps(request, AGENT_A, ['playwright-busybox', 'playwright-logs']);

    PEER_B_NAME = await resolvePeerBName(request);
  });

  test('deploys a long-running alpine container', async ({ pageA }) => {
    expect(PEER_B_NAME).toBeTruthy();
    await pageA.goto('/deploy');
    await pageA.locator('[data-mode="yaml"]').click();
    await expect(pageA.locator('#deploy-yaml-wrap')).toBeVisible();

    await setDeploySpecValue(pageA, [
      'apiVersion: porpulsion.io/v1alpha1',
      'kind: RemoteApp',
      'metadata:',
      '  name: playwright-exec',
      'spec:',
      '  image: alpine:3.19',
      '  command: ["sh", "-c", "sleep 3600"]',
      '  replicas: 1',
      `  targetPeer: ${PEER_B_NAME}`,
    ].join('\n'));

    await pageA.locator('#deploy-submit-btn-yaml').click();
    await expect(pageA).toHaveURL(/\/workloads/, { timeout: 15_000 });
  });

  test('app reaches Ready on Agent B (up to 120s)', async ({ request }) => {
    await waitForExecutingApp(request, 'playwright-exec', ['Ready', 'Running'], 24, 5000);
  });

  test('app status propagates to Agent A (terminal tab becomes enabled)', async ({ request }) => {
    await waitForSubmittedAppReady(request, 'playwright-exec', 24, 5000);
  });

  test('detail modal has an enabled Terminal tab when app is Running', async ({ pageA }) => {
    await pageA.goto('/workloads');
    await openAppModal(pageA, 'playwright-exec');
    await expect(
      pageA.locator('#app-modal-tabs-bar [data-tab="terminal"]')
    ).not.toHaveClass(/modal-tab-disabled/, { timeout: 10_000 });
  });

  test('Terminal tab renders the xterm container', async ({ pageA }) => {
    await pageA.goto('/workloads');
    await openAppModal(pageA, 'playwright-exec');
    await pageA.locator('#app-modal-tabs-bar [data-tab="terminal"]:not(.modal-tab-disabled)').click({ timeout: 15_000 });
    await expect(
      pageA.locator('#app-modal-body [data-panel="terminal"].active')
    ).toBeAttached({ timeout: 5_000 });
    await expect(
      pageA.locator('#app-modal-body [data-panel="terminal"] #exec-terminal-wrap')
    ).toBeAttached();
  });

  test('shell selector dropdown exists in the terminal tab', async ({ pageA }) => {
    await pageA.goto('/workloads');
    await openAppModal(pageA, 'playwright-exec');
    await pageA.locator('#app-modal-tabs-bar [data-tab="terminal"]:not(.modal-tab-disabled)').click({ timeout: 15_000 });
    await expect(
      pageA.locator('#app-modal-body [data-panel="terminal"].active')
    ).toBeAttached({ timeout: 5_000 });
    await expect(
      pageA.locator('#app-modal-body [data-panel="terminal"] #exec-shell-select')
    ).toBeAttached({ timeout: 5_000 });
  });

  test.afterAll(async ({ request }) => {
    await deleteApps(request, AGENT_A, ['playwright-exec']);
  });
});
