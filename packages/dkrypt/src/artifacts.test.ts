import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '#config.js';
import { withCorrelation } from '#correlation.js';
import { exportBackup, importBackup } from '#store/state.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';
import { flushTelemetry, startSpan } from '#telemetry.js';
import {
  artifactFileAvailable,
  getArtifactById,
  getArtifactStorageStats,
  listArtifacts,
  previewArtifactQuotaRetention,
  promoteArtifact,
  reloadArtifactIndex,
  reconcileArtifactStore,
  setArtifactPinned,
  setArtifactsPinned,
  setArtifactArchived,
  setArtifactsArchived,
  undoArtifactStateChanges,
  touchArtifact,
} from './artifacts.js';

async function stagingFile(contents: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dkrypt-artifact-test-'));
  const file = path.join(directory, 'source.ipa');
  await writeFile(file, contents);
  return file;
}

describe('persistent artifact store', () => {
  test('promotes atomically, records metadata, and updates access time', async () => {
    config.artifactMaxBytes = 1024 * 1024;
    const stagingPath = await stagingFile('first ipa');
    const artifact = await promoteArtifact({
      key: `test-promote-${crypto.randomUUID()}`,
      bundleId: 'com.example.promote',
      channel: 'appstore',
      externalVersionId: '123',
      versionLabel: '342.0',
      stagingPath,
    });

    expect(artifact.fileSizeBytes).toBe(9);
    expect(artifact.sha256).toHaveLength(64);
    expect(artifactFileAvailable(artifact)).toBe(true);
    expect(getArtifactById(artifact.id)?.filePath).toBe(artifact.filePath);
    const before = artifact.accessCount;
    await touchArtifact(artifact);
    expect(getArtifactById(artifact.id)?.accessCount).toBe(before + 1);
  });

  test('failed artifact metadata persistence leaves no orphan IPA and preserves prior artifacts', async () => {
    const previousQuota = config.artifactMaxBytes;
    const database = openStateCollectionDatabase({
      stateDir: config.stateDir,
      filename: config.stateDatabaseFile,
      busyTimeoutMs: config.stateDbBusyTimeoutMs,
    }, ['artifacts']);
    const trigger = `fail_artifact_promotion_${crypto.randomUUID().replaceAll('-', '')}`;
    let existingStagingPath: string | undefined;
    let stagingPath: string | undefined;

    try {
      config.artifactMaxBytes = Number.MAX_SAFE_INTEGER;
      existingStagingPath = await stagingFile('existing artifact');
      const existing = await promoteArtifact({
        key: `test-preserve-on-failure-${crypto.randomUUID()}`,
        bundleId: 'com.example.preserve-on-failure',
        channel: 'appstore',
        stagingPath: existingStagingPath,
      });
      const priorArtifacts = listArtifacts({ limit: 200 }).artifacts;
      const priorFileNames = (await readdir(config.artifactDir)).filter((name) => name.endsWith('.ipa')).sort();
      const priorStats = getArtifactStorageStats();
      stagingPath = await stagingFile('new artifact');

      database.exec(`CREATE TRIGGER ${trigger} BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT, 'forced artifact metadata failure'); END;`);

      await expect(promoteArtifact({
        key: `test-failed-metadata-${crypto.randomUUID()}`,
        bundleId: 'com.example.failed-metadata',
        channel: 'appstore',
        stagingPath,
      })).rejects.toThrow('forced artifact metadata failure');

      expect(listArtifacts({ limit: 200 }).artifacts.map((artifact) => artifact.id).sort()).toEqual(priorArtifacts.map((artifact) => artifact.id).sort());
      expect(getArtifactStorageStats()).toMatchObject(priorStats);
      expect(artifactFileAvailable(getArtifactById(existing.id))).toBe(true);
      expect((await readdir(config.artifactDir)).filter((name) => name.endsWith('.ipa')).sort()).toEqual(priorFileNames);
    } finally {
      database.exec(`DROP TRIGGER IF EXISTS ${trigger};`);
      database.close();
      config.artifactMaxBytes = previousQuota;
      if (existingStagingPath) await rm(path.dirname(existingStagingPath), { recursive: true, force: true });
      if (stagingPath) await rm(path.dirname(stagingPath), { recursive: true, force: true });
    }
  });

  test('links artifact promotion telemetry to the initiating request trace', async () => {
    const stagingPath = await stagingFile('trace artifact');
    const previousSampleRate = config.otelSampleRate;
    config.otelSampleRate = 1;
    const requestSpan = startSpan('test.http.request');
    let exportedSpans: Array<{ name: string; traceId: string; parentSpanId?: string; attributes: Array<{ key: string; value: Record<string, unknown> }> }> = [];

    try {
      await withCorrelation({
        correlationId: 'request-artifact-promotion',
        traceId: requestSpan.context.traceId,
        traceContext: requestSpan.context,
      }, () => promoteArtifact({
        key: `test-trace-${crypto.randomUUID()}`,
        bundleId: 'com.example.trace',
        channel: 'appstore',
        sourceJobId: 'job-artifact-trace',
        stagingPath,
      }));
      requestSpan.end();
      await flushTelemetry({
        endpoint: 'https://collector.example/v1/traces',
        fetcher: async (_input, init) => {
          const payload = JSON.parse(String(init?.body)) as {
            resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string; traceId: string; parentSpanId?: string; attributes: Array<{ key: string; value: Record<string, unknown> }> }> }> }>;
          };
          exportedSpans = payload.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans));
          return Response.json({});
        },
      });

      const promotionSpan = exportedSpans.find((span) => span.name === 'artifact.promotion' && span.traceId === requestSpan.context.traceId);
      expect(promotionSpan).toMatchObject({ traceId: requestSpan.context.traceId, parentSpanId: requestSpan.context.spanId });
      expect(promotionSpan?.attributes).toContainEqual({ key: 'artifact.bundle_id', value: { stringValue: 'com.example.trace' } });
      expect(promotionSpan?.attributes).toContainEqual({ key: 'artifact.source_job_id', value: { stringValue: 'job-artifact-trace' } });
    } finally {
      requestSpan.end();
      config.otelSampleRate = previousSampleRate;
    }
  });

  test('persists the source job and decrypt warnings with the artifact', async () => {
    const warnings = ['Some embedded extensions remained encrypted: Payload/Example.app/Extensions/Share.appex/Share'];
    const artifact = await promoteArtifact({
      key: `test-provenance-${crypto.randomUUID()}`,
      bundleId: 'com.example.provenance',
      channel: 'appstore',
      stagingPath: await stagingFile('artifact provenance'),
      sourceJobId: 'job-provenance-1',
      warnings,
    });

    reloadArtifactIndex();
    expect(getArtifactById(artifact.id)).toMatchObject({ sourceJobId: 'job-provenance-1', warnings });
  });

  test('adds newly discovered warnings when reusing an existing artifact', async () => {
    const key = `test-reused-provenance-${crypto.randomUUID()}`;
    const artifact = await promoteArtifact({
      key,
      bundleId: 'com.example.reused-provenance',
      channel: 'appstore',
      stagingPath: await stagingFile('original artifact'),
      sourceJobId: 'job-original',
    });
    const warning = 'An embedded extension remains encrypted';
    const duplicateStagingPath = await stagingFile('duplicate artifact');

    const reusedArtifact = await promoteArtifact({
      key,
      bundleId: artifact.bundleId,
      channel: artifact.channel,
      stagingPath: duplicateStagingPath,
      sourceJobId: 'job-with-warning',
      warnings: [warning],
    });

    reloadArtifactIndex();
    expect(reusedArtifact.id).toBe(artifact.id);
    expect(existsSync(duplicateStagingPath)).toBe(false);
    expect(getArtifactById(artifact.id)).toMatchObject({ sourceJobId: 'job-original', warnings: [warning] });
  });

  test('serializes promotion and evicts the least recently accessed artifact', async () => {
    config.artifactMaxBytes = 7;
    const first = await promoteArtifact({
      key: `test-lru-first-${crypto.randomUUID()}`,
      bundleId: 'com.example.lru',
      channel: 'appstore',
      externalVersionId: 'first',
      stagingPath: await stagingFile('1234'),
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await promoteArtifact({
      key: `test-lru-second-${crypto.randomUUID()}`,
      bundleId: 'com.example.lru',
      channel: 'appstore',
      externalVersionId: 'second',
      stagingPath: await stagingFile('5678'),
    });

    expect(getArtifactById(first.id)).toBeUndefined();
    expect(getArtifactById(second.id)).toBeDefined();
    expect(getArtifactStorageStats().usedBytes).toBe(4);
  });

  test('pinned artifacts survive quota pressure and can be evicted after unpinning', async () => {
    config.artifactMaxBytes = 4;
    const protectedArtifact = await promoteArtifact({
      key: `test-pinned-${crypto.randomUUID()}`,
      bundleId: 'com.example.pinned',
      channel: 'appstore',
      externalVersionId: 'pinned',
      stagingPath: await stagingFile('1234'),
    });

    const pinned = await setArtifactPinned(protectedArtifact.id, true);
    expect(pinned.changed).toBe(true);
    expect(pinned.artifact?.pinnedAt).toBeTypeOf('number');
    reloadArtifactIndex();
    expect(getArtifactById(protectedArtifact.id)?.pinnedAt).toBe(pinned.artifact?.pinnedAt);

    const preview = previewArtifactQuotaRetention(1);
    expect(preview).toMatchObject({ pinnedCount: 1, pinnedBytes: 4, retainedCount: 1, retainedBytes: 4, evictedCount: 0, remainingOverQuotaBytes: 3 });
    await expect(promoteArtifact({
      key: `test-pinned-blocked-${crypto.randomUUID()}`,
      bundleId: 'com.example.pinned-blocked',
      channel: 'appstore',
      stagingPath: await stagingFile('x'),
    })).rejects.toThrow('unable to free enough artifact storage');
    expect(artifactFileAvailable(getArtifactById(protectedArtifact.id))).toBe(true);
    await expect(setArtifactPinned(protectedArtifact.id, true)).resolves.toMatchObject({ changed: false });

    const unpinned = await setArtifactPinned(protectedArtifact.id, false);
    expect(unpinned.changed).toBe(true);
    expect(unpinned.artifact?.pinnedAt).toBeUndefined();
    const replacement = await promoteArtifact({
      key: `test-after-unpin-${crypto.randomUUID()}`,
      bundleId: 'com.example.after-unpin',
      channel: 'appstore',
      stagingPath: await stagingFile('5678'),
    });
    expect(getArtifactById(protectedArtifact.id)).toBeUndefined();
    expect(artifactFileAvailable(replacement)).toBe(true);
  });

  test('bulk pinning updates metadata together and preserves prior state when persistence fails', async () => {
    config.artifactMaxBytes = 1024 * 1024;
    const first = await promoteArtifact({
      key: `test-bulk-pin-a-${crypto.randomUUID()}`,
      bundleId: 'com.example.bulk-pin-a',
      channel: 'appstore',
      stagingPath: await stagingFile('bulk pin a'),
    });
    const second = await promoteArtifact({
      key: `test-bulk-pin-b-${crypto.randomUUID()}`,
      bundleId: 'com.example.bulk-pin-b',
      channel: 'testflight',
      stagingPath: await stagingFile('bulk pin b'),
    });

    const pinned = await setArtifactsPinned([first.id, second.id], true);
    expect(pinned).toMatchObject({ changedIds: [first.id, second.id], missingIds: [] });
    expect(pinned.artifacts.every((artifact) => artifact.pinnedAt !== undefined)).toBe(true);
    reloadArtifactIndex();
    expect(getArtifactById(first.id)?.pinnedAt).toBeDefined();
    expect(getArtifactById(second.id)?.pinnedAt).toBeDefined();

    const missing = await setArtifactsPinned([first.id, 'missing-artifact'], false);
    expect(missing).toMatchObject({ artifacts: [], changedIds: [], missingIds: ['missing-artifact'] });
    expect(getArtifactById(first.id)?.pinnedAt).toBeDefined();

    const database = openStateCollectionDatabase({
      stateDir: config.stateDir,
      filename: config.stateDatabaseFile,
      busyTimeoutMs: config.stateDbBusyTimeoutMs,
    }, ['artifacts']);
    const trigger = `fail_artifact_bulk_pin_${crypto.randomUUID().replaceAll('-', '')}`;
    try {
      database.exec(`CREATE TRIGGER ${trigger} BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT, 'forced artifact bulk pin failure'); END;`);
      await expect(setArtifactsPinned([first.id, second.id], false)).rejects.toThrow('forced artifact bulk pin failure');
      expect(getArtifactById(first.id)?.pinnedAt).toBeDefined();
      expect(getArtifactById(second.id)?.pinnedAt).toBeDefined();
    } finally {
      database.exec(`DROP TRIGGER IF EXISTS ${trigger};`);
      database.close();
      await setArtifactsPinned([first.id, second.id], false);
    }
  });

  test('archiving persists organizational state without changing quota or eviction protection', async () => {
    config.artifactMaxBytes = 1024 * 1024;
    const archivedArtifact = await promoteArtifact({
      key: `test-archived-${crypto.randomUUID()}`,
      bundleId: 'com.example.archived',
      channel: 'appstore',
      stagingPath: await stagingFile('archive me'),
    });
    const initialStats = getArtifactStorageStats();

    const archived = await setArtifactArchived(archivedArtifact.id, true);
    expect(archived).toMatchObject({ changed: true, artifact: { archivedAt: expect.any(Number) } });
    expect(listArtifacts({ query: archivedArtifact.bundleId, archived: false }).total).toBe(0);
    expect(listArtifacts({ query: archivedArtifact.bundleId, archived: true }).artifacts).toMatchObject([{ id: archivedArtifact.id }]);
    expect(getArtifactStorageStats()).toMatchObject(initialStats);
    reloadArtifactIndex();
    expect(getArtifactById(archivedArtifact.id)?.archivedAt).toBeTypeOf('number');

    const restored = await setArtifactArchived(archivedArtifact.id, false);
    expect(restored).toMatchObject({ changed: true, artifact: { archivedAt: undefined } });
    expect(listArtifacts({ query: archivedArtifact.bundleId, archived: false }).artifacts).toMatchObject([{ id: archivedArtifact.id }]);
  });

  test('archived unpinned artifacts remain eviction candidates while pinned archives are protected', async () => {
    const previousQuota = config.artifactMaxBytes;
    config.artifactMaxBytes = 4;

    try {
      const archivedArtifact = await promoteArtifact({
        key: `test-archived-eviction-${crypto.randomUUID()}`,
        bundleId: 'com.example.archived-eviction',
        channel: 'appstore',
        stagingPath: await stagingFile('1234'),
      });

      await setArtifactArchived(archivedArtifact.id, true);
      const unpinnedPreview = previewArtifactQuotaRetention(1);
      expect(unpinnedPreview).toMatchObject({
        evictedCount: 1,
        evictionExamples: [expect.objectContaining({ id: archivedArtifact.id })],
      });

      await setArtifactPinned(archivedArtifact.id, true);
      const pinnedPreview = previewArtifactQuotaRetention(1);
      expect(pinnedPreview).toMatchObject({ evictedCount: 0, remainingOverQuotaBytes: 3 });

      await setArtifactPinned(archivedArtifact.id, false);
      const replacement = await promoteArtifact({
        key: `test-after-archived-eviction-${crypto.randomUUID()}`,
        bundleId: 'com.example.after-archived-eviction',
        channel: 'appstore',
        stagingPath: await stagingFile('5678'),
      });
      expect(getArtifactById(archivedArtifact.id)).toBeUndefined();
      expect(artifactFileAvailable(replacement)).toBe(true);
    } finally {
      config.artifactMaxBytes = previousQuota;
    }
  });

  test('bulk archive updates metadata together and rolls back if persistence fails', async () => {
    config.artifactMaxBytes = 1024 * 1024;
    const first = await promoteArtifact({
      key: `test-bulk-archive-a-${crypto.randomUUID()}`,
      bundleId: 'com.example.bulk-archive-a',
      channel: 'appstore',
      stagingPath: await stagingFile('bulk archive a'),
    });
    const second = await promoteArtifact({
      key: `test-bulk-archive-b-${crypto.randomUUID()}`,
      bundleId: 'com.example.bulk-archive-b',
      channel: 'testflight',
      stagingPath: await stagingFile('bulk archive b'),
    });

    const archived = await setArtifactsArchived([first.id, second.id], true);
    expect(archived).toMatchObject({ changedIds: [first.id, second.id], missingIds: [] });
    expect(archived.artifacts.every((artifact) => artifact.archivedAt !== undefined)).toBe(true);
    reloadArtifactIndex();
    expect(getArtifactById(first.id)?.archivedAt).toBeDefined();
    expect(getArtifactById(second.id)?.archivedAt).toBeDefined();

    const missing = await setArtifactsArchived([first.id, 'missing-artifact'], false);
    expect(missing).toMatchObject({ artifacts: [], changedIds: [], missingIds: ['missing-artifact'] });
    expect(getArtifactById(first.id)?.archivedAt).toBeDefined();

    const database = openStateCollectionDatabase({
      stateDir: config.stateDir,
      filename: config.stateDatabaseFile,
      busyTimeoutMs: config.stateDbBusyTimeoutMs,
    }, ['artifacts']);
    const trigger = `fail_artifact_bulk_archive_${crypto.randomUUID().replaceAll('-', '')}`;
    try {
      database.exec(`CREATE TRIGGER ${trigger} BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT, 'forced artifact bulk archive failure'); END;`);
      await expect(setArtifactsArchived([first.id, second.id], false)).rejects.toThrow('forced artifact bulk archive failure');
      expect(getArtifactById(first.id)?.archivedAt).toBeDefined();
      expect(getArtifactById(second.id)?.archivedAt).toBeDefined();
    } finally {
      database.exec(`DROP TRIGGER IF EXISTS ${trigger};`);
      database.close();
    }
  });

  test('undo restores unchanged artifact state and skips items changed afterward', async () => {
    config.artifactMaxBytes = 1024 * 1024;
    const first = await promoteArtifact({
      key: `test-undo-first-${crypto.randomUUID()}`,
      bundleId: 'com.example.undo-first',
      channel: 'appstore',
      stagingPath: await stagingFile('undo first'),
    });
    const second = await promoteArtifact({
      key: `test-undo-second-${crypto.randomUUID()}`,
      bundleId: 'com.example.undo-second',
      channel: 'testflight',
      stagingPath: await stagingFile('undo second'),
    });

    const firstPin = await setArtifactPinned(first.id, true);
    const secondArchive = await setArtifactArchived(second.id, true);
    const firstRevision = firstPin.artifact?.pinnedStateChangedAt;
    const secondRevision = secondArchive.artifact?.archivedStateChangedAt;
    expect(firstRevision).toBeTypeOf('number');
    expect(secondRevision).toBeTypeOf('number');

    await setArtifactPinned(first.id, false);
    const result = await undoArtifactStateChanges([
      { id: first.id, kind: 'pin', expectedStateChangedAt: firstRevision!, expectedCurrentState: true },
      { id: second.id, kind: 'archive', expectedStateChangedAt: secondRevision!, expectedCurrentState: true },
    ]);

    expect(result).toEqual({ undoneIds: [second.id], conflictIds: [first.id] });
    expect(getArtifactById(first.id)?.pinnedAt).toBeUndefined();
    expect(getArtifactById(second.id)?.archivedAt).toBeUndefined();
  });

  test('rejects an artifact larger than the quota without promoting it', async () => {
    config.artifactMaxBytes = 3;
    const stagingPath = await stagingFile('1234');
    await expect(
      promoteArtifact({
        key: `test-oversized-${crypto.randomUUID()}`,
        bundleId: 'com.example.oversized',
        channel: 'testflight',
        testflightBuildId: 109440,
        stagingPath,
      }),
    ).rejects.toThrow(/larger than/);
    await expect(rm(stagingPath)).resolves.toBeUndefined();
  });

  test('does not promote an artifact after the job has been aborted', async () => {
    const stagingPath = await stagingFile('cancelled ipa');
    const controller = new AbortController();
    controller.abort(new Error('job deadline exceeded'));

    await expect(promoteArtifact({
      key: `test-aborted-${crypto.randomUUID()}`,
      bundleId: 'com.example.aborted',
      channel: 'appstore',
      stagingPath,
      signal: controller.signal,
    })).rejects.toThrow('job deadline exceeded');

    expect(existsSync(stagingPath)).toBe(true);
    await rm(stagingPath, { force: true });
  });

  test('reconcile removes stale partials and unindexed IPA files', async () => {
    config.artifactMaxBytes = 1024 * 1024;
    const staging = path.join(config.artifactDir, '.staging');
    await mkdir(staging, { recursive: true });
    const partial = path.join(staging, 'partial.ipa');
    const orphan = path.join(config.artifactDir, 'orphan.ipa');
    await writeFile(partial, 'partial');
    await writeFile(orphan, 'orphan');
    await reconcileArtifactStore();

    await expect(rm(partial)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(rm(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('lists artifacts newest first with quota statistics', async () => {
    config.artifactMaxBytes = 1024 * 1024;
    await promoteArtifact({
      key: `test-list-${crypto.randomUUID()}`,
      bundleId: 'com.example.list',
      channel: 'appstore',
      externalVersionId: '456',
      stagingPath: await stagingFile('listed ipa'),
    });
    const result = listArtifacts({ query: 'com.example.list' });
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.totalBytes).toBeGreaterThan(0);
    expect(result.maxBytes).toBe(1024 * 1024);
  });

  test('keeps all imported artifact records in the shared library', async () => {
    const bundleId = `com.example.project.${crypto.randomUUID()}`;
    const artifact = await promoteArtifact({
      key: `test-project-scope-${crypto.randomUUID()}`,
      bundleId,
      channel: 'appstore',
      externalVersionId: '789',
      projectId: 'project-a',
      stagingPath: await stagingFile('project ipa'),
    });

    expect(artifact.projectIds).toEqual(['default']);
    expect(listArtifacts({ projectIds: ['project-a'], query: bundleId }).total).toBe(1);
    expect(listArtifacts({ projectIds: ['project-b'], query: bundleId }).total).toBe(1);

    const linked = await promoteArtifact({
      key: artifact.key,
      bundleId,
      channel: 'appstore',
      externalVersionId: '789',
      projectId: 'project-b',
      stagingPath: await stagingFile('duplicate project ipa'),
    });

    expect(linked.id).toBe(artifact.id);
    expect(linked.projectIds).toEqual(['default']);
    expect(listArtifacts({ projectIds: ['project-b'], query: bundleId }).total).toBe(1);
  });

  test('applies the shared artifact storage policy regardless of legacy workspace metadata', async () => {
    const stagingPath = await stagingFile('four');

    const artifact = await promoteArtifact({
      key: `test-project-quota-${crypto.randomUUID()}`,
      bundleId: `com.example.project-quota.${crypto.randomUUID()}`,
      channel: 'appstore',
      projectId: 'legacy-workspace',
      stagingPath,
    });
    expect(artifact.projectIds).toEqual(['default']);
  });

  test('backup restore omits workspace metadata and keeps artifacts in the shared library', async () => {
    const artifact = await promoteArtifact({
      key: `test-artifact-backup-${crypto.randomUUID()}`,
      bundleId: `com.example.artifact-backup.${crypto.randomUUID()}`,
      channel: 'appstore',
      projectId: 'default',
      stagingPath: await stagingFile('backup ipa'),
    });
    const backup = exportBackup();
    expect(backup).not.toHaveProperty('projects');
    expect(backup).not.toHaveProperty('artifactProjectLinks');
    expect(JSON.stringify(backup)).not.toContain(artifact.filePath);

    expect(importBackup(backup, 'test').ok).toBe(true);
    reloadArtifactIndex();
    expect(getArtifactById(artifact.id)?.projectIds).toEqual(['default']);

    expect(importBackup(backup, 'test').ok).toBe(true);
    reloadArtifactIndex();
    expect(getArtifactById(artifact.id)?.projectIds).toEqual(['default']);
  });

  test('previews least-recently-used quota evictions without changing artifact storage', async () => {
    config.artifactMaxBytes = 1024 * 1024;
    const existing = listArtifacts({ limit: 200 }).artifacts;
    const oldest = await promoteArtifact({
      key: `test-retention-preview-oldest-${crypto.randomUUID()}`,
      bundleId: 'com.example.retention-preview',
      channel: 'appstore',
      stagingPath: await stagingFile('aaaa'),
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await promoteArtifact({
      key: `test-retention-preview-middle-${crypto.randomUUID()}`,
      bundleId: 'com.example.retention-preview',
      channel: 'appstore',
      stagingPath: await stagingFile('bbbb'),
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await promoteArtifact({
      key: `test-retention-preview-newest-${crypto.randomUUID()}`,
      bundleId: 'com.example.retention-preview',
      channel: 'appstore',
      stagingPath: await stagingFile('cccc'),
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    for (const artifact of existing) await touchArtifact(artifact);

    const before = listArtifacts({ limit: 200 }).artifacts;
    const beforeStats = getArtifactStorageStats();
    const targetMaxBytes = beforeStats.usedBytes - oldest.fileSizeBytes;
    const preview = previewArtifactQuotaRetention(targetMaxBytes);

    expect(preview.currentBytes).toBe(beforeStats.usedBytes);
    expect(preview.targetMaxBytes).toBe(targetMaxBytes);
    expect(preview.evictedCount).toBe(1);
    expect(preview.evictionExamples.map((artifact) => artifact.id)).toEqual([oldest.id]);
    expect(preview.retainedCount).toBe(before.length - 1);
    expect(preview.retainedBytes).toBeLessThanOrEqual(targetMaxBytes);
    expect(preview.currentBytes - preview.retainedBytes).toBe(preview.reclaimedBytes);
    expect(getArtifactStorageStats().usedBytes).toBe(beforeStats.usedBytes);
    expect(before.every(artifactFileAvailable)).toBe(true);
  });

  test('rejects invalid simulated artifact quotas', () => {
    expect(() => previewArtifactQuotaRetention(0)).toThrow('artifact quota must be a positive safe integer');
    expect(() => previewArtifactQuotaRetention(Number.MAX_SAFE_INTEGER + 1)).toThrow('artifact quota must be a positive safe integer');
  });

  test('applies bundle scopes before artifact pagination and storage totals', async () => {
    config.artifactMaxBytes = 1024 * 1024;
    const allowedBundleId = `com.example.scoped-${crypto.randomUUID().slice(0, 8)}`;
    const deniedBundleId = `com.example.other-${crypto.randomUUID().slice(0, 8)}`;
    const allowed = await promoteArtifact({
      key: `test-scoped-list-allowed-${crypto.randomUUID()}`,
      bundleId: allowedBundleId,
      channel: 'appstore',
      stagingPath: await stagingFile('allowed scoped ipa'),
    });
    const denied = await promoteArtifact({
      key: `test-scoped-list-denied-${crypto.randomUUID()}`,
      bundleId: deniedBundleId,
      channel: 'appstore',
      stagingPath: await stagingFile('denied scoped ipa'),
    });

    try {
      const result = listArtifacts({ bundleIds: [allowedBundleId] });
      expect(result.artifacts.map((artifact) => artifact.bundleId)).toEqual([allowedBundleId]);
      expect(result.total).toBe(1);
      expect(result.totalBytes).toBe(allowed.fileSizeBytes);
      expect(result.artifacts.some((artifact) => artifact.id === denied.id)).toBe(false);
    } finally {
      await rm(allowed.filePath, { force: true });
      await rm(denied.filePath, { force: true });
    }
  });

  test('stores Apple version and build metadata separately from TestFlight release tags', async () => {
    const key = `test-metadata-${crypto.randomUUID()}`;
    const artifact = await promoteArtifact({
      key,
      bundleId: 'com.example.metadata',
      channel: 'testflight',
      versionLabel: '344.0_109551',
      buildNumber: '109551',
      stagingPath: await stagingFile('metadata ipa'),
    });

    expect(artifact.versionLabel).toBe('344.0');
    expect(artifact.buildNumber).toBe('109551');

    const refreshed = await promoteArtifact({
      key,
      bundleId: 'com.example.metadata',
      channel: 'testflight',
      versionLabel: '344.0',
      buildNumber: '109551',
      stagingPath: await stagingFile('discarded ipa'),
    });
    expect(refreshed.versionLabel).toBe('344.0');
    expect(refreshed.buildNumber).toBe('109551');
  });
});
