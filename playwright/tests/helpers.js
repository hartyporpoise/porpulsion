/**
 * Shared test helpers for the Porpulsion Playwright suite.
 *
 * These are plain async functions — not fixtures — so they can be imported
 * and called directly in any spec without needing the fixture system.
 */

const AGENT_A = process.env.PLAYWRIGHT_AGENT_A_URL || 'http://cluster-a:30080';
const AGENT_B = process.env.PLAYWRIGHT_AGENT_B_URL || 'http://cluster-b:30080';

/**
 * Poll /api/remoteapps on agentUrl until the named app reaches the expected phase.
 * Spreads both submitted and executing lists.
 *
 * @param {import('@playwright/test').APIRequestContext} request
 * @param {string} agentUrl
 * @param {string} appName
 * @param {string} phase - e.g. 'Ready', 'Running', 'Failed', 'Rejected'
 * @param {object} [opts]
 * @param {number} [opts.attempts=60]
 * @param {number} [opts.intervalMs=5000]
 * @param {string} [opts.authHeader]
 */
async function waitForAppPhase(request, agentUrl, appName, phase, opts = {}) {
  const { attempts = 60, intervalMs = 5000 } = opts;
  const auth = opts.authHeader || buildAuthHeader();

  for (let i = 0; i < attempts; i++) {
    const resp = await request.get(`${agentUrl}/api/remoteapps`, {
      headers: { Authorization: auth },
      failOnStatusCode: false,
    });
    if (resp.ok()) {
      const body = await resp.json();
      const all = [...(body.submitted || []), ...(body.executing || [])];
      const app = all.find((a) => a.name === appName);
      const phases = Array.isArray(phase) ? phase : [phase];
      if (app && phases.some((p) => app.status === p || app.phase === p)) return app;
    }
    if (i < attempts - 1) await sleep(intervalMs);
  }
  throw new Error(`App "${appName}" never reached phase "${phase}" on ${agentUrl} after ${attempts * intervalMs / 1000}s`);
}

/**
 * Delete all apps with the given names on agentUrl using Basic Auth.
 */
async function deleteApps(request, agentUrl, appNames) {
  const auth = buildAuthHeader();
  const resp = await request.get(`${agentUrl}/api/remoteapps`, {
    headers: { Authorization: auth },
    failOnStatusCode: false,
  });
  if (!resp.ok()) return;
  const body = await resp.json();
  const all = [...(body.submitted || []), ...(body.executing || [])];
  for (const name of appNames) {
    const app = all.find((a) => a.name === name);
    const id = app?.app_id || app?.id;
    if (id) {
      await request.delete(`${agentUrl}/api/remoteapp/${id}`, {
        headers: { Authorization: auth },
        failOnStatusCode: false,
      });
    }
  }
}

/**
 * Find an app by name in /api/remoteapps (both lists) and return it.
 * Returns undefined if not found.
 */
async function findApp(request, agentUrl, appName) {
  const auth = buildAuthHeader();
  const resp = await request.get(`${agentUrl}/api/remoteapps`, {
    headers: { Authorization: auth },
    failOnStatusCode: false,
  });
  if (!resp.ok()) return undefined;
  const body = await resp.json();
  const all = [...(body.submitted || []), ...(body.executing || [])];
  return all.find((a) => a.name === appName);
}

/**
 * Open the app detail modal for a submitted app by name.
 * Waits for the modal to have class "open".
 */
async function openAppModal(page, appName) {
  const row = page.locator('#submitted-body tr').filter({ hasText: appName });
  await row.waitFor({ timeout: 15_000 });
  await row.locator('.app-detail-btn').click();
  await page.locator('#app-modal.open').waitFor({ timeout: 8_000 });
  // Wait for getAppDetail fetch to complete and render the tabs bar + body panels
  await page.locator('#app-modal-tabs-bar [data-tab="overview"]').waitFor({ timeout: 15_000 });
}

/**
 * Open the app detail modal for an executing app by name.
 */
async function openExecutingAppModal(page, appName) {
  const row = page.locator('#executing-body tr').filter({ hasText: appName });
  await row.waitFor({ timeout: 15_000 });
  await row.locator('.app-detail-btn').click();
  await page.locator('#app-modal.open').waitFor({ timeout: 8_000 });
}

/**
 * Switch to a tab in the app detail modal and wait for the panel to activate.
 * tabKey: 'overview' | 'logs' | 'terminal' | 'config' | 'edit'
 */
