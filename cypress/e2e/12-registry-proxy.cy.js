/**
 * Registry pull-through proxy tests.
 *
 * The /v2/ OCI Distribution endpoint is always registered on the agent.
 * The registry_pull_enabled toggle controls whether the k8s pull secret and
 * system user are created — it doesn't gate the /v2/ route itself.
 *
 * Tests:
 *   1. /v2/ OCI ping responds correctly (authenticated).
 *   2. Unauthenticated /v2/ returns 401 with WWW-Authenticate and OCI error body.
 *   3. registry_pull_enabled toggle persists to the API.
 *   4. Proxying a public image manifest returns a non-500 response.
 *
 * Preconditions: Both agents running.
 */
describe('Registry pull-through proxy', () => {
  const AGENT_A = Cypress.env('AGENT_A_URL');
  const AGENT_B = Cypress.env('AGENT_B_URL');

  after(() => {
    // Restore default (disabled) after all tests
    cy.apiRequest('POST', `${AGENT_B}/api/settings`, { registry_pull_enabled: false });
  });

  // ----------------------------------------------------------------
  // /v2/ endpoint — always active, auth-gated
  // ----------------------------------------------------------------
  context('/v2/ OCI ping endpoint', () => {
    it('unauthenticated GET /v2/ returns 401 with Docker-Distribution-Api-Version header', () => {
      cy.request({
        method: 'GET',
        url: `${AGENT_A}/v2/`,
        failOnStatusCode: false,
      }).then((r) => {
        expect(r.status).to.eq(401);
        expect(r.headers).to.have.property('docker-distribution-api-version', 'registry/2.0');
        // OCI error body
        expect(r.body).to.have.property('errors').that.is.an('array');
      });
    });

    it('authenticated GET /v2/ returns 200 with OCI distribution API version header', () => {
      cy.request({
        method: 'GET',
        url: `${AGENT_A}/v2/`,
        failOnStatusCode: false,
        auth: { user: Cypress.env('USERNAME'), pass: Cypress.env('PASSWORD') },
      }).then((r) => {
        expect(r.status).to.eq(200);
        expect(r.headers).to.have.property('docker-distribution-api-version', 'registry/2.0');
      });
    });

    it('authenticated HEAD /v2/ also returns 200', () => {
      cy.request({
        method: 'HEAD',
        url: `${AGENT_A}/v2/`,
        failOnStatusCode: false,
        auth: { user: Cypress.env('USERNAME'), pass: Cypress.env('PASSWORD') },
      }).then((r) => {
        expect(r.status).to.eq(200);
      });
    });
  });

  // ----------------------------------------------------------------
  // Proxy a public manifest — confirms the proxy forwards requests
  // ----------------------------------------------------------------
  context('Manifest proxy (public registry)', () => {
    it('GET /v2/<host>/<repo>/manifests/<tag> for a public image returns non-500', () => {
      // Route: /v2/registry-1.docker.io/library/alpine/manifests/3.19
      // The proxy forwards this to https://registry-1.docker.io/v2/library/alpine/manifests/3.19
      // We expect 200 (manifest), 401 (upstream auth required), or 404 — NOT 500.
      cy.request({
        method: 'GET',
        url: `${AGENT_A}/v2/registry-1.docker.io/library/alpine/manifests/3.19`,
        failOnStatusCode: false,
        auth: { user: Cypress.env('USERNAME'), pass: Cypress.env('PASSWORD') },
        headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' },
        timeout: 30000,
      }).then((r) => {
        expect(r.status).to.be.lessThan(500);
      });
    });
  });

  // ----------------------------------------------------------------
  // registry_pull_enabled toggle persists to API
  // ----------------------------------------------------------------
  context('registry_pull_enabled toggle', () => {
    it('enabling registry_pull_enabled persists to GET /api/settings', () => {
      cy.apiRequest('POST', `${AGENT_B}/api/settings`, { registry_pull_enabled: true })
        .its('status').should('eq', 200);
      cy.apiRequest('GET', `${AGENT_B}/api/settings`).then((r) => {
        expect(r.body.registry_pull_enabled).to.eq(true);
      });
    });

    it('Registry tab in the UI reflects the enabled state', () => {
      cy.loginTo(AGENT_B);
      cy.visit(`${AGENT_B}/settings`);
      cy.get('.stg-tab[data-section="registry"]').click();
      cy.get('#setting-registry-pull-enabled', { timeout: 5000 }).should('be.checked');
    });

    it('disabling registry_pull_enabled persists to GET /api/settings', () => {
      cy.apiRequest('POST', `${AGENT_B}/api/settings`, { registry_pull_enabled: false })
        .its('status').should('eq', 200);
      cy.apiRequest('GET', `${AGENT_B}/api/settings`).then((r) => {
        expect(r.body.registry_pull_enabled).to.eq(false);
      });
    });

    it('saving a registry_api_url via the UI form persists to the API', () => {
      // First enable registry pull so the URL field is relevant
      cy.apiRequest('POST', `${AGENT_B}/api/settings`, { registry_pull_enabled: true });

      cy.loginTo(AGENT_B);
      cy.visit(`${AGENT_B}/settings`);
      cy.get('.stg-tab[data-section="registry"]').click();
      cy.get('#setting-registry-api-url').clear().type('https://registry.example.internal');
      cy.get('#setting-registry-save').click();
      cy.get('#toast', { timeout: 5000 }).should('have.class', 'show')
        .and('satisfy', ($el) => /saved|registry/i.test($el.text()));

      cy.apiRequest('GET', `${AGENT_B}/api/settings`).then((r) => {
        expect(r.body.registry_api_url).to.eq('https://registry.example.internal');
      });

      // Clean up the url field
      cy.apiRequest('POST', `${AGENT_B}/api/settings`, {
        registry_pull_enabled: false,
        registry_api_url: '',
      });
    });
  });
});
