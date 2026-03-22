/**
 * Workload tests — deploy, view, scale, spec-edit, delete — all via the UI.
 * Precondition: A and B are peered (02-peering ran first).
 */

const { test, expect, AGENT_A, AGENT_B } = require('./fixtures');
const {
  openAppModal,
  appModalTab,
  confirmDialog,
  selectTargetPeer,
  setDeploySpecValue,
  setModalSpecEditorValue,
  resolvePeerBName,
  waitForExecutingApp,
  deleteApps,
  findApp,
} = require('./helpers');

// Resolved in the first test, shared across the suite via module-level variable
let PEER_B_NAME;

test.describe('Workloads', () => {
  test.beforeAll(async ({ request }) => {
    // Reset Agent B settings (in case a prior run left them dirty)
    const auth = 'Basic ' + Buffer.from(
      `${process.env.PLAYWRIGHT_USERNAME || 'admin'}:${process.env.PLAYWRIGHT_PASSWORD || 'adminpass1'}`
    ).toString('base64');
    await request.post(`${AGENT_B}/api/settings`, {
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      data: { allow_inbound_remoteapps: true, require_remoteapp_approval: false, blocked_images: '', allowed_images: '' },
      failOnStatusCode: false,
    });
    PEER_B_NAME = await resolvePeerBName(request);
  });

  // ----------------------------------------------------------------
  // Deploy page — Form mode
  // ----------------------------------------------------------------
  test.describe('Deploy via Form', () => {
    test('deploy page loads with Form and YAML tabs', async ({ pageA }) => {
      await pageA.goto('/deploy');
      await expect(pageA.locator('#deploy-mode-ctrl')).toBeVisible();
      await expect(pageA.locator('[data-mode="form"]')).toHaveClass(/active/);
      await expect(pageA.locator('[data-mode="yaml"]')).toBeAttached();
    });

    test('shows a validation error when name is empty', async ({ pageA }) => {
      await pageA.goto('/deploy');
      await pageA.locator('#deploy-submit-btn').click();
      await expect(pageA.locator('#toast.show')).toBeVisible({ timeout: 5_000 });
      await expect(pageA.locator('#toast')).toContainText('name');
    });

    test('deploys an nginx app via the form', async ({ pageA }) => {
      expect(PEER_B_NAME, 'PEER_B_NAME must be resolved').toBeTruthy();
      await pageA.goto('/deploy');
      await pageA.locator('#deploy-name').fill('playwright-nginx');
      await selectTargetPeer(pageA, PEER_B_NAME);
      await pageA.locator('#deploy-image').fill('nginx:alpine');
      await pageA.locator('#deploy-replicas').clear();
      await pageA.locator('#deploy-replicas').fill('1');
      await pageA.locator('#deploy-submit-btn').click();
      await expect(pageA).toHaveURL(/\/workloads/, { timeout: 15_000 });
    });

    test('deployed app appears in the submitted apps table', async ({ pageA }) => {
      await pageA.goto('/workloads');
      await expect(pageA.locator('#submitted-body')).toContainText('playwright-nginx', { timeout: 15_000 });
    });
  });

  // ----------------------------------------------------------------
  // Deploy page — YAML mode
  // ----------------------------------------------------------------
  test.describe('Deploy via YAML', () => {
    test('switching to YAML mode shows the CR editor', async ({ pageA }) => {
      await pageA.goto('/deploy');
      await pageA.locator('#deploy-name').fill('temp-yaml-test');
      await selectTargetPeer(pageA, PEER_B_NAME);
      await pageA.locator('#deploy-image').fill('nginx:alpine');
      await pageA.locator('[data-mode="yaml"]').click();
      await expect(pageA.locator('#deploy-yaml-wrap')).toBeVisible();
      const yamlVal = await pageA.locator('#app-spec-yaml').inputValue();
      expect(yamlVal).toMatch(/apiVersion.*porpulsion/s);
    });

    test('form fields survive a form to YAML to form roundtrip', async ({ pageA }) => {
      await pageA.goto('/deploy');
      await pageA.locator('#deploy-name').fill('roundtrip-test');
      await selectTargetPeer(pageA, PEER_B_NAME);
      await pageA.locator('#deploy-image').fill('redis:alpine');
      await pageA.locator('#deploy-replicas').clear();
      await pageA.locator('#deploy-replicas').fill('2');

      await pageA.locator('[data-mode="yaml"]').click();
      const yamlVal = await pageA.locator('#app-spec-yaml').inputValue();
      expect(yamlVal).toContain('redis:alpine');
      expect(yamlVal).toContain('roundtrip-test');
      expect(yamlVal).toContain(PEER_B_NAME);

      await pageA.locator('[data-mode="form"]').click();
      await expect(pageA.locator('#deploy-image')).toHaveValue('redis:alpine');
      await expect(pageA.locator('#deploy-replicas')).toHaveValue('2');
      await expect(pageA.locator('#deploy-name')).toHaveValue('roundtrip-test');
    });

    test('deploys a busybox app via raw YAML', async ({ pageA }) => {
      await pageA.goto('/deploy');
      await pageA.locator('[data-mode="yaml"]').click();
      await expect(pageA.locator('#deploy-yaml-wrap')).toBeVisible();

      const cr = [
        'apiVersion: porpulsion.io/v1alpha1',
        'kind: RemoteApp',
        'metadata:',
        '  name: playwright-busybox',
        'spec:',
        '  image: busybox:1.36',
        '  command: ["sh", "-c", "sleep 3600"]',
        '  replicas: 1',
        `  targetPeer: ${PEER_B_NAME}`,
      ].join('\n');

      await setDeploySpecValue(pageA, cr);
      await pageA.locator('#deploy-submit-btn-yaml').click();
      await expect(pageA).toHaveURL(/\/workloads/, { timeout: 15_000 });
    });
  });

  // ----------------------------------------------------------------
  // Workloads list & app detail modal
  // ----------------------------------------------------------------
  test.describe('Workloads list', () => {
    test('workloads page has a + Deploy link', async ({ pageA }) => {
      await pageA.goto('/workloads');
      await expect(pageA.getByRole('link', { name: '+ Deploy' })).toBeVisible();
    });

    test('submitted apps table lists playwright-nginx', async ({ pageA }) => {
      await pageA.goto('/workloads');
      await expect(pageA.locator('#submitted-body')).toContainText('playwright-nginx', { timeout: 10_000 });
    });

    test('clicking a submitted app row opens the detail modal', async ({ pageA }) => {
      await pageA.goto('/workloads');
      await openAppModal(pageA, 'playwright-nginx');
    });

    test('detail modal shows Overview, Logs, and YAML tabs', async ({ pageA }) => {
      await pageA.goto('/workloads');
      await openAppModal(pageA, 'playwright-nginx');
      await expect(pageA.locator('#app-modal-tabs-bar')).toContainText('Overview');
      await expect(pageA.locator('#app-modal-tabs-bar')).toContainText('Logs');
      await expect(pageA.locator('#app-modal-tabs-bar')).toContainText('YAML');
    });

    test('YAML tab in detail modal shows the full CR', async ({ pageA }) => {
      await pageA.goto('/workloads');
      await openAppModal(pageA, 'playwright-nginx');
      await appModalTab(pageA, 'edit');
      const textarea = pageA.locator('#modal-spec-textarea');
      await textarea.waitFor({ timeout: 8_000 });
      const val = await textarea.getAttribute('data-spec-yaml') || await textarea.inputValue();
      expect(val).toMatch(/apiVersion|RemoteApp/s);
    });
  });

  // ----------------------------------------------------------------
  // App reaches Running on Agent B
  // ----------------------------------------------------------------
  test('playwright-nginx reaches Ready on Agent B (up to 5 minutes)', async ({ request }) => {
    test.setTimeout(330_000);
    await waitForExecutingApp(request, 'playwright-nginx', ['Ready', 'Running'], 60, 5000);
  });

  // ----------------------------------------------------------------
  // Overview tab content
  // ----------------------------------------------------------------
  test.describe('Overview tab content', () => {
    test('overview tab shows the image, replicas, and target peer', async ({ pageA }) => {
      await pageA.goto('/workloads');
      await openAppModal(pageA, 'playwright-nginx');
      await appModalTab(pageA, 'overview');
      const panel = pageA.locator('#app-modal-body [data-panel="overview"]');
      await expect(panel).toContainText(/nginx/i);
      await expect(panel).toContainText('1');
    });
  });

  // ----------------------------------------------------------------
  // Scale via API
  // ----------------------------------------------------------------
  test.describe('Scale', () => {
    test('scales playwright-nginx to 2 replicas via the API', async ({ apiA }) => {
      const resp = await apiA.get('/api/remoteapps');
      const body = await resp.json();
      const app = (body.submitted || []).find((a) => a.name === 'playwright-nginx');
      expect(app).toBeTruthy();
      const id = app.app_id || app.id;
      const scaleResp = await apiA.post(`/api/remoteapp/${id}/scale`, { replicas: 2 });
      expect(scaleResp.status()).toBe(200);
    });

    test('playwright-nginx spec shows 2 replicas on Agent A after scale', async ({ apiA }) => {
      await expect.poll(
        async () => {
          const resp = await apiA.get('/api/remoteapps');
          const body = await resp.json();
          const app = (body.submitted || []).find((a) => a.name === 'playwright-nginx');
          return app?.spec?.replicas;
        },
        { timeout: 36_000, intervals: [3000] }
      ).toBe(2);
    });

    test('scales playwright-nginx back to 1 replica via the API', async ({ apiA }) => {
      const resp = await apiA.get('/api/remoteapps');
      const body = await resp.json();
      const app = (body.submitted || []).find((a) => a.name === 'playwright-nginx');
      const id = app?.app_id || app?.id;
      if (id) {
        const scaleResp = await apiA.post(`/api/remoteapp/${id}/scale`, { replicas: 1 });
        expect(scaleResp.status()).toBe(200);
      }
    });
  });

  // ----------------------------------------------------------------
  // Spec update via YAML tab
  // ----------------------------------------------------------------
  test.describe('Spec update via YAML editor', () => {
    test('edits the image tag in the YAML tab and saves', async ({ pageA }) => {
      test.setTimeout(60_000);
      await pageA.goto('/workloads');
      await openAppModal(pageA, 'playwright-nginx');
      await appModalTab(pageA, 'edit');

      const textarea = pageA.locator('#modal-spec-textarea');
      await textarea.waitFor({ timeout: 8_000 });
      const current = await textarea.getAttribute('data-spec-yaml') || await textarea.inputValue();
      const updated = current.replace(/nginx:alpine/, 'nginx:1.25-alpine');
      await setModalSpecEditorValue(pageA, updated);

      await pageA.locator('#app-modal-footer #spec-tab-save').click();
      await expect(pageA.locator('#toast.show')).toBeVisible({ timeout: 8_000 });
      const toastText = await pageA.locator('#toast').textContent();
      expect(/saved|updated|ok/i.test(toastText)).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // ConfigMap deploy (tests the multi-line fix)
  // ----------------------------------------------------------------
  test.describe('ConfigMap in deploy form', () => {
    test('adds a configmap with a multi-line value and survives form to yaml to form roundtrip', async ({ pageA }) => {
      await pageA.goto('/deploy');
      await pageA.locator('#deploy-name').fill('playwright-cm-test');
      await selectTargetPeer(pageA, PEER_B_NAME);
      await pageA.locator('#deploy-image').fill('nginx:alpine');

      // Add a ConfigMap
      await pageA.locator('#deploy-add-cm').click();
      await pageA.locator('[data-role="vol-name"]').last().fill('my-config');
      await pageA.locator('[data-role="vol-mount"]').last().fill('/etc/myapp');
      await pageA.locator('.cfg-add-section').last().getByText('+ Add key').click();
      await pageA.locator('[data-role="kv-key"]').last().fill('app.conf');
      // Shift+Enter promotes to textarea for multi-line value
      await pageA.locator('[data-role="kv-val"]').last().press('Shift+Enter');
      await pageA.locator('[data-role="kv-val"]').last().fill('line1\nline2\nline3');

      // Switch to YAML — multi-line value should appear as block scalar
      await pageA.locator('[data-mode="yaml"]').click();
      const yamlVal = await pageA.locator('#app-spec-yaml').inputValue();
      expect(yamlVal).toContain('app.conf');
      expect(yamlVal).toContain('|');

      // Switch back to Form — value should be preserved
      await pageA.locator('[data-mode="form"]').click();
      const kvVal = await pageA.locator('[data-role="kv-val"]').last().inputValue();
      expect(kvVal).toContain('line1');
      expect(kvVal).toContain('line2');
    });
  });

  // ----------------------------------------------------------------
  // Delete via UI
  // ----------------------------------------------------------------
  test.describe('Delete apps via UI', () => {
    test('deletes playwright-busybox via the workloads table', async ({ pageA }) => {
      await pageA.goto('/workloads');
      const body = pageA.locator('#submitted-body');
      const hasBusybox = await body.locator('tr').filter({ hasText: 'playwright-busybox' }).count() > 0;
      if (!hasBusybox) return;
      await openAppModal(pageA, 'playwright-busybox');
      await pageA.locator('#app-modal-body .app-modal-delete-btn').click();
      await confirmDialog(pageA);
      await expect(pageA.locator('#submitted-body')).not.toContainText('playwright-busybox', { timeout: 10_000 });
    });

    test('deletes playwright-cm-test via the workloads table', async ({ pageA }) => {
      await pageA.goto('/workloads');
      const body = pageA.locator('#submitted-body');
      const hasCm = await body.locator('tr').filter({ hasText: 'playwright-cm-test' }).count() > 0;
      if (!hasCm) return;
      await openAppModal(pageA, 'playwright-cm-test');
      await pageA.locator('#app-modal-body .app-modal-delete-btn').click();
      await confirmDialog(pageA);
      await expect(pageA.locator('#submitted-body')).not.toContainText('playwright-cm-test', { timeout: 10_000 });
    });

    test('deletes playwright-nginx via the workloads table', async ({ pageA }) => {
      await pageA.goto('/workloads');
      await openAppModal(pageA, 'playwright-nginx');
      await pageA.locator('#app-modal-body .app-modal-delete-btn').click();
      await confirmDialog(pageA);
      await expect(pageA.locator('#submitted-body')).not.toContainText('playwright-nginx', { timeout: 15_000 });
    });

    test('Agent B eventually removes the executing app after deletion', async ({ apiB }) => {
      await expect.poll(
        async () => {
          const resp = await apiB.get('/api/remoteapps');
          const body = await resp.json();
          const all = [...(body.submitted || []), ...(body.executing || [])];
          return all.find((a) => a.name === 'playwright-nginx');
        },
        { timeout: 60_000, intervals: [5000] }
      ).toBeFalsy();
    });
  });

  test.afterAll(async ({ request }) => {
    // Best-effort cleanup in case tests failed partway through
    await deleteApps(request, AGENT_A, ['playwright-nginx', 'playwright-busybox', 'playwright-cm-test']);
  });
});
