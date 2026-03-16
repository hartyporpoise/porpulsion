/**
 * Logs tests — deploy a log-emitting app, open the detail modal, view the Logs tab.
 * Precondition: A and B are peered (02-peering ran first).
 */
describe('Logs', () => {
  const AGENT_A = Cypress.env('AGENT_A_URL');
  let PEER_B_NAME;

  before(() => {
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

  it('deploys a log-emitting app via YAML', () => {
    cy.loginTo();
    cy.visit('/deploy');
    cy.get('[data-mode="yaml"]').click();
    cy.get('#deploy-yaml-wrap').should('be.visible');

    cy.window().then((win) => {
      win.PorpulsionVscodeEditor.setDeploySpecValue([
        'apiVersion: porpulsion.io/v1alpha1',
        'kind: RemoteApp',
        'metadata:',
        '  name: cypress-logs',
        'spec:',
        '  image: busybox:1.36',
        "  command: [\"sh\", \"-c\", \"i=1; while [ $i -le 60 ]; do echo \\\"log line $i\\\"; i=$((i+1)); sleep 1; done\"]",
        '  replicas: 1',
        `  targetPeer: ${PEER_B_NAME}`,
      ].join('\n'));
    });
    cy.get('#deploy-submit-btn-yaml').click();
    cy.url({ timeout: 15000 }).should('include', '/workloads');
  });

  it('app appears in the submitted apps table', () => {
    cy.loginTo();
    cy.visit('/workloads');
    cy.get('#submitted-body', { timeout: 15000 }).should('contain.text', 'cypress-logs');
  });

  it('logs tab in detail modal renders the xterm terminal (up to 90s)', () => {
    cy.loginTo();
    cy.visit('/workloads');
    cy.openAppModal('cypress-logs');
    cy.appModalTab('logs');
    // Logs are rendered in xterm.js — check that the terminal container is present and active
    cy.get('#app-modal-body [data-panel="logs"]', { timeout: 90000 })
      .find('#logs-terminal-wrap')
      .should('exist');
  });

  after(() => {
    cy.apiRequest('GET', `${AGENT_A}/api/remoteapps`).then((resp) => {
      const app = (resp.body.submitted || []).find((a) => a.name === 'cypress-logs');
      const id = app?.app_id || app?.id;
      if (id) cy.apiRequest('DELETE', `${AGENT_A}/api/remoteapp/${id}`);
    });
  });
});
