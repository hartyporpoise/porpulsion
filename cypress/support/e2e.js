// Global Cypress helpers

Cypress.on('uncaught:exception', () => false);

// Force dark mode via CDP before every test
before(() => {
  cy.wrap(
    Cypress.automation('remote:debugger:protocol', {
      command: 'Emulation.setEmulatedMedia',
      params: {
        media: 'page',
        features: [{ name: 'prefers-color-scheme', value: 'dark' }],
      },
    })
  );
});

const USERNAME = () => Cypress.env('USERNAME');
const PASSWORD = () => Cypress.env('PASSWORD');

const clusterA = () => Cypress.config('baseUrl').replace(/\/$/, '');
const clusterB = () => Cypress.env('AGENT_B_URL').replace(/\/$/, '');

/** Basic-auth header for direct API calls (bypasses CSRF, avoids cross-origin session issues) */
function authHeaders() {
  return {
    Authorization: 'Basic ' + btoa(`${USERNAME()}:${PASSWORD()}`),
  };
}

/**
 * Log in to agentUrl.
 * Clears all cookies/storage, GETs the CSRF token, POSTs credentials,
 * then visits / so the browser has an active session.
 * Must be called before visiting any page on that cluster.
 */
Cypress.Commands.add('loginTo', (agentUrl) => {
  const url = agentUrl || clusterA();
  cy.clearAllCookies();
  cy.clearAllLocalStorage();
  cy.clearAllSessionStorage();
  // Visit the login page directly in the browser so cookies are set in the
  // correct origin context — avoids cy.request cookie jar vs browser mismatch.
  cy.visit(`${url}/login`);
  cy.get('#username', { timeout: 10000 }).should('be.visible').type(USERNAME());
  cy.get('#password').type(PASSWORD());
  cy.get('button[type="submit"]').click();
});

/**
 * Make an authenticated API request using HTTP Basic Auth.
 * Use this instead of cy.request() for /api/* endpoints.
 */
Cypress.Commands.add('apiRequest', (method, url, body) => {
  return cy.request({
    method,
    url,
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body,
    failOnStatusCode: false,
  });
});

/**
 * Select a peer by name in the deploy target peer selector.
 */
Cypress.Commands.add('selectTargetPeer', (peerName) => {
  cy.get(`#deploy-target-peer option[value="${peerName}"]`, { timeout: 15000 }).should('exist');
  cy.get('#deploy-target-peer').select(peerName, { force: true });
});

/**
 * Confirm the currently-open confirm dialog by clicking the OK/confirm button.
 */
Cypress.Commands.add('confirmDialog', () => {
  cy.get('#dialog-backdrop.open #dialog-actions button:last-child').click();
});

/**
 * Open the app detail modal for a submitted app by name.
 */
Cypress.Commands.add('openAppModal', (appName) => {
  cy.contains('#submitted-body tr', appName, { timeout: 15000 })
    .find('.app-detail-btn')
    .click();
  cy.get('#app-modal.open', { timeout: 8000 }).should('be.visible');
});

/**
 * Switch to a tab in the app detail modal.
 * tabKey: 'overview' | 'logs' | 'terminal' | 'config' | 'edit' (YAML)
 */
Cypress.Commands.add('appModalTab', (tabKey) => {
  cy.get(`#app-modal-tabs-bar [data-tab="${tabKey}"]`).should('not.be.disabled').click();
  cy.get(`#app-modal-body [data-panel="${tabKey}"].active`, { timeout: 5000 }).should('exist');
});

/**
 * Open the app detail modal for an executing app (on its own agent's workloads page).
 */
Cypress.Commands.add('openExecutingAppModal', (appName) => {
  cy.contains('#executing-body tr', appName, { timeout: 15000 })
    .find('.app-detail-btn')
    .click();
  cy.get('#app-modal.open', { timeout: 8000 }).should('be.visible');
});

/**
 * Wait for the exec terminal to be ready, then type a command.
 */
Cypress.Commands.add('execTerminalType', (command) => {
  cy.get('#exec-terminal-wrap').click();
  cy.wait(800);
  cy.get('#exec-terminal-wrap').type(`${command}{enter}`, { delay: 40 });
});

