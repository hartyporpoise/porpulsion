// Global Cypress helpers

Cypress.on('uncaught:exception', () => false);

const USERNAME = () => Cypress.env('USERNAME');
const PASSWORD = () => Cypress.env('PASSWORD');

/**
 * Log in via the UI login form. Lands on the dashboard.
 */
Cypress.Commands.add('loginUI', (username, password) => {
  cy.session(
    [username || USERNAME(), password || PASSWORD()],
    () => {
      cy.visit('/login');
      cy.get('#username').type(username || USERNAME());
      cy.get('#password').type(password || PASSWORD());
      cy.get('button[type="submit"]').click();
      cy.url().should('not.include', '/login');
    },
    { cacheAcrossSpecs: true }
  );
});

/**
 * Log in to a specific agent URL (for cross-agent API calls).
 */
Cypress.Commands.add('loginTo', (agentUrl, username, password) => {
  return cy.request({
    method: 'POST',
    url: `${agentUrl}/login`,
    form: true,
    body: {
      username: username || USERNAME(),
      password: password || PASSWORD(),
    },
    followRedirect: false,
  });
});

/**
 * Wait for Agent B's peer channel to show as connected on Agent A.
 * Retries up to maxAttempts × intervalMs.
 */
Cypress.Commands.add('waitForPeerConnected', (agentUrl, maxAttempts = 15, intervalMs = 3000) => {
  const poll = (attempt) => {
    return cy.request(`${agentUrl}/peers`).then((resp) => {
      const connected = resp.body.find((p) => p.channel === 'connected');
      if (connected) return connected;
      if (attempt >= maxAttempts) throw new Error('Peer never connected');
      cy.wait(intervalMs);
      return poll(attempt + 1);
    });
  };
  return poll(0);
});

/**
 * Wait for a RemoteApp to reach a given phase on an agent.
 */
Cypress.Commands.add('waitForAppPhase', (agentUrl, appName, phase, maxAttempts = 20, intervalMs = 5000) => {
  const poll = (attempt) => {
    return cy.request(`${agentUrl}/remoteapps`).then((resp) => {
      const app = resp.body.find((a) => a.name === appName);
      if (app && app.status && app.status.phase === phase) return app;
      if (attempt >= maxAttempts) throw new Error(`App ${appName} never reached phase ${phase} (last: ${app?.status?.phase})`);
      cy.wait(intervalMs);
      return poll(attempt + 1);
    });
  };
  return poll(0);
});
