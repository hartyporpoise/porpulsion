/**
 * Terminal tests — deploy a long-running container, open the Terminal tab,
 * verify the xterm widget renders and the shell selector exists.
 * Precondition: A and B are peered (02-peering ran first).
 */
describe('Terminal (exec)', () => {
  const AGENT_A = Cypress.env('AGENT_A_URL');
  const AGENT_B = Cypress.env('AGENT_B_URL');
  let PEER_B_NAME;

  before(() => {
    // Ensure Agent B will accept inbound workloads (may have been toggled by 09-settings-rbac)
    cy.agentBSettings({ inboundApps: true, requireApproval: false });

    const waitForPeer = (attempts = 0) => {
      cy.apiRequest('GET', `${AGENT_A}/api/peers`).then((resp) => {
        const peer = resp.body.find((p) => p.channel === 'connected') || resp.body[0];
        if (peer?.name) { PEER_B_NAME = peer.name; return; }
        if (attempts >= 10) throw new Error('No peer found on Agent A after waiting');
        cy.wait(3000);
        waitForPeer(attempts + 1);
      });
    };
    waitForPeer();
  });

  it('deploys a long-running alpine container', () => {
    cy.loginTo();
    cy.visit('/deploy');
    cy.get('[data-mode="yaml"]').click();
    cy.get('#deploy-yaml-wrap').should('be.visible');

    cy.window().then((win) => {
      win.PorpulsionVscodeEditor.setDeploySpecValue([
        'apiVersion: porpulsion.io/v1alpha1',
        'kind: RemoteApp',
        'metadata:',
        '  name: cypress-exec',
        'spec:',
        '  image: alpine:3.19',
        '  command: ["sh", "-c", "sleep 3600"]',
        '  replicas: 1',
        `  targetPeer: ${PEER_B_NAME}`,
      ].join('\n'));
    });
    cy.get('#deploy-submit-btn-yaml').click();
    cy.url({ timeout: 15000 }).should('include', '/workloads');
  });

  it('app reaches Ready on Agent B (up to 90s)', () => {
    cy.waitForExecutingApp('cypress-exec', 'Ready', 18, 5000);
  });

  it('detail modal has an enabled Terminal tab when app is Running', () => {
    cy.loginTo();
    // The modal reads status from Agent A which may lag Agent B by a few seconds.
    // Poll by reopening the modal until the Terminal tab becomes enabled.
    const waitForTerminalEnabled = (attempts = 0) => {
      cy.visit('/workloads');
      cy.openAppModal('cypress-exec');
      cy.get('#app-modal-tabs-bar [data-tab="terminal"]', { timeout: 10000 })
        .then(($tab) => {
          if (!$tab.hasClass('modal-tab-disabled')) return;
          if (attempts >= 12) throw new Error('Terminal tab never became enabled');
          cy.get('#app-modal-close').click({ force: true });
          cy.wait(5000);
          waitForTerminalEnabled(attempts + 1);
        });
    };
    waitForTerminalEnabled();
    cy.get('#app-modal-tabs-bar [data-tab="terminal"]').should('not.have.class', 'modal-tab-disabled');
  });

  it('Terminal tab renders the xterm container', () => {
    cy.loginTo();
    cy.visit('/workloads');
    cy.openAppModal('cypress-exec');
    // Terminal tab must be enabled before clicking — wait for it
    cy.get('#app-modal-tabs-bar [data-tab="terminal"]:not(.modal-tab-disabled)', { timeout: 60000 })
      .click();
    cy.get('#app-modal-body [data-panel="terminal"].active', { timeout: 5000 }).should('exist');
    cy.get('#app-modal-body [data-panel="terminal"]')
      .find('#exec-terminal-wrap')
      .should('exist');
  });

  it('shell selector dropdown exists in the terminal tab', () => {
    cy.loginTo();
    cy.visit('/workloads');
    cy.openAppModal('cypress-exec');
    cy.get('#app-modal-tabs-bar [data-tab="terminal"]:not(.modal-tab-disabled)', { timeout: 60000 })
      .click();
    cy.get('#app-modal-body [data-panel="terminal"].active', { timeout: 5000 }).should('exist');
    cy.get('#app-modal-body [data-panel="terminal"] #exec-shell-select', { timeout: 5000 })
      .should('exist');
  });

  after(() => {
    cy.apiRequest('GET', `${AGENT_A}/api/remoteapps`).then((resp) => {
      const all = [...(resp.body?.submitted || []), ...(resp.body?.executing || [])];
      const app = all.find((a) => a.name === 'cypress-exec');
      const id = app?.app_id || app?.id;
      if (id) cy.apiRequest('DELETE', `${AGENT_A}/api/remoteapp/${id}`);
    });
  });
});
