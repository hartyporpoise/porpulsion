const { defineConfig } = require("cypress");

module.exports = defineConfig({
  e2e: {
    baseUrl: process.env.CYPRESS_BASE_URL || "http://agent-a:30080",
    setupNodeEvents() {},
    supportFile: "cypress/support/e2e.js",
    specPattern: "cypress/e2e/**/*.cy.js",
    // Generous timeouts — k8s reconciliation loops can be slow
    defaultCommandTimeout: 15000,
    responseTimeout: 30000,
    pageLoadTimeout: 60000,
    requestTimeout: 20000,
    experimentalSessionAndOrigin: true,
    video: false,
    screenshotOnRunFailure: true,
    screenshotsFolder: "cypress/screenshots",
  },
  env: {
    AGENT_A_URL: process.env.CYPRESS_AGENT_A_URL || "http://agent-a:30080",
    AGENT_B_URL: process.env.CYPRESS_AGENT_B_URL || "http://agent-b:30080",
    USERNAME: process.env.CYPRESS_USERNAME || "admin",
    PASSWORD: process.env.CYPRESS_PASSWORD || "adminpass1",
  },
});
