/**
 * Workload tests — deploy, view, scale, spec-edit, delete — all via the UI.
 * Precondition: A and B are peered (02-peering ran first).
 */
describe('Workloads', () => {
  const AGENT_A = Cypress.env('AGENT_A_URL');
  const AGENT_B = Cypress.env('AGENT_B_URL');
  let PEER_B_NAME;

  before(() => {
    // Wait for at least one peer to be connected (02-peering must have run first).
    const waitForPeer = (attempts = 0) => {
      cy.apiRequest('GET', `${AGENT_A}/api/peers`).then((resp) => {
        const connected = resp.body.find((p) => p.channel === 'connected') || resp.body[0];
        if (connected?.name) {
          PEER_B_NAME = connected.name;
          cy.log(`PEER_B_NAME resolved to: ${PEER_B_NAME}`);
          return;
        }
        if (attempts >= 10) throw new Error('No peer found on Agent A after waiting');
        cy.wait(3000).then(() => waitForPeer(attempts + 1));
      });
    };
    waitForPeer();

    // Clean up any leftover apps from a previous run before starting fresh
    const CLEANUP_APPS = ['cypress-nginx', 'cypress-busybox', 'cypress-cm-test'];
    cy.apiRequest('GET', `${AGENT_A}/api/remoteapps`).then((resp) => {
      const all = [...(resp.body?.submitted || []), ...(resp.body?.executing || [])];
      all.forEach((app) => {
        if (CLEANUP_APPS.includes(app.name)) {
          const id = app.app_id || app.id;
          if (id) cy.apiRequest('DELETE', `${AGENT_A}/api/remoteapp/${id}`);
        }
      });
    });
  });

  // ----------------------------------------------------------------
  // Deploy page — Form mode
  // ----------------------------------------------------------------
  context('Deploy via Form', () => {
    beforeEach(() => cy.loginTo());

    it('deploy page loads with Form and YAML tabs', () => {
      cy.visit('/deploy');
      cy.get('#deploy-mode-ctrl').should('be.visible');
      cy.get('[data-mode="form"]').should('have.class', 'active');
      cy.get('[data-mode="yaml"]').should('exist');
    });

    it('shows a validation error when name is empty', () => {
      cy.visit('/deploy');
      cy.get('#deploy-submit-btn').click();
      // #toast uses opacity for show/hide — check for 'show' class, not 'be.visible'
      cy.get('#toast', { timeout: 5000 }).should('have.class', 'show').and('contain.text', 'name');
    });

    it('deploys an nginx app via the form', () => {
      expect(PEER_B_NAME, 'PEER_B_NAME must be set — is a peer connected?').to.be.ok;
      cy.visit('/deploy');
      cy.get('#deploy-name').type('cypress-nginx');
      cy.selectTargetPeer(PEER_B_NAME);
      cy.get('#deploy-image').type('nginx:alpine');
      cy.get('#deploy-replicas').clear().type('1');
      cy.get('#deploy-submit-btn').click();
      cy.url({ timeout: 15000 }).should('include', '/workloads');
    });

    it('deployed app appears in the submitted apps table', () => {
      cy.visit('/workloads');
      cy.get('#submitted-body', { timeout: 15000 }).should('contain.text', 'cypress-nginx');
    });
  });

  // ----------------------------------------------------------------
  // Deploy page — YAML mode
  // ----------------------------------------------------------------
  context('Deploy via YAML', () => {
    beforeEach(() => cy.loginTo());

    it('switching to YAML mode shows the CR editor', () => {
      cy.visit('/deploy');
      cy.get('#deploy-name').type('temp-yaml-test');
      cy.selectTargetPeer(PEER_B_NAME);
      cy.get('#deploy-image').type('nginx:alpine');
      cy.get('[data-mode="yaml"]').click();
      cy.get('#deploy-yaml-wrap').should('be.visible');
      // #app-spec-yaml is always synced by the editor
      cy.get('#app-spec-yaml').invoke('val').should('match', /apiVersion.*porpulsion/s);
    });

    it('form fields survive a form→YAML→form roundtrip', () => {
      cy.visit('/deploy');
      cy.get('#deploy-name').type('roundtrip-test');
      cy.selectTargetPeer(PEER_B_NAME);
      cy.get('#deploy-image').type('redis:alpine');
      cy.get('#deploy-replicas').clear().type('2');

      cy.get('[data-mode="yaml"]').click();
      cy.get('#app-spec-yaml').invoke('val')
        .should('include', 'redis:alpine')
        .and('include', 'roundtrip-test')
        .and('include', PEER_B_NAME);

      cy.get('[data-mode="form"]').click();
      cy.get('#deploy-image').should('have.value', 'redis:alpine');
      cy.get('#deploy-replicas').should('have.value', '2');
      cy.get('#deploy-name').should('have.value', 'roundtrip-test');
    });

    it('deploys a busybox app via raw YAML', () => {
      cy.visit('/deploy');
      cy.get('[data-mode="yaml"]').click();
      cy.get('#deploy-yaml-wrap').should('be.visible');

      const cr = [
        'apiVersion: porpulsion.io/v1alpha1',
        'kind: RemoteApp',
        'metadata:',
        '  name: cypress-busybox',
        'spec:',
        '  image: busybox:1.36',
        '  command: ["sh", "-c", "sleep 3600"]',
        '  replicas: 1',
        `  targetPeer: ${PEER_B_NAME}`,
      ].join('\n');

      // Set value via the editor API (works regardless of Monaco vs fallback)
      cy.window().then((win) => {
        win.PorpulsionVscodeEditor.setDeploySpecValue(cr);
      });
      cy.get('#deploy-submit-btn-yaml').click();
      cy.url({ timeout: 15000 }).should('include', '/workloads');
    });
  });

  // ----------------------------------------------------------------
  // Workloads list & app detail modal
  // ----------------------------------------------------------------
  context('Workloads list', () => {
    beforeEach(() => cy.loginTo());

    it('workloads page has a + Deploy link', () => {
      cy.visit('/workloads');
      cy.get('a[href="/deploy"]').should('be.visible');
    });

    it('submitted apps table lists cypress-nginx', () => {
      cy.visit('/workloads');
      cy.get('#submitted-body', { timeout: 10000 }).should('contain.text', 'cypress-nginx');
    });

    it('clicking a submitted app row opens the detail modal', () => {
      cy.visit('/workloads');
      cy.openAppModal('cypress-nginx');
    });

    it('detail modal shows Overview, Logs, and YAML tabs', () => {
      cy.visit('/workloads');
      cy.openAppModal('cypress-nginx');
      cy.get('#app-modal-tabs-bar').within(() => {
        cy.contains('Overview').should('exist');
        cy.contains('Logs').should('exist');
        cy.contains('YAML').should('exist');
      });
    });

    it('YAML tab in detail modal shows the full CR', () => {
      cy.visit('/workloads');
      cy.openAppModal('cypress-nginx');
      cy.appModalTab('edit');
      cy.get('#modal-spec-textarea', { timeout: 5000 }).invoke('val')
        .should('match', /apiVersion|RemoteApp/s);
    });
  });

  // ----------------------------------------------------------------
  // App reaches Running on Agent B
  // ----------------------------------------------------------------
  context('App lifecycle on Agent B', () => {
    it('cypress-nginx reaches Ready on Agent B executing apps (up to 90s)', () => {
      cy.waitForExecutingApp('cypress-nginx', 'Ready', 18, 5000);
    });
  });

  // ----------------------------------------------------------------
  // Spec update via YAML tab
  // ----------------------------------------------------------------
  context('Spec update via YAML editor', () => {
    beforeEach(() => cy.loginTo());

    it('edits the image tag in the YAML tab and saves', () => {
      cy.visit('/workloads');
      cy.openAppModal('cypress-nginx');
      cy.appModalTab('edit');

      // Monaco editor may be active in headless Electron — use the editor API to get/set value.
      // Wait until the editor has content (Monaco may initialise async after tab switch).
      cy.window().then((win) => {
        cy.wrap(null, { timeout: 8000 }).should(() => {
          const v = win.PorpulsionVscodeEditor.getModalSpecEditorValue('modal-spec-editor-host', 'modal-spec-textarea');
          expect(v).to.have.length.greaterThan(10);
        });
      });
      cy.window().then((win) => {
        const current = win.PorpulsionVscodeEditor.getModalSpecEditorValue('modal-spec-editor-host', 'modal-spec-textarea');
        const updated = current.replace(/nginx:alpine/, 'nginx:1.25-alpine');
        win.PorpulsionVscodeEditor.setModalSpecEditorValue('modal-spec-editor-host', 'modal-spec-textarea', updated);
      });

      cy.get('#app-modal-footer #spec-tab-save').click();
      // #toast uses opacity for show/hide — check for 'show' class
      cy.get('#toast', { timeout: 8000 }).should('have.class', 'show')
        .and('satisfy', ($el) => /saved|updated|ok/i.test($el.text()));
    });
  });

  // ----------------------------------------------------------------
  // ConfigMap deploy (tests the multi-line fix)
  // ----------------------------------------------------------------
  context('ConfigMap in deploy form', () => {
    beforeEach(() => cy.loginTo());

    it('adds a configmap with a multi-line value and survives form→yaml→form roundtrip', () => {
      cy.visit('/deploy');
      cy.get('#deploy-name').type('cypress-cm-test');
      cy.selectTargetPeer(PEER_B_NAME);
      cy.get('#deploy-image').type('nginx:alpine');

      // Add a ConfigMap
      cy.get('#deploy-add-cm').click();
      cy.get('[data-role="vol-name"]').last().type('my-config');
      cy.get('[data-role="vol-mount"]').last().type('/etc/myapp');
      cy.get('.cfg-add-section').last().contains('+ Add key').click();
      cy.get('[data-role="kv-key"]').last().type('app.conf');
      // Shift+Enter promotes to textarea for multi-line value
      cy.get('[data-role="kv-val"]').last().type('line1{shift}{enter}line2{shift}{enter}line3');

      // Switch to YAML — multi-line value should appear as block scalar
      cy.get('[data-mode="yaml"]').click();
      cy.get('#app-spec-yaml').invoke('val')
        .should('include', 'app.conf')
        .and('include', '|');

      // Switch back to Form — value should be preserved
      cy.get('[data-mode="form"]').click();
      cy.get('[data-role="kv-val"]').last().invoke('val')
        .should('include', 'line1')
        .and('include', 'line2');
    });
  });

  // ----------------------------------------------------------------
  // Delete via UI
  // ----------------------------------------------------------------
  context('Delete apps via UI', () => {
    beforeEach(() => cy.loginTo());

    it('deletes cypress-busybox via the workloads table', () => {
      cy.visit('/workloads');
      cy.get('body').then(($body) => {
        if (!$body.text().includes('cypress-busybox')) return;
        cy.openAppModal('cypress-busybox');
        cy.get('#app-modal-body .app-modal-delete-btn').click();
        cy.confirmDialog();
        cy.get('#submitted-body', { timeout: 10000 }).should('not.contain.text', 'cypress-busybox');
      });
    });

    it('deletes cypress-cm-test via the workloads table', () => {
      cy.visit('/workloads');
      cy.get('body').then(($body) => {
        if (!$body.text().includes('cypress-cm-test')) return;
        cy.openAppModal('cypress-cm-test');
        cy.get('#app-modal-body .app-modal-delete-btn').click();
        cy.confirmDialog();
        cy.get('#submitted-body', { timeout: 10000 }).should('not.contain.text', 'cypress-cm-test');
      });
    });

    it('deletes cypress-nginx via the workloads table', () => {
      cy.visit('/workloads');
      cy.openAppModal('cypress-nginx');
      cy.get('#app-modal-body .app-modal-delete-btn').click();
      cy.confirmDialog();
      cy.get('#submitted-body', { timeout: 15000 }).should('not.contain.text', 'cypress-nginx');
    });

    it('Agent B eventually removes the executing app after deletion', () => {
      const waitForGone = (attempts = 0) => {
        cy.apiRequest('GET', `${AGENT_B}/api/remoteapps`).then((resp) => {
          const all = [...(resp.body?.submitted || []), ...(resp.body?.executing || [])];
          const app = all.find((a) => a.name === 'cypress-nginx');
          if (!app) return;
          if (attempts >= 12) expect(app, 'App still exists on Agent B after deletion').to.be.undefined;
          cy.wait(5000);
          waitForGone(attempts + 1);
        });
      };
      waitForGone();
    });
  });
});
