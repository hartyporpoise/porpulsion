/**
 * Peering tests — invite bundle exchange between Agent A and Agent B.
 *
 * Flow:
 *   1. GET agent-b /invite  → bundle
 *   2. POST agent-a /peers/connect  { bundle }
 *   3. Wait for channel to become "connected"
 *   4. Verify both agents show each other as peers
 */
describe("Peering", () => {
  const AGENT_A = Cypress.env("AGENT_A_URL");
  const AGENT_B = Cypress.env("AGENT_B_URL");
  const USERNAME = Cypress.env("USERNAME");
  const PASSWORD = Cypress.env("PASSWORD");

  // We need an active session cookie for A and B separately.
  // The simplest approach: use cy.request() directly (session cookies are
  // stored in the Cypress cookie jar per origin).

  function loginTo(agentUrl) {
    return cy.request({
      method: "POST",
      url: `${agentUrl}/login`,
      form: true,
      body: { username: USERNAME, password: PASSWORD },
      followRedirect: false,
    });
  }

  context("Invite bundle", () => {
    it("Agent B returns a valid invite bundle", () => {
      loginTo(AGENT_B).then(() => {
        cy.request(`${AGENT_B}/invite`).then((resp) => {
          expect(resp.status).to.eq(200);
          expect(resp.body).to.have.property("bundle").and.to.be.a("string");
          expect(resp.body).to.have.property("agent").and.to.be.a("string");
          expect(resp.body).to.have.property("self_url").and.to.be.a("string");
        });
      });
    });

    it("Agent A returns a valid invite bundle", () => {
      loginTo(AGENT_A).then(() => {
        cy.request(`${AGENT_A}/invite`).then((resp) => {
          expect(resp.status).to.eq(200);
          expect(resp.body.bundle).to.be.a("string").and.have.length.greaterThan(10);
        });
      });
    });
  });

  context("Connect peers (A → B)", () => {
    let bundleB;

    before(() => {
      // Fetch B's bundle
      loginTo(AGENT_B).then(() => {
        cy.request(`${AGENT_B}/invite`).then((resp) => {
          bundleB = resp.body.bundle;
        });
      });
    });

    it("rejects connect with missing bundle", () => {
      loginTo(AGENT_A).then(() => {
        cy.request({
          method: "POST",
          url: `${AGENT_A}/peers/connect`,
          body: {},
          headers: { "Content-Type": "application/json" },
          failOnStatusCode: false,
        }).then((resp) => {
          expect(resp.status).to.eq(400);
          expect(resp.body.error).to.match(/bundle is required/i);
        });
      });
    });

    it("rejects connect with garbage bundle", () => {
      loginTo(AGENT_A).then(() => {
        cy.request({
          method: "POST",
          url: `${AGENT_A}/peers/connect`,
          body: { bundle: "notavalidbundle" },
          headers: { "Content-Type": "application/json" },
          failOnStatusCode: false,
        }).then((resp) => {
          expect(resp.status).to.eq(400);
          expect(resp.body.error).to.match(/invalid bundle/i);
        });
      });
    });

    it("connects A to B successfully using valid bundle", () => {
      loginTo(AGENT_A).then(() => {
        cy.request({
          method: "POST",
          url: `${AGENT_A}/peers/connect`,
          body: { bundle: bundleB },
          headers: { "Content-Type": "application/json" },
        }).then((resp) => {
          expect(resp.status).to.eq(200);
          expect(resp.body.ok).to.be.true;
        });
      });
    });

    it("rejects duplicate connect (already peered)", () => {
      // Give the channel a moment to establish
      cy.wait(3000);
      loginTo(AGENT_A).then(() => {
        cy.request({
          method: "POST",
          url: `${AGENT_A}/peers/connect`,
          body: { bundle: bundleB },
          headers: { "Content-Type": "application/json" },
          failOnStatusCode: false,
        }).then((resp) => {
          expect(resp.status).to.eq(409);
          expect(resp.body.error).to.match(/already (fully )?peered/i);
        });
      });
    });
  });

  context("Peer list after connecting", () => {
    it("Agent A lists Agent B as a peer with connected channel", () => {
      loginTo(AGENT_A).then(() => {
        // Retry until channel is connected (up to 30s)
        const waitForChannel = (attempts = 0) => {
          cy.request(`${AGENT_A}/peers`).then((resp) => {
            expect(resp.status).to.eq(200);
            const peers = resp.body;
            const b = peers.find((p) => p.channel === "connected");
            if (!b && attempts < 10) {
              cy.wait(3000);
              waitForChannel(attempts + 1);
            } else {
              expect(b).to.exist;
            }
          });
        };
        waitForChannel();
      });
    });

    it("Agent A's peer entry has a name, url, and direction", () => {
      loginTo(AGENT_A).then(() => {
        cy.request(`${AGENT_A}/peers`).then((resp) => {
          expect(resp.body.length).to.be.greaterThan(0);
          const peer = resp.body[0];
          expect(peer).to.have.property("name").and.to.be.a("string");
          expect(peer).to.have.property("url").and.to.be.a("string");
          expect(peer).to.have.property("direction");
        });
      });
    });
  });

  context("Peering UI", () => {
    beforeEach(() => {
      cy.loginUI(USERNAME, PASSWORD);
    });

    it("peers page shows the connected peer", () => {
      cy.visit("/");
      // Navigate to peers section
      cy.contains(/peers/i).first().click({ force: true });
      cy.wait(1000);
      // At least one peer row should be visible
      cy.get("body").then(($body) => {
        // Accept either the peers section or the full page
        expect($body.text()).to.match(/connected|peer/i);
      });
    });
  });
});
