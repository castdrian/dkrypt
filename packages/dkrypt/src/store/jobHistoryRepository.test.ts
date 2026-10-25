import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createJobHistoryRepository } from '#store/jobHistoryRepository.js';
import type { JobHistoryEntry } from '#store/state.js';
import { LATEST_SQLITE_SCHEMA_VERSION, openStateDatabase } from '#store/sqlite.js';

function historyEntry(overrides: Partial<JobHistoryEntry> = {}): JobHistoryEntry {
  return {
    id: 'history-1',
    projectId: 'project-a',
    bundleId: 'com.example.app',
    status: 'done',
    source: 'manual',
    queuedBy: 'member@example.com',
    createdAt: 100,
    finishedAt: 200,
    ...overrides,
  };
}

test('job history repository presents one shared history and orders it newest first', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-job-history-repository-'));
  const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
  const repository = createJobHistoryRepository(database.db);
  const older = historyEntry({ id: 'history-older', finishedAt: 100 });
  const newer = historyEntry({ id: 'history-newer', finishedAt: 200 });
  const failed = historyEntry({ id: 'history-failed', status: 'failed', error: 'App Store timed out', deviceId: 'device-a', finishedAt: 300 });
  const other = historyEntry({ id: 'history-other', projectId: 'project-b', queuedBy: 'other@example.com', finishedAt: 400 });
  const wildcard = historyEntry({ id: 'history-wildcard', bundleId: 'com.example.percent_%', finishedAt: 500 });

  try {
    database.writeState({ version: 18, jobHistory: [older, newer, failed, other, wildcard] });

    expect(repository.list({ projectId: 'project-a', status: 'done' })).toEqual([wildcard, other, newer, older]);
    expect(repository.list({ bundleIdSearch: 'PERCENT_%' })).toEqual([wildcard]);
    expect(repository.list({ errorSearch: 'APP STORE', deviceId: 'device-a' })).toEqual([failed]);
    expect(repository.listForUser('MEMBER@example.com')).toEqual([wildcard, failed, newer, older]);
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('job history migration backfills existing snapshot records', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-job-history-migration-'));
  const options = { stateDir, filename: 'state.sqlite' };
  const existing = openStateDatabase(options);
  const entry = historyEntry({ id: 'legacy-history', projectId: 'default', finishedAt: 300 });

  try {
    existing.writeState({ version: 18, jobHistory: [entry] });
    existing.db.exec(`
      DROP INDEX job_history_by_project_time;
      DROP INDEX job_history_by_user_time;
      DROP INDEX job_history_by_device_time;
      DELETE FROM schema_migrations WHERE version = 15;
      DROP TABLE job_history;
    `);
    existing.close();

    const migrated = openStateDatabase(options);
    try {
      expect(migrated.schemaVersion).toBe(LATEST_SQLITE_SCHEMA_VERSION);
      expect(createJobHistoryRepository(migrated.db).list()).toEqual([entry]);
    } finally {
      migrated.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
