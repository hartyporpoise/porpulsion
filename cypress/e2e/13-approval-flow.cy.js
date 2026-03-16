/**
 * Approval flow tests — enable require_remoteapp_approval on Agent B, deploy
 * an app from Agent A, then approve it via the Agent B UI and confirm it reaches Ready.
 *
 * Precondition: A and B are peered (02-peering ran first).
 * All state is restored in after().
 */
describe('Approval flow', () => {
  const AGENT_A = Cypress.env('AGENT_A_URL');
  const AGENT_B = Cypress.env('AGENT_B_URL');
  let PEER_B_NAME;

  before(() => {
    // Set Agent B to require approval before any tests run
    cy.apiRequest('POST', `${AGENT_B}/api/settings`, {
      allow_inbound_remoteapps: true,
      require_remoteapp_approval: true,
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
  // Deploy — app should be held for approval, not immediately Running
  // ----------------------------------------------------------------
  it('confirms Agent B has require_remoteapp_approval=true via API', () => {
    // Belt-and-suspenders: verify the setting is saved before we deploy.
    // If this fails the agentBSettings toast-wait is not working correctly.
    const waitForSetting = (attempts = 0) => {
      cy.apiRequest('GET', `${AGENT_B}/api/settings`).then((resp) => {
        if (resp.body.require_remoteapp_approval === true) return;
        if (attempts >= 5) throw new Error('Agent B require_remoteapp_approval never became true');
        cy.wait(1000).then(() => waitForSetting(attempts + 1));
      });
    };
    waitForSetting();
  });

  it('deploys an app to a peer that requires approval', () => {
    cy.loginTo();
    cy.visit('/deploy');
    cy.get('[data-mode="yaml"]').click();
    cy.get('#deploy-yaml-wrap').should('be.visible');

    cy.window().then((win) => {
      win.PorpulsionVscodeEditor.setDeploySpecValue([
        'apiVersion: porpulsion.io/v1alpha1',
        'kind: RemoteApp',
        'metadata:',
        '  name: cypress-approval',
        'spec:',
        '  image: nginx:alpine',
        '  replicas: 1',
        `  targetPeer: ${PEER_B_NAME}`,
      ].join('\n'));
    });
    cy.get('#deploy-submit-btn-yaml').click();
    cy.url({ timeout: 15000 }).should('include', '/workloads');
  });

  it('app appears in the submitted table on Agent A', () => {
    cy.loginTo();
    cy.visit('/workloads');
    cy.get('#submitted-body', { timeout: 15000 }).should('contain.text', 'cypress-approval');
  });

  it('app does NOT reach executing on Agent B within a short window (held for approval)', () => {
    // When requireApproval is on, the app goes to pending_approval — NOT executing.
    // After 8s, the executing body should not contain cypress-approval.
    cy.wait(8000);
    cy.loginTo(AGENT_B);
    cy.visit(`${AGENT_B}/workloads`);
    cy.get('#executing-body').should('not.contain.text', 'cypress-approval');
  });

  // ----------------------------------------------------------------
  // Approve via Agent B UI
  // ----------------------------------------------------------------
  it('approval banner appears on Agent B workloads page', () => {
    cy.loginTo(AGENT_B);
    cy.visit(`${AGENT_B}/workloads`);
    cy.get('#approval-banner', { timeout: 15000 }).should('be.visible');
    cy.get('.approval-item', { timeout: 10000 }).should('have.length.gte', 1);
    cy.get('.approval-item-name').should('contain.text', 'cypress-approval');
  });

  it('clicking Approve on Agent B makes the app proceed to Ready', () => {
    cy.loginTo(AGENT_B);
    cy.visit(`${AGENT_B}/workloads`);

    // Find the approval item for cypress-approval and click Approve
    cy.contains('.approval-item', 'cypress-approval', { timeout: 15000 })
      .find('[data-approve-app]')
      .click();

    // Toast should confirm approval
    cy.get('#toast', { timeout: 8000 })
      .should('have.class', 'show')
      .and('satisfy', ($el) => /approved/i.test($el.text()));

    // Now wait for it to reach Ready on Agent B
    cy.waitForExecutingApp('cypress-approval', 'Ready', 18, 5000);
  });

  it('app also shows as running on Agent A submitted list', () => {
    // Wait for Agent A to reflect Ready before checking the table
    cy.waitForSubmittedAppReady('cypress-approval', 18, 5000);
    cy.contains('#submitted-body tr', 'cypress-approval', { timeout: 10000 })
      .find('td:nth-child(3)')
      .should('contain.text', 'Ready');
  });

  // ----------------------------------------------------------------
  // Reject flow — deploy a second app and reject it
  // ----------------------------------------------------------------
  context('Reject flow', () => {
    it('deploys a second app to be rejected', () => {
      cy.loginTo();
      cy.visit('/deploy');
      cy.get('[data-mode="yaml"]').click();
      cy.window().then((win) => {
        win.PorpulsionVscodeEditor.setDeploySpecValue([
          'apiVersion: porpulsion.io/v1alpha1',
          'kind: RemoteApp',
          'metadata:',
          '  name: cypress-reject',
          'spec:',
          '  image: nginx:alpine',
          '  replicas: 1',
          `  targetPeer: ${PEER_B_NAME}`,
        ].join('\n'));
      });
      cy.get('#deploy-submit-btn-yaml').click();
      cy.url({ timeout: 15000 }).should('include', '/workloads');
    });

    it('rejection banner shows cypress-reject on Agent B', () => {
      cy.loginTo(AGENT_B);
      cy.visit(`${AGENT_B}/workloads`);
      cy.get('.approval-item-name', { timeout: 15000 }).should('contain.text', 'cypress-reject');
    });

    it('clicking Reject marks the app as Failed on Agent A', () => {
      cy.loginTo(AGENT_B);
      cy.visit(`${AGENT_B}/workloads`);
      cy.contains('.approval-item', 'cypress-reject', { timeout: 15000 })
        .find('[data-reject-app]')
        .click();
      cy.confirmDialog();
      cy.get('#toast', { timeout: 8000 })
        .should('have.class', 'show')
        .and('satisfy', ($el) => /reject/i.test($el.text()));

      // Agent A should reflect Failed status
      cy.loginTo();
      cy.visit('/workloads');
      cy.contains('#submitted-body tr', 'cypress-reject', { timeout: 30000 })
        .find('td:nth-child(3)')
        .should('contain.text', 'Failed');
    });

    after(() => {
      cy.apiRequest('GET', `${AGENT_A}/api/remoteapps`).then((resp) => {
        const app = (resp.body?.submitted || []).find((a) => a.name === 'cypress-reject');
        const id = app?.app_id || app?.id;
        if (id) cy.apiRequest('DELETE', `${AGENT_A}/api/remoteapp/${id}`);
      });
    });
  });

  after(() => {
    // Restore Agent B to auto-approve so subsequent specs are not affected
    cy.apiRequest('POST', `${AGENT_B}/api/settings`, { require_remoteapp_approval: false });
    // Clean up cypress-approval
    cy.apiRequest('GET', `${AGENT_A}/api/remoteapps`).then((resp) => {
      const app = (resp.body?.submitted || []).find((a) => a.name === 'cypress-approval');
      const id = app?.app_id || app?.id;
      if (id) cy.apiRequest('DELETE', `${AGENT_A}/api/remoteapp/${id}`);
    });
  });
});
