import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createDeviceHistoryRepository } from '#store/deviceHistoryRepository.js';
import { createDeviceHealthRepository } from '#store/deviceHealthRepository.js';
import { LATEST_SQLITE_SCHEMA_VERSION, openStateCollectionDatabase, openStateDatabase, readStateCollection, replaceStateCollections, verifyDatabaseBackup } from '#store/sqlite.js';
import { rewindApiKeySearchMigration, rewindSessionSearchMigration } from '#store/sqliteTestHelpers.js';

const initializationApplicationId = 184527631;

function initializationMarkerContents(databasePath: string, phase: 'unbound' | 'bound' = 'unbound', applicationId = initializationApplicationId): string {
  const pathHash = createHash('sha256').update(path.resolve(databasePath)).digest('hex');
  const status = phase === 'bound' ? statSync(databasePath) : undefined;
  return `dkrypt-state-initialization-v1\n${pathHash}\n${applicationId}\n${phase}\n${status?.dev ?? '-'}\n${status?.ino ?? '-'}\n`;
}

function rewindToSchemaVersion16(database: ReturnType<typeof openStateDatabase>): void {
  rewindApiKeySearchMigration(database.db);
  rewindSessionSearchMigration(database.db);
  database.db.exec(`
    DROP INDEX decrypt_quota_by_owner_time;
    DROP TABLE decrypt_quota_ledger;
    DROP INDEX worker_instances_by_heartbeat;
    DROP TABLE worker_instances;
    DROP INDEX billing_events_by_provider_event;
    DROP INDEX billing_events_by_processed_at;
    DROP TABLE billing_customers;
    DROP TABLE billing_subscriptions;
    DROP TABLE billing_checkouts;
    DROP TABLE billing_charges;
    DROP TABLE billing_entitlement_history;
    DROP TABLE backup_schedule;
    DROP INDEX diagnostic_reports_by_user_time;
    DROP INDEX diagnostic_reports_by_expiry;
    DROP TABLE diagnostic_reports;
    DROP TABLE pending_oauth_links;
    DROP TABLE integration_deliveries;
    DROP TABLE integration_policies;
    DROP TABLE operational_incidents;
    DROP TABLE watch_revisions;
    DROP TABLE watch_drafts;
    DROP TABLE appstore_offline_credential_operations;
    DROP TABLE appstore_offline_authentication_operations;
    DROP TABLE job_worker_leases;
    DROP TABLE job_worker_generations;
    DROP TABLE appstore_offline_account;
    DROP TABLE mcp_records;
    DROP TABLE decrypt_credit_records;
    DROP TABLE service_monitor_state;
    ALTER TABLE billing_events DROP COLUMN provider;
    ALTER TABLE billing_events DROP COLUMN event_id;
    ALTER TABLE billing_events DROP COLUMN occurred_at;
    ALTER TABLE billing_events DROP COLUMN processed_at;
    DELETE FROM schema_migrations WHERE version IN (17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34);
  `);
}

function expectVersion16AfterMigrationRollback(database: Database): void {
  const tables = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('billing_customers', 'billing_subscriptions', 'billing_checkouts', 'billing_charges', 'billing_entitlement_history') ORDER BY name;").all();
  expect(tables).toEqual([]);
  expect(database.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 16 });
  expect(database.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
}

async function killChildAtOutput(child: ChildProcess, marker: string): Promise<void> {
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  let output = '';
  let errorOutput = '';
  child.stderr?.on('data', (chunk: string) => { errorOutput += chunk; });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`child did not reach ${marker}: ${output}${errorOutput}`)), 10_000);
    const onData = (chunk: string) => {
      output += chunk;
      if (output.includes(marker)) finish();
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`child exited before reaching ${marker}: code=${code} signal=${signal} ${errorOutput}`));
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    child.stdout?.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });

  const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`child did not stop after SIGKILL at ${marker}`)), 5_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  if (!child.kill('SIGKILL')) throw new Error(`could not send SIGKILL to child at ${marker}`);
  expect(await childExit).toEqual({ code: null, signal: 'SIGKILL' });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const childExit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await childExit;
}

