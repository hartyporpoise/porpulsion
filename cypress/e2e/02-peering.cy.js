/**
 * Peering tests — connect Agent A → Agent B entirely through the UI.
 *
 * Flow:
 *   1. Fetch Agent B's invite bundle via authenticated API
 *   2. Open Agent A's Peers page, paste the bundle, submit
 *   3. Wait for the peer row to show "connected"
 */
describe('Peering', () => {
  const AGENT_B = Cypress.env('AGENT_B_URL');
  let bundleB;

  before(() => {
    // Fetch Agent B's invite bundle via Basic Auth API call
    cy.apiRequest('GET', `${AGENT_B}/api/invite`).then((resp) => {
      expect(resp.status).to.eq(200);
      bundleB = resp.body.bundle;
      expect(bundleB).to.be.a('string').and.have.length.greaterThan(10);
    });
  });

  context('Your Invite Bundle card on Agent A', () => {
    beforeEach(() => cy.loginTo());

    it('shows the invite bundle on the Peers page', () => {
      cy.visit('/peers');
      cy.get('#invite-bundle').should('exist');
      // Reveal the masked bundle
      cy.get('.eye-btn').first().click();
      cy.get('#invite-bundle').invoke('attr', 'data-value').should('have.length.greaterThan', 10);
    });

    it('shows the self URL endpoint', () => {
      cy.visit('/peers');
      cy.get('#token-url', { timeout: 8000 }).should('not.contain.text', 'loading').and('not.be.empty');
    });
  });

  context('Connect A → B using the UI form', () => {
    it('pastes Agent B bundle into the connect form and submits', () => {
      cy.loginTo();
      cy.visit('/peers');
      cy.get('#new-peer-bundle').should('be.visible').type(bundleB, { delay: 0 });
      cy.get('#connect-peer-form button[type="submit"]').click();
      // Wait for the peer row to appear
      cy.get('#all-peers-body tr', { timeout: 20000 }).should('have.length.greaterThan', 0);
    });

    it('peer row shows the connected channel status', () => {
      cy.loginTo();
      cy.visit('/peers');
      // Channel badge shows "live" (badge-mtls) or "local" (badge-pending) — never the literal word "connected".
      // Use Cypress retry-ability: should() retries until the badge appears or timeout.
      cy.get('#all-peers-body .badge-mtls, #all-peers-body .badge-pending', { timeout: 30000 })
        .should('exist');
    });

    it('shows peer count badge > 0', () => {
      cy.loginTo();
      cy.visit('/peers');
      // #all-peers-count is updated by the JS poll — wait for it to reflect > 0
      cy.get('#all-peers-count', { timeout: 15000 }).should(($el) => {
        expect(parseInt($el.text(), 10)).to.be.greaterThan(0);
      });
    });

    it('rejects a duplicate connect attempt', () => {
      cy.loginTo();
      cy.visit('/peers');
      cy.get('#new-peer-bundle').type(bundleB, { delay: 0 });
      cy.get('#connect-peer-form button[type="submit"]').click();
      // Should show a toast error for already-peered.
      // #toast uses opacity for show/hide so check for 'show' class, not 'be.visible'.
      cy.get('#toast', { timeout: 8000 })
        .should('have.class', 'show')
        .and('satisfy', ($el) => /already|peered|409|exists/i.test($el.text()));
    });
  });
});
