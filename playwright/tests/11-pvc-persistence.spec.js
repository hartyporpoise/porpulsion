/**
 * PVC persistence tests — deploy an app with a PVC, write a file via the
 * exec terminal, restart the pod, and confirm the file survives.
 *
 * Preconditions:
 *   - A and B are peered (02-peering ran first)
 *   - Agent B has allow_pvcs=true (ensured in beforeAll)
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
let APP_ID;

const SENTINEL = 'porpulsion-pvc-ok';

test.describe('PVC persistence', () => {
  test.beforeAll(async ({ request }) => {
    const auth = 'Basic ' + Buffer.from(
      `${process.env.PLAYWRIGHT_USERNAME || 'admin'}:${process.env.PLAYWRIGHT_PASSWORD || 'adminpass1'}`
    ).toString('base64');
    // Reset Agent B — ensure inbound, no approval, PVCs enabled
    await request.post(`${AGENT_B}/api/settings`, {
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      data: {
        allow_inbound_remoteapps: true,
        require_remoteapp_approval: false,
        allow_pvcs: true,
        allowed_images: '',
        blocked_images: '',
      },
      failOnStatusCode: false,
    });
    // Verify settings took
    const { expect: pwExpect } = require('@playwright/test');
    await pwExpect.poll(
      async () => {
        const r = await request.get(`${AGENT_B}/api/settings`, {
          headers: { Authorization: auth },
          failOnStatusCode: false,
        });
        const b = await r.json();
        return b.allow_pvcs === true && b.require_remoteapp_approval === false;
      },
      { timeout: 10_000 }
    ).toBe(true);

    PEER_B_NAME = await resolvePeerBName(request);
  });

  test('deploys an alpine app with a 100Mi PVC', async ({ pageA }) => {
    await pageA.goto('/deploy');
    await pageA.locator('[data-mode="yaml"]').click();
    await expect(pageA.locator('#deploy-yaml-wrap')).toBeVisible();

    await setDeploySpecValue(pageA, [
      'apiVersion: porpulsion.io/v1alpha1',
      'kind: RemoteApp',
      'metadata:',
      '  name: playwright-pvc',
      'spec:',
      '  image: alpine:3.19',
      '  command: ["sh", "-c", "sleep 3600"]',
      '  replicas: 1',
      `  targetPeer: ${PEER_B_NAME}`,
      '  pvcs:',
      '    - name: data',
      '      mountPath: /data',
      '      storage: 100Mi',
      '      accessMode: ReadWriteOnce',
    ].join('\n'));

    await pageA.locator('#deploy-submit-btn-yaml').click();
    await expect(pageA).toHaveURL(/\/workloads/, { timeout: 15_000 });
  });

  test('app appears in submitted table', async ({ pageA }) => {
    await pageA.goto('/workloads');
    await expect(pageA.locator('#submitted-body')).toContainText('playwright-pvc', { timeout: 15_000 });
  });

  test('app reaches Ready on Agent B (up to 120s — PVC provisioning can be slow)', async ({ request }) => {
    test.setTimeout(150_000);
    await waitForExecutingApp(request, 'playwright-pvc', ['Ready', 'Running'], 24, 5000);
  });

  test('app status propagates to Agent A (terminal tab becomes enabled)', async ({ request }) => {
    test.setTimeout(150_000);
    await waitForSubmittedAppReady(request, 'playwright-pvc', 24, 5000);
  });

  test('detail modal Overview mentions the PVC volume', async ({ pageA }) => {
    await pageA.goto('/workloads');
    await openAppModal(pageA, 'playwright-pvc');
    await appModalTab(pageA, 'overview');
    const panel = pageA.locator('#app-modal-body [data-panel="overview"]');
    await expect.poll(
      async () => panel.textContent(),
      { timeout: 10_000 }
    ).toMatch(/data|100Mi|pvc/i);
  });

  // ----------------------------------------------------------------
  // Write a file via exec terminal
  // ----------------------------------------------------------------
  test('Terminal tab is enabled when app is Running', async ({ pageA }) => {
    await pageA.goto('/workloads');
    await openAppModal(pageA, 'playwright-pvc');
    const tab = pageA.locator('#app-modal-tabs-bar [data-tab="terminal"]');
    await expect(tab).toBeAttached({ timeout: 15_000 });
    await expect(tab).not.toHaveClass(/modal-tab-disabled/);
  });

  test('writes a sentinel file to /data via the exec terminal', async ({ pageA }) => {
    await pageA.goto('/workloads');
    await openAppModal(pageA, 'playwright-pvc');
    await appModalTab(pageA, 'terminal');

    // xterm container must be present
    await expect(pageA.locator('#exec-terminal-wrap')).toBeAttached({ timeout: 10_000 });

    // Select /bin/sh (available in alpine)
    await pageA.selectOption('#exec-shell-select', '/bin/sh', { force: true });

    // Wait for the WebSocket to connect — status text changes to 'Connected'
    await expect(
      pageA.locator('#exec-status .exec-status-text')
    ).toContainText('Connected', { timeout: 20_000 });

    // Type command via keyboard (xterm captures key events)
    await pageA.locator('#exec-terminal-wrap').click();
    await pageA.waitForTimeout(800);
    await pageA.keyboard.type(`echo ${SENTINEL} > /data/sentinel.txt`, { delay: 40 });
    await pageA.keyboard.press('Enter');
    await pageA.waitForTimeout(500);
    await pageA.keyboard.type('cat /data/sentinel.txt', { delay: 40 });
    await pageA.keyboard.press('Enter');

    // Wait a moment then confirm the WebSocket is still open
    await pageA.waitForTimeout(1500);
    await expect(
      pageA.locator('#exec-status .exec-status-text')
    ).toContainText('Connected');
  });

  // ----------------------------------------------------------------
  // Restart pod and confirm PVC data persists
  // ----------------------------------------------------------------
  test('triggers a rollout restart via the API', async ({ apiA }) => {
    const resp = await apiA.get('/api/remoteapps');
    const body = await resp.json();
    const app = (body.submitted || []).find((a) => a.name === 'playwright-pvc');
    APP_ID = app?.app_id || app?.id;
    expect(APP_ID).toBeTruthy();
    const restartResp = await apiA.post(`/api/remoteapp/${APP_ID}/restart`);
    expect(restartResp.status()).toBe(200);
  });

  test('app returns to Ready after restart (up to 90s)', async ({ request }) => {
    test.setTimeout(150_000);
    await new Promise((r) => setTimeout(r, 5000)); // let the rollout begin
    await waitForExecutingApp(request, 'playwright-pvc', ['Ready', 'Running'], 24, 5000);
  });

  test('sentinel file is still in /data after pod restart (PVC persisted)', async ({ apiA }) => {
    const resp = await apiA.get('/api/remoteapps');
    const body = await resp.json();
    const app = (body.submitted || []).find((a) => a.name === 'playwright-pvc');
    expect(app).toBeTruthy();
    APP_ID = app.app_id || app.id;

    // Get a pod name
    const podsResp = await apiA.get(`/api/remoteapp/${APP_ID}/pods`);
    const podsBody = await podsResp.json();
    const pod = (podsBody.pods || [])[0];
    expect(pod).toBeTruthy();

    // Exec cat /data/sentinel.txt
    const execResp = await apiA.post(`/api/remoteapp/${APP_ID}/exec`, {
      pod: pod.name,
      command: 'cat /data/sentinel.txt',
    });
    expect(execResp.status()).toBe(200);
    const execBody = await execResp.json();
    expect(execBody.output || '').toContain(SENTINEL);
  });

  test.afterAll(async ({ request, apiB }) => {
    await deleteApps(request, AGENT_A, ['playwright-pvc']);
    await apiB.post('/api/settings', {
      allow_inbound_remoteapps: true,
      require_remoteapp_approval: false,
      allow_pvcs: true,
      allowed_images: '',
      blocked_images: '',
    });
  });
});
