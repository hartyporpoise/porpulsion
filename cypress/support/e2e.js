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

/** Basic-auth header for direct API calls (bypasses CSRF, avoids cross-origin session issues) */
function authHeaders() {
  return {
    Authorization: 'Basic ' + btoa(`${USERNAME()}:${PASSWORD()}`),
  };
}

/**
 * Log in to the baseUrl agent via the UI login form.
 * Uses cy.session so it's only done once per spec.
 */
Cypress.Commands.add('loginUI', (username, password) => {
  cy.session(
    [username || USERNAME(), password || PASSWORD()],
    () => {
      cy.visit('/login');
      cy.get('#username').type(username || USERNAME());
      cy.get('#password').type(password || PASSWORD());
      cy.get('button[type="submit"]').click();
      cy.url().should('not.include', '/login');
    },
    {
      cacheAcrossSpecs: false,
      validate() {
        // Confirm the session cookie is still accepted before reusing it
        cy.visit('/', { failOnStatusCode: false });
        cy.url().should('not.include', '/login');
      },
    }
  );
});

/**
 * Log in to a specific (cross-origin) agent URL via the browser UI.
 */
Cypress.Commands.add('loginTo', (agentUrl, username, password) => {
  const user = username || USERNAME();
  const pass = password || PASSWORD();
  cy.origin(agentUrl, { args: { user, pass } }, ({ user, pass }) => {
    cy.visit('/login');
    cy.get('#username').type(user);
    cy.get('#password').type(pass);
    cy.get('button[type="submit"]').click();
    cy.url().should('not.include', '/login');
  });
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
 * The native <select> is hidden behind a custom dropdown, so we force the value
 * and dispatch a change event to sync the dropdown label.
 */
Cypress.Commands.add('selectTargetPeer', (peerName) => {
  // Wait for the peer option to be populated (async API call on page load)
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
 * Clicks the detail (info) button in the app's row.
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
 * Unlike openAppModal (which looks in #submitted-body), this looks in #executing-body.
 */
Cypress.Commands.add('openExecutingAppModal', (appName) => {
  cy.contains('#executing-body tr', appName, { timeout: 15000 })
    .find('.app-detail-btn')
    .click();
  cy.get('#app-modal.open', { timeout: 8000 }).should('be.visible');
});

/**
 * Wait for the exec terminal to show "Connected" status, then type a command.
 * Handles the click-to-focus needed by xterm and waits for the shell prompt.
 * @param {string} command - shell command to run (without newline)
 */
Cypress.Commands.add('execTerminalType', (command) => {
  cy.get('#exec-terminal-wrap').click();
  cy.wait(800); // let shell finish printing its prompt
  cy.get('#exec-terminal-wrap').type(`${command}{enter}`, { delay: 40 });
});

/**
 * Visit Agent B's settings page via cy.origin and set executing-tab toggles.
 * settings: { inboundApps, requireApproval, allowPvcs } — each boolean, all optional.
 * Clears cookies first so the Agent A session doesn't bleed over.
 */
Cypress.Commands.add('agentBSettings', (agentBUrl, settings = {}) => {
  const user = USERNAME();
  const pass = PASSWORD();
  cy.origin(agentBUrl, { args: { agentBUrl, settings, user, pass } },
    ({ agentBUrl, settings, user, pass }) => {
      function setToggle(id, value) {
        cy.get(id).then(($el) => {
          if ($el.prop('checked') !== value) cy.wrap($el).click();
        });
      }
      cy.visit(`${agentBUrl}/login`);
      cy.get('#username').type(user);
      cy.get('#password').type(pass);
      cy.get('button[type="submit"]').click();
      cy.url({ timeout: 10000 }).should('not.include', '/login');
      cy.visit(`${agentBUrl}/settings`);
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
    }
  );
});

/**
 * Log into Agent B via cy.origin, go to /workloads, and wait until the
 * named app appears in #executing-body with the expected status text.
 * Clears cookies first so the Agent A session doesn't bleed over.
 */
Cypress.Commands.add('waitForExecutingApp', (agentBUrl, appName, status = 'Ready', maxAttempts = 18, intervalMs = 5000) => {
  const user = USERNAME();
  const pass = PASSWORD();
  const timeoutMs = maxAttempts * intervalMs;
  cy.origin(agentBUrl, { args: { agentBUrl, appName, status, user, pass, timeoutMs } },
    ({ agentBUrl, appName, status, user, pass, timeoutMs }) => {
      cy.visit(`${agentBUrl}/login`);
      cy.get('#username').type(user);
      cy.get('#password').type(pass);
      cy.get('button[type="submit"]').click();
      cy.url({ timeout: 10000 }).should('not.include', '/login');
      cy.visit(`${agentBUrl}/workloads`);
      // Status is in the 3rd td of the row (rendered by statusBadge())
      cy.contains('#executing-body tr', appName, { timeout: timeoutMs })
        .find('td:nth-child(3)')
        .should('contain.text', status);
    }
  );
});
