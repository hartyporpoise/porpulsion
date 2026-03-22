/**
 * Per-app proxy auth toggle tests.
 *
 * Verifies:
 *   - proxy_require_auth is true by default in the remoteapps list
 *   - POST /api/remoteapp/<id>/proxy-auth toggles the flag
 *   - The tunnels page shows the .proxy-auth-chk toggle for the app
 *
 * Note: The vhost proxy URL (app-name-port.apiDomain) requires wildcard DNS
 * which is not available in the containerised test environment. Auth enforcement
 * on the vhost URL is covered by manual/integration testing. These tests cover
 * the API contract and the UI toggle.
 *
 * Preconditions: A and B are peered (02-peering ran first).
 */

const { test, expect, AGENT_A, AGENT_B } = require('./fixtures');
const { waitForAppPhase, deleteApps, resolvePeerBName, buildAuthHeader } = require('./helpers');

const APP_NAME = 'proxy-auth-test';

test.describe('Per-app proxy auth toggle', () => {
  // appId is resolved in the first test and carried forward
  let appId;

  test.beforeAll(async ({ request }) => {
    const peerBName = await resolvePeerBName(request);
    const auth = buildAuthHeader();
    const resp = await request.post(`${AGENT_A}/api/remoteapp`, {
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      data: {
        name: APP_NAME,
        target_peer: peerBName,
        spec: { image: 'nginx:alpine', ports: [{ port: 80 }] },
      },
      failOnStatusCode: false,
    });
    expect(resp.status()).toBe(201);
    const body = await resp.json();
    appId = body.app_id || body.id;
  });

  test.afterAll(async ({ request }) => {
    await deleteApps(request, AGENT_A, [APP_NAME]);
  });

  test('proxy_require_auth defaults to true in the remoteapps list', async ({ apiA, request }) => {
    // Wait for the app to appear (CR creation is async)
    await waitForAppPhase(request, AGENT_A, APP_NAME, null, {
      attempts: 10, intervalMs: 2000,
      authHeader: buildAuthHeader(),
    }).catch(() => {});

    const resp = await apiA.get('/api/remoteapps');
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    const all = [...(body.submitted || []), ...(body.executing || [])];
    const app = all.find((a) => a.name === APP_NAME);
    expect(app, `App "${APP_NAME}" not found in remoteapps list`).toBeTruthy();
    // Carry resolved id forward (beforeAll body may have short id, status may add app_id)
    if (app) appId = app.app_id || app.id || appId;
    expect(app.proxy_require_auth).toBe(true);
  });

  test('POST proxy-auth with require_auth=false disables auth', async ({ apiA }) => {
    const resp = await apiA.post(`/api/remoteapp/${appId}/proxy-auth`, { require_auth: false });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.proxy_require_auth).toBe(false);
  });

  test('proxy_require_auth is false in the list after disabling', async ({ apiA }) => {
    const resp = await apiA.get('/api/remoteapps');
    const body = await resp.json();
    const all = [...(body.submitted || []), ...(body.executing || [])];
    const app = all.find((a) => a.name === APP_NAME);
    expect(app).toBeTruthy();
    expect(app.proxy_require_auth).toBe(false);
  });

  test('POST proxy-auth with require_auth=true re-enables auth', async ({ apiA }) => {
    const resp = await apiA.post(`/api/remoteapp/${appId}/proxy-auth`, { require_auth: true });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.proxy_require_auth).toBe(true);
  });

  test('proxy_require_auth is true again after re-enabling', async ({ apiA }) => {
    const resp = await apiA.get('/api/remoteapps');
    const body = await resp.json();
    const all = [...(body.submitted || []), ...(body.executing || [])];
    const app = all.find((a) => a.name === APP_NAME);
    expect(app).toBeTruthy();
    expect(app.proxy_require_auth).toBe(true);
  });

  test('tunnels page shows the proxy-auth toggle for the app', async ({ pageA }) => {
    await pageA.goto(`${AGENT_A}/tunnels`);
    await expect(pageA.locator('.proxy-auth-chk').first()).toBeVisible({ timeout: 10_000 });
  });
});
