/**
 * Terminal tests — deploy a long-running container, open the Terminal tab,
 * verify the xterm widget renders and the shell selector exists.
 * Precondition: A and B are peered (02-peering ran first).
 */
describe('Terminal (exec)', () => {
  const AGENT_A = Cypress.env('AGENT_A_URL');
  let PEER_B_NAME;

  before(() => {
    const waitForPeer = (attempts = 0) => {
      cy.apiRequest('GET', `${AGENT_A}/api/peers`).then((resp) => {
        const peer = resp.body.find((p) => p.channel === 'connected') || resp.body[0];
        if (peer?.name) { PEER_B_NAME = peer.name; return; }
        if (attempts >= 10) throw new Error('No peer found on Agent A after waiting');
        cy.wait(3000).then(() => waitForPeer(attempts + 1));
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

  it('app reaches Ready on Agent B (up to 120s)', () => {
    cy.waitForExecutingApp('cypress-exec', 'Ready', 24, 5000);
  });

  it('app status propagates to Agent A (terminal tab becomes enabled)', () => {
    // Wait for Agent A to reflect Ready so the terminal tab is enabled in the modal
    cy.waitForSubmittedAppReady('cypress-exec', 24, 5000);
  });

  it('detail modal has an enabled Terminal tab when app is Running', () => {
    cy.loginTo();
    cy.visit('/workloads');
    cy.openAppModal('cypress-exec');
    cy.get('#app-modal-tabs-bar [data-tab="terminal"]', { timeout: 10000 })
      .should('not.have.class', 'modal-tab-disabled');
  });

  it('Terminal tab renders the xterm container', () => {
    cy.loginTo();
    cy.visit('/workloads');
    cy.openAppModal('cypress-exec');
    cy.get('#app-modal-tabs-bar [data-tab="terminal"]:not(.modal-tab-disabled)', { timeout: 15000 })
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
    cy.get('#app-modal-tabs-bar [data-tab="terminal"]:not(.modal-tab-disabled)', { timeout: 15000 })
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
