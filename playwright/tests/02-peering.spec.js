/**
 * Peering tests — connect Agent A to Agent B entirely through the UI.
 *
 * Flow:
 *   1. Fetch Agent B's invite bundle via API
 *   2. Open Agent A's Peers page, paste the bundle, submit
 *   3. Wait for the peer row to show a connected badge
 *   4. Verify direction via API
 *   5. Upgrade to bidirectional (B connects back to A)
 */

const { test, expect, AGENT_A, AGENT_B } = require('./fixtures');

let bundleB;
let bundleA;

test.describe('Peering', () => {
  test.describe('Your Invite Bundle card on Agent A', () => {
    test('shows the invite bundle on the Peers page', async ({ pageA }) => {
      await pageA.goto('/peers');
      // Wait for JS to populate data-value (async API call on page load)
      await expect.poll(
        async () => {
          const val = await pageA.locator('#invite-bundle').getAttribute('data-value');
          return val && val.length > 10;
        },
        { timeout: 20_000 }
      ).toBeTruthy();
      // Reveal the masked bundle
      await pageA.locator('.eye-btn').first().click();
      const dataValue = await pageA.locator('#invite-bundle').getAttribute('data-value');
      expect(dataValue).toBeTruthy();
      expect(dataValue.length).toBeGreaterThan(10);
    });

    test('shows the self URL endpoint', async ({ pageA }) => {
      await pageA.goto('/peers');
      // Wait for JS to replace "loading…" with the actual URL
      await expect.poll(
        async () => {
          const text = await pageA.locator('#token-url').textContent();
          return text && !text.includes('loading');
        },
        { timeout: 20_000 }
      ).toBeTruthy();
      const text = await pageA.locator('#token-url').textContent();
      expect(text.trim()).toBeTruthy();
    });
  });

  test.describe('Connect A to B using the UI form', () => {
    test('fetch Agent B invite bundle and paste into Agent A connect form', async ({ pageA, apiB }) => {
      // Fetch bundle from B
      const inviteResp = await apiB.get('/api/invite');
      expect(inviteResp.status()).toBe(200);
      const inviteBody = await inviteResp.json();
      bundleB = inviteBody.bundle;
      expect(bundleB).toBeTruthy();
      expect(bundleB.length).toBeGreaterThan(10);

      // Paste into A's connect form
      await pageA.goto('/peers');
      await pageA.locator('#new-peer-bundle').fill(bundleB);
      await pageA.locator('#connect-peer-form button[type="submit"]').click();
      // Wait for a peer row to appear
      await expect(pageA.locator('#all-peers-body tr').first()).toBeVisible({ timeout: 20_000 });
    });

    test('peer row shows the connected channel status', async ({ pageA }) => {
      await pageA.goto('/peers');
      // Badge shows "live" (badge-mtls) or "local" (badge-pending), never the literal word "connected"
      await expect(
        pageA.locator('#all-peers-body .badge-mtls, #all-peers-body .badge-pending').first()
      ).toBeVisible({ timeout: 30_000 });
    });

    test('shows peer count badge > 0', async ({ pageA }) => {
      await pageA.goto('/peers');
      await expect.poll(
        async () => {
          const text = await pageA.locator('#all-peers-count').textContent();
          return parseInt(text, 10);
        },
        { timeout: 15_000 }
      ).toBeGreaterThan(0);
    });

    test('Agent A has Agent B as a peer (outgoing or bidirectional)', async ({ apiA }) => {
      const resp = await apiA.get('/api/peers');
      expect(resp.status()).toBe(200);
      const peers = await resp.json();
      expect(peers.length).toBeGreaterThan(0);
      expect(['outgoing', 'bidirectional']).toContain(peers[0].direction);
    });

    test('Agent B has Agent A as a peer (incoming or bidirectional)', async ({ apiB }) => {
      const resp = await apiB.get('/api/peers');
      expect(resp.status()).toBe(200);
      const peers = await resp.json();
      expect(peers.length).toBeGreaterThan(0);
      expect(['incoming', 'bidirectional']).toContain(peers[0].direction);
    });

    test('rejects a duplicate connect attempt', async ({ pageA }) => {
      // bundleB is already in scope from the first test in this describe
      await pageA.goto('/peers');
      await pageA.locator('#new-peer-bundle').fill(bundleB);
      await pageA.locator('#connect-peer-form button[type="submit"]').click();
      // Toast shows an error for already-peered
      await expect(pageA.locator('#toast.show')).toBeVisible({ timeout: 8_000 });
      const toastText = await pageA.locator('#toast').textContent();
      expect(/already|peered|409|exists/i.test(toastText)).toBe(true);
    });
  });

  test.describe('Upgrade to bidirectional — B connects back to A', () => {
    test('fetch Agent A invite bundle and paste into Agent B connect form', async ({ pageB, apiA }) => {
      const inviteResp = await apiA.get('/api/invite');
      expect(inviteResp.status()).toBe(200);
      const inviteBody = await inviteResp.json();
      bundleA = inviteBody.bundle;
      expect(bundleA).toBeTruthy();
      expect(bundleA.length).toBeGreaterThan(10);

      await pageB.goto(`${AGENT_B}/peers`);
      await pageB.locator('#new-peer-bundle').fill(bundleA);
      await pageB.locator('#connect-peer-form button[type="submit"]').click();
      await expect(pageB.locator('#all-peers-body tr').first()).toBeVisible({ timeout: 20_000 });
    });

    test('Agent A direction upgrades to bidirectional', async ({ apiA }) => {
      const resp = await apiA.get('/api/peers');
      const peers = await resp.json();
      expect(peers.length).toBeGreaterThan(0);
      expect(peers[0].direction).toBe('bidirectional');
    });

    test('Agent B direction upgrades to bidirectional', async ({ apiB }) => {
      const resp = await apiB.get('/api/peers');
      const peers = await resp.json();
      expect(peers.length).toBeGreaterThan(0);
      expect(peers[0].direction).toBe('bidirectional');
    });
  });
});
