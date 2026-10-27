import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';

export type DeviceRecoveryStatus = 'queued' | 'running' | 'verifying' | 'complete' | 'failed' | 'interrupted';

export interface DeviceRecoveryOperation {
  id: string;
  deviceId: string;
  ownerId: string;
  action: 'springboard-reload';
  status: DeviceRecoveryStatus;
  stage: string;
  stages: Array<{ label: string; at: number; status: 'running' | 'complete' | 'failed' }>;
  commandExitCode?: number;
  reachable?: boolean;
  agentReady?: boolean;
  springboardReady?: boolean;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export function createDeviceRecoveryRepository(database: Database) {
  const read = database.query('SELECT payload FROM device_recovery_operations WHERE id = ?');
  const write = database.query('INSERT INTO device_recovery_operations (id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at');
  const fromRow = (row: { payload: string } | null): DeviceRecoveryOperation | undefined => row ? JSON.parse(row.payload) as DeviceRecoveryOperation : undefined;
  const get = (id: string) => fromRow(read.get(id) as { payload: string } | null);
  const persist = (operation: DeviceRecoveryOperation): DeviceRecoveryOperation => {
    operation.updatedAt = Math.max(Date.now(), operation.updatedAt + 1);
    write.run(operation.id, JSON.stringify(operation), operation.updatedAt);
    return operation;
  };
  return {
    create(deviceId: string, ownerId: string): DeviceRecoveryOperation {
      const now = Date.now();
      return persist({
        id: randomUUID(),
        deviceId,
        ownerId,
        action: 'springboard-reload',
        status: 'queued',
        stage: 'queued',
        stages: [],
        createdAt: now,
        updatedAt: now - 1,
      });
    },
    get,
    list(deviceId: string, limit = 20): DeviceRecoveryOperation[] {
      const rows = database.query("SELECT payload FROM device_recovery_operations WHERE json_extract(payload, '$.deviceId') = ? ORDER BY updated_at DESC LIMIT ?").all(deviceId, limit) as Array<{ payload: string }>;
      return rows.map((row) => JSON.parse(row.payload) as DeviceRecoveryOperation);
    },
    advance(id: string, status: Extract<DeviceRecoveryStatus, 'running' | 'verifying'>, stage: string): DeviceRecoveryOperation | undefined {
      const operation = get(id);
      if (!operation || ['complete', 'failed', 'interrupted'].includes(operation.status)) return operation;
      const previous = operation.stages.at(-1);
      if (previous?.status === 'running') previous.status = 'complete';
      operation.status = status;
      operation.stage = stage;
      operation.error = undefined;
      operation.stages.push({ label: stage, at: Date.now(), status: 'running' });
      return persist(operation);
    },
    complete(id: string, result: Pick<DeviceRecoveryOperation, 'reachable' | 'agentReady' | 'springboardReady' | 'commandExitCode'>): DeviceRecoveryOperation | undefined {
      const operation = get(id);
      if (!operation || ['complete', 'failed', 'interrupted'].includes(operation.status)) return operation;
      const previous = operation.stages.at(-1);
      if (previous?.status === 'running') previous.status = 'complete';
      Object.assign(operation, result, { status: 'complete' as const, stage: 'reconnected and verified', completedAt: Date.now() });
      return persist(operation);
    },
    fail(id: string, error: string, result: Partial<Pick<DeviceRecoveryOperation, 'reachable' | 'agentReady' | 'springboardReady' | 'commandExitCode'>> = {}): DeviceRecoveryOperation | undefined {
      const operation = get(id);
      if (!operation || ['complete', 'failed', 'interrupted'].includes(operation.status)) return operation;
      const previous = operation.stages.at(-1);
      if (previous?.status === 'running') previous.status = 'failed';
      Object.assign(operation, result, { status: 'failed' as const, stage: 'recovery could not be verified', error, completedAt: Date.now() });
      return persist(operation);
    },
    interruptRunning(): number {
      const rows = database.query("SELECT payload FROM device_recovery_operations WHERE json_extract(payload, '$.status') IN ('queued', 'running', 'verifying')").all() as Array<{ payload: string }>;
      for (const row of rows) {
        const operation = JSON.parse(row.payload) as DeviceRecoveryOperation;
        const previous = operation.stages.at(-1);
        if (previous?.status === 'running') previous.status = 'failed';
        operation.status = 'interrupted';
        operation.stage = 'service restarted during recovery';
        operation.error = 'Recovery was interrupted by a dkrypt restart. Start a new recovery to verify the device.';
        operation.completedAt = Date.now();
        persist(operation);
      }
      return rows.length;
    },
    close(): void {
      database.close();
    },
  };
}
