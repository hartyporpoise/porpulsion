/**
 * PVC persistence tests — deploy an app with a PVC, write a file via the
 * exec terminal, restart the pod, and confirm the file survives.
 *
 * Preconditions:
 *   - A and B are peered (02-peering ran first)
 *   - Agent B has allow_pvcs=true (ensured in before())
 */
describe('PVC persistence', () => {
  const AGENT_A = Cypress.env('AGENT_A_URL');
  let PEER_B_NAME;
  let APP_ID;

  // Unique sentinel written to the PVC
  const SENTINEL = 'porpulsion-pvc-ok';

  before(() => {
    // Reset Agent B — ensure inbound, no approval, PVCs enabled
    cy.apiRequest('POST', `${Cypress.env('AGENT_B_URL')}/api/settings`, {
      allow_inbound_remoteapps: true,
      require_remoteapp_approval: false,
      allow_pvcs: true,
      allowed_images: '',
      blocked_images: '',
    });
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
  // Deploy
  // ----------------------------------------------------------------
  it('deploys an alpine app with a 100Mi PVC', () => {
    cy.loginTo();
    cy.visit('/deploy');
    cy.get('[data-mode="yaml"]').click();
    cy.get('#deploy-yaml-wrap').should('be.visible');

    cy.window().then((win) => {
      win.PorpulsionVscodeEditor.setDeploySpecValue([
        'apiVersion: porpulsion.io/v1alpha1',
        'kind: RemoteApp',
        'metadata:',
        '  name: cypress-pvc',
        'spec:',
        '  image: alpine:3.19',
        '  command: ["sh", "-c", "sleep 3600"]',
        '  replicas: 1',
        `  targetPeer: ${PEER_B_NAME}`,
        '  pvcs:',
        '    - name: data',
        '      mountPath: /data',
        '      storage: 100Mi',
        '      accessMode: ReadWriteOnce',
      ].join('\n'));
    });
    cy.get('#deploy-submit-btn-yaml').click();
    cy.url({ timeout: 15000 }).should('include', '/workloads');
  });

  it('app appears in submitted table', () => {
    cy.loginTo();
    cy.visit('/workloads');
    cy.get('#submitted-body', { timeout: 15000 }).should('contain.text', 'cypress-pvc');
  });

  it('app reaches Ready on Agent B (up to 120s — PVC provisioning can be slow)', () => {
    cy.waitForExecutingApp('cypress-pvc', 'Ready', 24, 5000);
  });

  it('app status propagates to Agent A (terminal tab becomes enabled)', () => {
    cy.waitForSubmittedAppReady('cypress-pvc', 24, 5000);
  });

  it('detail modal Overview mentions the PVC volume', () => {
    cy.loginTo();
    cy.visit('/workloads');
    cy.openAppModal('cypress-pvc');
    cy.get('#app-modal-body [data-panel="overview"]', { timeout: 10000 })
      .should('satisfy', ($el) => /data|100Mi|pvc/i.test($el.text()));
  });

  // ----------------------------------------------------------------
  // Write a file via exec terminal
  // ----------------------------------------------------------------
  it('Terminal tab is enabled when app is Running', () => {
    cy.loginTo();
    cy.visit('/workloads');
    cy.openAppModal('cypress-pvc');
    // waitForSubmittedAppReady already confirmed Agent A shows Ready,
    // so the terminal tab should be enabled immediately.
    cy.get('#app-modal-tabs-bar [data-tab="terminal"]', { timeout: 15000 })
      .should('exist')
      .and('not.have.class', 'modal-tab-disabled');
  });

  it('writes a sentinel file to /data via the exec terminal', () => {
    cy.loginTo();
    cy.visit('/workloads');
    cy.openAppModal('cypress-pvc');
    cy.appModalTab('terminal');

    // xterm container must be present
    cy.get('#exec-terminal-wrap', { timeout: 10000 }).should('exist');

    // Select /bin/sh (available in alpine)
    cy.get('#exec-shell-select').select('/bin/sh', { force: true });

    // Wait for the WebSocket to connect — status text changes to 'Connected'
    cy.get('#exec-status .exec-status-text', { timeout: 20000 })
      .should('contain.text', 'Connected');

    // xterm captures keyboard events when focused — execTerminalType handles focus + type.
    cy.execTerminalType(`echo ${SENTINEL} > /data/sentinel.txt`);
    cy.wait(500);
    cy.execTerminalType('cat /data/sentinel.txt');

    // Wait a moment then confirm the WebSocket is still open (no error state)
    cy.wait(1500);
    cy.get('#exec-status .exec-status-text').should('contain.text', 'Connected');
  });

  // ----------------------------------------------------------------
  // Restart pod and confirm PVC data persists
  // ----------------------------------------------------------------
  it('triggers a rollout restart via the API', () => {
    cy.apiRequest('GET', `${AGENT_A}/api/remoteapps`).then((resp) => {
      const app = resp.body.submitted.find((a) => a.name === 'cypress-pvc');
      APP_ID = app?.app_id || app?.id;
      expect(APP_ID, 'cypress-pvc app_id must exist').to.be.ok;
      cy.apiRequest('POST', `${AGENT_A}/api/remoteapp/${APP_ID}/restart`)
        .its('status').should('eq', 200);
    });
  });

  it('app returns to Ready after restart (up to 90s)', () => {
    cy.wait(5000); // let the rollout begin
    cy.waitForExecutingApp('cypress-pvc', 'Ready', 24, 5000);
  });

  it('sentinel file is still in /data after pod restart (PVC persisted)', () => {
    // Use the API exec endpoint to verify the sentinel file — more reliable than
    // reading the xterm DOM (the xterm helper textarea does not hold terminal output).
    cy.apiRequest('GET', `${AGENT_A}/api/remoteapps`).then((resp) => {
      const app = resp.body.submitted.find((a) => a.name === 'cypress-pvc');
      expect(app, 'cypress-pvc must exist in submitted list').to.exist;
      APP_ID = app.app_id || app.id;

      // Get a pod name
      cy.apiRequest('GET', `${AGENT_A}/api/remoteapp/${APP_ID}/pods`).then((podsResp) => {
        const pod = (podsResp.body.pods || [])[0];
        expect(pod, 'at least one pod must be running for cypress-pvc').to.exist;

        // Exec cat /data/sentinel.txt
        cy.apiRequest('POST', `${AGENT_A}/api/remoteapp/${APP_ID}/exec`, {
          pod: pod.name,
          command: `cat /data/sentinel.txt`,
        }).then((execResp) => {
          expect(execResp.status).to.eq(200);
          expect(execResp.body.output || '').to.include(SENTINEL);
        });
      });
    });
  });

  after(() => {
    cy.apiRequest('GET', `${AGENT_A}/api/remoteapps`).then((resp) => {
      const all = [...(resp.body?.submitted || []), ...(resp.body?.executing || [])];
      const app = all.find((a) => a.name === 'cypress-pvc');
      const id = app?.app_id || app?.id;
      if (id) cy.apiRequest('DELETE', `${AGENT_A}/api/remoteapp/${id}`);
    });
    cy.apiRequest('POST', `${Cypress.env('AGENT_B_URL')}/api/settings`, {
      allow_inbound_remoteapps: true,
      require_remoteapp_approval: false,
      allow_pvcs: true,
      allowed_images: '',
      blocked_images: '',
    });
  });
});
