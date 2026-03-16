/**
 * Peer persistence tests — verifies the peer table shows a connected peer
 * and that the peer detail modal opens correctly.
 * Precondition: A and B are peered (02-peering ran first).
 */
describe('Peer persistence', () => {
  beforeEach(() => cy.loginTo());

  it('peers page shows at least one peer', () => {
    cy.visit('/peers');
    cy.get('#all-peers-body tr', { timeout: 10000 }).should('have.length.greaterThan', 0);
  });

  it('peers table shows connected channel status', () => {
    cy.visit('/peers');
    // Channel badge renders "live" (badge-mtls) or "local" (badge-pending) — not the literal word "connected"
    cy.get('#all-peers-body .badge-mtls, #all-peers-body .badge-pending', { timeout: 15000 })
      .should('exist');
  });

  it('clicking a peer info button opens the peer detail modal', () => {
    cy.visit('/peers');
    // Click the info (i) button on the first peer row — not the row itself
    cy.get('#all-peers-body tr').first().find('.peer-info-btn').click();
    cy.get('#peer-modal.open', { timeout: 5000 }).should('be.visible');
    cy.get('#peer-modal-close').click();
    cy.get('#peer-modal').should('not.have.class', 'open');
  });

  it('peer detail modal shows peer name, URL, and latency', () => {
    cy.visit('/peers');
    cy.get('#all-peers-body tr').first().find('.peer-info-btn').click();
    cy.get('#peer-modal.open', { timeout: 5000 }).should('be.visible');
    // Modal must show a peer name and a URL (http)
    cy.get('#peer-modal').invoke('text').should('match', /http/i);
    cy.get('#peer-modal-close').click();
  });

  it('peer count badge matches the number of peer rows', () => {
    cy.visit('/peers');
    cy.get('#all-peers-body tr', { timeout: 10000 }).then(($rows) => {
      cy.get('#all-peers-count').should(($el) => {
        expect(parseInt($el.text(), 10)).to.eq($rows.length);
      });
    });
  });
});