test('SQLite state snapshots survive restart and retain independently owned collections', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-'));
  try {
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    expect(database.readState()).toBeUndefined();
    const state = { version: 16, devices: [{ id: 'device-1', updatedAt: 10 }], projects: [{ id: 'project-1', name: 'Default workspace', memberIds: [], isDefault: true, createdBy: 'system', createdAt: 10, updatedAt: 10 }], settings: { maintenanceMode: false } };
    database.writeState(state);
    database.replaceCollection('jobs', [{ id: 'job-1', payload: { id: 'job-1', status: 'queued' }, updatedAt: 20 }]);
    database.writeState({ ...state, settings: { maintenanceMode: true } });
    expect(database.readState()).toEqual({ ...state, settings: { maintenanceMode: true } });
    expect(database.readCollection('jobs')).toEqual([{ id: 'job-1', status: 'queued' }]);
    database.close();

    const reopened = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    expect(reopened.integrityStatus()).toBe('ok');
    expect(reopened.schemaVersion).toBe(LATEST_SQLITE_SCHEMA_VERSION);
    expect(reopened.readCollection('jobs')).toEqual([{ id: 'job-1', status: 'queued' }]);
    expect(reopened.readCollection('scheduler_runs')).toEqual([]);
    expect(reopened.readCollection('projects')).toEqual(state.projects);
    reopened.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite migration adds persisted Apple Account authentication operations', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-apple-auth-migration-'));
  try {
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    database.db.exec('DROP TABLE appstore_offline_authentication_operations; DROP TABLE job_worker_leases; DROP TABLE job_worker_generations; DROP INDEX worker_instances_by_heartbeat; DROP TABLE worker_instances; DELETE FROM schema_migrations WHERE version IN (29, 30, 31, 32, 33);');
    database.close();

    const migrated = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    const table = migrated.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'appstore_offline_authentication_operations'").get();
    expect(migrated.schemaVersion).toBe(LATEST_SQLITE_SCHEMA_VERSION);
    expect(table).toEqual({ name: 'appstore_offline_authentication_operations' });
    migrated.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite state and watch revision writes roll back together', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-watch-revision-'));
  const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
  try {
    const original = { version: 1, watches: [] };
    database.writeState(original);
    expect(() => database.writeState({ version: 1, watches: [{ id: 'watch-1', bundleId: 'com.example.app' }] }, undefined, [], (transaction) => {
      transaction.query('INSERT INTO watch_revisions (id, payload, updated_at, watch_id, project_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?)').run('revision-1', '{}', Date.now(), 'watch-1', 'default', null);
      throw new Error('revision write failed');
    })).toThrow('revision write failed');
    expect(database.readState()).toEqual(original);
    expect(database.db.query('SELECT COUNT(*) AS count FROM watch_revisions WHERE id = ?').get('revision-1')).toEqual({ count: 0 });
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite keeps scheduler history separate from job timelines', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-scheduler-'));
  try {
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    database.writeState({
      version: 15,
      schedulerRunHistory: [{ id: 'run-1', ts: 100, appStore: {}, testflight: {} }],
      devices: [],
      settings: {},
    });
    expect(database.readCollection('scheduler_runs')).toHaveLength(1);
    expect(database.readCollection('job_timelines')).toEqual([]);
    database.replaceCollection('job_timelines', [{ id: 'job-1', payload: { jobId: 'job-1', events: [] }, updatedAt: 200 }]);
    expect(database.readCollection('job_timelines')).toEqual([{ jobId: 'job-1', events: [] }]);
    database.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite migrates legacy scheduler rows out of job timelines', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-scheduler-migration-'));
  try {
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    database.db.query('DELETE FROM schema_migrations WHERE version = 4').run();
    database.db.query('INSERT OR REPLACE INTO job_timelines (id, payload, updated_at) VALUES (?, ?, ?)').run('run-legacy', JSON.stringify({ id: 'run-legacy', ts: 100, appStore: {}, testflight: {} }), 100);
    database.close();

    const migrated = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    expect(migrated.readCollection('job_timelines')).toEqual([]);
    expect(migrated.readCollection('scheduler_runs')).toEqual([{ id: 'run-legacy', ts: 100, appStore: {}, testflight: {} }]);
    migrated.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite backfills indexed device activity from its state snapshot during migration', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-device-history-migration-'));
  try {
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    const older = { id: 'activity-older', ts: 100, deviceId: 'device-a', kind: 'bridge' as const, message: 'older' };
    const newer = { id: 'activity-newer', ts: 200, deviceId: 'device-a', kind: 'job' as const, message: 'newer' };
    database.writeState({ version: 18, deviceActivity: [newer, older], deviceHealthHistory: {} });
    database.db.exec('DELETE FROM device_history; DELETE FROM schema_migrations WHERE version = 10; DROP INDEX device_history_by_device_time;');
    for (const column of ['bundle_id', 'occurred_at', 'history_kind', 'device_id']) {
      database.db.exec(`ALTER TABLE device_history DROP COLUMN ${column};`);
    }
    database.close();

    const migrated = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    const repository = createDeviceHistoryRepository(migrated.db);
    expect(migrated.schemaVersion).toBe(LATEST_SQLITE_SCHEMA_VERSION);
    expect(repository.listByDevice('device-a')).toEqual([newer, older]);
    expect(repository.listByDevice('device-b')).toEqual([]);
    migrated.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite backfills normalized device health checks from its state snapshot during migration', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-device-health-migration-'));
  try {
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    const older = { ts: 100, reachable: true, batteryPercent: 82 };
    const newer = { ts: 200, reachable: false, batteryPercent: 81 };
    database.writeState({
      version: 18,
      deviceActivity: [],
      deviceHealthHistory: { 'device-a': [older, newer] },
    });
    database.db.exec('DELETE FROM device_health; DELETE FROM schema_migrations WHERE version = 11; DROP INDEX device_health_by_device_time;');
    const legacyCheck = { ts: 300, reachable: true, batteryTemperatureC: 31.5 };
    database.db.query('INSERT INTO device_health (id, payload, updated_at) VALUES (?, ?, ?)').run(
      'device-health-device-b',
      JSON.stringify({ key: 'device-b', value: [legacyCheck] }),
      legacyCheck.ts,
    );
    for (const column of ['storage_used_percent', 'battery_temperature_c', 'battery_percent', 'reachable', 'checked_at', 'device_id']) {
      database.db.exec(`ALTER TABLE device_health DROP COLUMN ${column};`);
    }
    database.close();

    const migrated = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    const repository = createDeviceHealthRepository(migrated.db);
    expect(migrated.schemaVersion).toBe(LATEST_SQLITE_SCHEMA_VERSION);
    expect(repository.listByDevice('device-a')).toEqual([newer, older]);
    expect(repository.listByDevice('device-b')).toEqual([legacyCheck]);
    migrated.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite backfills backup schedule from its state snapshot during migration', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-backup-schedule-migration-'));
  const schedule = { enabled: true, cron: '15 4 * * *', retentionCount: 9 };

  try {
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    database.writeState({ version: 18, backupSchedule: schedule });
    database.db.exec('DELETE FROM schema_migrations WHERE version = 20; DROP TABLE backup_schedule;');
    database.close();

    const migrated = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    try {
      expect(migrated.schemaVersion).toBe(LATEST_SQLITE_SCHEMA_VERSION);
      expect(readStateCollection(migrated.db, 'backup_schedule')).toEqual([schedule]);
    } finally {
      migrated.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite backfills projects from its state snapshot during migration', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-project-migration-'));
  const project = {
    id: 'default',
    name: 'Default workspace',
    memberIds: [],
    isDefault: true,
    createdBy: 'system',
    createdAt: 100,
    updatedAt: 200,
  };

  try {
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    database.writeState({ version: 18, projects: [project] });
    database.db.exec('DELETE FROM projects; DELETE FROM schema_migrations WHERE version = 21;');
    database.close();

    const migrated = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    try {
      expect(migrated.schemaVersion).toBe(LATEST_SQLITE_SCHEMA_VERSION);
      expect(readStateCollection(migrated.db, 'projects')).toEqual([project]);
    } finally {
      migrated.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite normalizes a numeric project default flag written by older migration SQL', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-project-boolean-migration-'));
  try {
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    database.writeState({
      version: 20,
      projects: [{ id: 'default', name: 'dkrypt', memberIds: [], isDefault: true, createdBy: 'system', createdAt: 100, updatedAt: 100 }],
    });
    database.db.exec("UPDATE projects SET payload = json_set(payload, '$.isDefault', 1) WHERE id = 'default'; DELETE FROM schema_migrations WHERE version = 31;");
    database.close();

    const migrated = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    try {
      expect(migrated.schemaVersion).toBe(LATEST_SQLITE_SCHEMA_VERSION);
      expect(readStateCollection(migrated.db, 'projects')).toEqual([
        expect.objectContaining({ id: 'default', isDefault: true }),
      ]);
    } finally {
      migrated.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite collection updates commit together and roll back together on failure', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-transaction-'));
  const database = openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['jobs', 'job_timelines']);
  try {
    replaceStateCollections(database, [
      { table: 'jobs', rows: [{ id: 'job-1', payload: { id: 'job-1', status: 'queued' }, updatedAt: 10 }] },
      { table: 'job_timelines', rows: [{ id: 'job-1', payload: { jobId: 'job-1', events: [{ at: 10, label: 'queued' }] }, updatedAt: 10 }] },
    ]);

    expect(() => replaceStateCollections(database, [
      { table: 'jobs', rows: [{ id: 'job-1', payload: { id: 'job-1', status: 'done' }, updatedAt: 20 }] },
      { table: 'job_timelines', rows: [
        { id: 'duplicate', payload: { jobId: 'job-1', events: [] }, updatedAt: 20 },
        { id: 'duplicate', payload: { jobId: 'job-2', events: [] }, updatedAt: 20 },
      ] },
    ])).toThrow();

    expect(readStateCollection(database, 'jobs')).toEqual([{ id: 'job-1', status: 'queued' }]);
    expect(readStateCollection(database, 'job_timelines')).toEqual([{ jobId: 'job-1', events: [{ at: 10, label: 'queued' }] }]);

    replaceStateCollections(database, [
      { table: 'jobs', rows: [{ id: 'job-1', payload: { id: 'job-1', status: 'done' }, updatedAt: 30 }] },
      { table: 'job_timelines', rows: [{ id: 'job-1', payload: { jobId: 'job-1', events: [{ at: 30, label: 'done' }] }, updatedAt: 30 }] },
    ]);

    expect(readStateCollection(database, 'jobs')).toEqual([{ id: 'job-1', status: 'done' }]);
    expect(readStateCollection(database, 'job_timelines')).toEqual([{ jobId: 'job-1', events: [{ at: 30, label: 'done' }] }]);
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite rolls back schema changes when a migration fails partway through', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-interrupted-migration-'));
  const databasePath = path.join(stateDir, 'state.sqlite');
  const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
  let databaseOpen = true;

  try {
    rewindToSchemaVersion16(database);
    database.db.exec('ALTER TABLE billing_events ADD COLUMN provider TEXT;');
    database.close();
    databaseOpen = false;

    expect(() => openStateDatabase({ stateDir, filename: 'state.sqlite' })).toThrow(/duplicate column name: provider/i);

    const failedMigration = new Database(databasePath, { create: false, strict: true });
    try {
      expectVersion16AfterMigrationRollback(failedMigration);
    } finally {
      failedMigration.close();
    }
  } finally {
    if (databaseOpen) database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite rolls back an in-progress migration after abrupt process termination', async () => {
  if (process.platform === 'win32') return;

  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-killed-migration-'));
  try {
    const databasePath = path.join(stateDir, 'state.sqlite');
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    try {
      rewindToSchemaVersion16(database);
    } finally {
      database.close();
    }

    const sqliteModulePath = path.join(process.cwd(), 'src/store/sqlite.ts');
    const childSource = [
      "const { Database } = require('bun:sqlite')",
      'const originalExec = Database.prototype.exec',
      'Database.prototype.exec = function(sql, ...args) {',
      '  const result = originalExec.call(this, sql, ...args)',
      "  if (typeof sql === 'string' && sql.includes('CREATE TABLE IF NOT EXISTS billing_customers')) {",
      "    process.stdout.write('migration-uncommitted\\n')",
      '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000)',
      '  }',
      '  return result',
      '}',
      `require(${JSON.stringify(sqliteModulePath)}).openStateDatabase({ stateDir: ${JSON.stringify(stateDir)}, filename: 'state.sqlite' })`,
    ].join('\n');
    const child = spawn(process.execPath, ['-e', childSource], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });

    try {
      await killChildAtOutput(child, 'migration-uncommitted');

      const interruptedMigration = new Database(databasePath, { create: false, strict: true });
      try {
        expectVersion16AfterMigrationRollback(interruptedMigration);
      } finally {
        interruptedMigration.close();
      }
    } finally {
      await stopChild(child);
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite creates a verified pre-migration backup before upgrading an existing database', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-pre-migration-backup-'));
  const state = { version: 18, devices: [{ id: 'device-before-migration' }], settings: { maintenanceMode: false } };
  try {
    const original = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    try {
      original.writeState(state);
      rewindToSchemaVersion16(original);
    } finally {
      original.close();
    }

    const migrated = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    try {
      expect(migrated.schemaVersion).toBe(LATEST_SQLITE_SCHEMA_VERSION);
      const backupDirectory = path.join(stateDir, 'backups');
      const backupNames = (await readdir(backupDirectory)).filter((name) => name.startsWith('pre-migration-'));
      expect(backupNames).toHaveLength(1);

      const backup = new Database(path.join(backupDirectory, backupNames[0]), { create: false, strict: true });
      try {
        expect(backup.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 16 });
        expect(backup.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
        expect(JSON.parse((backup.query('SELECT payload FROM state_snapshots WHERE id = 1').get() as { payload: string }).payload)).toEqual(state);
      } finally {
        backup.close();
      }
    } finally {
      migrated.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite preserves the last committed state after abrupt process termination', async () => {
  if (process.platform === 'win32') return;

  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-killed-state-write-'));
  let child: ChildProcess | undefined;
  try {
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    const committedState = { version: 18, devices: [{ id: 'device-1' }], settings: { maintenanceMode: false } };
    try {
      database.writeState(committedState, undefined, [{
        table: 'jobs',
        rows: [{ id: 'job-1', payload: { id: 'job-1', status: 'queued' }, updatedAt: 10 }],
      }]);
    } finally {
      database.close();
    }

    const sqliteModulePath = path.join(process.cwd(), 'src/store/sqlite.ts');
    const childSource = [
      "const { Database } = require('bun:sqlite')",
      'const originalExec = Database.prototype.exec',
      'Database.prototype.exec = function(sql, ...args) {',
      "  if (typeof sql === 'string' && sql.trim() === 'COMMIT;') {",
      "    const snapshot = this.query('SELECT payload FROM state_snapshots WHERE id = 1').get()",
      "    if (snapshot?.payload.includes('state-crash-target')) {",
      "      process.stdout.write('state-uncommitted\\n')",
      '      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000)',
      '    }',
      '  }',
      '  return originalExec.call(this, sql, ...args)',
      '}',
      `const database = require(${JSON.stringify(sqliteModulePath)}).openStateDatabase({ stateDir: ${JSON.stringify(stateDir)}, filename: 'state.sqlite' })`,
      "database.writeState({ version: 18, devices: [{ id: 'device-1' }], settings: { maintenanceMode: true }, marker: 'state-crash-target' }, undefined, [{ table: 'jobs', rows: [{ id: 'job-1', payload: { id: 'job-1', status: 'done' }, updatedAt: 20 }] }])",
    ].join('\n');
    child = spawn(process.execPath, ['-e', childSource], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });

    await killChildAtOutput(child, 'state-uncommitted');

    const recovered = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    try {
      expect(recovered.readState()).toEqual(committedState);
      expect(recovered.readCollection('jobs')).toEqual([{ id: 'job-1', status: 'queued' }]);
      expect(recovered.integrityStatus()).toBe('ok');
    } finally {
      recovered.close();
    }
  } finally {
    if (child) await stopChild(child);
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite backup is atomic and can be reopened with its checksum intact', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-backup-'));
  try {
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    database.writeState({ version: 15, devices: [], settings: {} });
    const backupPath = path.join(stateDir, 'backups', 'state.sqlite');
    await mkdir(path.dirname(backupPath), { recursive: true });
    database.backupTo(backupPath);
    database.close();
    const backup = openStateDatabase({ stateDir: path.dirname(backupPath), filename: path.basename(backupPath) });
    expect(backup.integrityStatus()).toBe('ok');
    expect(backup.readState()).toEqual({ version: 15, devices: [], settings: {} });
    backup.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite backup verification accepts an older schema when its applied migration history is intact', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-older-backup-'));
  try {
    const databasePath = path.join(stateDir, 'state.sqlite');
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    database.writeState({ version: 29, settings: {} });
    database.db.exec('DROP TABLE appstore_offline_authentication_operations; DROP TABLE job_worker_leases; DROP TABLE job_worker_generations; DROP INDEX worker_instances_by_heartbeat; DROP TABLE worker_instances; DROP TABLE mcp_records; DROP TABLE decrypt_credit_records; DROP TABLE service_monitor_state; DELETE FROM schema_migrations WHERE version IN (29, 30, 31, 32, 33, 34);');
    database.close();

    expect(verifyDatabaseBackup(databasePath)).toEqual({ schemaVersion: 28, integrity: 'ok', hasStateSnapshot: true });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite rejects a tampered state snapshot instead of returning empty state', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-corrupt-'));
  try {
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    database.writeState({ version: 15, devices: [], settings: {} });
    database.db.query("UPDATE state_snapshots SET payload = '{\"version\":0}' WHERE id = 1").run();
    expect(() => database.readState()).toThrow('checksum mismatch');
    database.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite rejects a missing state snapshot after a committed state write', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-missing-snapshot-'));
  try {
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    try {
      database.writeState({ version: 18, devices: [{ id: 'device-1' }], settings: {} });
      database.db.exec('DELETE FROM state_snapshots WHERE id = 1;');
      expect(() => database.readState()).toThrow(/state snapshot is missing/i);
    } finally {
      database.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite backfills the state snapshot marker before protecting an upgraded database', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-snapshot-marker-upgrade-'));
  try {
    const original = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    original.writeState({ version: 18, devices: [{ id: 'device-1' }], settings: {} });
    original.db.query('DELETE FROM metadata WHERE key = ?').run('state_snapshot_initialized');
    original.close();

    const upgraded = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    try {
      upgraded.db.exec('DELETE FROM state_snapshots WHERE id = 1;');
      expect(() => upgraded.readState()).toThrow(/state snapshot is missing/i);
    } finally {
      upgraded.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite rejects an unmarked missing snapshot when application data remains', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-unmarked-missing-snapshot-'));
  try {
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    try {
      database.writeState({ version: 18, devices: [{ id: 'device-1' }], settings: {} });
      database.db.query('DELETE FROM metadata WHERE key = ?').run('state_snapshot_initialized');
      database.db.exec('DELETE FROM state_snapshots WHERE id = 1;');
      expect(database.readState({ legacyMirrorAvailable: true })).toBeUndefined();
      expect(() => database.readState()).toThrow(/state snapshot is missing/i);
    } finally {
      database.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite startup fails closed without replacing a corrupt database', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-startup-corrupt-'));
  const databasePath = path.join(stateDir, 'state.sqlite');
  const contents = 'not a SQLite database';
  try {
    await writeFile(databasePath, contents);
    expect(() => openStateDatabase({ stateDir, filename: 'state.sqlite' })).toThrow();
    expect(await readFile(databasePath, 'utf8')).toBe(contents);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite startup fails closed when an existing database has no schema', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-startup-empty-'));
  const databasePath = path.join(stateDir, 'state.sqlite');
  try {
    await writeFile(databasePath, '');
    expect(() => openStateDatabase({ stateDir, filename: 'state.sqlite' })).toThrow(/recognized schema/i);
    expect(await readFile(databasePath, 'utf8')).toBe('');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite startup preserves an existing database with an unrecognized schema', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-startup-unrecognized-'));
  const databasePath = path.join(stateDir, 'state.sqlite');
  try {
    const unrelatedDatabase = new Database(databasePath, { create: true, strict: true });
    unrelatedDatabase.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY);');
    unrelatedDatabase.exec(`PRAGMA application_id = ${initializationApplicationId};`);
    unrelatedDatabase.close();
    await writeFile(`${databasePath}.initializing`, initializationMarkerContents(databasePath, 'bound'), { mode: 0o600 });

    expect(() => openStateDatabase({ stateDir, filename: 'state.sqlite' })).toThrow(/recognized schema/i);

    const preservedDatabase = new Database(databasePath, { create: false, strict: true });
    try {
      expect(preservedDatabase.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: 'unrelated' }]);
    } finally {
      preservedDatabase.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite collection startup rejects a recovery marker beside an unrecognized database', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-collection-startup-unrecognized-'));
  const databasePath = path.join(stateDir, 'state.sqlite');
  try {
    const unrelatedDatabase = new Database(databasePath, { create: true, strict: true });
    unrelatedDatabase.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY);');
    unrelatedDatabase.exec(`PRAGMA application_id = ${initializationApplicationId};`);
    unrelatedDatabase.close();
    await writeFile(`${databasePath}.initializing`, initializationMarkerContents(databasePath, 'bound'), { mode: 0o600 });

    expect(() => openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['jobs'])).toThrow(/recognized schema/i);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite rejects a recovery marker when the migration ledger does not match the schema', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-initialization-schema-mismatch-'));
  const databasePath = path.join(stateDir, 'state.sqlite');
  try {
    const initialized = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    initialized.close();
    const incompleteDatabase = new Database(databasePath, { create: false, strict: true });
    incompleteDatabase.exec('DROP TABLE users;');
    incompleteDatabase.exec(`PRAGMA application_id = ${initializationApplicationId};`);
    incompleteDatabase.close();
    await writeFile(`${databasePath}.initializing`, initializationMarkerContents(databasePath, 'bound'), { mode: 0o600 });

    expect(() => openStateDatabase({ stateDir, filename: 'state.sqlite' })).toThrow(/recognized schema/i);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite rejects a recovery marker beside an unrecognized schema object without tables', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-initialization-view-'));
  const databasePath = path.join(stateDir, 'state.sqlite');
  try {
    const unrelatedDatabase = new Database(databasePath, { create: true, strict: true });
    unrelatedDatabase.exec('CREATE VIEW unrelated_view AS SELECT 1;');
    unrelatedDatabase.exec(`PRAGMA application_id = ${initializationApplicationId};`);
    unrelatedDatabase.close();
    await writeFile(`${databasePath}.initializing`, initializationMarkerContents(databasePath, 'bound'), { mode: 0o600 });

    expect(() => openStateDatabase({ stateDir, filename: 'state.sqlite' })).toThrow(/recognized schema/i);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite rejects a recovery marker bound to a different database path', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-initialization-marker-path-'));
  const databasePath = path.join(stateDir, 'state.sqlite');
  const otherDatabasePath = path.join(stateDir, 'other.sqlite');
  try {
    await writeFile(databasePath, '');
    await writeFile(`${databasePath}.initializing`, initializationMarkerContents(otherDatabasePath), { mode: 0o600 });

    expect(() => openStateDatabase({ stateDir, filename: 'state.sqlite' })).toThrow(/initialization marker is invalid/i);
    expect(await readFile(databasePath, 'utf8')).toBe('');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite rejects a recovery marker after the bound database file is replaced', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-initialization-marker-replaced-'));
  const databasePath = path.join(stateDir, 'state.sqlite');
  const replacementPath = path.join(stateDir, 'replacement.sqlite');
  try {
    const unrelatedDatabase = new Database(databasePath, { create: true, strict: true });
    unrelatedDatabase.exec(`PRAGMA application_id = ${initializationApplicationId};`);
    unrelatedDatabase.close();
    await writeFile(`${databasePath}.initializing`, initializationMarkerContents(databasePath, 'bound'), { mode: 0o600 });
    const replacementDatabase = new Database(replacementPath, { create: true, strict: true });
    replacementDatabase.exec(`PRAGMA application_id = ${initializationApplicationId};`);
    replacementDatabase.close();
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    await rm(`${replacementPath}-wal`, { force: true });
    await rm(`${replacementPath}-shm`, { force: true });
    await rm(databasePath);
    await rename(replacementPath, databasePath);

    expect(() => openStateDatabase({ stateDir, filename: 'state.sqlite' })).toThrow(/does not match the database/i);
    const replacedDatabase = new Database(databasePath, { create: false, strict: true });
    try {
      expect(replacedDatabase.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
    } finally {
      replacedDatabase.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite refuses to initialize an existing database without a snapshot or legacy mirror', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-startup-missing-state-'));
  try {
    const original = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    original.db.query('DELETE FROM metadata WHERE key IN (?, ?)').run('state_snapshot_initialized', 'state_snapshot_pending_initialization');
    original.close();

    const reopened = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    try {
      expect(() => reopened.readState()).toThrow(/state snapshot is missing/i);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite resumes fresh initialization after an interrupted database-file creation', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-initialization-resume-'));
  const databasePath = path.join(stateDir, 'state.sqlite');
  const markerPath = `${databasePath}.initializing`;
  try {
    await writeFile(markerPath, initializationMarkerContents(databasePath), { mode: 0o600 });
    await writeFile(databasePath, '');

    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    try {
      expect(database.schemaVersion).toBe(LATEST_SQLITE_SCHEMA_VERSION);
      expect(database.readState()).toBeUndefined();
    } finally {
      database.close();
    }

    expect(await readdir(stateDir)).not.toContain(path.basename(markerPath));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite collection startup resumes interrupted fresh initialization', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-collection-initialization-resume-'));
  const databasePath = path.join(stateDir, 'state.sqlite');
  const markerPath = `${databasePath}.initializing`;
  try {
    await writeFile(markerPath, initializationMarkerContents(databasePath), { mode: 0o600 });
    await writeFile(databasePath, '');

    const database = openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['jobs']);
    try {
      expect(database.query('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'jobs')).toEqual({ name: 'jobs' });
      expect(database.query('SELECT value FROM metadata WHERE key = ?').get('state_snapshot_pending_initialization')).toEqual({ value: '1' });
    } finally {
      database.close();
    }

    expect(await readdir(stateDir)).not.toContain(path.basename(markerPath));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite resumes fresh initialization after migrations commit before the first snapshot', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-post-migration-initialization-resume-'));
  const databasePath = path.join(stateDir, 'state.sqlite');
  const markerPath = `${databasePath}.initializing`;
  try {
    const initialized = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    expect(initialized.readState()).toBeUndefined();
    initialized.db.exec(`PRAGMA application_id = ${initializationApplicationId};`);
    initialized.close();
    await writeFile(markerPath, initializationMarkerContents(databasePath, 'bound'), { mode: 0o600 });

    const resumed = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    try {
      expect(resumed.schemaVersion).toBe(LATEST_SQLITE_SCHEMA_VERSION);
      expect(resumed.readState()).toBeUndefined();
    } finally {
      resumed.close();
    }

    expect(await readdir(stateDir)).not.toContain(path.basename(markerPath));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
