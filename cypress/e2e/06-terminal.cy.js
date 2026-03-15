/**
 * Terminal / exec tests.
 * We open a WebSocket exec session to a running pod on Agent B and verify
 * that we can send input and receive output.
 *
 * Note: Cypress doesn't support WebSocket natively, so we test the exec
 * setup endpoint and verify the pod is exec-able via the agent's API.
 */
describe("Terminal (exec)", () => {
  const AGENT_A = Cypress.env("AGENT_A_URL");
  const AGENT_B = Cypress.env("AGENT_B_URL");
  const USERNAME = Cypress.env("USERNAME");
  const PASSWORD = Cypress.env("PASSWORD");

  let PEER_B_NAME;
  let EXEC_APP_ID;

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

  it("deploys a long-running shell app for exec testing", () => {
    loginTo(AGENT_A).then(() => {
      cy.request({
        method: "POST",
        url: `${AGENT_A}/remoteapp`,
        body: {
          name: "cypress-exec",
          target_peer: PEER_B_NAME,
          spec: {
            image: "alpine:3.19",
            command: ["sh", "-c", "sleep 3600"],
            replicas: 1,
          },
        },
        headers: { "Content-Type": "application/json" },
      }).then((resp) => {
        expect(resp.status).to.eq(200);
      });
    });
  });

  it("app reaches Running state (up to 90s)", () => {
    const waitForRunning = (attempts = 0) => {
      cy.wait(5000);
      loginTo(AGENT_A).then(() => {
        cy.request(`${AGENT_A}/remoteapps`).then((resp) => {
          const app = resp.body.find((a) => a.name === "cypress-exec");
          EXEC_APP_ID = app?.app_id || app?.status?.appId;
          if (app?.status?.phase === "Running") {
            expect(app.status.phase).to.eq("Running");
          } else if (attempts < 16) {
            waitForRunning(attempts + 1);
          } else {
            expect(app?.status?.phase, "never reached Running").to.eq("Running");
          }
        });
      });
    };
    waitForRunning();
  });

  it("exec detail endpoint returns pod info", () => {
    loginTo(AGENT_A).then(() => {
      cy.request({
        url: `${AGENT_A}/remoteapp/${EXEC_APP_ID}`,
        failOnStatusCode: false,
      }).then((resp) => {
        expect(resp.status).to.eq(200);
        const detail = resp.body;
        // App should have spec and status
        expect(detail).to.have.property("spec");
        expect(detail.status?.phase).to.eq("Running");
      });
    });
  });

  it("WebSocket exec endpoint path exists (HTTP upgrade check)", () => {
    // We can't do a full WS test in Cypress, but we can verify the
    // exec endpoint at least exists and returns an expected response
    // (101 Upgrade or 400 bad request without WS headers — not 404).
    loginTo(AGENT_A).then(() => {
      cy.request({
        method: "GET",
        url: `${AGENT_A}/remoteapp/${EXEC_APP_ID}/exec`,
        failOnStatusCode: false,
        headers: { Accept: "text/html" },
      }).then((resp) => {
        // Should not be 404 (endpoint exists)
        expect(resp.status).to.not.eq(404);
      });
    });
  });

  it("cleans up the exec app", () => {
    loginTo(AGENT_A).then(() => {
      if (!EXEC_APP_ID) return;
      cy.request({
        method: "DELETE",
        url: `${AGENT_A}/remoteapp/${EXEC_APP_ID}`,
        failOnStatusCode: false,
      });
    });
  });
});
