/**
 * Workload tests — deploy, view, scale, spec-edit, delete — all via the UI.
 *
 * Precondition: A and B are peered (02-peering ran first).
 */
describe('Workloads', () => {
  const AGENT_A = Cypress.env('AGENT_A_URL');
  const AGENT_B = Cypress.env('AGENT_B_URL');
  let PEER_B_NAME;

  before(() => {
    // Discover peer B's name from the API so we can select it in the form
    cy.loginTo(AGENT_A).then(() => {
      cy.request(`${AGENT_A}/peers`).then((resp) => {
        const connected = resp.body.find((p) => p.channel === 'connected') || resp.body[0];
        PEER_B_NAME = connected?.name;
        expect(PEER_B_NAME).to.be.a('string');
      });
    });
  });

  // ----------------------------------------------------------------
  // Deploy page — Form mode
  // ----------------------------------------------------------------
  context('Deploy via Form', () => {
    beforeEach(() => cy.loginUI());

    it('deploy page loads with Form and YAML tabs', () => {
      cy.visit('/deploy');
      cy.get('#deploy-mode-ctrl').should('be.visible');
      cy.get('[data-mode="form"]').should('have.class', 'active');
      cy.get('[data-mode="yaml"]').should('exist');
    });

    it('shows a validation error when name is empty', () => {
      cy.visit('/deploy');
      cy.get('#deploy-submit-btn').click();
      // Toast error for missing name
      cy.get('.toast, [class*="toast"]', { timeout: 5000 })
        .should('be.visible')
        .and('contain.text', 'name');
    });

    it('deploys an nginx app via the form', () => {
      cy.visit('/deploy');

      cy.get('#deploy-name').type('cypress-nginx');
      cy.get('#deploy-target-peer').select(PEER_B_NAME);
      cy.get('#deploy-image').type('nginx:alpine');
      cy.get('#deploy-replicas').clear().type('1');

      cy.get('#deploy-submit-btn').click();

      // Should redirect to /workloads after successful deploy
      cy.url({ timeout: 15000 }).should('include', '/workloads');
    });

    it('deployed app appears in the submitted apps table', () => {
      cy.visit('/workloads');
      cy.get('#submitted-body tr', { timeout: 15000 }).should('have.length.greaterThan', 0);
      cy.get('#submitted-body').should('contain.text', 'cypress-nginx');
    });
  });

  // ----------------------------------------------------------------
  // Deploy page — YAML mode
  // ----------------------------------------------------------------
  context('Deploy via YAML', () => {
    beforeEach(() => cy.loginUI());

    it('switching to YAML mode shows the CR editor', () => {
      cy.visit('/deploy');
      cy.get('#deploy-name').type('temp-yaml-test');
      cy.get('#deploy-target-peer').select(PEER_B_NAME);
      cy.get('#deploy-image').type('nginx:alpine');

      cy.get('[data-mode="yaml"]').click();

      cy.get('#deploy-yaml-wrap').should('be.visible');
      // The editor textarea (backing) or Monaco should contain the CR scaffold
      cy.get('#app-spec-yaml, #app-spec-yaml-fallback').invoke('val')
        .should('match', /apiVersion.*porpulsion/s);
    });

    it('form fields survive a form→YAML→form roundtrip', () => {
      cy.visit('/deploy');

      cy.get('#deploy-name').type('roundtrip-test');
      cy.get('#deploy-target-peer').select(PEER_B_NAME);
      cy.get('#deploy-image').type('redis:alpine');
      cy.get('#deploy-replicas').clear().type('2');

      // Switch to YAML
      cy.get('[data-mode="yaml"]').click();
      cy.get('#app-spec-yaml, #app-spec-yaml-fallback').invoke('val')
        .should('include', 'redis:alpine')
        .and('include', 'roundtrip-test')
        .and('include', PEER_B_NAME);

      // Switch back to Form
      cy.get('[data-mode="form"]').click();
      cy.get('#deploy-image').should('have.value', 'redis:alpine');
      cy.get('#deploy-replicas').should('have.value', '2');
      cy.get('#deploy-name').should('have.value', 'roundtrip-test');
    });

    it('deploys a busybox app via raw YAML', () => {
      cy.visit('/deploy');
      cy.get('[data-mode="yaml"]').click();

      const cr = `apiVersion: porpulsion.io/v1alpha1
kind: RemoteApp
metadata:
  name: cypress-busybox
spec:
  image: busybox:1.36
  command: ["sh", "-c", "sleep 3600"]
  replicas: 1
  targetPeer: ${PEER_B_NAME}`;

      // Type into the fallback textarea (Monaco may not be available headlessly)
      cy.get('#app-spec-yaml').invoke('val', cr);
      cy.get('#app-spec-yaml-fallback').then(($el) => {
        if ($el.is(':visible')) cy.wrap($el).clear().type(cr, { delay: 0 });
      });

      cy.get('#deploy-submit-btn-yaml').click();
      cy.url({ timeout: 15000 }).should('include', '/workloads');
    });
  });

  // ----------------------------------------------------------------
  // Workloads list & app detail modal
  // ----------------------------------------------------------------
  context('Workloads list', () => {
    beforeEach(() => cy.loginUI());

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
      cy.contains('#submitted-body tr', 'cypress-nginx').click();
      // Modal should appear
      cy.get('[class*="modal"], [id*="modal"], [role="dialog"]', { timeout: 8000 })
        .should('be.visible');
    });

    it('detail modal shows Overview, Logs, and YAML tabs', () => {
      cy.visit('/workloads');
      cy.contains('#submitted-body tr', 'cypress-nginx').click();
      cy.get('[class*="modal"], [id*="modal"], [role="dialog"]', { timeout: 8000 })
        .within(() => {
          cy.contains(/overview/i).should('exist');
          cy.contains(/logs/i).should('exist');
          cy.contains(/yaml/i).should('exist');
        });
    });

    it('YAML tab in detail modal shows the full CR', () => {
      cy.visit('/workloads');
      cy.contains('#submitted-body tr', 'cypress-nginx').click();
      cy.get('[class*="modal"], [id*="modal"], [role="dialog"]', { timeout: 8000 })
        .within(() => {
          cy.contains(/yaml/i).click();
          // The YAML editor/pre should contain the CR
          cy.get('pre, textarea, [class*="editor"]', { timeout: 5000 })
            .invoke('text')
            .should('match', /apiVersion|kind.*RemoteApp/s);
        });
    });
  });

  // ----------------------------------------------------------------
  // App reaches Running on Agent B
  // ----------------------------------------------------------------
  context('App lifecycle on Agent B', () => {
    it('cypress-nginx reaches Running on Agent B (up to 90s)', () => {
      cy.loginTo(AGENT_B);
      cy.waitForAppPhase(AGENT_B, 'cypress-nginx', 'Running', 18, 5000);
    });

    it('Agent B shows the executing app in its workloads table', () => {
      cy.loginUI();
      cy.visit(AGENT_B);
      cy.visit(AGENT_B + '/workloads');
      cy.get('#executing-body', { timeout: 15000 }).should('contain.text', 'cypress-nginx');
    });
  });

  // ----------------------------------------------------------------
  // Scale via the detail modal
  // ----------------------------------------------------------------
  context('Scale via UI', () => {
    beforeEach(() => cy.loginUI());

    it('scales cypress-nginx to 2 replicas via the modal', () => {
      cy.visit('/workloads');
      cy.contains('#submitted-body tr', 'cypress-nginx').click();

      cy.get('[class*="modal"], [id*="modal"], [role="dialog"]', { timeout: 8000 })
        .within(() => {
          // Look for a scale input or +/- replica control
          cy.get('input[type="number"][value="1"], input[placeholder*="eplic"]')
            .first()
            .clear()
            .type('2');
          cy.contains(/scale|apply|save/i).click();
        });

      cy.wait(3000);

      // Verify via API that replicas updated
      cy.loginTo(AGENT_A).then(() => {
        cy.request(`${AGENT_A}/remoteapps`).then((resp) => {
          const app = resp.body.find((a) => a.name === 'cypress-nginx');
          expect(app?.spec?.replicas ?? app?.status?.replicas).to.be.at.least(2);
        });
      });
    });
  });

  // ----------------------------------------------------------------
  // Spec update via YAML tab
  // ----------------------------------------------------------------
  context('Spec update via YAML editor', () => {
    beforeEach(() => cy.loginUI());

    it('edits the image tag in the YAML tab and saves', () => {
      cy.visit('/workloads');
      cy.contains('#submitted-body tr', 'cypress-nginx').click();

      cy.get('[class*="modal"], [id*="modal"], [role="dialog"]', { timeout: 8000 })
        .within(() => {
          cy.contains(/yaml/i).click();

          // Get the current YAML and replace the image tag
          cy.get('textarea, pre[contenteditable]', { timeout: 5000 }).first().then(($el) => {
            const current = $el.val() || $el.text();
            const updated = current.replace(/nginx:alpine/, 'nginx:1.25-alpine');
            cy.wrap($el).clear({ force: true }).type(updated, { delay: 0, force: true });
          });

          cy.contains(/save|apply|update/i).click();
        });

      // Toast should confirm success
      cy.get('.toast, [class*="toast"]', { timeout: 8000 })
        .should('be.visible')
        .and('satisfy', ($el) => $el.text().match(/saved|updated|ok/i));
    });
  });

  // ----------------------------------------------------------------
  // ConfigMap deploy (tests the multi-line fix)
  // ----------------------------------------------------------------
  context('ConfigMap in deploy form', () => {
    beforeEach(() => cy.loginUI());

    it('adds a configmap with a multi-line value and survives form→yaml→form roundtrip', () => {
      cy.visit('/deploy');

      cy.get('#deploy-name').type('cypress-cm-test');
      cy.get('#deploy-target-peer').select(PEER_B_NAME);
      cy.get('#deploy-image').type('nginx:alpine');

      // Add a ConfigMap
      cy.get('#deploy-add-cm').click();
      cy.get('[data-role="vol-name"]').last().type('my-config');
      cy.get('[data-role="vol-mount"]').last().type('/etc/myapp');
      cy.get('.cfg-add-section').last().find('button').contains('+ Add key').click();
      cy.get('[data-role="kv-key"]').last().type('app.conf');

      // Type Shift+Enter to promote to textarea, then type multi-line value
      cy.get('[data-role="kv-val"]').last().type('line1{shift}{enter}line2{shift}{enter}line3');

      // Switch to YAML — multi-line value should appear as block scalar
      cy.get('[data-mode="yaml"]').click();
      cy.get('#app-spec-yaml, #app-spec-yaml-fallback').invoke('val')
        .should('include', 'app.conf')
        .and('include', '|');

      // Switch back to Form — value should be preserved
      cy.get('[data-mode="form"]').click();
      cy.get('[data-role="kv-val"]').last()
        .invoke('val')
        .should('include', 'line1')
        .and('include', 'line2');
    });
  });

  // ----------------------------------------------------------------
  // Delete via UI
  // ----------------------------------------------------------------
  context('Delete apps via UI', () => {
    beforeEach(() => cy.loginUI());

    it('deletes cypress-busybox via the workloads table', () => {
      cy.visit('/workloads');
      cy.get('body').then(($body) => {
        if (!$body.text().includes('cypress-busybox')) return;
        cy.contains('#submitted-body tr', 'cypress-busybox').click();
        cy.get('[class*="modal"], [id*="modal"], [role="dialog"]', { timeout: 8000 })
          .within(() => {
            cy.contains(/delete|remove/i).click();
          });
        // Confirm dialog
        cy.on('window:confirm', () => true);
        cy.get('.confirm-dialog button, [class*="confirm"] button')
          .contains(/delete|confirm/i)
          .click({ force: true });
        cy.get('#submitted-body', { timeout: 10000 }).should('not.contain.text', 'cypress-busybox');
      });
    });

    it('deletes cypress-cm-test via the workloads table', () => {
      cy.visit('/workloads');
      cy.get('body').then(($body) => {
        if (!$body.text().includes('cypress-cm-test')) return;
        cy.contains('#submitted-body tr', 'cypress-cm-test').click();
        cy.get('[class*="modal"], [id*="modal"], [role="dialog"]', { timeout: 8000 })
          .within(() => {
            cy.contains(/delete|remove/i).click();
          });
        cy.on('window:confirm', () => true);
        cy.get('.confirm-dialog button, [class*="confirm"] button')
          .contains(/delete|confirm/i)
          .click({ force: true });
        cy.get('#submitted-body', { timeout: 10000 }).should('not.contain.text', 'cypress-cm-test');
      });
    });

    it('deletes cypress-nginx via the workloads table', () => {
      cy.visit('/workloads');
      cy.contains('#submitted-body tr', 'cypress-nginx').click();
      cy.get('[class*="modal"], [id*="modal"], [role="dialog"]', { timeout: 8000 })
        .within(() => {
          cy.contains(/delete|remove/i).click();
        });
      cy.on('window:confirm', () => true);
      cy.get('.confirm-dialog button, [class*="confirm"] button')
        .contains(/delete|confirm/i)
        .click({ force: true });
      cy.get('#submitted-body', { timeout: 15000 }).should('not.contain.text', 'cypress-nginx');
    });

    it('Agent B eventually removes the executing app after deletion', () => {
      cy.loginTo(AGENT_B);
      const waitForGone = (attempts = 0) => {
        cy.request(`${AGENT_B}/remoteapps`).then((resp) => {
          const app = resp.body.find((a) => a.name === 'cypress-nginx');
          if (!app) return;
          if (attempts >= 12) expect(app, 'App still exists on B after deletion').to.be.undefined;
          cy.wait(5000);
          waitForGone(attempts + 1);
        });
      };
      waitForGone();
    });
  });
});
