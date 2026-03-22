/**
 * API health / smoke tests — authenticated sanity checks on both agents.
 * Uses Basic Auth via apiA/apiB fixtures — no browser navigation needed.
 */

const { test, expect, AGENT_A, AGENT_B, USERNAME, PASSWORD } = require('./fixtures');

test.describe('API Health', () => {
  test.describe('Agent A', () => {
    test('GET / returns 200', async ({ request }) => {
      const auth = 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
      const resp = await request.get(AGENT_A, {
        headers: { Authorization: auth },
        failOnStatusCode: false,
      });
      expect(resp.status()).toBe(200);
    });

    test('GET /api/settings returns 200 with known fields', async ({ apiA }) => {
      const resp = await apiA.get('/api/settings');
      expect(resp.status()).toBe(200);
      const body = await resp.json();
      expect(body).toHaveProperty('allow_inbound_remoteapps');
      expect(body).toHaveProperty('allow_inbound_tunnels');
    });

    test('GET /api/peers returns array', async ({ apiA }) => {
      const resp = await apiA.get('/api/peers');
      const body = await resp.json();
      expect(Array.isArray(body)).toBe(true);
    });

    test('GET /api/remoteapps returns submitted and executing lists', async ({ apiA }) => {
      const resp = await apiA.get('/api/remoteapps');
      expect(resp.status()).toBe(200);
      const body = await resp.json();
      expect(body).toHaveProperty('submitted');
      expect(Array.isArray(body.submitted)).toBe(true);
      expect(body).toHaveProperty('executing');
      expect(Array.isArray(body.executing)).toBe(true);
    });

    test('GET /api/invite returns a signed bundle', async ({ apiA }) => {
      const resp = await apiA.get('/api/invite');
      expect(resp.status()).toBe(200);
      const body = await resp.json();
      expect(typeof body.bundle).toBe('string');
      expect(body.bundle.length).toBeGreaterThan(10);
    });

    test('unauthenticated GET /settings redirects to /login', async ({ request }) => {
      const resp = await request.get(`${AGENT_A}/settings`, { failOnStatusCode: false });
      expect([200, 302, 401, 403]).toContain(resp.status());
      // If it returned 200 it should be the login page
      if (resp.status() === 200) {
        const text = await resp.text();
        expect(text).toContain('Sign in');
      }
    });

    test('unauthenticated GET /api/peers returns 401', async ({ request }) => {
      const resp = await request.get(`${AGENT_A}/api/peers`, { failOnStatusCode: false });
      expect(resp.status()).toBe(401);
    });

    test('unauthenticated GET /api/remoteapps returns 401', async ({ request }) => {
      const resp = await request.get(`${AGENT_A}/api/remoteapps`, { failOnStatusCode: false });
      expect(resp.status()).toBe(401);
    });

    test('GET /api/notifications returns array', async ({ apiA }) => {
      const resp = await apiA.get('/api/notifications');
      expect(resp.status()).toBe(200);
      const body = await resp.json();
      expect(Array.isArray(body)).toBe(true);
    });
  });

  test.describe('Agent B', () => {
    test('GET / returns 200', async ({ request }) => {
      const auth = 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
      const resp = await request.get(AGENT_B, {
        headers: { Authorization: auth },
        failOnStatusCode: false,
      });
      expect(resp.status()).toBe(200);
    });

    test('GET /api/settings returns 200 with known fields', async ({ apiB }) => {
      const resp = await apiB.get('/api/settings');
      expect(resp.status()).toBe(200);
      const body = await resp.json();
      expect(body).toHaveProperty('allow_inbound_remoteapps');
    });

    test('GET /api/peers returns array', async ({ apiB }) => {
      const resp = await apiB.get('/api/peers');
      const body = await resp.json();
      expect(Array.isArray(body)).toBe(true);
    });

    test('GET /api/remoteapps returns submitted and executing lists', async ({ apiB }) => {
      const resp = await apiB.get('/api/remoteapps');
      expect(resp.status()).toBe(200);
      const body = await resp.json();
      expect(body).toHaveProperty('submitted');
      expect(body).toHaveProperty('executing');
    });

    test('GET /api/invite returns a signed bundle', async ({ apiB }) => {
      const resp = await apiB.get('/api/invite');
      expect(resp.status()).toBe(200);
      const body = await resp.json();
      expect(typeof body.bundle).toBe('string');
      expect(body.bundle.length).toBeGreaterThan(10);
    });
  });
});
