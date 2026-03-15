/**
 * Peer disconnect / reconnect persistence.
 *
 * Verifies that the peer survives a channel disconnect — i.e. it still
 * appears in the Peers table after a soft disconnect and reconnects on its own.
 */
describe('Peer disconnect & reconnect', () => {
  const AGENT_A = Cypress.env('AGENT_A_URL');

  beforeEach(() => cy.loginUI());

  it('peers page shows at least one peer', () => {
    cy.visit('/peers');
    cy.get('#all-peers-body tr').should('have.length.greaterThan', 0);
  });

  it('peer is still listed after a soft disconnect (channel close, not removal)', () => {
    // Send the disconnect signal via API
    cy.loginTo(AGENT_A).then(() => {
      cy.request(`${AGENT_A}/peers`).then((peersResp) => {
        const peer = peersResp.body[0];
        cy.request({
          method: 'POST',
          url: `${AGENT_A}/peer/disconnect`,
          body: { name: peer.name },
          headers: { 'Content-Type': 'application/json' },
          failOnStatusCode: false,
        }).then(() => {
          cy.wait(2000);
          // The peer must still exist in the list
          cy.request(`${AGENT_A}/peers`).then((resp) => {
            const still = resp.body.find((p) => p.name === peer.name);
            expect(still, 'peer was removed from list after disconnect').to.exist;
          });
        });
      });
    });
  });

  it('channel reconnects within 30s and peers table shows connected again', () => {
    cy.visit('/peers');

    const waitForConnected = (attempts = 0) => {
      cy.get('#all-peers-body').then(($tbody) => {
        if ($tbody.text().includes('connected')) return;
        if (attempts >= 10) throw new Error('Peer never reconnected in UI');
        cy.wait(3000);
        cy.reload();
        waitForConnected(attempts + 1);
      });
    };
    waitForConnected();
    cy.get('#all-peers-body').should('contain.text', 'connected');
  });
});
