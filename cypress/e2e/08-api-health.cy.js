/**
 * API health / smoke tests — quick sanity checks on both agents.
 * These run fast and don't require peering.
 */
describe("API Health", () => {
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

  context("Agent A", () => {
    beforeEach(() => loginTo(AGENT_A));

    it("GET / returns 200", () => {
      cy.request(AGENT_A).its("status").should("eq", 200);
    });

    it("GET /settings returns 200", () => {
      cy.request(`${AGENT_A}/settings`).its("status").should("eq", 200);
    });

    it("GET /peers returns an array", () => {
      cy.request(`${AGENT_A}/peers`).then((resp) => {
        expect(resp.status).to.eq(200);
        expect(resp.body).to.be.an("array");
      });
    });

    it("GET /remoteapps returns an array", () => {
      cy.request(`${AGENT_A}/remoteapps`).then((resp) => {
        expect(resp.status).to.eq(200);
        expect(resp.body).to.be.an("array");
      });
    });

    it("GET /invite returns a bundle", () => {
      cy.request(`${AGENT_A}/invite`).then((resp) => {
        expect(resp.status).to.eq(200);
        expect(resp.body.bundle).to.be.a("string");
      });
    });

    it("unauthenticated GET /settings is rejected (redirect or 401)", () => {
      cy.clearCookies();
      cy.request({
        url: `${AGENT_A}/settings`,
        failOnStatusCode: false,
      }).then((resp) => {
        expect(resp.status).to.be.oneOf([302, 401, 403]);
      });
    });
  });

  context("Agent B", () => {
    beforeEach(() => loginTo(AGENT_B));

    it("GET / returns 200", () => {
      cy.request(AGENT_B).its("status").should("eq", 200);
    });

    it("GET /settings returns 200", () => {
      cy.request(`${AGENT_B}/settings`).its("status").should("eq", 200);
    });

    it("GET /peers returns an array", () => {
      cy.request(`${AGENT_B}/peers`).then((resp) => {
        expect(resp.status).to.eq(200);
        expect(resp.body).to.be.an("array");
      });
    });

    it("GET /remoteapps returns an array", () => {
      cy.request(`${AGENT_B}/remoteapps`).then((resp) => {
        expect(resp.status).to.eq(200);
        expect(resp.body).to.be.an("array");
      });
    });

    it("GET /invite returns a bundle", () => {
      cy.request(`${AGENT_B}/invite`).then((resp) => {
        expect(resp.status).to.eq(200);
        expect(resp.body.bundle).to.be.a("string");
      });
    });
  });
});
