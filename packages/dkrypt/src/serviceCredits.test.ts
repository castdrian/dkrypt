import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createServiceOutageMonitor } from '#serviceCredits.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';

test('service outages grant one expiring credit pack to active subscribers and suppress manual maintenance', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-service-credits-'));
  const database = openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['service_monitor_state', 'decrypt_credit_records']);
  const notifications: Array<{ userId: string; groupKey?: string }> = [];
  const payingUsers = ['member@example.test', 'MEMBER@example.test', 'second@example.test'];
  let manualMaintenance = false;
  const monitor = createServiceOutageMonitor(database, {
    activePayingUsers: () => payingUsers,
    manualMaintenanceActive: () => manualMaintenance,
    notify: (notification) => notifications.push({ userId: notification.userId, groupKey: notification.groupKey }),
  });

  try {
    const firstHeartbeat = 1_800_000_000_000;
    expect(monitor.observe(firstHeartbeat)).toEqual({ outageDetected: false, recipientCount: 0 });
    database.query("UPDATE service_monitor_state SET payload = ?, updated_at = ? WHERE id = 'heartbeat'").run(JSON.stringify({ id: 'heartbeat', lastSeenAt: firstHeartbeat }), firstHeartbeat);
    expect(monitor.observe(firstHeartbeat + 30 * 60 * 1000 - 1)).toEqual({ outageDetected: false, recipientCount: 0 });
    database.query("UPDATE service_monitor_state SET payload = ?, updated_at = ? WHERE id = 'heartbeat'").run(JSON.stringify({ id: 'heartbeat', lastSeenAt: firstHeartbeat }), firstHeartbeat);
    expect(monitor.observe(firstHeartbeat + 30 * 60 * 1000)).toEqual({ outageDetected: true, recipientCount: 2 });

    const grants = database.query("SELECT payload FROM decrypt_credit_records WHERE json_extract(payload, '$.type') = 'grant' ORDER BY id").all() as Array<{ payload: string }>;
    expect(grants.map(({ payload }) => JSON.parse(payload))).toMatchObject([
      { ownerId: 'member@example.test', quantity: 10, remaining: 10, source: 'outage', expiresAt: firstHeartbeat + 30 * 60 * 1000 + 30 * 24 * 60 * 60 * 1000 },
      { ownerId: 'second@example.test', quantity: 10, remaining: 10, source: 'outage', expiresAt: firstHeartbeat + 30 * 60 * 1000 + 30 * 24 * 60 * 60 * 1000 },
    ]);
    expect(notifications).toHaveLength(2);

    database.query("UPDATE service_monitor_state SET payload = ?, updated_at = ? WHERE id = 'heartbeat'").run(JSON.stringify({ id: 'heartbeat', lastSeenAt: firstHeartbeat }), firstHeartbeat);
    expect(monitor.observe(firstHeartbeat + 30 * 60 * 1000)).toEqual({ outageDetected: true, recipientCount: 0 });
    expect(database.query("SELECT COUNT(*) AS count FROM decrypt_credit_records WHERE json_extract(payload, '$.type') = 'grant'").get()).toEqual({ count: 2 });

    const secondHeartbeat = firstHeartbeat + 31 * 60 * 1000;
    database.query("UPDATE service_monitor_state SET payload = ?, updated_at = ? WHERE id = 'heartbeat'").run(JSON.stringify({ id: 'heartbeat', lastSeenAt: secondHeartbeat }), secondHeartbeat);
    manualMaintenance = true;
    expect(monitor.observe(secondHeartbeat + 60_000)).toEqual({ outageDetected: false, recipientCount: 0 });
    manualMaintenance = false;
    expect(monitor.observe(secondHeartbeat + 30 * 60 * 1000 + 60_000)).toEqual({ outageDetected: true, recipientCount: 0 });
    expect(database.query("SELECT COUNT(*) AS count FROM decrypt_credit_records WHERE json_extract(payload, '$.type') = 'outage'").get()).toEqual({ count: 2 });
    expect(notifications).toHaveLength(2);
  } finally {
    monitor.stop();
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
