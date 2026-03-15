/**
 * First-run setup — create the admin user on both Agent A and Agent B
 * via the /signup UI. This must run before all other specs.
 *
 * On first boot the agent redirects GET / → /signup automatically.
 * We fill the form with the test credentials and submit.
 */
describe('First-run setup', () => {
  const USERNAME = Cypress.env('USERNAME');
  const PASSWORD = Cypress.env('PASSWORD');
  const AGENT_A  = Cypress.env('AGENT_A_URL');
  const AGENT_B  = Cypress.env('AGENT_B_URL');

  function createUser(agentUrl) {
    cy.visit(`${agentUrl}/signup`);
    // If we're redirected to /login, the user already exists — that's fine.
    cy.url().then((url) => {
      if (url.includes('/login')) return;
      cy.get('#username').type(USERNAME);
      cy.get('#password').type(PASSWORD);
      cy.get('#confirm').type(PASSWORD);
      cy.get('button[type="submit"]').click();
      // After submit: first-run signup auto-logs in and redirects to /
      cy.url({ timeout: 15000 }).should('not.include', '/signup');
    });
  }

  it('creates admin user on Agent A', () => {
    createUser(AGENT_A);
  });

  it('creates admin user on Agent B', () => {
    createUser(AGENT_B);
  });
});
