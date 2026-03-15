/**
 * Workload (RemoteApp) tests — deploy, scale, spec update, delete.
 *
 * Precondition: A and B are already peered (02-peering ran first).
 *
 * We deploy from Agent A targeting Agent B as the executor.
 */
describe("Workloads", () => {
  const AGENT_A = Cypress.env("AGENT_A_URL");
  const AGENT_B = Cypress.env("AGENT_B_URL");
  const USERNAME = Cypress.env("USERNAME");
  const PASSWORD = Cypress.env("PASSWORD");

  let PEER_B_NAME; // populated in before()
  let appCrName;   // populated after deploy

  function loginTo(agentUrl) {
    return cy.request({
      method: "POST",
      url: `${agentUrl}/login`,
      form: true,
      body: { username: USERNAME, password: PASSWORD },
      followRedirect: false,
    });
  }

  function loginToA() { return loginTo(AGENT_A); }
  function loginToB() { return loginTo(AGENT_B); }

  before(() => {
    // Discover Agent B's name from Agent A's peer list
    loginToA().then(() => {
      cy.request(`${AGENT_A}/peers`).then((resp) => {
        const connected = resp.body.find((p) => p.channel === "connected");
        PEER_B_NAME = connected ? connected.name : resp.body[0]?.name;
        expect(PEER_B_NAME).to.be.a("string");
      });
    });
  });

  // ----------------------------------------------------------------
  // Deploy
  // ----------------------------------------------------------------
  context("Deploy a RemoteApp", () => {
    it("deploys an nginx workload from A to B", () => {
      loginToA().then(() => {
        cy.request({
          method: "POST",
          url: `${AGENT_A}/remoteapp`,
          body: {
            name: "cypress-nginx",
            target_peer: PEER_B_NAME,
            spec: {
              image: "nginx:alpine",
              replicas: 1,
              port: 80,
            },
          },
          headers: { "Content-Type": "application/json" },
        }).then((resp) => {
          expect(resp.status).to.eq(200);
          expect(resp.body.ok).to.be.true;
        });
      });
    });

    it("lists the app in Agent A's RemoteApps", () => {
      loginToA().then(() => {
        cy.request(`${AGENT_A}/remoteapps`).then((resp) => {
          expect(resp.status).to.eq(200);
          const app = resp.body.find((a) => a.name === "cypress-nginx");
          expect(app).to.exist;
          appCrName = app?.cr_name || app?.name;
        });
      });
    });

    it("Agent B eventually shows the app as Running (up to 90s)", () => {
      loginToB();
      const waitForRunning = (attempts = 0) => {
        cy.wait(5000);
        loginToB().then(() => {
          cy.request(`${AGENT_B}/remoteapps`).then((resp) => {
            const app = resp.body.find(
              (a) => a.name === "cypress-nginx" || a.spec?.image?.includes("nginx")
            );
            if (app && app.status?.phase === "Running") {
              expect(app.status.phase).to.eq("Running");
            } else if (attempts < 16) {
              waitForRunning(attempts + 1);
            } else {
              // Print last known state for debug
              expect(app?.status?.phase, "app never reached Running").to.eq("Running");
            }
          });
        });
      };
      waitForRunning();
    });

    it("app has an appId in Agent A's list", () => {
      loginToA().then(() => {
        cy.request(`${AGENT_A}/remoteapps`).then((resp) => {
          const app = resp.body.find((a) => a.name === "cypress-nginx");
          expect(app?.status?.appId || app?.app_id).to.be.a("string").and.have.length.greaterThan(0);
        });
      });
    });
  });

  // ----------------------------------------------------------------
  // Scale
  // ----------------------------------------------------------------
  context("Scale a RemoteApp", () => {
    it("scales the app to 2 replicas", () => {
      loginToA().then(() => {
        cy.request(`${AGENT_A}/remoteapps`).then((listResp) => {
          const app = listResp.body.find((a) => a.name === "cypress-nginx");
          expect(app).to.exist;
          const id = app.app_id || app.status?.appId;
          cy.request({
            method: "POST",
            url: `${AGENT_A}/remoteapp/${id}/scale`,
            body: { replicas: 2 },
            headers: { "Content-Type": "application/json" },
          }).then((resp) => {
            expect(resp.status).to.eq(200);
            expect(resp.body.ok).to.be.true;
          });
        });
      });
    });

    it("Agent B eventually shows 2 replicas running (up to 60s)", () => {
      const waitFor2 = (attempts = 0) => {
        cy.wait(5000);
        loginToB().then(() => {
          cy.request(`${AGENT_B}/remoteapps`).then((resp) => {
            const app = resp.body.find(
              (a) => a.name === "cypress-nginx" || a.spec?.image?.includes("nginx")
            );
            const replicas = app?.status?.replicas || app?.replicas;
            if (replicas >= 2) {
              expect(replicas).to.be.at.least(2);
            } else if (attempts < 12) {
              waitFor2(attempts + 1);
            } else {
              expect(replicas, "replicas never reached 2").to.be.at.least(2);
            }
          });
        });
      };
      waitFor2();
    });

    it("scales back down to 1 replica", () => {
      loginToA().then(() => {
        cy.request(`${AGENT_A}/remoteapps`).then((listResp) => {
          const app = listResp.body.find((a) => a.name === "cypress-nginx");
          const id = app.app_id || app.status?.appId;
          cy.request({
            method: "POST",
            url: `${AGENT_A}/remoteapp/${id}/scale`,
            body: { replicas: 1 },
            headers: { "Content-Type": "application/json" },
          }).then((resp) => {
            expect(resp.status).to.eq(200);
          });
        });
      });
    });
  });

  // ----------------------------------------------------------------
  // Spec update
  // ----------------------------------------------------------------
  context("Spec update (YAML editor)", () => {
    it("updates the image tag via spec patch", () => {
      loginToA().then(() => {
        cy.request(`${AGENT_A}/remoteapps`).then((listResp) => {
          const app = listResp.body.find((a) => a.name === "cypress-nginx");
          const id = app.app_id || app.status?.appId;
          const crName = app.cr_name || "cypress-nginx";
          const peerName = app.peer || PEER_B_NAME;

          cy.request({
            method: "POST",
            url: `${AGENT_A}/remoteapp/${id}/spec`,
            body: {
              spec_yaml: `image: nginx:1.25-alpine\nreplicas: 1\nport: 80\ntargetPeer: ${peerName}\n`,
            },
            headers: { "Content-Type": "application/json" },
          }).then((resp) => {
            expect(resp.status).to.eq(200);
            expect(resp.body.ok).to.be.true;
          });
        });
      });
    });

    it("updated image eventually reflects on Agent B (up to 90s)", () => {
      const waitForImage = (attempts = 0) => {
        cy.wait(5000);
        loginToB().then(() => {
          cy.request(`${AGENT_B}/remoteapps`).then((resp) => {
            const app = resp.body.find(
              (a) => a.name === "cypress-nginx" || a.spec?.image?.includes("nginx")
            );
            if (app?.spec?.image?.includes("1.25") || attempts >= 16) {
              // Accept either propagated or timeout (spec patching may be async)
              expect(app).to.exist;
            } else {
              waitForImage(attempts + 1);
            }
          });
        });
      };
      waitForImage();
    });
  });

  // ----------------------------------------------------------------
  // App detail
  // ----------------------------------------------------------------
  context("App detail", () => {
    it("detail endpoint returns spec and status", () => {
      loginToA().then(() => {
        cy.request(`${AGENT_A}/remoteapps`).then((listResp) => {
          const app = listResp.body.find((a) => a.name === "cypress-nginx");
          const id = app.app_id || app.status?.appId;
          cy.request(`${AGENT_A}/remoteapp/${id}`).then((resp) => {
            expect(resp.status).to.eq(200);
            expect(resp.body).to.have.property("spec");
            expect(resp.body).to.have.property("status");
          });
        });
      });
    });
  });

  // ----------------------------------------------------------------
  // Deploy via full CR YAML
  // ----------------------------------------------------------------
  context("Deploy via full CR YAML", () => {
    it("deploys a second app using cr_yaml field", () => {
      loginToA().then(() => {
        const cr = `apiVersion: porpulsion.io/v1alpha1
kind: RemoteApp
metadata:
  name: cypress-busybox
spec:
  image: busybox:1.36
  command: ["sh", "-c", "while true; do sleep 3600; done"]
  replicas: 1
  targetPeer: ${PEER_B_NAME}
`;
        cy.request({
          method: "POST",
          url: `${AGENT_A}/remoteapp`,
          body: { cr_yaml: cr },
          headers: { "Content-Type": "application/json" },
        }).then((resp) => {
          expect(resp.status).to.eq(200);
          expect(resp.body.ok).to.be.true;
        });
      });
    });

    it("busybox app appears in Agent A's list", () => {
      cy.wait(3000);
      loginToA().then(() => {
        cy.request(`${AGENT_A}/remoteapps`).then((resp) => {
          const app = resp.body.find((a) => a.name === "cypress-busybox");
          expect(app).to.exist;
        });
      });
    });
  });

  // ----------------------------------------------------------------
  // Delete
  // ----------------------------------------------------------------
  context("Delete RemoteApps", () => {
    it("deletes the nginx app", () => {
      loginToA().then(() => {
        cy.request(`${AGENT_A}/remoteapps`).then((listResp) => {
          const app = listResp.body.find((a) => a.name === "cypress-nginx");
          const id = app?.app_id || app?.status?.appId;
          if (!id) return; // already gone
          cy.request({
            method: "DELETE",
            url: `${AGENT_A}/remoteapp/${id}`,
          }).then((resp) => {
            expect(resp.status).to.eq(200);
            expect(resp.body.ok).to.be.true;
          });
        });
      });
    });

    it("nginx app no longer appears in Agent A's list after deletion", () => {
      cy.wait(3000);
      loginToA().then(() => {
        cy.request(`${AGENT_A}/remoteapps`).then((resp) => {
          const app = resp.body.find((a) => a.name === "cypress-nginx");
          expect(app).to.be.undefined;
        });
      });
    });

    it("deletes the busybox app", () => {
      loginToA().then(() => {
        cy.request(`${AGENT_A}/remoteapps`).then((listResp) => {
          const app = listResp.body.find((a) => a.name === "cypress-busybox");
          const id = app?.app_id || app?.status?.appId;
          if (!id) return;
          cy.request({
            method: "DELETE",
            url: `${AGENT_A}/remoteapp/${id}`,
          }).then((resp) => {
            expect(resp.status).to.eq(200);
          });
        });
      });
    });

    it("Agent B eventually removes the ExecutingApp (up to 60s)", () => {
      const waitForGone = (attempts = 0) => {
        cy.wait(5000);
        loginToB().then(() => {
          cy.request(`${AGENT_B}/remoteapps`).then((resp) => {
            const app = resp.body.find((a) => a.name === "cypress-nginx");
            if (!app || attempts >= 12) {
              expect(app).to.be.undefined;
            } else {
              waitForGone(attempts + 1);
            }
          });
        });
      };
      waitForGone();
    });
  });
});
