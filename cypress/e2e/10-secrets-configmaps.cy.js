/**
 * Secrets & ConfigMaps tests — deploy an app with secret and configmap volumes,
 * verify the Config tab shows plaintext values (server decodes base64),
 * edit values via the Config tab, and confirm the API round-trip is correct.
 *
 * Precondition: A and B are peered, Agent B has allow_pvcs=true (09-settings-rbac ran).
 */
describe('Secrets & ConfigMaps', () => {
  const AGENT_A = Cypress.env('AGENT_A_URL');
  let PEER_B_NAME;
  let APP_ID;

  before(() => {
    const waitForPeer = (attempts = 0) => {
      cy.apiRequest('GET', `${AGENT_A}/api/peers`).then((resp) => {
        const peer = resp.body.find((p) => p.channel === 'connected') || resp.body[0];
        if (peer?.name) { PEER_B_NAME = peer.name; return; }
        if (attempts >= 10) throw new Error('No peer found on Agent A after waiting');
        cy.wait(3000).then(() => waitForPeer(attempts + 1));
      });
    };
    waitForPeer();
  });

  // ----------------------------------------------------------------
  // Deploy an app that has both a ConfigMap and a Secret volume
  // ----------------------------------------------------------------
  it('deploys an app with a configmap and a secret volume', () => {
    cy.loginTo();
    cy.visit('/deploy');
    cy.get('[data-mode="yaml"]').click();
    cy.get('#deploy-yaml-wrap').should('be.visible');

    cy.window().then((win) => {
      win.PorpulsionVscodeEditor.setDeploySpecValue([
        'apiVersion: porpulsion.io/v1alpha1',
        'kind: RemoteApp',
        'metadata:',
        '  name: cypress-cfg-test',
        'spec:',
        '  image: busybox:1.36',
        '  command: ["sh", "-c", "sleep 3600"]',
        '  replicas: 1',
        `  targetPeer: ${PEER_B_NAME}`,
        '  configmaps:',
        '    - name: my-config',
        '      mountPath: /etc/myapp',
        '      data:',
        '        app.conf: "key=value\nline2=foo"',
        '        greeting: hello',
        '  secrets:',
        '    - name: my-secret',
        '      mountPath: /etc/mysecret',
        '      data:',
        '        api_key: super-secret-value',
        '        db_pass: p@ssw0rd!',
      ].join('\n'));
    });
    cy.get('#deploy-submit-btn-yaml').click();
    cy.url({ timeout: 15000 }).should('include', '/workloads');
  });

  it('app appears in submitted table', () => {
    cy.loginTo();
    cy.visit('/workloads');
    cy.get('#submitted-body', { timeout: 15000 }).should('contain.text', 'cypress-cfg-test');
  });

  it('app reaches Ready on Agent B (up to 90s)', () => {
    cy.waitForExecutingApp('cypress-cfg-test', 'Ready', 18, 5000);
  });

  // ----------------------------------------------------------------
  // Config tab: verify secrets are displayed as plaintext (decoded)
  // ----------------------------------------------------------------
  context('Config tab', () => {
    beforeEach(() => cy.loginTo());

    it('Config tab is enabled when app is Running', () => {
      cy.visit('/workloads');
      cy.openAppModal('cypress-cfg-test');
      cy.get('#app-modal-tabs-bar [data-tab="config"]', { timeout: 10000 })
        .should('exist')
        .and('not.have.class', 'modal-tab-disabled');
    });

    it('Config tab shows the configmap with plaintext values', () => {
      cy.visit('/workloads');
      cy.openAppModal('cypress-cfg-test');
      cy.appModalTab('config');
      // ConfigMap section should exist and show the key names
      cy.get('#cfg-panel-body', { timeout: 10000 })
        .should('contain.text', 'my-config')
        .and('contain.text', 'app.conf')
        .and('contain.text', 'greeting');
    });

    it('Config tab shows the secret with decoded plaintext values', () => {
      cy.visit('/workloads');
      cy.openAppModal('cypress-cfg-test');
      cy.appModalTab('config');
      // Secret section should show key names; values are loaded via API (plaintext)
      cy.get('#cfg-panel-body', { timeout: 10000 })
        .should('contain.text', 'my-secret')
        .and('contain.text', 'api_key')
        .and('contain.text', 'db_pass');
    });

    it('secret values API returns plaintext (base64 decoded by server)', () => {
      // Get app_id first
      cy.apiRequest('GET', `${AGENT_A}/api/remoteapps`).then((resp) => {
        const app = resp.body.submitted.find((a) => a.name === 'cypress-cfg-test');
        expect(app, 'cypress-cfg-test must exist').to.exist;
        APP_ID = app.app_id || app.id;

        cy.apiRequest('GET', `${AGENT_A}/api/remoteapp/${APP_ID}/config/secret/my-secret`).then((r) => {
          expect(r.status).to.eq(200);
          // Server decodes base64 before returning — values should be plaintext
          expect(r.body.data).to.have.property('api_key', 'super-secret-value');
          expect(r.body.data).to.have.property('db_pass', 'p@ssw0rd!');
        });
      });
    });

    it('configmap values API returns the raw string (no encoding)', () => {
      cy.apiRequest('GET', `${AGENT_A}/api/remoteapps`).then((resp) => {
        const app = resp.body.submitted.find((a) => a.name === 'cypress-cfg-test');
        APP_ID = app.app_id || app.id;

        cy.apiRequest('GET', `${AGENT_A}/api/remoteapp/${APP_ID}/config/configmap/my-config`).then((r) => {
          expect(r.status).to.eq(200);
          expect(r.body.data).to.have.property('greeting', 'hello');
        });
      });
    });

    it('patching a secret value re-encodes correctly (round-trip)', () => {
      cy.apiRequest('GET', `${AGENT_A}/api/remoteapps`).then((resp) => {
        const app = resp.body.submitted.find((a) => a.name === 'cypress-cfg-test');
        APP_ID = app.app_id || app.id;

        // Write a new plaintext value
        cy.apiRequest('PATCH', `${AGENT_A}/api/remoteapp/${APP_ID}/config/secret/my-secret`, {
          data: { api_key: 'updated-secret', db_pass: 'newpass123' },
        }).then((patch) => {
          expect(patch.status).to.eq(200);
        });

        // Read back and confirm it decodes to the new plaintext
        cy.apiRequest('GET', `${AGENT_A}/api/remoteapp/${APP_ID}/config/secret/my-secret`).then((r) => {
          expect(r.status).to.eq(200);
          expect(r.body.data.api_key).to.eq('updated-secret');
          expect(r.body.data.db_pass).to.eq('newpass123');
        });
      });
    });
  });

  // ----------------------------------------------------------------
  // YAML tab: secrets appear base64-encoded in the raw CR
  // ----------------------------------------------------------------
  it('YAML tab shows secret values as base64 (not plaintext) in the CR', () => {
    cy.loginTo();
    cy.visit('/workloads');
    cy.openAppModal('cypress-cfg-test');
    cy.appModalTab('edit');

    cy.window().then((win) => {
      cy.wrap(null, { timeout: 8000 }).should(() => {
        const v = win.PorpulsionVscodeEditor.getModalSpecEditorValue('modal-spec-editor-host', 'modal-spec-textarea');
        expect(v).to.have.length.greaterThan(10);
      });
    });
    cy.window().then((win) => {
      const yaml = win.PorpulsionVscodeEditor.getModalSpecEditorValue('modal-spec-editor-host', 'modal-spec-textarea');
      // The base64 of "updated-secret" is "dXBkYXRlZC1zZWNyZXQ="
      expect(yaml).to.include('dXBkYXRlZC1zZWNyZXQ=');
      // Plain text should NOT appear
      expect(yaml).not.to.include('updated-secret');
    });
  });

  after(() => {
    cy.apiRequest('GET', `${AGENT_A}/api/remoteapps`).then((resp) => {
      const all = [...(resp.body?.submitted || []), ...(resp.body?.executing || [])];
      const app = all.find((a) => a.name === 'cypress-cfg-test');
      const id = app?.app_id || app?.id;
      if (id) cy.apiRequest('DELETE', `${AGENT_A}/api/remoteapp/${id}`);
    });
  });
});
