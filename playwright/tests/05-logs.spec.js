/**
 * Logs tests — deploy a log-emitting app, open the detail modal, view the Logs tab.
 * Precondition: A and B are peered (02-peering ran first).
 */

const { test, expect, AGENT_A, AGENT_B } = require('./fixtures');
const {
  setDeploySpecValue,
  openAppModal,
  appModalTab,
  deleteApps,
  resolvePeerBName,
} = require('./helpers');

let PEER_B_NAME;

test.describe('Logs', () => {
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

    // Clean up any leftover playwright-logs from a previous run
    await deleteApps(request, AGENT_A, ['playwright-logs']);

    PEER_B_NAME = await resolvePeerBName(request);
  });

  test('deploys a log-emitting app via YAML', async ({ pageA }) => {
    expect(PEER_B_NAME).toBeTruthy();
    await pageA.goto('/deploy');
    await pageA.locator('[data-mode="yaml"]').click();
    await expect(pageA.locator('#deploy-yaml-wrap')).toBeVisible();

    await setDeploySpecValue(pageA, [
      'apiVersion: porpulsion.io/v1alpha1',
      'kind: RemoteApp',
      'metadata:',
      '  name: playwright-logs',
      'spec:',
      '  image: busybox:1.36',
      '  command: ["sh", "-c", "i=1; while [ $i -le 60 ]; do echo \\"log line $i\\"; i=$((i+1)); sleep 1; done"]',
      '  replicas: 1',
      `  targetPeer: ${PEER_B_NAME}`,
    ].join('\n'));

    await pageA.locator('#deploy-submit-btn-yaml').click();
    await expect(pageA).toHaveURL(/\/workloads/, { timeout: 15_000 });
  });

  test('app appears in the submitted apps table', async ({ pageA }) => {
    await pageA.goto('/workloads');
    await expect(pageA.locator('#submitted-body')).toContainText('playwright-logs', { timeout: 15_000 });
  });

  test('logs tab in detail modal renders the xterm terminal (up to 90s)', async ({ pageA }) => {
    await pageA.goto('/workloads');
    await openAppModal(pageA, 'playwright-logs');
    await appModalTab(pageA, 'logs');
    // Logs are rendered in xterm.js — check that the terminal container is present and active
    await expect(
      pageA.locator('#app-modal-body [data-panel="logs"] #logs-terminal-wrap')
    ).toBeAttached({ timeout: 90_000 });
  });

  test.afterAll(async ({ request }) => {
    await deleteApps(request, AGENT_A, ['playwright-logs']);
  });
});
