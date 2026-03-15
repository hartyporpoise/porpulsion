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
    // Enable require_approval on Agent B so incoming apps wait for approval
    cy.agentBSettings(AGENT_B, { inboundApps: true, requireApproval: true });

    const waitForPeer = (attempts = 0) => {
      cy.apiRequest('GET', `${AGENT_A}/api/peers`).then((resp) => {
        const peer = resp.body.find((p) => p.channel === 'connected') || resp.body[0];
        if (peer?.name) { PEER_B_NAME = peer.name; return; }
        if (attempts >= 10) throw new Error('No peer found on Agent A after waiting');
        cy.wait(3000);
        waitForPeer(attempts + 1);
      });
    };
    waitForPeer();
  });

  after(() => {
    // Restore Agent B to auto-approve mode
    cy.agentBSettings(AGENT_B, { requireApproval: false });

    // Delete the test app if it exists
    cy.apiRequest('GET', `${AGENT_A}/api/remoteapps`).then((resp) => {
      const all = [...(resp.body?.submitted || []), ...(resp.body?.executing || [])];
      const app = all.find((a) => a.name === 'cypress-approval');
      const id = app?.app_id || app?.id;
      if (id) cy.apiRequest('DELETE', `${AGENT_A}/api/remoteapp/${id}`);
    });
  });

  // ----------------------------------------------------------------
  // Deploy — app should be held for approval, not immediately Running
  // ----------------------------------------------------------------
  it('deploys an app to a peer that requires approval', () => {
    cy.loginUI();
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
    cy.loginUI();
    cy.visit('/workloads');
    cy.get('#submitted-body', { timeout: 15000 }).should('contain.text', 'cypress-approval');
  });

  it('app does NOT reach Ready on Agent B within a short window (held for approval)', () => {
    // Wait a few seconds — if approval is working the app should stay in PendingApproval
    cy.wait(8000);
    cy.origin(AGENT_B, { args: { AGENT_B } }, ({ AGENT_B }) => {
      const user = Cypress.env('USERNAME') || 'admin';
      const pass = Cypress.env('PASSWORD') || 'admin';
      cy.visit(`${AGENT_B}/login`);
      cy.get('#username').type(user);
      cy.get('#password').type(pass);
      cy.get('button[type="submit"]').click();
      cy.url({ timeout: 10000 }).should('not.include', '/login');
      cy.visit(`${AGENT_B}/workloads`);
      // App should exist in executing table but NOT show Ready
      cy.contains('#executing-body tr', 'cypress-approval', { timeout: 15000 })
        .find('td:nth-child(3)')
        .should('not.contain.text', 'Ready');
    });
  });

  // ----------------------------------------------------------------
  // Approve via Agent B UI
  // ----------------------------------------------------------------
  it('approval banner appears on Agent B workloads page', () => {
    cy.origin(AGENT_B, { args: { AGENT_B } }, ({ AGENT_B }) => {
      const user = Cypress.env('USERNAME') || 'admin';
      const pass = Cypress.env('PASSWORD') || 'admin';
      cy.visit(`${AGENT_B}/login`);
      cy.get('#username').type(user);
      cy.get('#password').type(pass);
      cy.get('button[type="submit"]').click();
      cy.url({ timeout: 10000 }).should('not.include', '/login');
      cy.visit(`${AGENT_B}/workloads`);
      cy.get('#approval-banner', { timeout: 15000 }).should('be.visible');
      cy.get('.approval-item', { timeout: 10000 }).should('have.length.gte', 1);
      cy.get('.approval-item-name').should('contain.text', 'cypress-approval');
    });
  });

  it('clicking Approve on Agent B makes the app proceed to Ready', () => {
    cy.origin(AGENT_B, { args: { AGENT_B } }, ({ AGENT_B }) => {
      const user = Cypress.env('USERNAME') || 'admin';
      const pass = Cypress.env('PASSWORD') || 'admin';
      cy.visit(`${AGENT_B}/login`);
      cy.get('#username').type(user);
      cy.get('#password').type(pass);
      cy.get('button[type="submit"]').click();
      cy.url({ timeout: 10000 }).should('not.include', '/login');
      cy.visit(`${AGENT_B}/workloads`);

      // Find the approval item for cypress-approval and click Approve
      cy.contains('.approval-item', 'cypress-approval', { timeout: 15000 })
        .find('[data-approve-app]')
        .click();

      // Toast should confirm approval
      cy.get('#toast', { timeout: 8000 })
        .should('have.class', 'show')
        .and('satisfy', ($el) => /approved/i.test($el.text()));
    });

    // Now wait for it to reach Ready on Agent B
    cy.waitForExecutingApp(AGENT_B, 'cypress-approval', 'Ready', 18, 5000);
  });

  it('app also shows as running on Agent A submitted list', () => {
    cy.loginUI();
    cy.visit('/workloads');
    cy.contains('#submitted-body tr', 'cypress-approval', { timeout: 30000 })
      .find('td:nth-child(3)')
      .should('contain.text', 'Ready');
  });
});