async function appModalTab(page, tabKey) {
  // Wait for the tab button to exist (modal renders tabs async after open)
  await page.locator(`#app-modal-tabs-bar [data-tab="${tabKey}"]`).waitFor({ timeout: 10_000 });
  await page.locator(`#app-modal-tabs-bar [data-tab="${tabKey}"]`).click();
  await page.locator(`#app-modal-body [data-panel="${tabKey}"].active`).waitFor({ timeout: 5_000 });
}

/**
 * Click the OK/confirm button in the confirm dialog.
 */
async function confirmDialog(page) {
  await page.locator('#dialog-backdrop.open #dialog-actions button:last-child').click();
}

/**
 * Select a target peer in the deploy form.
 * The deploy page fetches peers once on load. If the option isn't present after 5s,
 * reload the page (re-triggering the fetch) and retry — handles the case where the
 * peer's direction was "incoming" at initial page load time and has since upgraded.
 */
async function selectTargetPeer(page, peerName) {
  const optionLocator = page.locator(`#deploy-target-peer option[value="${peerName}"]`);

  // Fast path: option already present (most common case)
  const present = await optionLocator.count();
  if (!present) {
    // Wait up to 8s for the initial async fetch to populate it
    const appeared = await optionLocator.waitFor({ timeout: 8_000 }).then(() => true).catch(() => false);
    if (!appeared) {
      // Reload so the page re-fetches peers (direction may have updated since page load)
      await page.reload({ waitUntil: 'domcontentloaded' });
      await optionLocator.waitFor({ timeout: 20_000 });
    }
  }

  await page.selectOption('#deploy-target-peer', peerName, { force: true });
}

/**
 * Set YAML in the Monaco deploy editor via the window API.
 */
async function setDeploySpecValue(page, yaml) {
  await page.evaluate((y) => {
    window.PorpulsionVscodeEditor.setDeploySpecValue(y);
  }, yaml);
}

/**
 * Get the current value from the Monaco modal spec editor.
 * Falls back to reading #modal-spec-textarea directly if PorpulsionVscodeEditor is not ready.
 */
async function getModalSpecEditorValue(page) {
  return page.evaluate(() => {
    if (window.PorpulsionVscodeEditor) {
      return window.PorpulsionVscodeEditor.getModalSpecEditorValue('modal-spec-editor-host', 'modal-spec-textarea');
    }
    var el = document.getElementById('modal-spec-textarea');
    return el ? el.value : '';
  });
}

/**
 * Wait until the modal spec editor textarea has content (> 10 chars).
 * Polls both Monaco and the fallback textarea.
 */
async function waitForModalSpecEditor(page, timeout = 8_000) {
  const { expect } = require('@playwright/test');
  // Poll the length (number) so we can use toBeGreaterThan — toSatisfy is not in base Playwright
  await expect.poll(
    () => page.evaluate(() => {
      var val = '';
      if (window.PorpulsionVscodeEditor) {
        val = window.PorpulsionVscodeEditor.getModalSpecEditorValue('modal-spec-editor-host', 'modal-spec-textarea') || '';
      } else {
        var el = document.getElementById('modal-spec-textarea');
        val = el ? el.value : '';
      }
      return val.length;
    }),
    { timeout }
  ).toBeGreaterThan(10);
}

/**
 * Set value in the Monaco modal spec editor.
 * Falls back to setting #modal-spec-textarea directly if PorpulsionVscodeEditor is not ready.
 */
async function setModalSpecEditorValue(page, value) {
  await page.evaluate((v) => {
    if (window.PorpulsionVscodeEditor) {
      window.PorpulsionVscodeEditor.setModalSpecEditorValue('modal-spec-editor-host', 'modal-spec-textarea', v);
    } else {
      var el = document.getElementById('modal-spec-textarea');
      if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
    }
  }, value);
}

/**
 * Navigate to Agent B's settings page and apply the given toggles/fields.
 * Requires a page already authenticated on Agent B (pageB fixture).
 */
