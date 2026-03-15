/**
 * Peering tests — connect Agent A → Agent B entirely through the UI.
 *
 * Flow:
 *   1. Open Agent B's Peers page, reveal and copy the invite bundle
 *   2. Open Agent A's Peers page, paste the bundle, submit
 *   3. Wait for the peer row to appear as "connected"
 */
describe('Peering', () => {
  const AGENT_B = Cypress.env('AGENT_B_URL');

  // We need Agent B's invite bundle. Fetch it via API (it's a read-only
  // endpoint — no user interaction needed to just get the value).
  let bundleB;

  before(() => {
    cy.loginTo(AGENT_B).then(() => {
      cy.request(`${AGENT_B}/invite`).then((resp) => {
        bundleB = resp.body.bundle;
        expect(bundleB).to.be.a('string').and.have.length.greaterThan(10);
      });
    });
  });

  // ----------------------------------------------------------------
  // Invite bundle UI
  // ----------------------------------------------------------------
  context('Your Invite Bundle card on Agent A', () => {
    beforeEach(() => cy.loginUI());

    it('shows the invite bundle on the Peers page', () => {
      cy.visit('/peers');
      // The bundle is masked by default — reveal it
      cy.get('#invite-bundle').should('exist');
      cy.get('.eye-btn').first().click();
      cy.get('#invite-bundle').invoke('attr', 'data-value').should('have.length.greaterThan', 10);
    });

    it('shows the self URL endpoint', () => {
      cy.visit('/peers');
      cy.get('#token-url').should('not.be.empty');
    });
  });

  // ----------------------------------------------------------------
  // Connect via the UI form
  // ----------------------------------------------------------------
  context('Connect A → B using the UI form', () => {
    it('pastes Agent B bundle into the connect form and submits', () => {
      cy.loginUI();
      cy.visit('/peers');

      cy.get('#new-peer-bundle').should('be.visible').type(bundleB, { delay: 0 });
      cy.get('#connect-peer-form button[type="submit"]').click();

      // Should show a success toast or the peer should appear in the table
      // Give the channel a few seconds to establish
      cy.wait(4000);

      // The peers table should now have at least one row
      cy.get('#all-peers-body tr', { timeout: 20000 }).should('have.length.greaterThan', 0);
    });

    it('peer row shows the connected channel status', () => {
      cy.loginUI();
      cy.visit('/peers');

      // Poll until the channel shows "connected"
      const waitForConnected = (attempts = 0) => {
        cy.get('#all-peers-body').then(($tbody) => {
          const text = $tbody.text();
          if (text.includes('connected')) return;
          if (attempts >= 10) throw new Error('Peer channel never showed connected in UI');
          cy.wait(3000);
          cy.reload();
          waitForConnected(attempts + 1);
        });
      };
      waitForConnected();
      cy.get('#all-peers-body').should('contain.text', 'connected');
    });

    it('shows peer count badge > 0', () => {
      cy.loginUI();
      cy.visit('/peers');
      cy.get('#all-peers-count').invoke('text').then((text) => {
        expect(parseInt(text, 10)).to.be.greaterThan(0);
      });
    });

    it('rejects a duplicate connect attempt', () => {
      cy.loginUI();
      cy.visit('/peers');
      cy.get('#new-peer-bundle').type(bundleB, { delay: 0 });
      cy.get('#connect-peer-form button[type="submit"]').click();
      // Should show an error toast (already peered)
      cy.get('.toast, [class*="toast"], [class*="error"]', { timeout: 8000 })
        .should('be.visible')
        .and('satisfy', ($el) => $el.text().match(/already|peered|409/i));
    });
  });
});
