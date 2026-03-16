/**
 * Settings page tests — view settings, verify agent name and selfUrl are shown.
 */
describe('Settings', () => {
  const AGENT_A = Cypress.env('AGENT_A_URL');

  beforeEach(() => cy.loginTo());

  it('settings page loads', () => {
    cy.visit('/settings');
    cy.url().should('include', '/settings');
    cy.get('#settings-panel-agent').should('be.visible');
  });

  it('shows the agent name', () => {
    // Fetch agent name from /api/invite (has "agent" field), then verify it's visible in the UI
    cy.apiRequest('GET', `${AGENT_A}/api/invite`).then((resp) => {
      expect(resp.status).to.eq(200);
      const agentName = resp.body.agent;
      expect(agentName).to.be.a('string').and.have.length.greaterThan(0);
      cy.visit('/settings');
      // Agent name is rendered server-side in the first .stg-row-val.mono
      cy.get('#settings-panel-agent .stg-row-val.mono').first()
        .should('contain.text', agentName);
    });
  });

  it('shows selfUrl', () => {
    cy.visit('/settings');
    // selfUrl is loaded via JS into #about-url — wait for it to populate (not the dash placeholder)
    cy.get('#about-url', { timeout: 10000 })
      .should('not.have.text', '—')
      .and('not.be.empty');
  });

  it('executing panel has the inbound workloads toggle', () => {
    cy.visit('/settings');
    cy.get('.stg-tab[data-section="executing"]').click();
    cy.get('#settings-panel-executing #setting-inbound-apps').should('exist');
  });
});