async function applyAgentBSettings(pageB, settings = {}) {
  await pageB.goto(`${AGENT_B}/settings`);

  async function setToggle(id, value) {
    const checked = await pageB.locator(id).isChecked();
    if (checked !== value) {
      // Wait for any stale toast to clear
      await pageB.locator('#toast').evaluate((el) => el.classList.remove('show')).catch(() => {});
      await pageB.locator(id).scrollIntoViewIfNeeded();
      await pageB.locator(id).click({ force: true });
      await pageB.locator('#toast.show').waitFor({ timeout: 5_000 });
    }
  }

  if (settings.inboundApps !== undefined || settings.requireApproval !== undefined || settings.allowPvcs !== undefined) {
    await pageB.locator('.stg-tab[data-section="executing"]').click();
    if (settings.inboundApps !== undefined)    await setToggle('#setting-inbound-apps', settings.inboundApps);
    if (settings.requireApproval !== undefined) await setToggle('#setting-require-approval', settings.requireApproval);
    if (settings.allowPvcs !== undefined)       await setToggle('#setting-allow-pvcs', settings.allowPvcs);
  }

  if (settings.blockedImages !== undefined || settings.allowedImages !== undefined) {
    await pageB.locator('.stg-tab[data-section="executing"]').click();
    if (settings.blockedImages !== undefined) {
      await pageB.locator('#setting-blocked-images').clear();
      if (settings.blockedImages) await pageB.locator('#setting-blocked-images').fill(settings.blockedImages);
    }
    if (settings.allowedImages !== undefined) {
      await pageB.locator('#setting-allowed-images').clear();
      if (settings.allowedImages) await pageB.locator('#setting-allowed-images').fill(settings.allowedImages);
    }
    await pageB.locator('#setting-filters-save').click();
    await pageB.locator('#toast.show').waitFor({ timeout: 5_000 });
  }
}

/**
 * Poll Agent B's executing table until the app reaches the expected status.
 * Uses the API (faster and more reliable than UI polling).
 */
async function waitForExecutingApp(request, appName, status = 'Ready', attempts = 18, intervalMs = 5000) {
  return waitForAppPhase(request, AGENT_B, appName, status, { attempts, intervalMs });
}

/**
 * Wait for Agent A to reflect the app as Ready/Running via the API.
 */
async function waitForSubmittedAppReady(request, appName, attempts = 12, intervalMs = 5000) {
  const auth = buildAuthHeader();
  for (let i = 0; i < attempts; i++) {
    const resp = await request.get(`${AGENT_A}/api/remoteapps`, {
      headers: { Authorization: auth },
      failOnStatusCode: false,
    });
    if (resp.ok()) {
      const body = await resp.json();
      const all = [...(body.submitted || []), ...(body.executing || [])];
      const app = all.find((a) => a.name === appName);
      if (app && (app.status === 'Ready' || app.status === 'Running')) return app;
    }
    if (i < attempts - 1) await sleep(intervalMs);
  }
  throw new Error(`App "${appName}" never reached Ready on Agent A after ${attempts * intervalMs / 1000}s`);
}

/**
 * Resolve the first deployable peer name visible on Agent A.
 * Waits for a peer with direction outgoing or bidirectional — these are the only
 * peers that appear in the deploy form's target peer dropdown.
 */
async function resolvePeerBName(request, maxAttempts = 20, intervalMs = 3000) {
  const auth = buildAuthHeader();
  for (let i = 0; i < maxAttempts; i++) {
    const resp = await request.get(`${AGENT_A}/api/peers`, {
      headers: { Authorization: auth },
      failOnStatusCode: false,
    });
    if (resp.ok()) {
      const peers = await resp.json();
      const deployable = peers.find(
        (p) => p.name && (p.direction === 'outgoing' || p.direction === 'bidirectional')
      );
      if (deployable) return deployable.name;
    }
    if (i < maxAttempts - 1) await sleep(intervalMs);
  }
  throw new Error('No deployable (outgoing/bidirectional) peer found on Agent A after waiting');
}

function buildAuthHeader() {
  const u = process.env.PLAYWRIGHT_USERNAME || 'admin';
  const p = process.env.PLAYWRIGHT_PASSWORD || 'adminpass1';
  return 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  waitForAppPhase,
  waitForExecutingApp,
  waitForSubmittedAppReady,
  deleteApps,
  findApp,
  openAppModal,
  openExecutingAppModal,
  appModalTab,
  confirmDialog,
  selectTargetPeer,
  setDeploySpecValue,
  getModalSpecEditorValue,
  waitForModalSpecEditor,
  setModalSpecEditorValue,
  applyAgentBSettings,
  resolvePeerBName,
  buildAuthHeader,
  AGENT_A,
  AGENT_B,
};
