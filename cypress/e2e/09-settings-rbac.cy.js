/**
 * Settings & RBAC tests — exercises the Executing tab toggles and filter/quota fields.
 * Tests that settings persist (API round-trip), that toggling inbound apps blocks
 * a deploy, and that image policy enforcement works.
 *
 * Precondition: A and B are peered (02-peering ran first).
 * Each context stays on one cluster — no mid-test cluster switches.
 */
describe('Settings & RBAC', () => {
  const AGENT_A = Cypress.env('AGENT_A_URL');
  const AGENT_B = Cypress.env('AGENT_B_URL');
  let PEER_B_NAME;

  before(() => {
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

  // ----------------------------------------------------------------
  // Settings page structure (cluster-a)
  // ----------------------------------------------------------------
  context('Settings page structure', () => {
    beforeEach(() => cy.loginTo());

    it('shows all five settings tabs', () => {
      cy.visit('/settings');
      ['agent', 'executing', 'quotas', 'tunnels', 'registry'].forEach((section) => {
        cy.get(`.stg-tab[data-section="${section}"]`).should('exist');
      });
    });

    it('Executing tab shows key toggle controls', () => {
      cy.visit('/settings');
      cy.get('.stg-tab[data-section="executing"]').click();
      cy.get('#settings-panel-executing #setting-inbound-apps').should('exist');
      cy.get('#settings-panel-executing #setting-require-approval').should('exist');
      cy.get('#settings-panel-executing #setting-allow-pvcs').should('exist');
    });

    it('Tunnels tab shows inbound tunnels toggle', () => {
      cy.visit('/settings');
      cy.get('.stg-tab[data-section="tunnels"]').click();
      cy.get('#settings-panel-tunnels #setting-inbound-tunnels').should('exist');
    });

    it('Registry tab shows pull-through proxy toggle', () => {
      cy.visit('/settings');
      cy.get('.stg-tab[data-section="registry"]').click();
      cy.get('#settings-panel-registry #setting-registry-pull-enabled').should('exist');
    });
  });

  // ----------------------------------------------------------------
  // Inbound apps toggle (cluster-b only)
  // ----------------------------------------------------------------
  context('Inbound apps toggle — Agent B', () => {
    beforeEach(() => cy.loginTo(AGENT_B));

    it('disables inbound apps on Agent B', () => {
      cy.agentBSettings({ inboundApps: false });
    });

    it('inbound apps toggle is unchecked after disabling', () => {
      cy.visit(`${AGENT_B}/settings`);
      cy.get('.stg-tab[data-section="executing"]').click();
      cy.get('#setting-inbound-apps').should('not.be.checked');
    });
  });

  // ----------------------------------------------------------------
  // Deploy rejected when inbound disabled (cluster-a)
  // ----------------------------------------------------------------
  context('Inbound apps toggle — deploy rejected on Agent A', () => {
    beforeEach(() => cy.loginTo());

    it('deploy to Agent B is rejected when inbound apps is disabled', () => {
      cy.visit('/deploy');
      cy.get('[data-mode="yaml"]').click();
      cy.get('#deploy-yaml-wrap').should('be.visible');
      cy.window().then((win) => {
        win.PorpulsionVscodeEditor.setDeploySpecValue([
          'apiVersion: porpulsion.io/v1alpha1',
          'kind: RemoteApp',
          'metadata:',
          '  name: cypress-rbac-blocked',
          'spec:',
          '  image: nginx:alpine',
          '  replicas: 1',
          `  targetPeer: ${PEER_B_NAME}`,
        ].join('\n'));
      });
      cy.get('#deploy-submit-btn-yaml').click();
      cy.get('#toast', { timeout: 8000 }).should('have.class', 'show')
        .and('satisfy', ($el) => /inbound|disabled|not allowed|rejected/i.test($el.text()));
      cy.url().should('not.include', '/workloads');
    });
  });

  // ----------------------------------------------------------------
  // Re-enable inbound apps (cluster-b only)
  // ----------------------------------------------------------------
  context('Inbound apps toggle — re-enable on Agent B', () => {
    beforeEach(() => cy.loginTo(AGENT_B));

    it('re-enables inbound apps on Agent B', () => {
      cy.agentBSettings({ inboundApps: true });
    });

    it('inbound apps toggle is checked after re-enabling', () => {
      cy.visit(`${AGENT_B}/settings`);
      cy.get('.stg-tab[data-section="executing"]').click();
      cy.get('#setting-inbound-apps').should('be.checked');
    });
  });

  // ----------------------------------------------------------------
  // Image policy — set blocked images (cluster-b)
  // ----------------------------------------------------------------
  context('Image policy — blocked images on Agent B', () => {
    beforeEach(() => cy.loginTo(AGENT_B));

    it('sets blocked_images on Agent B', () => {
      cy.agentBSettings({ blockedImages: 'cypress-blocked.io/', allowedImages: '' });
    });
  });

  context('Image policy — blocked deploy rejected on Agent A', () => {
    beforeEach(() => cy.loginTo());

    it('deploy with blocked image is rejected', () => {
      cy.visit('/deploy');
      cy.get('[data-mode="yaml"]').click();
      cy.window().then((win) => {
        win.PorpulsionVscodeEditor.setDeploySpecValue([
          'apiVersion: porpulsion.io/v1alpha1',
          'kind: RemoteApp',
          'metadata:',
          '  name: cypress-image-blocked',
          'spec:',
          '  image: cypress-blocked.io/nginx:latest',
          '  replicas: 1',
          `  targetPeer: ${PEER_B_NAME}`,
        ].join('\n'));
      });
      cy.get('#deploy-submit-btn-yaml').click();
      cy.get('#toast', { timeout: 8000 }).should('have.class', 'show')
        .and('satisfy', ($el) => /block|policy|not allowed/i.test($el.text()));
    });
  });

  // ----------------------------------------------------------------
  // Image policy — set allowed images (cluster-b)
  // ----------------------------------------------------------------
  context('Image policy — allowed images on Agent B', () => {
    beforeEach(() => cy.loginTo(AGENT_B));

    it('sets allowed_images on Agent B', () => {
      cy.agentBSettings({ blockedImages: '', allowedImages: 'docker.io/' });
    });
  });

  context('Image policy — non-allowed deploy rejected on Agent A', () => {
    beforeEach(() => cy.loginTo());

    it('deploy with image outside allowed prefix is rejected', () => {
      cy.visit('/deploy');
      cy.get('[data-mode="yaml"]').click();
      cy.window().then((win) => {
        win.PorpulsionVscodeEditor.setDeploySpecValue([
          'apiVersion: porpulsion.io/v1alpha1',
          'kind: RemoteApp',
          'metadata:',
          '  name: cypress-image-notallowed',
          'spec:',
          '  image: gcr.io/google-containers/pause:3.9',
          '  replicas: 1',
          `  targetPeer: ${PEER_B_NAME}`,
        ].join('\n'));
      });
      cy.get('#deploy-submit-btn-yaml').click();
      cy.get('#toast', { timeout: 8000 }).should('have.class', 'show')
        .and('satisfy', ($el) => /allowed|policy|not in/i.test($el.text()));
    });
  });

  // ----------------------------------------------------------------
  // Clear image filters (cluster-b)
  // ----------------------------------------------------------------
  context('Image policy — clear filters on Agent B', () => {
    beforeEach(() => cy.loginTo(AGENT_B));

    it('clears image filters on Agent B', () => {
      cy.agentBSettings({ blockedImages: '', allowedImages: '' });
    });
  });

  // ----------------------------------------------------------------
  // Image filter UI round-trip (cluster-a)
  // ----------------------------------------------------------------
  context('Image filter UI round-trip', () => {
    beforeEach(() => cy.loginTo());

    it('image filter settings save and reload via the UI filters form', () => {
      cy.visit('/settings');
      cy.get('.stg-tab[data-section="executing"]').click();
      cy.get('#setting-allowed-images').clear().type('my-registry.io/');
      cy.get('#setting-blocked-images').clear().type('bad-registry.io/');
      cy.get('#setting-filters-save').click();
      cy.get('#toast', { timeout: 5000 }).should('have.class', 'show')
        .and('satisfy', ($el) => /saved|filter/i.test($el.text()));

      cy.reload();
      cy.get('.stg-tab[data-section="executing"]').click();
      cy.get('#setting-allowed-images').should('have.value', 'my-registry.io/');
      cy.get('#setting-blocked-images').should('have.value', 'bad-registry.io/');
    });
  });

  // ----------------------------------------------------------------
  // Allow PVCs toggle (cluster-b)
  // ----------------------------------------------------------------
  context('allow_pvcs toggle — Agent B', () => {
    beforeEach(() => cy.loginTo(AGENT_B));

    it('disables allow_pvcs on Agent B', () => {
      cy.agentBSettings({ allowPvcs: false });
    });

    it('allow_pvcs toggle is unchecked after disabling', () => {
      cy.visit(`${AGENT_B}/settings`);
      cy.get('.stg-tab[data-section="executing"]').click();
      cy.get('#setting-allow-pvcs').should('not.be.checked');
    });

    it('re-enables allow_pvcs on Agent B', () => {
      cy.agentBSettings({ allowPvcs: true });
    });

    it('allow_pvcs toggle is checked after re-enabling', () => {
      cy.visit(`${AGENT_B}/settings`);
      cy.get('.stg-tab[data-section="executing"]').click();
      cy.get('#setting-allow-pvcs').should('be.checked');
    });
  });
});
