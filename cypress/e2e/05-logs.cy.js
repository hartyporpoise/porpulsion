/**
 * Logs tests — verify the logs API works for executing apps.
 * Runs a short-lived app on B, fetches its logs via A.
 */
describe("Logs", () => {
  const AGENT_A = Cypress.env("AGENT_A_URL");
  const AGENT_B = Cypress.env("AGENT_B_URL");
  const USERNAME = Cypress.env("USERNAME");
  const PASSWORD = Cypress.env("PASSWORD");

  let PEER_B_NAME;
  let LOG_APP_ID;

  function loginTo(agentUrl) {
    return cy.request({
      method: "POST",
      url: `${agentUrl}/login`,
      form: true,
      body: { username: USERNAME, password: PASSWORD },
      followRedirect: false,
    });
  }

  before(() => {
    loginTo(AGENT_A).then(() => {
      cy.request(`${AGENT_A}/peers`).then((resp) => {
        const peer = resp.body.find((p) => p.channel === "connected") || resp.body[0];
        PEER_B_NAME = peer?.name;
      });
    });
  });

  it("deploys a log-generating app", () => {
    loginTo(AGENT_A).then(() => {
      cy.request({
        method: "POST",
        url: `${AGENT_A}/remoteapp`,
        body: {
          name: "cypress-logs",
          target_peer: PEER_B_NAME,
          spec: {
            image: "busybox:1.36",
            command: ["sh", "-c", "for i in $(seq 1 20); do echo \"line $i\"; sleep 1; done"],
            replicas: 1,
          },
        },
        headers: { "Content-Type": "application/json" },
      }).then((resp) => {
        expect(resp.status).to.eq(200);
      });
    });
  });

  it("app gets an appId", () => {
    cy.wait(5000);
    loginTo(AGENT_A).then(() => {
      cy.request(`${AGENT_A}/remoteapps`).then((resp) => {
        const app = resp.body.find((a) => a.name === "cypress-logs");
        LOG_APP_ID = app?.app_id || app?.status?.appId;
        expect(LOG_APP_ID).to.be.a("string").and.have.length.greaterThan(0);
      });
    });
  });

  it("logs endpoint returns output (up to 90s)", () => {
    const checkLogs = (attempts = 0) => {
      cy.wait(5000);
      loginTo(AGENT_A).then(() => {
        cy.request({
          url: `${AGENT_A}/remoteapp/${LOG_APP_ID}/logs`,
          failOnStatusCode: false,
        }).then((resp) => {
          if (resp.status === 200 && resp.body?.logs?.length > 0) {
            expect(resp.body.logs).to.be.an("array").and.have.length.greaterThan(0);
          } else if (attempts < 16) {
            checkLogs(attempts + 1);
          } else {
            expect(resp.status, "logs endpoint never returned 200").to.eq(200);
          }
        });
      });
    };
    checkLogs();
  });

  it("cleans up the logs app", () => {
    loginTo(AGENT_A).then(() => {
      if (!LOG_APP_ID) return;
      cy.request({
        method: "DELETE",
        url: `${AGENT_A}/remoteapp/${LOG_APP_ID}`,
        failOnStatusCode: false,
      });
    });
  });
});
