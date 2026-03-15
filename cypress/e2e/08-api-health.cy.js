/**
 * API health / smoke tests — quick sanity checks on both agents.
 * These run fast and don't require peering.
 */
describe('API Health', () => {
  const AGENT_A = Cypress.env('AGENT_A_URL');
  const AGENT_B = Cypress.env('AGENT_B_URL');

  function loginTo(url) {
    return cy.loginTo(url);
  }

  context('Agent A', () => {
    beforeEach(() => loginTo(AGENT_A));

    it('GET / returns 200', () => cy.request(AGENT_A).its('status').should('eq', 200));
    it('GET /settings returns 200 with agentName', () => {
      cy.request(`${AGENT_A}/settings`).then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body).to.have.property('agentName').and.be.a('string');
        expect(r.body).to.have.property('selfUrl').and.match(/^http/);
      });
    });
    it('GET /peers returns array', () => {
      cy.request(`${AGENT_A}/peers`).its('body').should('be.an', 'array');
    });
    it('GET /remoteapps returns array', () => {
      cy.request(`${AGENT_A}/remoteapps`).its('body').should('be.an', 'array');
    });
    it('GET /invite returns a signed bundle', () => {
      cy.request(`${AGENT_A}/invite`).then((r) => {
        expect(r.body.bundle).to.be.a('string').and.have.length.greaterThan(10);
      });
    });
    it('unauthenticated GET /settings redirects to /login', () => {
      cy.clearCookies();
      cy.request({ url: `${AGENT_A}/settings`, failOnStatusCode: false })
        .its('status').should('be.oneOf', [302, 401, 403]);
    });
  });

  context('Agent B', () => {
    beforeEach(() => loginTo(AGENT_B));

    it('GET / returns 200', () => cy.request(AGENT_B).its('status').should('eq', 200));
    it('GET /settings returns 200 with agentName', () => {
      cy.request(`${AGENT_B}/settings`).then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body.agentName).to.be.a('string');
      });
    });
    it('GET /peers returns array', () => {
      cy.request(`${AGENT_B}/peers`).its('body').should('be.an', 'array');
    });
    it('GET /remoteapps returns array', () => {
      cy.request(`${AGENT_B}/remoteapps`).its('body').should('be.an', 'array');
    });
    it('GET /invite returns a signed bundle', () => {
      cy.request(`${AGENT_B}/invite`).then((r) => {
        expect(r.body.bundle).to.be.a('string').and.have.length.greaterThan(10);
      });
    });
  });
});