/**
 * Navigate to Agent B's settings page and apply the given toggles/fields.
 * settings: { inboundApps, requireApproval, allowPvcs, blockedImages, allowedImages }
 */
Cypress.Commands.add('agentBSettings', (settings = {}) => {
  // iOS toggles hide the <input> behind the label — always force click.
  // After clicking, wait for the toast so the async API save has completed.
  function setToggle(id, value) {
    cy.get(id).then(($el) => {
      if ($el.prop('checked') !== value) {
        // Wait for any stale toast to clear, then click, then wait for the new toast.
        cy.get('#toast').should('not.have.class', 'show');
        cy.wrap($el).click({ force: true });
        cy.get('#toast', { timeout: 5000 }).should('have.class', 'show');
      }
    });
  }

  cy.loginTo(clusterB());
  cy.visit(`${clusterB()}/settings`);
  if (settings.inboundApps !== undefined || settings.requireApproval !== undefined || settings.allowPvcs !== undefined) {
    cy.get('.stg-tab[data-section="executing"]').click();
    if (settings.inboundApps !== undefined)    setToggle('#setting-inbound-apps',     settings.inboundApps);
    if (settings.requireApproval !== undefined) setToggle('#setting-require-approval', settings.requireApproval);
    if (settings.allowPvcs !== undefined)       setToggle('#setting-allow-pvcs',       settings.allowPvcs);
  }
  if (settings.blockedImages !== undefined || settings.allowedImages !== undefined) {
    cy.get('.stg-tab[data-section="executing"]').click();
    if (settings.blockedImages !== undefined) {
      cy.get('#setting-blocked-images').clear();
      if (settings.blockedImages) cy.get('#setting-blocked-images').type(settings.blockedImages);
    }
    if (settings.allowedImages !== undefined) {
      cy.get('#setting-allowed-images').clear();
      if (settings.allowedImages) cy.get('#setting-allowed-images').type(settings.allowedImages);
    }
    cy.get('#setting-filters-save').click();
  }
});

/**
 * Navigate to Agent B's workloads page and wait until the named app
 * appears in #executing-body with the expected status text.
 */
Cypress.Commands.add('waitForExecutingApp', (appName, status = 'Ready', maxAttempts = 18, intervalMs = 5000) => {
  const timeoutMs = maxAttempts * intervalMs;

  cy.loginTo(clusterB());
  cy.visit(`${clusterB()}/workloads`);
  // Use a single cy.contains targeting the row text that includes both the app name
  // AND status, so the full timeout applies to the status assertion too.
  // The table auto-refreshes every 3s, so Cypress will see the updated status.
  cy.get('#executing-body', { timeout: timeoutMs }).should(($body) => {
    const row = $body.find('tr').filter((_, tr) => tr.textContent.includes(appName));
    expect(row.length, `App "${appName}" not found in executing table`).to.be.gt(0);
    const statusCell = row.find('td:nth-child(3)');
    expect(statusCell.text(), `App "${appName}" status`).to.include(status);
  });
});

/**
 * After waitForExecutingApp confirms Agent B shows the app as Ready,
 * switch back to Agent A and wait for the submitted app's status to
 * also reflect Ready (so the modal terminal/config tabs are enabled).
 */
Cypress.Commands.add('waitForSubmittedAppReady', (appName, maxAttempts = 12, intervalMs = 5000) => {
  const AGENT_A_URL = clusterA();
  cy.loginTo(AGENT_A_URL);
  cy.visit(`${AGENT_A_URL}/workloads`);

  const waitForStatus = (attempts = 0) => {
    cy.apiRequest('GET', `${AGENT_A_URL}/api/remoteapps`).then((resp) => {
      const all = [...(resp.body?.submitted || []), ...(resp.body?.executing || [])];
      const app = all.find((a) => a.name === appName);
      if (app && (app.status === 'Ready' || app.status === 'Running')) return;
      if (attempts >= maxAttempts) throw new Error(`${appName} never reached Ready on Agent A`);
      cy.wait(intervalMs).then(() => waitForStatus(attempts + 1));
    });
  };
  waitForStatus();

  // Reload the page so the workloads table reflects the latest status
  cy.visit(`${AGENT_A_URL}/workloads`);
});
