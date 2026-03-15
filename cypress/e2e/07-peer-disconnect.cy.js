/**
 * Peer disconnect / reconnect persistence tests.
 *
 * Verifies that:
 * - Disconnect does NOT wipe the peer from state (only the channel closes)
 * - After reconnect the peer appears with a connected channel again
 */
describe("Peer disconnect & reconnect persistence", () => {
  const AGENT_A = Cypress.env("AGENT_A_URL");
  const AGENT_B = Cypress.env("AGENT_B_URL");
  const USERNAME = Cypress.env("USERNAME");
  const PASSWORD = Cypress.env("PASSWORD");

  function loginTo(agentUrl) {
    return cy.request({
      method: "POST",
      url: `${agentUrl}/login`,
      form: true,
      body: { username: USERNAME, password: PASSWORD },
      followRedirect: false,
    });
  }

  it("Agent A has at least one peer before disconnect", () => {
    loginTo(AGENT_A).then(() => {
      cy.request(`${AGENT_A}/peers`).then((resp) => {
        expect(resp.body.length).to.be.greaterThan(0);
      });
    });
  });

  it("GET /peers still returns the peer after a disconnect signal", () => {
    // We simulate a soft disconnect via POST /peer/disconnect (channel close, not removal)
    loginTo(AGENT_A).then(() => {
      cy.request(`${AGENT_A}/peers`).then((peersResp) => {
        const peer = peersResp.body[0];
        expect(peer).to.exist;

        // POST disconnect — should close WS channel but NOT remove peer from list
        cy.request({
          method: "POST",
          url: `${AGENT_A}/peer/disconnect`,
          body: { name: peer.name },
          headers: { "Content-Type": "application/json" },
          failOnStatusCode: false,
        }).then(() => {
          // Peer must still exist in the list (channel may be disconnected briefly)
          cy.wait(1000);
          loginTo(AGENT_A).then(() => {
            cy.request(`${AGENT_A}/peers`).then((resp2) => {
              const still = resp2.body.find((p) => p.name === peer.name);
              expect(still, "peer was removed from list after disconnect — should persist").to.exist;
            });
          });
        });
      });
    });
  });

  it("channel reconnects automatically (up to 30s)", () => {
    // After disconnect the channel.py loop should auto-reconnect
    const waitForConnected = (attempts = 0) => {
      cy.wait(3000);
      loginTo(AGENT_A).then(() => {
        cy.request(`${AGENT_A}/peers`).then((resp) => {
          const connected = resp.body.find((p) => p.channel === "connected");
          if (connected || attempts >= 10) {
            expect(connected, "channel never reconnected").to.exist;
          } else {
            waitForConnected(attempts + 1);
          }
        });
      });
    };
    waitForConnected();
  });

  it("DELETE /peers/<name> permanently removes the peer", () => {
    loginTo(AGENT_A).then(() => {
      cy.request(`${AGENT_A}/peers`).then((peersResp) => {
        const peer = peersResp.body[0];
        if (!peer) return;

        cy.request({
          method: "DELETE",
          url: `${AGENT_A}/peers/${encodeURIComponent(peer.name)}`,
        }).then((resp) => {
          expect(resp.status).to.eq(200);
        });

        cy.wait(1000);
        loginTo(AGENT_A).then(() => {
          cy.request(`${AGENT_A}/peers`).then((resp2) => {
            const gone = resp2.body.find((p) => p.name === peer.name);
            expect(gone, "peer still exists after DELETE").to.be.undefined;
          });
        });
      });
    });
  });

  // Re-peer for any remaining tests
  after(() => {
    loginTo(AGENT_B).then(() => {
      cy.request(`${AGENT_B}/invite`).then((inviteResp) => {
        loginTo(AGENT_A).then(() => {
          cy.request({
            method: "POST",
            url: `${AGENT_A}/peers/connect`,
            body: { bundle: inviteResp.body.bundle },
            headers: { "Content-Type": "application/json" },
            failOnStatusCode: false, // May already be peered
          });
        });
      });
    });
  });
});
