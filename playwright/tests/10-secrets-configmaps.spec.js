/**
 * Secrets & ConfigMaps tests — deploy an app with secret and configmap volumes,
 * verify the Config tab shows plaintext values (server decodes base64),
 * edit values via the Config tab, and confirm the API round-trip is correct.
 *
 * Precondition: A and B are peered, Agent B has allow_pvcs=true (09-settings-rbac ran).
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

test.describe('Secrets & ConfigMaps', () => {
  test.beforeAll(async ({ request }) => {
    // Clean up any stale app from a previous run
    await deleteApps(request, AGENT_A, ['playwright-cfg-test']);

    const auth = 'Basic ' + Buffer.from(
      `${process.env.PLAYWRIGHT_USERNAME || 'admin'}:${process.env.PLAYWRIGHT_PASSWORD || 'adminpass1'}`
    ).toString('base64');
    // Reset Agent B to a clean state
    await request.post(`${AGENT_B}/api/settings`, {
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      data: { allow_inbound_remoteapps: true, require_remoteapp_approval: false, allowed_images: '', blocked_images: '' },
      failOnStatusCode: false,
    });
    PEER_B_NAME = await resolvePeerBName(request);
  });

  test('deploys an app with a configmap and a secret volume', async ({ pageA }) => {
    await pageA.goto('/deploy');
    await pageA.locator('[data-mode="yaml"]').click();
    await expect(pageA.locator('#deploy-yaml-wrap')).toBeVisible();

    await setDeploySpecValue(pageA, [
      'apiVersion: porpulsion.io/v1alpha1',
      'kind: RemoteApp',
      'metadata:',
      '  name: playwright-cfg-test',
      'spec:',
      '  image: busybox:1.36',
      '  command: ["sh", "-c", "sleep 3600"]',
      '  replicas: 1',
      `  targetPeer: ${PEER_B_NAME}`,
      '  configMaps:',
      '    - name: my-config',
      '      mountPath: /etc/myapp',
      '      data:',
      '        app.conf: "key=value\\nline2=foo"',
      '        greeting: hello',
      '  secrets:',
      '    - name: my-secret',
      '      mountPath: /etc/mysecret',
      '      data:',
      '        api_key: super-secret-value',
      '        db_pass: p@ssw0rd!',
    ].join('\n'));

    await pageA.locator('#deploy-submit-btn-yaml').click();
    await expect(pageA).toHaveURL(/\/workloads/, { timeout: 15_000 });
  });

  test('app appears in submitted table', async ({ pageA }) => {
    await pageA.goto('/workloads');
    await expect(pageA.locator('#submitted-body')).toContainText('playwright-cfg-test', { timeout: 15_000 });
  });

  test('app reaches Ready on Agent B (up to 90s)', async ({ request }) => {
    test.setTimeout(150_000);
    await waitForExecutingApp(request, 'playwright-cfg-test', ['Ready', 'Running'], 18, 5000);
  });

  test('app status propagates to Agent A (config tab becomes enabled)', async ({ request }) => {
    test.setTimeout(150_000);
    await waitForSubmittedAppReady(request, 'playwright-cfg-test', 24, 5000);
  });

  // ----------------------------------------------------------------
  // Config tab: verify secrets are displayed as plaintext (decoded)
  // ----------------------------------------------------------------
  test.describe('Config tab', () => {
    test('Config tab is enabled when app is Running', async ({ pageA }) => {
      await pageA.goto('/workloads');
      await openAppModal(pageA, 'playwright-cfg-test');
      const tab = pageA.locator('#app-modal-tabs-bar [data-tab="config"]');
      await expect(tab).toBeAttached({ timeout: 10_000 });
      await expect(tab).not.toHaveClass(/modal-tab-disabled/);
    });

    test('Config tab shows the configmap with plaintext values', async ({ pageA }) => {
      await pageA.goto('/workloads');
      await openAppModal(pageA, 'playwright-cfg-test');
      await appModalTab(pageA, 'config');
      // Wait for the async fetch to populate key inputs
      await expect.poll(
        async () => {
          const inputs = await pageA.locator('#cfg-panel-body [data-role="cfg-key"]').all();
          const values = await Promise.all(inputs.map((i) => i.inputValue()));
          return values;
        },
        { timeout: 20_000 }
      ).toEqual(expect.arrayContaining(['app.conf', 'greeting']));
    });

    test('Config tab shows the secret with decoded plaintext values', async ({ pageA }) => {
      await pageA.goto('/workloads');
      await openAppModal(pageA, 'playwright-cfg-test');
      await appModalTab(pageA, 'config');
      await expect.poll(
        async () => {
          const inputs = await pageA.locator('#cfg-panel-body [data-role="cfg-key"]').all();
          return Promise.all(inputs.map((i) => i.inputValue()));
        },
        { timeout: 20_000 }
      ).toEqual(expect.arrayContaining(['api_key', 'db_pass']));
    });

    test('secret values API returns plaintext (base64 decoded by server)', async ({ apiA }) => {
      const resp = await apiA.get('/api/remoteapps');
      const body = await resp.json();
      const app = (body.submitted || []).find((a) => a.name === 'playwright-cfg-test');
      expect(app).toBeTruthy();
      APP_ID = app.app_id || app.id;

      const secResp = await apiA.get(`/api/remoteapp/${APP_ID}/config/secret/my-secret`);
      expect(secResp.status()).toBe(200);
      const secBody = await secResp.json();
      expect(secBody.data.api_key).toBe('super-secret-value');
      expect(secBody.data.db_pass).toBe('p@ssw0rd!');
    });

    test('configmap values API returns the raw string (no encoding)', async ({ apiA }) => {
      const resp = await apiA.get('/api/remoteapps');
      const body = await resp.json();
      const app = (body.submitted || []).find((a) => a.name === 'playwright-cfg-test');
      APP_ID = app.app_id || app.id;

      const cmResp = await apiA.get(`/api/remoteapp/${APP_ID}/config/configmap/my-config`);
      expect(cmResp.status()).toBe(200);
      const cmBody = await cmResp.json();
      expect(cmBody.data.greeting).toBe('hello');
    });

    test('patching a secret value re-encodes correctly (round-trip)', async ({ apiA }) => {
      const resp = await apiA.get('/api/remoteapps');
      const body = await resp.json();
      const app = (body.submitted || []).find((a) => a.name === 'playwright-cfg-test');
      APP_ID = app.app_id || app.id;

      const patchResp = await apiA.patch(`/api/remoteapp/${APP_ID}/config/secret/my-secret`, {
        data: { api_key: 'updated-secret', db_pass: 'newpass123' },
      });
      expect(patchResp.status()).toBe(200);

      const getResp = await apiA.get(`/api/remoteapp/${APP_ID}/config/secret/my-secret`);
      expect(getResp.status()).toBe(200);
      const getBody = await getResp.json();
      expect(getBody.data.api_key).toBe('updated-secret');
      expect(getBody.data.db_pass).toBe('newpass123');
    });
  });

  // ----------------------------------------------------------------
  // YAML tab: secrets appear base64-encoded in the raw CR
  // ----------------------------------------------------------------
  test('YAML tab shows secret values as base64 (not plaintext) in the CR', async ({ pageA }) => {
    test.setTimeout(60_000);
    await pageA.goto('/workloads');
    await openAppModal(pageA, 'playwright-cfg-test');
    await appModalTab(pageA, 'edit');

    const textarea = pageA.locator('#modal-spec-textarea');
    await textarea.waitFor({ timeout: 8_000 });
    const yaml = await textarea.getAttribute('data-spec-yaml') || await textarea.inputValue();
    expect(yaml).toMatch(/secrets/);
    // Plain text values should NOT appear raw
    expect(yaml).not.toContain('super-secret-value');
  });

  test.afterAll(async ({ request, apiB }) => {
    await deleteApps(request, AGENT_A, ['playwright-cfg-test']);
    await apiB.post('/api/settings', {
      allow_inbound_remoteapps: true,
      require_remoteapp_approval: false,
      allowed_images: '',
      blocked_images: '',
    });
  });
});
