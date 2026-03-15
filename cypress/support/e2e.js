// Shared helpers and Cypress configuration for all specs

// Suppress uncaught exceptions from the app that don't affect test assertions
Cypress.on("uncaught:exception", () => false);

/**
 * Login to an agent.
 * @param {string} baseUrl - agent URL (defaults to Cypress baseUrl)
 * @param {string} username
 * @param {string} password
 */
Cypress.Commands.add("login", (baseUrl, username, password) => {
  const url = baseUrl || Cypress.config("baseUrl");
  const user = username || Cypress.env("USERNAME");
  const pass = password || Cypress.env("PASSWORD");

  cy.request({
    method: "POST",
    url: `${url}/login`,
    form: true,
    body: { username: user, password: pass },
    followRedirect: false,
  }).then((resp) => {
    // Flask redirects to / on success
    expect(resp.status).to.be.oneOf([200, 302]);
  });
});

/**
 * Login via the UI (full page flow).
 */
Cypress.Commands.add("loginUI", (username, password) => {
  const user = username || Cypress.env("USERNAME");
  const pass = password || Cypress.env("PASSWORD");
  cy.visit("/login");
  cy.get('input[name="username"]').type(user);
  cy.get('input[name="password"]').type(pass);
  cy.get('button[type="submit"]').click();
  // Should end up on the dashboard
  cy.url().should("not.include", "/login");
});

/**
 * Make an authenticated API request against a specific agent URL.
 */
Cypress.Commands.add("apiRequest", (method, agentUrl, path, body) => {
  return cy.request({
    method,
    url: `${agentUrl}${path}`,
    body,
    failOnStatusCode: false,
  });
});
