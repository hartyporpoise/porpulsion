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
  buildAuthHeader,
} = require('./helpers');

let PEER_B_NAME;
let APP_ID;

const SENTINEL = 'porpulsion-pvc-ok';

test.describe('PVC persistence', () => {
  test.beforeAll(async ({ request }) => {
    // Clean up any stale app from a previous run before deploying fresh
    await deleteApps(request, AGENT_A, ['playwright-pvc']);

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

  test('writes a sentinel file to /data by typing into the terminal UI', async ({ pageA, apiA }) => {
    // Resolve APP_ID for later tests
    const appsResp = await apiA.get('/api/remoteapps');
    const appsBody = await appsResp.json();
    const app = (appsBody.submitted || []).find((a) => a.name === 'playwright-pvc');
    expect(app).toBeTruthy();
    APP_ID = app.app_id || app.id;

    // Poll until the pod is Running and ready before opening the terminal
    await expect.poll(async () => {
      const r = await apiA.get(`/api/remoteapp/${APP_ID}/pods`);
      const b = await r.json();
      const pod = (b.pods || [])[0];
      return pod && pod.ready === true && pod.phase === 'Running';
    }, { timeout: 60_000, intervals: [3000] }).toBeTruthy();

    // Open the terminal tab
    await pageA.goto('/workloads');
    await openAppModal(pageA, 'playwright-pvc');

    // Alpine only has /bin/sh. The shell select is in the modal HTML (rendered at modal open),
    // so set it BEFORE clicking the terminal tab so _initExecTab() picks it up on first connect.
    await pageA.locator('#exec-shell-select').waitFor({ state: 'attached', timeout: 5_000 });
    await pageA.locator('#exec-shell-select').selectOption('/bin/sh', { force: true });

    await pageA.locator('#app-modal-tabs-bar [data-tab="terminal"]:not(.modal-tab-disabled)').click({ timeout: 15_000 });
    await expect(pageA.locator('#app-modal-body [data-panel="terminal"].active')).toBeAttached({ timeout: 5_000 });

    // Wait for the terminal to connect with /bin/sh
    await expect(pageA.locator('#exec-status .exec-status-text')).toHaveText('Connected', { timeout: 30_000 });

    // Click to focus xterm, then type commands and press Enter
    await pageA.locator('#exec-terminal-wrap').click();
    await pageA.keyboard.type(`echo ${SENTINEL} > /data/sentinel.txt`);
    await pageA.keyboard.press('Enter');
    await pageA.waitForTimeout(1000);
    await pageA.keyboard.type('echo done');
    await pageA.keyboard.press('Enter');

    // Give the shell a moment, then verify via API that the file was actually written to the PVC
    await pageA.waitForTimeout(1500);

    const podsResp = await apiA.get(`/api/remoteapp/${APP_ID}/pods`);
    const podsBody = await podsResp.json();
    const pod = (podsBody.pods || [])[0];
    expect(pod, 'pod must exist').toBeTruthy();

    const readResp = await apiA.post(`/api/remoteapp/${APP_ID}/exec`, {
      pod: pod.name,
      command: 'cat /data/sentinel.txt',
    });
    expect(readResp.status()).toBe(200);
    const readBody = await readResp.json();
    expect(readBody.output || '').toContain(SENTINEL);
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
    const auth = buildAuthHeader();
    // Wait for rollout to begin — poll until not Ready, then wait for Ready again
    await new Promise((r) => setTimeout(r, 8000));
    for (let i = 0; i < 6; i++) {
      const r = await request.get(`${AGENT_B}/api/remoteapps`, { headers: { Authorization: auth }, failOnStatusCode: false });
      if (r.ok()) {
        const b = await r.json();
        const all = [...(b.submitted || []), ...(b.executing || [])];
        const app = all.find((a) => a.name === 'playwright-pvc' || a.name.endsWith('-playwright-pvc'));
        if (!app || (app.status !== 'Ready' && app.status !== 'Running')) break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
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
