/**
 * Logs tests — deploy a log-emitting app, open detail modal, view logs tab.
 */
describe('Logs', () => {
  const AGENT_A = Cypress.env('AGENT_A_URL');
  let PEER_B_NAME;

  before(() => {
    cy.loginTo(AGENT_A).then(() => {
      cy.request(`${AGENT_A}/peers`).then((resp) => {
        const peer = resp.body.find((p) => p.channel === 'connected') || resp.body[0];
        PEER_B_NAME = peer?.name;
      });
    });
  });

  it('deploys a log-emitting app via API', () => {
    cy.loginTo(AGENT_A).then(() => {
      cy.request({
        method: 'POST',
        url: `${AGENT_A}/remoteapp`,
        body: {
          name: 'cypress-logs',
          target_peer: PEER_B_NAME,
          spec: {
            image: 'busybox:1.36',
            command: ['sh', '-c', 'i=1; while [ $i -le 30 ]; do echo "log line $i"; i=$((i+1)); sleep 1; done'],
            replicas: 1,
          },
        },
        headers: { 'Content-Type': 'application/json' },
      }).its('body.ok').should('be.true');
    });
  });

  it('app appears in the workloads table', () => {
    cy.loginUI();
    cy.visit('/workloads');
    cy.get('#submitted-body', { timeout: 15000 }).should('contain.text', 'cypress-logs');
  });

  it('logs tab in detail modal shows output (up to 90s)', () => {
    cy.loginUI();
    cy.visit('/workloads');
    cy.contains('#submitted-body tr', 'cypress-logs').click();

    cy.get('[class*="modal"], [id*="modal"], [role="dialog"]', { timeout: 8000 })
      .within(() => {
        cy.contains(/logs/i).click();

        // Wait for at least one log line to appear (up to 90s)
        cy.contains(/log line|Running|stdout/i, { timeout: 90000 }).should('be.visible');
      });
  });

  after(() => {
    // Clean up
    cy.loginTo(AGENT_A).then(() => {
      cy.request(`${AGENT_A}/remoteapps`).then((resp) => {
        const app = resp.body.find((a) => a.name === 'cypress-logs');
        const id = app?.app_id || app?.status?.appId;
        if (id) {
          cy.request({ method: 'DELETE', url: `${AGENT_A}/remoteapp/${id}`, failOnStatusCode: false });
        }
      });
    });
  });
});
