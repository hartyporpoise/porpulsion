const { defineConfig } = require("cypress");

module.exports = defineConfig({
  e2e: {
    baseUrl: process.env.CYPRESS_BASE_URL || "http://cluster-a:30080",
    viewportWidth: 1920,
    viewportHeight: 1080,
    setupNodeEvents(on) {
      on('before:browser:launch', (browser, launchOptions) => {
        if (browser.name === 'electron') {
          launchOptions.preferences.width = 1920;
          launchOptions.preferences.height = 1080;
          launchOptions.preferences.fullscreen = true;
        }
        return launchOptions;
      });
    },
    supportFile: "cypress/support/e2e.js",
    specPattern: "cypress/e2e/**/*.cy.js",
    // Generous timeouts — k8s reconciliation loops can be slow
    defaultCommandTimeout: 15000,
    responseTimeout: 30000,
    pageLoadTimeout: 60000,
    requestTimeout: 20000,
    testIsolation: true,
    video: false,
    screenshotOnRunFailure: true,
    screenshotsFolder: "cypress/screenshots",
  },
  env: {
    AGENT_A_URL: process.env.CYPRESS_AGENT_A_URL || "http://cluster-a:30080",
    AGENT_B_URL: process.env.CYPRESS_AGENT_B_URL || "http://cluster-b:30080",
    USERNAME: process.env.CYPRESS_USERNAME || "admin",
    PASSWORD: process.env.CYPRESS_PASSWORD || "adminpass1",
  },
});
