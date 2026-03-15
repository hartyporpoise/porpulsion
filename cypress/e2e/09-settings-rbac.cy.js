/**
 * Settings & RBAC tests — exercises the Executing tab toggles and filter/quota fields.
 * Tests that settings persist (API round-trip), that toggling inbound apps blocks
 * a deploy, and that image policy enforcement works.
 *
 * Precondition: A and B are peered (02-peering ran first).
 * All state changes are restored in after() / afterEach() so later suites are unaffected.
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
  // Settings page structure
  // ----------------------------------------------------------------
  context('Settings page structure', () => {
    beforeEach(() => cy.loginUI());

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
  // Toggle: inbound apps (allow_inbound_remoteapps)
  // ----------------------------------------------------------------
  context('Inbound apps toggle', () => {
    after(() => {
      // Restore to enabled on Agent B so subsequent tests can deploy
      cy.apiRequest('POST', `${AGENT_B}/api/settings`, { allow_inbound_remoteapps: true });
    });

    it('disabling inbound apps on Agent B rejects a deploy from Agent A', () => {
      // Disable inbound on B via API (faster than UI navigation)
      cy.apiRequest('POST', `${AGENT_B}/api/settings`, { allow_inbound_remoteapps: false })
        .then((r) => { expect(r.status).to.eq(200); });

      cy.loginUI();
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

      // Should show a toast error — not redirect to /workloads
      cy.get('#toast', { timeout: 8000 }).should('have.class', 'show')
        .and('satisfy', ($el) => /inbound|disabled|not allowed|rejected/i.test($el.text()));
      cy.url().should('not.include', '/workloads');
    });

    it('re-enabling inbound apps on Agent B via UI toggle persists in the API', () => {
      cy.loginUI();
      // Navigate to Agent B settings via cy.origin since it's a different origin
      const user = Cypress.env('USERNAME');
      const pass = Cypress.env('PASSWORD');
      cy.origin(AGENT_B, { args: { AGENT_B, user, pass } }, ({ AGENT_B, user, pass }) => {
        cy.visit(`${AGENT_B}/login`);
        cy.get('#username').type(user);
        cy.get('#password').type(pass);
        cy.get('button[type="submit"]').click();
        cy.url({ timeout: 10000 }).should('not.include', '/login');
        cy.visit(`${AGENT_B}/settings`);
        cy.get('.stg-tab[data-section="executing"]').click();
        // Toggle should currently be OFF — click to enable
        cy.get('#setting-inbound-apps').then(($chk) => {
          if (!$chk.prop('checked')) cy.wrap($chk).click();
        });
      });

      // Verify API reflects the change
      cy.apiRequest('GET', `${AGENT_B}/api/settings`).then((r) => {
        expect(r.body.allow_inbound_remoteapps).to.eq(true);
      });
    });
  });

  // ----------------------------------------------------------------
  // Image policy: allowed_images and blocked_images
  // ----------------------------------------------------------------
  context('Image policy', () => {
    after(() => {
      // Clear both filter fields on Agent B
      cy.apiRequest('POST', `${AGENT_B}/api/settings`, {
        allowed_images: '',
        blocked_images: '',
      });
    });

    it('blocked_images rejects a deploy whose image matches the prefix', () => {
      cy.apiRequest('POST', `${AGENT_B}/api/settings`, { blocked_images: 'cypress-blocked.io/' })
        .then((r) => { expect(r.status).to.eq(200); });

      cy.loginUI();
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

    it('allowed_images filter rejects an image outside the allowed prefix', () => {
      cy.apiRequest('POST', `${AGENT_B}/api/settings`, {
        blocked_images: '',
        allowed_images: 'docker.io/',
      }).then((r) => { expect(r.status).to.eq(200); });

      cy.loginUI();
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

    it('image filter settings save and reload via the UI filters form', () => {
      cy.loginUI();
      cy.visit('/settings');
      cy.get('.stg-tab[data-section="executing"]').click();
      cy.get('#setting-allowed-images').clear().type('my-registry.io/');
      cy.get('#setting-blocked-images').clear().type('bad-registry.io/');
      cy.get('#setting-filters-save').click();
      cy.get('#toast', { timeout: 5000 }).should('have.class', 'show')
        .and('satisfy', ($el) => /saved|filter/i.test($el.text()));

      // Reload and verify the values are reflected
      cy.reload();
      cy.get('.stg-tab[data-section="executing"]').click();
      cy.get('#setting-allowed-images').should('have.value', 'my-registry.io/');
      cy.get('#setting-blocked-images').should('have.value', 'bad-registry.io/');
    });
  });

  // ----------------------------------------------------------------
  // Allow PVCs toggle
  // ----------------------------------------------------------------
  context('allow_pvcs toggle', () => {
    after(() => {
      cy.apiRequest('POST', `${AGENT_B}/api/settings`, { allow_pvcs: true });
    });

    it('allow_pvcs checkbox state is reflected in the UI', () => {
      // Set to false via API, then check the UI shows it unchecked
      cy.apiRequest('POST', `${AGENT_B}/api/settings`, { allow_pvcs: false });

      const user = Cypress.env('USERNAME');
      const pass = Cypress.env('PASSWORD');
      cy.origin(AGENT_B, { args: { AGENT_B, user, pass } }, ({ AGENT_B, user, pass }) => {
        cy.visit(`${AGENT_B}/login`);
        cy.get('#username').type(user);
        cy.get('#password').type(pass);
        cy.get('button[type="submit"]').click();
        cy.url({ timeout: 10000 }).should('not.include', '/login');
        cy.visit(`${AGENT_B}/settings`);
        cy.get('.stg-tab[data-section="executing"]').click();
        cy.get('#setting-allow-pvcs').should('not.be.checked');
      });
    });

    it('enabling allow_pvcs via toggle persists to API', () => {
      const user = Cypress.env('USERNAME');
      const pass = Cypress.env('PASSWORD');
      cy.origin(AGENT_B, { args: { AGENT_B, user, pass } }, ({ AGENT_B, user, pass }) => {
        cy.visit(`${AGENT_B}/login`);
        cy.get('#username').type(user);
        cy.get('#password').type(pass);
        cy.get('button[type="submit"]').click();
        cy.url({ timeout: 10000 }).should('not.include', '/login');
        cy.visit(`${AGENT_B}/settings`);
        cy.get('.stg-tab[data-section="executing"]').click();
        cy.get('#setting-allow-pvcs').then(($chk) => {
          if (!$chk.prop('checked')) cy.wrap($chk).click();
        });
      });
      cy.apiRequest('GET', `${AGENT_B}/api/settings`).then((r) => {
        expect(r.body.allow_pvcs).to.eq(true);
      });
    });
  });
});
