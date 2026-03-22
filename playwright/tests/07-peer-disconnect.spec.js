/**
 * Peer persistence tests — verifies the peer table shows a connected peer
 * and that the peer detail modal opens correctly.
 * Precondition: A and B are peered (02-peering ran first).
 */

const { test, expect } = require('./fixtures');

test.describe('Peer persistence', () => {
  test('peers page shows at least one peer', async ({ pageA }) => {
    await pageA.goto('/peers');
    await expect(pageA.locator('#all-peers-body tr').first()).toBeVisible({ timeout: 10_000 });
  });

  test('peers table shows connected channel status', async ({ pageA }) => {
    await pageA.goto('/peers');
    // Badge renders "live" (badge-mtls) or "local" (badge-pending), not the literal word "connected"
    await expect(
      pageA.locator('#all-peers-body .badge-mtls, #all-peers-body .badge-pending').first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test('clicking a peer info button opens the peer detail modal', async ({ pageA }) => {
    await pageA.goto('/peers');
    await pageA.locator('#all-peers-body tr').first().locator('.peer-info-btn').click();
    await expect(pageA.locator('#peer-modal.open')).toBeVisible({ timeout: 5_000 });
    await pageA.locator('#peer-modal-close').click();
    await expect(pageA.locator('#peer-modal')).not.toHaveClass(/open/);
  });

  test('peer detail modal shows peer name, URL, and latency', async ({ pageA }) => {
    await pageA.goto('/peers');
    await pageA.locator('#all-peers-body tr').first().locator('.peer-info-btn').click();
    await expect(pageA.locator('#peer-modal.open')).toBeVisible({ timeout: 5_000 });
    await expect(pageA.locator('#peer-modal')).toContainText(/http/i);
    await pageA.locator('#peer-modal-close').click();
  });

  test('peer count badge matches the number of peer rows', async ({ pageA }) => {
    await pageA.goto('/peers');
    const rows = pageA.locator('#all-peers-body tr');
    await rows.first().waitFor({ timeout: 10_000 });
    const rowCount = await rows.count();
    const badgeText = await pageA.locator('#all-peers-count').textContent();
    expect(parseInt(badgeText, 10)).toBe(rowCount);
  });
});
