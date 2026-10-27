import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStateDatabase, readStateCollection } from '#store/sqlite.js';
import { PermissionFlag } from '#permissions.js';

async function runStateModule(stateDir: string, script = "await import('./src/store/state.ts')"): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    [process.execPath, '-e', script],
    {
      cwd: process.cwd(),
      env: {
        API_KEY: 'state-migration-api-key',
        SESSION_SIGNING_SECRET: 'state-migration-session-secret',
        ADMIN_PASSWORD: 'state-migration-admin-password',
        STATE_DIR: stateDir,
        STATE_DATABASE_FILE: 'state.sqlite',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe('state migrations', () => {
  test('removes inherited log access from the default member role in existing state', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-default-role-permissions-'));
    try {
      const initialLoad = await runStateModule(stateDir);
      expect(initialLoad.exitCode).toBe(0);

      const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
      try {
        const state = database.readState() as Record<string, unknown>;
        const roles = state.roles as Array<Record<string, unknown>>;
        const defaultRole = roles.find((role) => role.isDefault)!;
        expect(defaultRole.permissions).toBe('0');
        const defaultRoleId = defaultRole.id as string;
        const legacyRole = { ...defaultRole, permissions: PermissionFlag.viewLogs.toString() };
        state.roles = roles.map((role) => role.id === defaultRoleId ? legacyRole : role);
        const payload = JSON.stringify(state);
        database.db.query('UPDATE state_snapshots SET payload = ?, sha256 = ?, updated_at = ? WHERE id = 1;')
          .run(payload, createHash('sha256').update(payload).digest('hex'), Date.now());
        database.db.query('UPDATE roles SET payload = ?, updated_at = ? WHERE id = ?;')
          .run(JSON.stringify(legacyRole), Date.now(), defaultRoleId);
      } finally {
        database.close();
      }

      const reload = await runStateModule(stateDir);
      expect(reload.exitCode).toBe(0);
      const normalizedDatabase = openStateDatabase({ stateDir, filename: 'state.sqlite' });
      try {
        const normalizedState = normalizedDatabase.readState() as { roles: Array<{ id: string; permissions: string; isDefault: boolean }> };
        const defaultRole = normalizedState.roles.find((role) => role.isDefault)!;
        expect(defaultRole.permissions).toBe('0');
        expect(readStateCollection(normalizedDatabase.db, 'roles')).toContainEqual(expect.objectContaining({ id: defaultRole.id, permissions: '0' }));
      } finally {
        normalizedDatabase.close();
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('persists normalized scheduler history before validating its SQLite repository', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-scheduler-normalization-'));
    try {
      const initialLoad = await runStateModule(stateDir);
      expect(initialLoad.exitCode).toBe(0);

      const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
      const entry = {
        id: 'scheduler-run-legacy-shape',
        ts: 100,
        watchId: 'watch-a',
        bundleId: 'com.example.app',
        appStore: { reason: 'dispatched' },
        testflight: { reason: 'no eligible build' },
      };
      const timeline = { jobId: 'job-history-owned', events: [{ at: 100, label: 'queued' }] };

      try {
        const state = database.readState() as Record<string, unknown>;
        state.schedulerRunHistory = [entry];
        const payload = JSON.stringify(state);
        database.db.query('UPDATE state_snapshots SET payload = ?, sha256 = ?, updated_at = ? WHERE id = 1;')
          .run(payload, createHash('sha256').update(payload).digest('hex'), Date.now());
        database.db.query('DELETE FROM scheduler_runs;').run();
        database.db.query('INSERT INTO scheduler_runs (id, payload, updated_at) VALUES (?, ?, ?);')
          .run(entry.id, JSON.stringify(entry), entry.ts);
        database.db.query('INSERT INTO job_timelines (id, payload, updated_at) VALUES (?, ?, ?);')
          .run(timeline.jobId, JSON.stringify(timeline), entry.ts);
      } finally {
        database.close();
      }

      const reload = await runStateModule(stateDir);
      expect(reload.exitCode).toBe(0);
      const normalizedDatabase = openStateDatabase({ stateDir, filename: 'state.sqlite' });
      try {
        expect(normalizedDatabase.readState()).toMatchObject({
          schedulerRunHistory: [{
            id: entry.id,
            watchId: entry.watchId,
            bundleId: entry.bundleId,
            appStore: { ok: true, triggered: false, reason: 'dispatched' },
            testflight: { ok: true, triggered: false, reason: 'no eligible build' },
          }],
        });
        expect(readStateCollection(normalizedDatabase.db, 'scheduler_runs')).toMatchObject([{
          id: entry.id,
          watchId: entry.watchId,
          bundleId: entry.bundleId,
          appStore: { ok: true, triggered: false, reason: 'dispatched' },
          testflight: { ok: true, triggered: false, reason: 'no eligible build' },
        }]);
        expect(readStateCollection(normalizedDatabase.db, 'job_timelines')).toEqual([timeline]);
      } finally {
        normalizedDatabase.close();
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('removes v13 share records and obsolete permission bits', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-state-migration-'));
    const obsoletePermissions = (1n << 10n).toString();
    await writeFile(
      path.join(stateDir, 'state.json'),
      JSON.stringify({
        version: 13,
        backupHistory: [{ id: 'legacy-backup', createdAt: 5, sizeBytes: 10, filename: 'backup.json', trigger: 'manual' }],
        roles: [{ id: 'legacy', name: 'Legacy', color: '#000000', permissions: obsoletePermissions, position: 0, isDefault: false, createdAt: 0, updatedAt: 0 }],
        shareLinks: [{ id: 'old-link', jobId: 'old-job' }],
        jobHistory: [{ id: 'legacy-job', bundleId: 'com.example.legacy', status: 'done', source: 'manual', createdAt: 1, finishedAt: 2 }],
      }),
    );

    const child = Bun.spawn(
      [process.execPath, '-e', "await import('./src/store/state.ts')"],
      {
        cwd: process.cwd(),
        env: {
          API_KEY: 'state-migration-api-key',
          SESSION_SIGNING_SECRET: 'state-migration-session-secret',
          ADMIN_PASSWORD: 'state-migration-admin-password',
          STATE_DIR: stateDir,
          STATE_DATABASE_FILE: 'state.sqlite',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (exitCode !== 0) throw new Error(`state migration failed: ${stderr}`);

    const migrated = JSON.parse(await readFile(path.join(stateDir, 'state.json'), 'utf8')) as {
      version: number;
      roles: Array<{ id: string; permissions: string; isDefault: boolean }>;
      projects: Array<{ id: string; isDefault: boolean }>;
      jobHistory: Array<{ id: string; projectId?: string }>;
      backupHistory: Array<{ id: string; restoreDrillStatus: string }>;
      shareLinks?: unknown;
    };
    expect(migrated.version).toBe(18);
    expect(migrated.roles[0]?.permissions).toBe('0');
    expect(migrated.roles).toEqual([expect.objectContaining({ id: 'legacy', isDefault: false, permissions: '0' })]);
    expect(migrated.projects).toContainEqual(expect.objectContaining({ id: 'default', isDefault: true }));
    expect(migrated.jobHistory).toContainEqual(expect.objectContaining({ id: 'legacy-job', projectId: 'default' }));
    expect(migrated.backupHistory).toContainEqual(expect.objectContaining({ id: 'legacy-backup', restoreDrillStatus: 'not_run' }));
    expect(migrated.shareLinks).toBeUndefined();

    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    try {
      expect(readStateCollection(database.db, 'projects')).toContainEqual(expect.objectContaining({ id: 'default', isDefault: true }));
    } finally {
      database.close();
    }
  });

  test('a partial backup index fails closed without deleting valid snapshot files', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-backup-index-migration-'));
    const backupDir = path.join(stateDir, 'backups');
    const snapshots = [
      { id: 'backup-a', directory: 'snapshot-00000000-0000-4000-8000-000000000001', contents: 'snapshot-a' },
      { id: 'backup-b', directory: 'snapshot-00000000-0000-4000-8000-000000000002', contents: 'snapshot-b' },
    ];
    const state = {
      version: 13,
      backupHistory: snapshots.map((snapshot, index) => ({
        id: snapshot.id,
        createdAt: index + 1,
        sizeBytes: 10,
        filename: `${snapshot.directory}/backup.json`,
        trigger: 'manual',
      })),
      roles: [{ id: 'legacy', name: 'Legacy', color: '#000000', permissions: '0', position: 0, isDefault: false, createdAt: 0, updatedAt: 0 }],
    };
    await mkdir(backupDir, { recursive: true });
    await writeFile(path.join(stateDir, 'state.json'), JSON.stringify(state));
    for (const snapshot of snapshots) {
      const directory = path.join(backupDir, snapshot.directory);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'backup.json'), snapshot.contents);
    }

    try {
      const initialLoad = Bun.spawn(
        [process.execPath, '-e', "await import('./src/store/state.ts')"],
        {
          cwd: process.cwd(),
          env: {
            API_KEY: 'backup-index-api-key',
            SESSION_SIGNING_SECRET: 'backup-index-session-secret',
            ADMIN_PASSWORD: 'backup-index-admin-password',
            STATE_DIR: stateDir,
            STATE_DATABASE_FILE: 'state.sqlite',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [initialError, initialExitCode] = await Promise.all([new Response(initialLoad.stderr).text(), initialLoad.exited]);
      expect(initialExitCode).toBe(0);
      expect(initialError).toBe('');

      const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
      try {
        database.db.query('DELETE FROM backups WHERE id = ?;').run('backup-b');
      } finally {
        database.close();
      }

      const reload = Bun.spawn(
        [process.execPath, '-e', "await import('./src/store/state.ts')"],
        {
          cwd: process.cwd(),
          env: {
            API_KEY: 'backup-index-api-key',
            SESSION_SIGNING_SECRET: 'backup-index-session-secret',
            ADMIN_PASSWORD: 'backup-index-admin-password',
            STATE_DIR: stateDir,
            STATE_DATABASE_FILE: 'state.sqlite',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [reloadError, reloadExitCode] = await Promise.all([new Response(reload.stderr).text(), reload.exited]);

      expect(reloadExitCode).not.toBe(0);
      expect(reloadError).toContain('persistent backup repository does not match state snapshot');
      for (const snapshot of snapshots) {
        expect(await readFile(path.join(backupDir, snapshot.directory, 'backup.json'), 'utf8')).toBe(snapshot.contents);
      }

      const emptyDatabase = openStateDatabase({ stateDir, filename: 'state.sqlite' });
      try {
        emptyDatabase.db.query('DELETE FROM backups;').run();
      } finally {
        emptyDatabase.close();
      }

      const emptyReload = Bun.spawn(
        [process.execPath, '-e', "await import('./src/store/state.ts')"],
        {
          cwd: process.cwd(),
          env: {
            API_KEY: 'backup-index-api-key',
            SESSION_SIGNING_SECRET: 'backup-index-session-secret',
            ADMIN_PASSWORD: 'backup-index-admin-password',
            STATE_DIR: stateDir,
            STATE_DATABASE_FILE: 'state.sqlite',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [emptyReloadError, emptyReloadExitCode] = await Promise.all([new Response(emptyReload.stderr).text(), emptyReload.exited]);

      expect(emptyReloadExitCode).not.toBe(0);
      expect(emptyReloadError).toContain('persistent backup repository does not match state snapshot');
      for (const snapshot of snapshots) {
        expect(await readFile(path.join(backupDir, snapshot.directory, 'backup.json'), 'utf8')).toBe(snapshot.contents);
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('a missing backup schedule row fails closed after repository migration', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-backup-schedule-index-migration-'));
    const statePath = path.join(stateDir, 'state.json');
    await writeFile(statePath, JSON.stringify({
      version: 13,
      backupSchedule: { enabled: true, cron: '15 4 * * *', retentionCount: 9 },
      roles: [{ id: 'legacy', name: 'Legacy', color: '#000000', permissions: '0', position: 0, isDefault: false, createdAt: 0, updatedAt: 0 }],
    }));

    try {
      const initialLoad = Bun.spawn(
        [process.execPath, '-e', "await import('./src/store/state.ts')"],
        {
          cwd: process.cwd(),
          env: {
            API_KEY: 'backup-schedule-api-key',
            SESSION_SIGNING_SECRET: 'backup-schedule-session-secret',
            ADMIN_PASSWORD: 'backup-schedule-admin-password',
            STATE_DIR: stateDir,
            STATE_DATABASE_FILE: 'state.sqlite',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [initialError, initialExitCode] = await Promise.all([new Response(initialLoad.stderr).text(), initialLoad.exited]);
      expect(initialExitCode).toBe(0);
      expect(initialError).toBe('');

      const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
      try {
        database.db.query('DELETE FROM backup_schedule WHERE id = ?;').run('active');
      } finally {
        database.close();
      }

      const reload = Bun.spawn(
        [process.execPath, '-e', "await import('./src/store/state.ts')"],
        {
          cwd: process.cwd(),
          env: {
            API_KEY: 'backup-schedule-api-key',
            SESSION_SIGNING_SECRET: 'backup-schedule-session-secret',
            ADMIN_PASSWORD: 'backup-schedule-admin-password',
            STATE_DIR: stateDir,
            STATE_DATABASE_FILE: 'state.sqlite',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [reloadError, reloadExitCode] = await Promise.all([new Response(reload.stderr).text(), reload.exited]);

      expect(reloadExitCode).not.toBe(0);
      expect(reloadError).toContain('persistent backup schedule repository does not match state snapshot');
      const migrated = JSON.parse(await readFile(statePath, 'utf8')) as { backupSchedule: { enabled: boolean; cron: string; retentionCount: number } };
      expect(migrated.backupSchedule).toEqual({ enabled: true, cron: '15 4 * * *', retentionCount: 9 });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('an empty settings index fails closed without rebuilding from the snapshot', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-settings-index-migration-'));
    const statePath = path.join(stateDir, 'state.json');
    await writeFile(statePath, JSON.stringify({
      version: 13,
      settings: { maintenanceMode: true },
      roles: [{ id: 'legacy', name: 'Legacy', color: '#000000', permissions: '0', position: 0, isDefault: false, createdAt: 0, updatedAt: 0 }],
    }));

    try {
      const initialLoad = await runStateModule(stateDir);
      expect(initialLoad.exitCode).toBe(0);
      expect(initialLoad.stderr).toBe('');

      const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
      try {
        const stateRow = database.db.query('SELECT payload FROM state_snapshots WHERE id = 1;').get() as { payload: string };
        const legacySnapshot = { ...JSON.parse(stateRow.payload), version: 17 };
        const payload = JSON.stringify(legacySnapshot);
        database.db.query('UPDATE state_snapshots SET state_version = 17, payload = ?, sha256 = ? WHERE id = 1;').run(
          payload,
          createHash('sha256').update(payload).digest('hex'),
        );
        database.db.exec('DELETE FROM settings;');
      } finally {
        database.close();
      }

      const reload = await runStateModule(stateDir);
      expect(reload.exitCode).not.toBe(0);
      expect(reload.stderr).toContain('persistent settings repository does not match state snapshot');
      const migrated = JSON.parse(await readFile(statePath, 'utf8')) as { settings: { maintenanceMode: boolean } };
      expect(migrated.settings.maintenanceMode).toBe(true);
      const intactDatabase = openStateDatabase({ stateDir, filename: 'state.sqlite' });
      try {
        const stateRow = intactDatabase.db.query('SELECT payload FROM state_snapshots WHERE id = 1;').get() as { payload: string };
        expect(JSON.parse(stateRow.payload).version).toBe(17);
        expect(readStateCollection(intactDatabase.db, 'settings')).toEqual([]);
      } finally {
        intactDatabase.close();
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('a normalized startup cannot recreate a missing device activity index', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-device-activity-index-migration-'));
    const activity = { id: 'activity-1', ts: 10, deviceId: 'device-1', kind: 'health', message: 'Device reachable' };

    try {
      const initialLoad = await runStateModule(stateDir);
      expect(initialLoad.exitCode).toBe(0);
      expect(initialLoad.stderr).toBe('');

      const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
      try {
        const stateRow = database.db.query('SELECT payload FROM state_snapshots WHERE id = 1;').get() as { payload: string };
        const state = JSON.parse(stateRow.payload) as { deviceActivity: unknown[]; version: number };
        state.deviceActivity = [activity];
        state.version = 17;
        database.writeState(state);
        database.db.exec('DELETE FROM device_history;');
      } finally {
        database.close();
      }

      const reload = await runStateModule(stateDir);
      expect(reload.exitCode).not.toBe(0);
      expect(reload.stderr).toContain('persistent device_history index does not match state snapshot');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('session last-seen updates survive snapshot normalization', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-session-last-seen-migration-'));
    const session = { id: 'session-1', sub: 'root', createdAt: 1, lastSeenAt: 2, ip: '192.0.2.1' };

    try {
      const initialLoad = await runStateModule(stateDir);
      expect(initialLoad.exitCode).toBe(0);
      expect(initialLoad.stderr).toBe('');

      const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
      try {
        const stateRow = database.db.query('SELECT payload FROM state_snapshots WHERE id = 1;').get() as { payload: string };
        const state = JSON.parse(stateRow.payload) as { activeSessions: unknown[]; version: number };
        state.activeSessions = [session];
        state.version = 17;
        database.writeState(state);
        database.db.query("UPDATE sessions SET payload = json_set(payload, '$.lastSeenAt', 42), updated_at = 42, last_seen_at = 42 WHERE id = ?;").run(session.id);
      } finally {
        database.close();
      }

      const reload = await runStateModule(
        stateDir,
        "const state = await import('./src/store/state.ts'); process.stdout.write('SESSIONS:' + JSON.stringify(state.listSessionsForUser('root')))",
      );
      expect(reload.exitCode).toBe(0);
      expect(reload.stderr).toBe('');
      expect(reload.stdout).toContain('"lastSeenAt":42');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('an API key index with records absent from the snapshot fails closed', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-api-key-index-migration-'));

    try {
      const initialLoad = await runStateModule(stateDir);
      expect(initialLoad.exitCode).toBe(0);
      expect(initialLoad.stderr).toBe('');

      const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
      try {
        database.db.query('INSERT INTO api_keys (id, payload, updated_at) VALUES (?, ?, ?);').run(
          'unindexed-api-key',
          JSON.stringify({ id: 'unindexed-api-key', name: 'Unindexed', ownerId: 'root', status: 'approved', createdAt: 1 }),
          1,
        );
      } finally {
        database.close();
      }

      const reload = await runStateModule(stateDir);
      expect(reload.exitCode).not.toBe(0);
      expect(reload.stderr).toContain('persistent API key repository does not match state snapshot');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('duplicate API key snapshot ids cannot hide a different indexed key', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-api-key-duplicate-index-migration-'));
    const firstKey = { id: 'first-key', name: 'First', ownerId: 'root', status: 'approved', hash: 'first-hash', createdAt: 1 };
    const secondKey = { id: 'second-key', name: 'Second', ownerId: 'root', status: 'approved', hash: 'second-hash', createdAt: 2 };

    try {
      const initialLoad = await runStateModule(stateDir);
      expect(initialLoad.exitCode).toBe(0);
      expect(initialLoad.stderr).toBe('');

      const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
      try {
        const stateRow = database.db.query('SELECT payload FROM state_snapshots WHERE id = 1;').get() as { payload: string };
        const state = JSON.parse(stateRow.payload) as { apiKeys: unknown[]; version: number };
        state.apiKeys = [firstKey, secondKey];
        database.writeState(state);
        state.apiKeys = [firstKey, firstKey];
        state.version = 17;
        const payload = JSON.stringify(state);
        database.db.query('UPDATE state_snapshots SET state_version = 17, payload = ?, sha256 = ? WHERE id = 1;').run(
          payload,
          createHash('sha256').update(payload).digest('hex'),
        );
      } finally {
        database.close();
      }

      const reload = await runStateModule(stateDir);
      expect(reload.exitCode).not.toBe(0);
      expect(reload.stderr).toContain('persistent API key repository does not match state snapshot');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('API key security fields must match the snapshot', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-api-key-record-migration-'));
    const apiKey = {
      id: 'persistent-api-key',
      name: 'Persistent key',
      ownerId: 'root',
      status: 'approved',
      hash: 'original-hash',
      createdAt: 1,
    };

    try {
      const initialLoad = await runStateModule(stateDir);
      expect(initialLoad.exitCode).toBe(0);
      expect(initialLoad.stderr).toBe('');

      const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
      try {
        const stateRow = database.db.query('SELECT payload FROM state_snapshots WHERE id = 1;').get() as { payload: string };
        const state = JSON.parse(stateRow.payload) as { apiKeys: unknown[]; version: number };
        state.apiKeys = [apiKey];
        state.version = 17;
        database.writeState(state);
        database.db.query("UPDATE api_keys SET payload = json_set(payload, '$.hash', 'changed-hash', '$.lastUsedAt', 2) WHERE id = ?;").run(apiKey.id);
      } finally {
        database.close();
      }

      const reload = await runStateModule(stateDir);
      expect(reload.exitCode).not.toBe(0);
      expect(reload.stderr).toContain('persistent API key repository does not match state snapshot');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('API key usage metadata is reconciled from its persistent index', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-api-key-usage-migration-'));
    const apiKey = {
      id: 'persistent-api-key',
      name: 'Persistent key',
      ownerId: 'root',
      status: 'approved',
      hash: 'original-hash',
      createdAt: 1,
    };

    try {
      const initialLoad = await runStateModule(stateDir);
      expect(initialLoad.exitCode).toBe(0);
      expect(initialLoad.stderr).toBe('');

      const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
      try {
        const stateRow = database.db.query('SELECT payload FROM state_snapshots WHERE id = 1;').get() as { payload: string };
        const state = JSON.parse(stateRow.payload) as { apiKeys: unknown[]; version: number };
        state.apiKeys = [apiKey];
        state.version = 17;
        database.writeState(state);
        database.db.query("UPDATE api_keys SET payload = json_set(payload, '$.lastUsedAt', 42, '$.lastUsedIp', '192.0.2.1') WHERE id = ?;").run(apiKey.id);
      } finally {
        database.close();
      }

      const reload = await runStateModule(
        stateDir,
        "const state = await import('./src/store/state.ts'); process.stdout.write('API_KEY_STATE:' + JSON.stringify(state.getApiKeyById('persistent-api-key')))",
      );
      expect(reload.stderr).toBe('');
      expect(reload.exitCode).toBe(0);
      expect(reload.stdout).toContain('API_KEY_STATE:');
      expect(reload.stdout).toContain('"lastUsedAt":42');
      expect(reload.stdout).toContain('"lastUsedIp":"192.0.2.1"');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('preserves valid v6 accounts that use the viewer permission default', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-state-v6-account-'));
    const statePath = path.join(stateDir, 'state.json');
    await writeFile(statePath, JSON.stringify({ version: 6, allowedUsers: [{ username: 'legacy-viewer', addedAt: 1 }] }));

    try {
      const child = Bun.spawn(
        [process.execPath, '-e', "await import('./src/store/state.ts')"],
        {
          cwd: process.cwd(),
          env: {
            API_KEY: 'state-v6-account-api-key',
            SESSION_SIGNING_SECRET: 'state-v6-account-session-secret',
            ADMIN_PASSWORD: 'state-v6-account-admin-password',
            STATE_DIR: stateDir,
            STATE_DATABASE_FILE: 'state.sqlite',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      if (exitCode !== 0) throw new Error(`valid v6 account migration failed: ${stderr}`);

      const migrated = JSON.parse(await readFile(statePath, 'utf8')) as { allowedUsers: Array<{ username: string; roleIds: string[]; addedAt: number }> };
      expect(migrated.allowedUsers).toEqual([{ username: 'legacy-viewer', roleIds: [], addedAt: 1 }]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('fails closed on malformed account and role collections without rewriting the legacy state file', async () => {
    const invalidRole = { id: 'legacy-role', name: 'Legacy', color: '#000000', permissions: 'not-a-bitfield', position: 0, isDefault: false, createdAt: 1, updatedAt: 1 };
    const malformedStates = [
      { version: 1, allowedUsers: 'lost-users' },
      { version: 1, allowedUsers: [{ username: 'lost-user' }] },
      { version: 1, roles: 'lost-roles' },
      { version: 2, allowedUsers: 'lost-users' },
      { version: 3, allowedUsers: 'lost-users' },
      { version: 4, allowedUsers: 'lost-users' },
      { version: 5, allowedUsers: 'lost-users' },
      { version: 6, allowedUsers: 'lost-users' },
      { version: 6, allowedUsers: [{ username: 'escalated-user', addedAt: 1, permissions: [] }] },
      { version: 6, allowedUsers: [{ username: 'escalated-user', addedAt: 1, permissions: {} }] },
      { version: 7, roles: 'lost-roles' },
      { version: 8, roles: 'lost-roles' },
      { version: 9, roles: 'lost-roles' },
      { version: 7, roles: [invalidRole] },
      { version: 8, roles: [invalidRole] },
      { version: 9, roles: [invalidRole] },
      { version: 13, roles: [invalidRole] },
      { version: 13, roles: [{ ...invalidRole, permissions: (1n << 50n).toString() }] },
      { version: 18, allowedUsers: { username: 'lost-user' }, roles: [] },
      { version: 18, allowedUsers: [], roles: 'lost-role' },
    ];

    for (const [index, malformedState] of malformedStates.entries()) {
      const stateDir = await mkdtemp(path.join(tmpdir(), `dkrypt-state-malformed-accounts-${index}-`));
      const source = JSON.stringify(malformedState);
      const statePath = path.join(stateDir, 'state.json');
      await writeFile(statePath, source);

      try {
        const child = Bun.spawn(
          [process.execPath, '-e', "await import('./src/store/state.ts')"],
          {
            cwd: process.cwd(),
            env: {
              API_KEY: 'state-malformed-api-key',
              SESSION_SIGNING_SECRET: 'state-malformed-session-secret',
              ADMIN_PASSWORD: 'state-malformed-admin-password',
              STATE_DIR: stateDir,
              STATE_DATABASE_FILE: 'state.sqlite',
            },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);

        expect(exitCode).not.toBe(0);
        expect(stderr).toMatch(/persistent (account|role|account or role) data (is malformed|has no supported migration)/);
        expect(await readFile(statePath, 'utf8')).toBe(source);
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    }
  }, 30_000);
});
