import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createArtifactRepository } from '#artifacts/repository.js';
import type { ArtifactRecord } from '#artifactTypes.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';

function createArtifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: 'artifact-1',
    key: 'com.example.app|appstore|version:1.0',
    projectIds: ['default'],
    bundleId: 'com.example.app',
    channel: 'appstore',
    versionLabel: '1.0',
    buildNumber: '10',
    filePath: '/artifacts/1.ipa',
    fileSizeBytes: 100,
    sha256: 'a'.repeat(64),
    createdAt: 100,
    lastAccessedAt: 120,
    accessCount: 2,
    sourceJobId: 'job-1',
    ...overrides,
  };
}

test('artifact repository migrates legacy records into the shared account scope', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-artifact-repository-migration-'));
  const databasePath = path.join(stateDir, 'state.sqlite');
  const legacyDatabase = new Database(databasePath, { create: true, strict: true });
  legacyDatabase.exec('CREATE TABLE artifacts (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);');
  const legacyArtifact = createArtifact({ id: 'legacy-artifact', key: 'legacy-key', sourceJobId: 'legacy-job' });
  legacyDatabase.query('INSERT INTO artifacts (id, payload, updated_at) VALUES (?, ?, ?)').run(legacyArtifact.id, JSON.stringify(legacyArtifact), legacyArtifact.lastAccessedAt);
  legacyDatabase.close();

  let repository: ReturnType<typeof createArtifactRepository> | undefined;
  try {
    repository = createArtifactRepository(openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['artifacts']));
    expect(repository.findByKey('legacy-key')).toEqual(legacyArtifact);
    expect(repository.findBySourceJobId('legacy-job')).toEqual(legacyArtifact);
    expect(repository.load()).toEqual([legacyArtifact]);
  } finally {
    repository?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('artifact repository keeps account-wide records and indexed lookups across restart', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-artifact-repository-restart-'));
  const options = { stateDir, filename: 'state.sqlite' };
  let repository: ReturnType<typeof createArtifactRepository> | undefined;

  try {
    repository = createArtifactRepository(openStateCollectionDatabase(options, ['artifacts']));
    const first = createArtifact();
    const second = createArtifact({ id: 'artifact-2', key: 'com.example.app|testflight|42', channel: 'testflight', testflightBuildId: 42, buildNumber: '42', sourceJobId: 'job-2', lastAccessedAt: 130 });
    const wildcardText = createArtifact({ id: 'artifact-3', key: 'com.example.percent_%|appstore|1', bundleId: 'com.example.percent_%', versionLabel: '1' });
    repository.replace([first, second, wildcardText]);
    expect(repository.findById('artifact-2')).toEqual(second);
    expect(repository.findByKey(first.key)).toEqual(first);
    expect(repository.list()).toEqual([wildcardText, second, first]);
    expect(repository.list({ channel: 'testflight', query: '42' })).toEqual([second]);
    expect(repository.list({ query: 'percent_%' })).toEqual([wildcardText]);
    expect(repository.list({ bundleIds: [] })).toEqual([]);
    repository.close();
    repository = undefined;

    repository = createArtifactRepository(openStateCollectionDatabase(options, ['artifacts']));
    expect(repository.findBySourceJobId('job-2')).toEqual(second);
    expect(repository.load().sort((left, right) => left.id.localeCompare(right.id))).toEqual([first, second, wildcardText]);
    repository.replace([second]);
    expect(repository.list()).toEqual([second]);
  } finally {
    repository?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('artifact repository filters active, archived, and unfiltered records', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-artifact-repository-archive-'));
  let repository: ReturnType<typeof createArtifactRepository> | undefined;

  try {
    repository = createArtifactRepository(openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['artifacts']));
    const active = createArtifact({ id: 'active-artifact' });
    const archived = createArtifact({ id: 'archived-artifact', archivedAt: 150 });
    repository.replace([active, archived]);

    expect(repository.list({ archived: false })).toEqual([active]);
    expect(repository.list({ archived: true })).toEqual([archived]);
    expect(repository.list()).toHaveLength(2);
  } finally {
    repository?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('artifact repository imports the legacy JSON index without modifying the source file', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-artifact-repository-json-import-'));
  const legacyIndexPath = path.join(stateDir, 'artifacts.json');
  const legacyArtifact = createArtifact({ id: 'legacy-json-artifact', key: 'legacy-json-key', sourceJobId: 'legacy-json-job' });
  const legacyIndex = JSON.stringify({ version: 1, artifacts: [legacyArtifact] });
  const options = { stateDir, filename: 'state.sqlite' };
  let repository: ReturnType<typeof createArtifactRepository> | undefined;

  try {
    await writeFile(legacyIndexPath, legacyIndex);
    repository = createArtifactRepository(openStateCollectionDatabase(options, ['artifacts']));
    const imported = repository.importLegacyIndex(legacyIndexPath);
    expect(imported).toEqual([legacyArtifact]);
    expect(await readFile(legacyIndexPath, 'utf8')).toBe(legacyIndex);
    repository.close();
    repository = undefined;

    repository = createArtifactRepository(openStateCollectionDatabase(options, ['artifacts']));
    expect(repository.findByKey('legacy-json-key')).toEqual(legacyArtifact);
    repository.replace([]);
    expect(repository.importLegacyIndex(legacyIndexPath)).toEqual([]);
    expect(repository.load()).toEqual([]);
    repository.close();
    repository = undefined;

    repository = createArtifactRepository(openStateCollectionDatabase(options, ['artifacts']));
    expect(repository.load()).toEqual([]);
  } finally {
    repository?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('artifact repository does not import a legacy index after completing an empty import', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-artifact-repository-empty-import-'));
  const legacyIndexPath = path.join(stateDir, 'artifacts.json');
  const legacyArtifact = createArtifact({ id: 'late-legacy-artifact', key: 'late-legacy-key' });
  const options = { stateDir, filename: 'state.sqlite' };
  let repository: ReturnType<typeof createArtifactRepository> | undefined;

  try {
    repository = createArtifactRepository(openStateCollectionDatabase(options, ['artifacts']));
    expect(repository.importLegacyIndex(legacyIndexPath)).toEqual([]);
    await writeFile(legacyIndexPath, JSON.stringify({ version: 1, artifacts: [legacyArtifact] }));
    expect(repository.importLegacyIndex(legacyIndexPath)).toEqual([]);
    expect(repository.load()).toEqual([]);
  } finally {
    repository?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
