/**
 * Playwright fixtures for the Porpulsion test suite.
 *
 * Key improvement over Cypress: storageState is loaded ONCE per test
 * via the fixture rather than triggering a full login on every test.
 * No more cy.loginTo() calls scattered through specs.
 *
 * Usage:
 *   const { test, expect } = require('./fixtures');
 *
 *   test('my test', async ({ pageA, pageB, apiA, apiB }) => { ... });
 *
 * Fixtures provided:
 *   pageA    - Page logged in to Agent A (storageState from .auth/agent-a.json)
 *   pageB    - Page logged in to Agent B (storageState from .auth/agent-b.json)
 *   apiA     - Helper bound to Agent A with Basic Auth (for API calls)
 *   apiB     - Helper bound to Agent B with Basic Auth (for API calls)
 */

const { test: base, expect } = require('@playwright/test');
const path = require('path');


const AGENT_A = process.env.PLAYWRIGHT_AGENT_A_URL || 'http://cluster-a:30080';
const AGENT_B = process.env.PLAYWRIGHT_AGENT_B_URL || 'http://cluster-b:30080';
const USERNAME = process.env.PLAYWRIGHT_USERNAME || 'admin';
const PASSWORD = process.env.PLAYWRIGHT_PASSWORD || 'adminpass1';

const AUTH_A = path.join(__dirname, '..', '.auth', 'agent-a.json');
const AUTH_B = path.join(__dirname, '..', '.auth', 'agent-b.json');

// Helper: make authenticated API requests using Basic Auth (no CSRF, no cookies needed)
function makeApiHelper(request, baseUrl) {
  const authHeader = 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
  return {
    async get(path) {
      return request.get(`${baseUrl}${path}`, {
        headers: { Authorization: authHeader },
        failOnStatusCode: false,
      });
    },
    async post(path, body) {
      return request.post(`${baseUrl}${path}`, {
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        data: body,
        failOnStatusCode: false,
      });
    },
    async patch(path, body) {
      return request.patch(`${baseUrl}${path}`, {
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        data: body,
        failOnStatusCode: false,
      });
    },
    async delete(path) {
      return request.delete(`${baseUrl}${path}`, {
        headers: { Authorization: authHeader },
        failOnStatusCode: false,
      });
    },
    // Raw request for full control (method, headers, etc.)
    async fetch(method, path, opts = {}) {
      return request.fetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: authHeader, 'Content-Type': 'application/json', ...opts.headers },
        data: opts.body,
        failOnStatusCode: false,
        timeout: opts.timeout,
      });
    },
    baseUrl,
  };
}

const test = base.extend({
  // Authenticated page on Agent A — session loaded from saved storageState
  pageA: async ({ browser }, use) => {
    const context = await browser.newContext({
      storageState: AUTH_A,
      baseURL: AGENT_A,
      colorScheme: 'dark',
    });
    // Abort Monaco CDN requests so context.close() never blocks on an
    // in-flight fetch. xterm.js and Alpine.js (also on unpkg.com) are
    // allowed through — only monaco-editor is blocked.
    await context.route('https://unpkg.com/**', (route) => {
      if (route.request().url().includes('monaco-editor')) route.abort();
      else route.continue();
    });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  // Authenticated page on Agent B — session loaded from saved storageState
  pageB: async ({ browser }, use) => {
    const context = await browser.newContext({
      storageState: AUTH_B,
      baseURL: AGENT_B,
      colorScheme: 'dark',
    });
    await context.route('https://unpkg.com/**', (route) => {
      if (route.request().url().includes('monaco-editor')) route.abort();
      else route.continue();
    });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  // Basic-Auth API helper for Agent A
  apiA: async ({ request }, use) => {
    await use(makeApiHelper(request, AGENT_A));
  },

  // Basic-Auth API helper for Agent B
  apiB: async ({ request }, use) => {
    await use(makeApiHelper(request, AGENT_B));
  },
});

module.exports = { test, expect, AGENT_A, AGENT_B, USERNAME, PASSWORD, AUTH_A, AUTH_B };
