import { randomUUID } from 'node:crypto';
import { config } from '#config.js';
import { isBillingSubscriptionActive, listBillingSubscriptions } from '#billing.js';
import { log } from '#logger.js';
import { recordNotification } from '#store/state.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';
import { getMaintenanceStatus } from '#maintenance.js';
import type { Database } from 'bun:sqlite';

const OUTAGE_THRESHOLD_MS = 30 * 60 * 1000;
const OUTAGE_CREDIT_QUANTITY = 10;
const OUTAGE_CREDIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 60_000;

const database = openStateCollectionDatabase(
  { stateDir: config.stateDir, filename: config.stateDatabaseFile, busyTimeoutMs: config.stateDbBusyTimeoutMs },
  ['service_monitor_state', 'decrypt_credit_records'],
);

interface MonitorState {
  id: 'heartbeat';
  lastSeenAt: number;
  manualMaintenance?: boolean;
}

export interface ServiceOutageMonitorDependencies {
  activePayingUsers(): string[];
  manualMaintenanceActive(): boolean;
  notify(input: Parameters<typeof recordNotification>[0]): void;
}

export function createServiceOutageMonitor(database: Database, dependencies: ServiceOutageMonitorDependencies) {
  let interval: ReturnType<typeof setInterval> | undefined;

  const readHeartbeat = (): MonitorState | undefined => {
    const row = database.query('SELECT payload FROM service_monitor_state WHERE id = ?').get('heartbeat') as { payload: string } | null;
    if (!row) return undefined;
    try {
      const value = JSON.parse(row.payload) as MonitorState;
      return value.id === 'heartbeat' && Number.isFinite(value.lastSeenAt) ? value : undefined;
    } catch {
      return undefined;
    }
  };

  const saveHeartbeat = (lastSeenAt: number, manualMaintenance: boolean): void => {
    const value: MonitorState = { id: 'heartbeat', lastSeenAt, manualMaintenance };
    database.query('INSERT INTO service_monitor_state (id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at').run('heartbeat', JSON.stringify(value), lastSeenAt);
  };

  const recordOutage = (startedAt: number, recoveredAt: number, maintenanceOverlapped: boolean): number => {
    const outageId = `outage-${startedAt}`;
    const recordId = `outage:${outageId}`;
    if (database.query('SELECT 1 AS present FROM decrypt_credit_records WHERE id = ?').get(recordId)) return 0;
    database.exec('BEGIN IMMEDIATE;');
    try {
      const inserted = database.query('INSERT INTO decrypt_credit_records (id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING').run(recordId, JSON.stringify({ id: recordId, type: 'outage', outageId, startedAt, recoveredAt, durationMs: recoveredAt - startedAt, creditQuantity: OUTAGE_CREDIT_QUANTITY }), recoveredAt);
      if (inserted.changes !== 1) {
        database.exec('COMMIT;');
        return 0;
      }
      const recipients = maintenanceOverlapped ? [] : [...new Set(dependencies.activePayingUsers().map((userId) => userId.trim().toLowerCase()).filter(Boolean))];
      let grants = 0;
      const grantedUsers: string[] = [];
      for (const userId of recipients) {
        const grantId = `grant:outage:${outageId}:${userId}`;
        const grant = { id: grantId, type: 'grant', ownerId: userId, quantity: OUTAGE_CREDIT_QUANTITY, remaining: OUTAGE_CREDIT_QUANTITY, source: 'outage', reference: outageId, createdAt: recoveredAt, expiresAt: recoveredAt + OUTAGE_CREDIT_TTL_MS };
        const result = database.query('INSERT INTO decrypt_credit_records (id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING').run(grantId, JSON.stringify(grant), recoveredAt);
        if (result.changes !== 1) continue;
        grants += 1;
        grantedUsers.push(userId);
      }
      const record = { id: recordId, type: 'outage', outageId, startedAt, recoveredAt, durationMs: recoveredAt - startedAt, creditQuantity: OUTAGE_CREDIT_QUANTITY, recipientCount: grants };
      database.query('UPDATE decrypt_credit_records SET payload = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(record), recoveredAt, recordId);
      database.exec('COMMIT;');
      for (const userId of grantedUsers) {
        try {
          dependencies.notify({
            userId,
            title: 'Service credits added',
            message: `${OUTAGE_CREDIT_QUANTITY} decrypt credits were added after a dkrypt outage lasting at least 30 minutes. They expire in 30 days.`,
            severity: 'info',
            groupKey: `service-credit:${outageId}`,
            href: '/?tab=billing',
          });
        } catch (error) {
          log.warn('service credit notification failed', { userId, outageId, error: String(error) });
        }
      }
      return grants;
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  };

  const observe = (now = Date.now()): { outageDetected: boolean; recipientCount: number } => {
    const prior = readHeartbeat();
    const manualMaintenance = dependencies.manualMaintenanceActive();
    if (!prior || now - prior.lastSeenAt < OUTAGE_THRESHOLD_MS) {
      saveHeartbeat(now, manualMaintenance);
      return { outageDetected: false, recipientCount: 0 };
    }
    const recipientCount = recordOutage(prior.lastSeenAt, now, Boolean(prior.manualMaintenance) || manualMaintenance);
    saveHeartbeat(now, manualMaintenance);
    return { outageDetected: true, recipientCount };
  };

  return {
    observe,
    start() {
      if (interval) return;
      observe();
      interval = setInterval(() => {
        try {
          observe();
        } catch {
          return;
        }
      }, HEARTBEAT_INTERVAL_MS);
      interval.unref();
    },
    stop() {
      if (interval) clearInterval(interval);
      interval = undefined;
    },
  };
}

function activePayingUsers(): string[] {
  return [...new Set(listBillingSubscriptions()
    .filter((subscription) => subscription.userId && isBillingSubscriptionActive(subscription))
    .map((subscription) => subscription.userId!.trim().toLowerCase())
    .filter((userId) => userId.length > 0))];
}

const monitor = createServiceOutageMonitor(database, {
  activePayingUsers,
  manualMaintenanceActive: () => getMaintenanceStatus().manual,
  notify: recordNotification,
});

export function observeServiceHeartbeat(now = Date.now()): { outageDetected: boolean; recipientCount: number } {
  return monitor.observe(now);
}

export function startServiceOutageMonitor(): void {
  monitor.start();
}

export function stopServiceOutageMonitor(): void {
  monitor.stop();
}

export function closeServiceCreditDatabase(): void {
  monitor.stop();
  database.close();
}

export function createCreditGrantReference(prefix = 'manual'): string {
  return `${prefix}-${randomUUID()}`;
}
