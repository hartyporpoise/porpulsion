/**
 * API health / smoke tests — authenticated sanity checks on both agents.
 * Uses Basic Auth via cy.apiRequest so these run fast without browser navigation.
 */
describe('API Health', () => {
  const AGENT_A = Cypress.env('AGENT_A_URL');
  const AGENT_B = Cypress.env('AGENT_B_URL');

  context('Agent A', () => {
    it('GET / returns 200', () => {
      cy.loginTo();
      cy.request(AGENT_A).its('status').should('eq', 200);
    });

    it('GET /api/settings returns 200 with known fields', () => {
      cy.apiRequest('GET', `${AGENT_A}/api/settings`).then((r) => {
        expect(r.status).to.eq(200);
        // Settings returns operational fields, not agentName/selfUrl
        expect(r.body).to.have.property('allow_inbound_remoteapps');
        expect(r.body).to.have.property('allow_inbound_tunnels');
      });
    });

    it('GET /api/peers returns array', () => {
      cy.apiRequest('GET', `${AGENT_A}/api/peers`).its('body').should('be.an', 'array');
    });

    it('GET /api/remoteapps returns submitted and executing lists', () => {
      cy.apiRequest('GET', `${AGENT_A}/api/remoteapps`).then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body).to.have.property('submitted').and.be.an('array');
        expect(r.body).to.have.property('executing').and.be.an('array');
      });
    });

    it('GET /api/invite returns a signed bundle', () => {
      cy.apiRequest('GET', `${AGENT_A}/api/invite`).then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body.bundle).to.be.a('string').and.have.length.greaterThan(10);
      });
    });

    it('unauthenticated GET /settings page redirects to /login', () => {
      cy.clearCookies();
      // followRedirect: false so we see the actual 302, not the login page 200
      cy.request({ url: `${AGENT_A}/settings`, failOnStatusCode: false, followRedirect: false })
        .its('status').should('be.oneOf', [302, 401, 403]);
    });

    it('unauthenticated GET /api/peers returns 401', () => {
      cy.request({ url: `${AGENT_A}/api/peers`, failOnStatusCode: false })
        .its('status').should('eq', 401);
    });

    it('unauthenticated GET /api/remoteapps returns 401', () => {
      cy.request({ url: `${AGENT_A}/api/remoteapps`, failOnStatusCode: false })
        .its('status').should('eq', 401);
    });

    it('GET /api/notifications returns array', () => {
      cy.apiRequest('GET', `${AGENT_A}/api/notifications`).then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body).to.be.an('array');
      });
    });
  });

  context('Agent B', () => {
    it('GET / returns 200', () => cy.request(AGENT_B).its('status').should('eq', 200));

    it('GET /api/settings returns 200 with known fields', () => {
      cy.apiRequest('GET', `${AGENT_B}/api/settings`).then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body).to.have.property('allow_inbound_remoteapps');
      });
    });

    it('GET /api/peers returns array', () => {
      cy.apiRequest('GET', `${AGENT_B}/api/peers`).its('body').should('be.an', 'array');
    });

    it('GET /api/remoteapps returns submitted and executing lists', () => {
      cy.apiRequest('GET', `${AGENT_B}/api/remoteapps`).then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body).to.have.property('submitted').and.be.an('array');
        expect(r.body).to.have.property('executing').and.be.an('array');
      });
    });

    it('GET /api/invite returns a signed bundle', () => {
      cy.apiRequest('GET', `${AGENT_B}/api/invite`).then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body.bundle).to.be.a('string').and.have.length.greaterThan(10);
      });
    });
  });
});
