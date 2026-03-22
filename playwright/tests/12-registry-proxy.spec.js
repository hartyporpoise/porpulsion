/**
 * Registry pull-through proxy tests.
 *
 * The /v2/ OCI Distribution endpoint is always registered on the agent.
 * The registry_pull_enabled toggle controls whether the k8s pull secret and
 * system user are created — it doesn't gate the /v2/ route itself.
 *
 * Tests:
 *   1. /v2/ OCI ping responds correctly (authenticated).
 *   2. Unauthenticated /v2/ returns 401 with WWW-Authenticate and OCI error body.
 *   3. registry_pull_enabled toggle persists to the API.
 *   4. Proxying a public image manifest returns a non-500 response.
 *
 * Preconditions: Both agents running.
 */

const { test, expect, AGENT_A, AGENT_B, USERNAME, PASSWORD } = require('./fixtures');

test.describe('Registry pull-through proxy', () => {
  // ----------------------------------------------------------------
  // /v2/ endpoint — always active, auth-gated
  // ----------------------------------------------------------------
  test.describe('/v2/ OCI ping endpoint', () => {
    test('unauthenticated GET /v2/ returns 401 with Docker-Distribution-Api-Version header', async ({ request }) => {
      const resp = await request.get(`${AGENT_A}/v2/`, { failOnStatusCode: false });
      expect(resp.status()).toBe(401);
      const headers = resp.headers();
      expect(headers['docker-distribution-api-version']).toBe('registry/2.0');
      const body = await resp.json();
      expect(Array.isArray(body.errors)).toBe(true);
    });

    test('authenticated GET /v2/ returns 200 with OCI distribution API version header', async ({ request }) => {
      const resp = await request.get(`${AGENT_A}/v2/`, {
        headers: { Authorization: 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64') },
        failOnStatusCode: false,
      });
      expect(resp.status()).toBe(200);
      expect(resp.headers()['docker-distribution-api-version']).toBe('registry/2.0');
    });

    test('authenticated HEAD /v2/ also returns 200', async ({ request }) => {
      const resp = await request.head(`${AGENT_A}/v2/`, {
        headers: { Authorization: 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64') },
        failOnStatusCode: false,
      });
      expect(resp.status()).toBe(200);
    });
  });

  // ----------------------------------------------------------------
  // Proxy a public manifest — confirms the proxy forwards requests
  // ----------------------------------------------------------------
  test.describe('Manifest proxy (public registry)', () => {
    test('GET /v2/<host>/<repo>/manifests/<tag> for a public image returns non-500', async ({ request }) => {
      const resp = await request.get(
        `${AGENT_A}/v2/registry-1.docker.io/library/alpine/manifests/3.19`,
        {
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64'),
            Accept: 'application/vnd.docker.distribution.manifest.v2+json',
          },
          failOnStatusCode: false,
          timeout: 30_000,
        }
      );
      expect(resp.status()).toBeLessThan(500);
    });
  });

  // ----------------------------------------------------------------
  // registry_pull_enabled toggle persists to API
  // ----------------------------------------------------------------
  test.describe('registry_pull_enabled toggle', () => {
    test('enabling registry_pull_enabled persists to GET /api/settings', async ({ apiB }) => {
      const resp = await apiB.post('/api/settings', { registry_pull_enabled: true });
      expect(resp.status()).toBe(200);
      const getResp = await apiB.get('/api/settings');
      const body = await getResp.json();
      expect(body.registry_pull_enabled).toBe(true);
    });

    test('Registry tab in the UI reflects the enabled state', async ({ pageB }) => {
      await pageB.goto(`${AGENT_B}/settings`);
      await pageB.locator('.stg-tab[data-section="registry"]').click();
      await expect(pageB.locator('#setting-registry-pull-enabled')).toBeChecked({ timeout: 5_000 });
    });

    test('disabling registry_pull_enabled persists to GET /api/settings', async ({ apiB }) => {
      const resp = await apiB.post('/api/settings', { registry_pull_enabled: false });
      expect(resp.status()).toBe(200);
      const getResp = await apiB.get('/api/settings');
      const body = await getResp.json();
      expect(body.registry_pull_enabled).toBe(false);
    });

  });

  test.afterAll(async ({ apiB }) => {
    await apiB.post('/api/settings', { registry_pull_enabled: false });
  });
});
