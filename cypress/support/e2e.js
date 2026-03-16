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
  const loginUrl = `${url}/login`;
  cy.clearAllCookies();
  cy.clearAllLocalStorage();
  cy.clearAllSessionStorage();
  cy.request({ url: loginUrl, method: 'GET' }).then((resp) => {
    const match = resp.body.match(/name="_csrf_token"\s+value="([^"]+)"/);
    const csrf = match ? match[1] : '';
    cy.request({
      url: loginUrl,
      method: 'POST',
      form: true,
      failOnStatusCode: false,
      body: { username: USERNAME(), password: PASSWORD(), _csrf_token: csrf },
    });
  });
  cy.visit(`${url}/`);
  cy.url({ timeout: 10000 }).should('not.include', '/login');
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
  function setToggle(id, value) {
    cy.get(id).then(($el) => {
      if ($el.prop('checked') !== value) cy.wrap($el).click();
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
      cy.get('#setting-blocked-images').clear().type(settings.blockedImages);
    }
    if (settings.allowedImages !== undefined) {
      cy.get('#setting-allowed-images').clear().type(settings.allowedImages);
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
  cy.contains('#executing-body tr', appName, { timeout: timeoutMs })
    .find('td:nth-child(3)')
    .should('contain.text', status);
});
