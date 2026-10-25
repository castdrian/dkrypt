import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createJobRepository } from '#jobs/repository.js';
import type { Job } from '#jobs/types.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';

function createJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    projectId: 'workspace-a',
    bundleId: 'com.example.app',
    source: 'manual',
    priority: 0,
    status: 'queued',
    progress: 'queued',
    createdAt: 100,
    timeline: [{ at: 100, label: 'Queued', status: 'queued' }],
    waiters: [],
    ...overrides,
  };
}

test('job repository indexes existing JSON jobs after SQLite migration', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-job-repository-migration-'));
  const databasePath = path.join(stateDir, 'state.sqlite');
  const legacyDatabase = new Database(databasePath, { create: true, strict: true });
  legacyDatabase.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);');
  legacyDatabase.query('INSERT INTO jobs (id, payload, updated_at) VALUES (?, ?, ?)').run('legacy-job', JSON.stringify({
    id: 'legacy-job',
    projectId: 'workspace-legacy',
    bundleId: 'com.example.legacy',
    source: 'manual',
    priority: 3,
    status: 'queued',
    progress: 'queued',
    createdAt: 50,
    externalVersionId: 'legacy-build',
    testflight: { appId: 42, build: { id: 501 } },
  }), 50);
  legacyDatabase.close();

  let repository: ReturnType<typeof createJobRepository> | undefined;
  try {
    const database = openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['jobs', 'job_timelines']);
    repository = createJobRepository(database);

    expect(repository.findActiveId({
      projectId: 'default',
      bundleId: 'com.example.legacy',
      externalVersionId: 'legacy-build',
      testFlightBuildId: 501,
    })).toBe('legacy-job');
    expect(repository.findActiveId({
      projectId: 'other-scope',
      bundleId: 'com.example.legacy',
      externalVersionId: 'legacy-build',
      testFlightBuildId: 501,
    })).toBeUndefined();
    expect(repository.load()).toMatchObject([{ id: 'legacy-job', projectId: 'default', status: 'queued' }]);
  } finally {
    repository?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('job repository persists exact-build lookups and timelines across restart', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-job-repository-restart-'));
  const options = { stateDir, filename: 'state.sqlite' };
  let repository: ReturnType<typeof createJobRepository> | undefined;

  try {
    repository = createJobRepository(openStateCollectionDatabase(options, ['jobs', 'job_timelines']));
    const traceContext = {
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      traceFlags: 1,
      traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    };
    const completed = createJob({
      id: 'completed-build',
      correlationId: 'job-correlation-7',
      parentCorrelationId: 'http-request-7',
      traceContext,
      status: 'done',
      externalVersionId: 'build-7',
      filePath: '/artifacts/build-7.ipa',
      finishedAt: 200,
      timeline: [
        { at: 100, label: 'Queued', status: 'queued' },
        { at: 200, label: 'Finished', status: 'done' },
      ],
    });
    const otherProject = createJob({
      id: 'other-project-build',
      projectId: 'workspace-b',
      status: 'done',
      externalVersionId: 'build-7',
      filePath: '/artifacts/build-7-other.ipa',
      finishedAt: 210,
    });
    repository.replace([completed, otherProject]);

    expect(repository.findReusableCompletedIds({
      projectId: 'workspace-a',
      bundleId: 'com.example.app',
      externalVersionId: 'build-7',
    })).toEqual(['completed-build']);
    repository.close();
    repository = undefined;

    repository = createJobRepository(openStateCollectionDatabase(options, ['jobs', 'job_timelines']));
    expect(repository.load()).toContainEqual(expect.objectContaining({
      id: 'completed-build',
      status: 'done',
      correlationId: 'job-correlation-7',
      parentCorrelationId: 'http-request-7',
      traceContext,
      externalVersionId: 'build-7',
      timeline: completed.timeline,
    }));
    expect(repository.findReusableCompletedIds({
      projectId: 'workspace-b',
      bundleId: 'com.example.app',
      externalVersionId: 'build-7',
    })).toEqual(['other-project-build']);
  } finally {
    repository?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
