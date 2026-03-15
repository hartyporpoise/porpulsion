/**
 * Terminal tests — open the exec tab on a running app and verify the
 * terminal element renders. Full WS interaction isn't testable in Cypress,
 * but we can confirm the xterm container mounts and the shell dropdown exists.
 */
describe('Terminal (exec)', () => {
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

  it('deploys a long-running alpine container for exec testing', () => {
    cy.loginTo(AGENT_A).then(() => {
      cy.request({
        method: 'POST',
        url: `${AGENT_A}/remoteapp`,
        body: {
          name: 'cypress-exec',
          target_peer: PEER_B_NAME,
          spec: { image: 'alpine:3.19', command: ['sh', '-c', 'sleep 3600'], replicas: 1 },
        },
        headers: { 'Content-Type': 'application/json' },
      }).its('body.ok').should('be.true');
    });
  });

  it('app reaches Running on Agent B (up to 90s)', () => {
    cy.loginTo(AGENT_A);
    cy.waitForAppPhase(AGENT_A, 'cypress-exec', 'Running', 18, 5000);
  });

  it('detail modal has a terminal/exec tab when app is Running', () => {
    cy.loginUI();
    cy.visit('/workloads');
    cy.contains('#submitted-body tr', 'cypress-exec').click();

    cy.get('[class*="modal"], [id*="modal"], [role="dialog"]', { timeout: 8000 })
      .within(() => {
        // The terminal tab label may say "Terminal", "Exec", or "Shell"
        cy.contains(/terminal|exec|shell/i).should('exist').click();
        // xterm container should render
        cy.get('.xterm, [class*="terminal"], [id*="terminal"]', { timeout: 10000 })
          .should('exist');
      });
  });

  it('shell selector dropdown exists in the exec tab', () => {
    cy.loginUI();
    cy.visit('/workloads');
    cy.contains('#submitted-body tr', 'cypress-exec').click();

    cy.get('[class*="modal"], [id*="modal"], [role="dialog"]', { timeout: 8000 })
      .within(() => {
        cy.contains(/terminal|exec|shell/i).click();
        cy.get('select', { timeout: 5000 }).should('exist');
      });
  });

  after(() => {
    cy.loginTo(AGENT_A).then(() => {
      cy.request(`${AGENT_A}/remoteapps`).then((resp) => {
        const app = resp.body.find((a) => a.name === 'cypress-exec');
        const id = app?.app_id || app?.status?.appId;
        if (id) {
          cy.request({ method: 'DELETE', url: `${AGENT_A}/remoteapp/${id}`, failOnStatusCode: false });
        }
      });
    });
  });
});
