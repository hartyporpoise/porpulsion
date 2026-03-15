/**
 * Settings tests — view and update agent settings.
 */
describe("Settings", () => {
  const AGENT_A = Cypress.env("AGENT_A_URL");
  const USERNAME = Cypress.env("USERNAME");
  const PASSWORD = Cypress.env("PASSWORD");

  function loginToA() {
    return cy.request({
      method: "POST",
      url: `${AGENT_A}/login`,
      form: true,
      body: { username: USERNAME, password: PASSWORD },
      followRedirect: false,
    });
  }

  context("Settings API", () => {
    it("GET /settings returns current settings", () => {
      loginToA().then(() => {
        cy.request(`${AGENT_A}/settings`).then((resp) => {
          expect(resp.status).to.eq(200);
          const s = resp.body;
          expect(s).to.have.property("selfUrl").and.to.be.a("string");
          expect(s).to.have.property("agentName").and.to.be.a("string");
          expect(s).to.have.property("namespace").and.to.be.a("string");
        });
      });
    });

    it("settings include a non-empty selfUrl", () => {
      loginToA().then(() => {
        cy.request(`${AGENT_A}/settings`).then((resp) => {
          expect(resp.body.selfUrl).to.match(/^http/);
        });
      });
    });

    it("settings include the version hash", () => {
      loginToA().then(() => {
        cy.request(`${AGENT_A}/settings`).then((resp) => {
          expect(resp.body).to.have.property("versionHash");
        });
      });
    });
  });

  context("Settings UI", () => {
    beforeEach(() => {
      cy.loginUI(USERNAME, PASSWORD);
    });

    it("settings page loads without error", () => {
      cy.visit("/settings");
      cy.url().should("include", "/settings");
      cy.get("body").should("be.visible");
    });

    it("shows the agent name on the settings page", () => {
      cy.visit("/settings");
      loginToA().then(() => {
        cy.request(`${AGENT_A}/settings`).then((resp) => {
          const agentName = resp.body.agentName;
          cy.visit("/settings");
          cy.contains(agentName).should("exist");
        });
      });
    });
  });
});
