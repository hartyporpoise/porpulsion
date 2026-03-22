// @ts-check
const { defineConfig, devices } = require('@playwright/test');

const AGENT_A = process.env.PLAYWRIGHT_AGENT_A_URL || 'http://cluster-a:30080';
const AGENT_B = process.env.PLAYWRIGHT_AGENT_B_URL || 'http://cluster-b:30080';

module.exports = defineConfig({
  testDir: './tests',
  // Run specs in filename order (sequential — each spec may depend on the previous)
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,

  // Generous timeouts — k8s reconciliation loops are slow
  timeout: 120_000,
  expect: { timeout: 20_000 },

  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],

  use: {
    baseURL: AGENT_A,
    viewport: { width: 1600, height: 960 },
    // Capture a screenshot and trace on first retry only
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    // All API requests use Basic Auth — no cookie handling needed for those
    ignoreHTTPSErrors: true,
    // Force dark mode via emulation
    colorScheme: 'dark',
    // Prevent Chromium from crashing inside Docker due to /dev/shm being too small
    launchOptions: {
      args: ['--disable-dev-shm-usage'],
    },
  },

  projects: [
    // --- Auth setup project: saves storageState for each agent to disk ---
    {
      name: 'setup-a',
      testMatch: /auth\.setup\.js/,
      use: {
        baseURL: AGENT_A,
        storageState: undefined,
      },
    },
    {
      name: 'setup-b',
      testMatch: /auth\.setup\.js/,
      use: {
        baseURL: AGENT_B,
        storageState: undefined,
      },
    },

    // --- Main test suite: depends on both setup projects ---
    {
      name: 'e2e',
      testMatch: /\d{2}-.*\.spec\.js/,
      dependencies: ['setup-a', 'setup-b'],
      use: {
        baseURL: AGENT_A,
        // storageState is loaded per-test via the authenticatedA / authenticatedB fixtures
      },
    },
  ],
});
