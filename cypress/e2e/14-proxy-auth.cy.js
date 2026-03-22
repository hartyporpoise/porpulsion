/**
 * Per-app proxy auth toggle tests.
 *
 * Verifies that:
 *   - Proxy requires auth by default (unauthenticated request returns 401)
 *   - Toggling auth off via API allows unauthenticated access (no 401)
 *   - Toggling auth back on restores the 401
 *   - The proxy_require_auth field is present in the remoteapps list
 *   - The UI toggle is present on the tunnels page
 *
 * Precondition: A and B are peered (02-peering ran first).
 */
describe('Per-app proxy auth toggle', () => {
  const AGENT_A = Cypress.env('AGENT_A_URL');
  let PEER_B_NAME;
  let APP_ID;
  const APP_NAME = 'proxy-auth-test';

  before(() => {
    cy.apiRequest('GET', `${AGENT_A}/api/peers`).then((resp) => {
      const peer = resp.body[0];
      if (peer?.name) PEER_B_NAME = peer.name;
    });
  });

  it('deploys a test app', () => {
    cy.apiRequest('GET', `${AGENT_A}/api/peers`).then((resp) => {
      PEER_B_NAME = resp.body[0]?.name;
      cy.apiRequest('POST', `${AGENT_A}/api/remoteapp`, {
        name: APP_NAME,
        target_peer: PEER_B_NAME,
        spec: { image: 'nginx:alpine', ports: [{ port: 80 }] },
      }).then((r) => {
        expect(r.status).to.eq(201);
      });
    });
  });

  it('proxy_require_auth is true by default in remoteapps list', () => {
    cy.waitForAppPhase(AGENT_A, APP_NAME, null, 10, 2000).then((app) => {
      APP_ID = app.app_id || app.id;
      cy.apiRequest('GET', `${AGENT_A}/api/remoteapps`).then((resp) => {
        const all = [...(resp.body?.submitted || []), ...(resp.body?.executing || [])];
        const found = all.find((a) => a.name === APP_NAME);
        expect(found).to.exist;
        expect(found.proxy_require_auth).to.eq(true);
      });
    });
  });

  it('unauthenticated proxy request returns 401 by default', () => {
    const proxyUrl = `${AGENT_A}/api/remoteapp/${APP_ID}/proxy/80`;
    cy.request({ url: proxyUrl, failOnStatusCode: false, auth: false }).then((r) => {
      expect(r.status).to.eq(401);
    });
  });

  it('toggles proxy auth off via API', () => {
    cy.apiRequest('POST', `${AGENT_A}/api/remoteapp/${APP_ID}/proxy-auth`, {
      require_auth: false,
    }).then((r) => {
      expect(r.status).to.eq(200);
      expect(r.body.proxy_require_auth).to.eq(false);
    });
  });

  it('proxy_require_auth is false after toggle in remoteapps list', () => {
    cy.apiRequest('GET', `${AGENT_A}/api/remoteapps`).then((resp) => {
      const all = [...(resp.body?.submitted || []), ...(resp.body?.executing || [])];
      const found = all.find((a) => a.name === APP_NAME);
      expect(found).to.exist;
      expect(found.proxy_require_auth).to.eq(false);
    });
  });

  it('unauthenticated proxy request no longer returns 401 when auth disabled', () => {
    const proxyUrl = `${AGENT_A}/api/remoteapp/${APP_ID}/proxy/80`;
    cy.request({ url: proxyUrl, failOnStatusCode: false, auth: false }).then((r) => {
      expect(r.status).to.not.eq(401);
    });
  });

  it('toggles proxy auth back on via API', () => {
    cy.apiRequest('POST', `${AGENT_A}/api/remoteapp/${APP_ID}/proxy-auth`, {
      require_auth: true,
    }).then((r) => {
      expect(r.status).to.eq(200);
      expect(r.body.proxy_require_auth).to.eq(true);
    });
  });

  it('unauthenticated proxy request returns 401 again after re-enabling auth', () => {
    const proxyUrl = `${AGENT_A}/api/remoteapp/${APP_ID}/proxy/80`;
    cy.request({ url: proxyUrl, failOnStatusCode: false, auth: false }).then((r) => {
      expect(r.status).to.eq(401);
    });
  });

  it('tunnels page shows the auth toggle for the app', () => {
    cy.loginUI();
    cy.visit(`${AGENT_A}/tunnels`);
    cy.get('.proxy-auth-chk').should('exist');
  });

  after(() => {
    if (!APP_ID) {
      cy.apiRequest('GET', `${AGENT_A}/api/remoteapps`).then((resp) => {
        const all = [...(resp.body?.submitted || []), ...(resp.body?.executing || [])];
        const app = all.find((a) => a.name === APP_NAME);
        const id = app?.app_id || app?.id;
        if (id) {
          cy.apiRequest('POST', `${AGENT_A}/api/remoteapp/${id}/proxy-auth`, { require_auth: true });
          cy.apiRequest('DELETE', `${AGENT_A}/api/remoteapp/${id}`);
        }
      });
      return;
    }
    cy.apiRequest('POST', `${AGENT_A}/api/remoteapp/${APP_ID}/proxy-auth`, { require_auth: true });
    cy.apiRequest('DELETE', `${AGENT_A}/api/remoteapp/${APP_ID}`);
  });
});
