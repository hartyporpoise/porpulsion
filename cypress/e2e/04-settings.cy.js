/**
 * Settings page tests — view settings, verify agent name is shown.
 */
describe('Settings', () => {
  const AGENT_A = Cypress.env('AGENT_A_URL');

  beforeEach(() => cy.loginUI());

  it('settings page loads', () => {
    cy.visit('/settings');
    cy.url().should('include', '/settings');
    cy.get('body').should('be.visible');
  });

  it('shows the agent name', () => {
    cy.loginTo(AGENT_A).then(() => {
      cy.request(`${AGENT_A}/settings`).then((resp) => {
        const agentName = resp.body.agentName;
        cy.visit('/settings');
        cy.contains(agentName).should('exist');
      });
    });
  });

  it('shows selfUrl', () => {
    cy.loginTo(AGENT_A).then(() => {
      cy.request(`${AGENT_A}/settings`).then((resp) => {
        const selfUrl = resp.body.selfUrl;
        cy.visit('/settings');
        cy.contains(selfUrl).should('exist');
      });
    });
  });

  it('shows the namespace', () => {
    cy.visit('/settings');
    cy.contains(/porpulsion/i).should('exist');
  });
});
