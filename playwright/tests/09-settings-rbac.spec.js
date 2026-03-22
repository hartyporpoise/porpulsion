/**
 * Settings & RBAC tests — exercises the Executing tab toggles and filter/quota fields.
 * Tests that settings persist (API round-trip), that toggling inbound apps blocks
 * a deploy, and that image policy enforcement works.
 *
 * Precondition: A and B are peered (02-peering ran first).
 */

const { test, expect, AGENT_A, AGENT_B } = require('./fixtures');
const {
  setDeploySpecValue,
  applyAgentBSettings,
  deleteApps,
  resolvePeerBName,
} = require('./helpers');

let PEER_B_NAME;

test.describe('Settings & RBAC', () => {
  test.beforeAll(async ({ request }) => {
    PEER_B_NAME = await resolvePeerBName(request);
  });

  // ----------------------------------------------------------------
  // Settings page structure (Agent A)
  // ----------------------------------------------------------------
  test.describe('Settings page structure', () => {
    test('shows all five settings tabs', async ({ pageA }) => {
      await pageA.goto('/settings');
      for (const section of ['agent', 'executing', 'quotas', 'tunnels', 'registry']) {
        await expect(pageA.locator(`.stg-tab[data-section="${section}"]`)).toBeAttached();
      }
    });

    test('Executing tab shows key toggle controls', async ({ pageA }) => {
      await pageA.goto('/settings');
      await pageA.locator('.stg-tab[data-section="executing"]').click();
      await expect(pageA.locator('#settings-panel-executing #setting-inbound-apps')).toBeAttached();
      await expect(pageA.locator('#settings-panel-executing #setting-require-approval')).toBeAttached();
      await expect(pageA.locator('#settings-panel-executing #setting-allow-pvcs')).toBeAttached();
    });

    test('Tunnels tab shows inbound tunnels toggle', async ({ pageA }) => {
      await pageA.goto('/settings');
      await pageA.locator('.stg-tab[data-section="tunnels"]').click();
      await expect(pageA.locator('#settings-panel-tunnels #setting-inbound-tunnels')).toBeAttached();
    });

    test('Registry tab shows pull-through proxy toggle', async ({ pageA }) => {
      await pageA.goto('/settings');
      await pageA.locator('.stg-tab[data-section="registry"]').click();
      await expect(pageA.locator('#settings-panel-registry #setting-registry-pull-enabled')).toBeAttached();
    });
  });

  // ----------------------------------------------------------------
  // Inbound apps toggle (Agent B)
  // ----------------------------------------------------------------
  test.describe('Inbound apps toggle — Agent B', () => {
    test('disables inbound apps on Agent B', async ({ pageB }) => {
      await applyAgentBSettings(pageB, { inboundApps: false });
    });

    test('inbound apps toggle is unchecked after disabling', async ({ pageB }) => {
      await pageB.goto(`${AGENT_B}/settings`);
      await pageB.locator('.stg-tab[data-section="executing"]').click();
      await expect(pageB.locator('#setting-inbound-apps')).not.toBeChecked();
    });
  });

  // ----------------------------------------------------------------
  // Deploy rejected when inbound disabled (Agent A)
  // ----------------------------------------------------------------
  test.describe('Inbound apps toggle — deploy rejected on Agent A', () => {
    test('deploy to Agent B is rejected when inbound apps is disabled', async ({ pageA, apiA }) => {
      await pageA.goto('/deploy');
      await pageA.locator('[data-mode="yaml"]').click();
      await expect(pageA.locator('#deploy-yaml-wrap')).toBeVisible();
      await setDeploySpecValue(pageA, [
        'apiVersion: porpulsion.io/v1alpha1',
        'kind: RemoteApp',
        'metadata:',
        '  name: playwright-rbac-blocked',
        'spec:',
        '  image: nginx:alpine',
        '  replicas: 1',
        `  targetPeer: ${PEER_B_NAME}`,
      ].join('\n'));
      await pageA.locator('#deploy-submit-btn-yaml').click();
      await expect(pageA).toHaveURL(/\/workloads/, { timeout: 15_000 });

      // The peer rejects it asynchronously — wait for the Failed status in the submitted table
      const row = pageA.locator('#submitted-body tr').filter({ hasText: 'playwright-rbac-blocked' });
      await expect(row.locator('td:nth-child(3)')).toContainText('Failed', { timeout: 30_000 });

      // Clean up
      const resp = await apiA.get('/api/remoteapps');
      const body = await resp.json();
      const app = (body.submitted || []).find((a) => a.name === 'playwright-rbac-blocked');
      const id = app?.app_id || app?.id;
      if (id) await apiA.delete(`/api/remoteapp/${id}`);
    });
  });

  // ----------------------------------------------------------------
  // Re-enable inbound apps (Agent B)
  // ----------------------------------------------------------------
  test.describe('Inbound apps toggle — re-enable on Agent B', () => {
    test('re-enables inbound apps on Agent B', async ({ pageB }) => {
      await applyAgentBSettings(pageB, { inboundApps: true });
    });

    test('inbound apps toggle is checked after re-enabling', async ({ pageB }) => {
      await pageB.goto(`${AGENT_B}/settings`);
      await pageB.locator('.stg-tab[data-section="executing"]').click();
      await expect(pageB.locator('#setting-inbound-apps')).toBeChecked();
    });
  });

  // ----------------------------------------------------------------
  // Image policy — blocked images (Agent B)
  // ----------------------------------------------------------------
  test.describe('Image policy — blocked images on Agent B', () => {
    test('sets blocked_images on Agent B', async ({ pageB }) => {
      await applyAgentBSettings(pageB, { blockedImages: 'playwright-blocked.io/', allowedImages: '' });
    });
  });

  test.describe('Image policy — blocked deploy rejected on Agent A', () => {
    test('deploy with blocked image is rejected', async ({ pageA, apiA }) => {
      await pageA.goto('/deploy');
      await pageA.locator('[data-mode="yaml"]').click();
      await setDeploySpecValue(pageA, [
        'apiVersion: porpulsion.io/v1alpha1',
        'kind: RemoteApp',
        'metadata:',
        '  name: playwright-image-blocked',
        'spec:',
        '  image: playwright-blocked.io/nginx:latest',
        '  replicas: 1',
        `  targetPeer: ${PEER_B_NAME}`,
      ].join('\n'));
      await pageA.locator('#deploy-submit-btn-yaml').click();
      await expect(pageA).toHaveURL(/\/workloads/, { timeout: 15_000 });
      const row = pageA.locator('#submitted-body tr').filter({ hasText: 'playwright-image-blocked' });
      await expect(row.locator('td:nth-child(3)')).toContainText('Failed', { timeout: 30_000 });

      const resp = await apiA.get('/api/remoteapps');
      const body = await resp.json();
      const app = (body.submitted || []).find((a) => a.name === 'playwright-image-blocked');
      const id = app?.app_id || app?.id;
      if (id) await apiA.delete(`/api/remoteapp/${id}`);
    });
  });

  // ----------------------------------------------------------------
  // Image policy — allowed images (Agent B)
  // ----------------------------------------------------------------
  test.describe('Image policy — allowed images on Agent B', () => {
    test('sets allowed_images on Agent B', async ({ pageB }) => {
      await applyAgentBSettings(pageB, { blockedImages: '', allowedImages: 'docker.io/' });
    });
  });

  test.describe('Image policy — non-allowed deploy rejected on Agent A', () => {
    test('deploy with image outside allowed prefix is rejected', async ({ pageA, apiA }) => {
      await pageA.goto('/deploy');
      await pageA.locator('[data-mode="yaml"]').click();
      await setDeploySpecValue(pageA, [
        'apiVersion: porpulsion.io/v1alpha1',
        'kind: RemoteApp',
        'metadata:',
        '  name: playwright-image-notallowed',
        'spec:',
        '  image: gcr.io/google-containers/pause:3.9',
        '  replicas: 1',
        `  targetPeer: ${PEER_B_NAME}`,
      ].join('\n'));
      await pageA.locator('#deploy-submit-btn-yaml').click();
      await expect(pageA).toHaveURL(/\/workloads/, { timeout: 15_000 });
      const row = pageA.locator('#submitted-body tr').filter({ hasText: 'playwright-image-notallowed' });
      await expect(row.locator('td:nth-child(3)')).toContainText('Failed', { timeout: 30_000 });

      const resp = await apiA.get('/api/remoteapps');
      const body = await resp.json();
      const app = (body.submitted || []).find((a) => a.name === 'playwright-image-notallowed');
      const id = app?.app_id || app?.id;
      if (id) await apiA.delete(`/api/remoteapp/${id}`);
    });
  });

  // ----------------------------------------------------------------
  // Clear image filters (Agent B)
  // ----------------------------------------------------------------
  test.describe('Image policy — clear filters on Agent B', () => {
    test('clears image filters on Agent B', async ({ pageB }) => {
      await applyAgentBSettings(pageB, { blockedImages: '', allowedImages: '' });
    });
  });

  // ----------------------------------------------------------------
  // Image filter UI round-trip (Agent A)
  // ----------------------------------------------------------------
  test.describe('Image filter UI round-trip', () => {
    test('image filter settings save and reload via the UI filters form', async ({ pageA }) => {
      await pageA.goto('/settings');
      await pageA.locator('.stg-tab[data-section="executing"]').click();
      await pageA.locator('#setting-allowed-images').clear();
      await pageA.locator('#setting-allowed-images').fill('my-registry.io/');
      await pageA.locator('#setting-blocked-images').clear();
      await pageA.locator('#setting-blocked-images').fill('bad-registry.io/');
      await pageA.locator('#setting-filters-save').click();
      await expect(pageA.locator('#toast.show')).toBeVisible({ timeout: 5_000 });
      const toastText = await pageA.locator('#toast').textContent();
      expect(/saved|filter/i.test(toastText)).toBe(true);

      await pageA.reload();
      await pageA.locator('.stg-tab[data-section="executing"]').click();
      await expect(pageA.locator('#setting-allowed-images')).toHaveValue('my-registry.io/');
      await expect(pageA.locator('#setting-blocked-images')).toHaveValue('bad-registry.io/');
    });
  });

  // ----------------------------------------------------------------
  // allow_pvcs toggle (Agent B)
  // ----------------------------------------------------------------
  test.describe('allow_pvcs toggle — Agent B', () => {
    test('disables allow_pvcs on Agent B', async ({ pageB }) => {
      await applyAgentBSettings(pageB, { allowPvcs: false });
    });

    test('allow_pvcs toggle is unchecked after disabling', async ({ pageB }) => {
      await pageB.goto(`${AGENT_B}/settings`);
      await pageB.locator('.stg-tab[data-section="executing"]').click();
      await expect(pageB.locator('#setting-allow-pvcs')).not.toBeChecked();
    });

    test('re-enables allow_pvcs on Agent B', async ({ pageB }) => {
      await applyAgentBSettings(pageB, { allowPvcs: true });
    });

    test('allow_pvcs toggle is checked after re-enabling', async ({ pageB }) => {
      await pageB.goto(`${AGENT_B}/settings`);
      await pageB.locator('.stg-tab[data-section="executing"]').click();
      await expect(pageB.locator('#setting-allow-pvcs')).toBeChecked();
    });
  });

  test.afterAll(async ({ apiA, apiB }) => {
    // Clear Agent A image filters left by the UI round-trip test
    await apiA.post('/api/settings', { allowed_images: '', blocked_images: '' });
    // Fully reset Agent B so subsequent specs start clean
    await apiB.post('/api/settings', {
      allow_inbound_remoteapps: true,
      require_remoteapp_approval: false,
      allow_pvcs: true,
      allowed_images: '',
      blocked_images: '',
    });
  });
});
