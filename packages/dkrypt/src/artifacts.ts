import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { type ArtifactChannel, type ArtifactRecord } from '#artifactTypes.js';
import type { AppStorePlatform } from '#platform.js';
import { createArtifactRepository } from '#artifacts/repository.js';
import { config } from '#config.js';
import { withCorrelationSpan } from '#correlation.js';
import { scopedLogger } from '#logger.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';
import { throwIfAborted } from '#util/abort.js';
import { paginateCursor } from '#util/cursor.js';

const log = scopedLogger('artifacts');

export type { ArtifactChannel, ArtifactRecord } from '#artifactTypes.js';

export interface ArtifactListOptions {
  offset?: number;
  limit?: number;
  cursor?: string;
  query?: string;
  channel?: ArtifactChannel;
  archived?: boolean;
  bundleIds?: string[];
  projectIds?: string[];
}

export interface ArtifactListResult {
  artifacts: ArtifactRecord[];
  total: number;
  totalBytes: number;
  maxBytes: number;
  nextCursor?: string;
}

export interface ArtifactQuotaRetentionPreview {
  targetMaxBytes: number;
  currentMaxBytes: number;
  currentCount: number;
  currentBytes: number;
  retainedCount: number;
  retainedBytes: number;
  evictedCount: number;
  reclaimedBytes: number;
  pinnedCount: number;
  pinnedBytes: number;
  remainingOverQuotaBytes: number;
  evictionExamples: Array<Pick<ArtifactRecord, 'id' | 'bundleId' | 'channel' | 'versionLabel' | 'fileSizeBytes' | 'lastAccessedAt'>>;
  additionalEvictions: number;
}

export interface ArtifactPinBatchResult {
  artifacts: ArtifactRecord[];
  changedIds: string[];
  missingIds: string[];
  previousPinnedAtById: Record<string, number | undefined>;
}

export interface ArtifactArchiveBatchResult {
  artifacts: ArtifactRecord[];
  changedIds: string[];
  missingIds: string[];
  previousArchivedAtById: Record<string, number | undefined>;
}

export interface ArtifactUndoChange {
  id: string;
  kind: 'pin' | 'archive';
  expectedStateChangedAt: number;
  expectedCurrentState: boolean;
  restoreAt?: number;
}

function nextArtifactStateRevision(previous: number | undefined): number {
  return Math.max(Date.now(), (previous ?? 0) + 1);
}

interface ArtifactIndex {
  version: 1;
  artifacts: ArtifactRecord[];
}

const indexPath = path.join(config.stateDir, 'artifacts.json');
const stagingDir = path.join(config.artifactDir, '.staging');
const artifactDatabase = openStateCollectionDatabase(
  {
    stateDir: config.stateDir,
    filename: config.stateDatabaseFile,
    busyTimeoutMs: config.stateDbBusyTimeoutMs,
    migrationDryRun: config.stateDbMigrationDryRun,
  },
  ['artifacts'],
);
const artifactRepository = createArtifactRepository(artifactDatabase);
let index: ArtifactIndex = loadIndex();
let mutationChain = Promise.resolve();

function normalizeArtifactVersionLabel(value: string | undefined, channel: ArtifactChannel): string | undefined {
  const normalized = value?.trim().replace(/^TestFlight\s+/i, '').replace(/^v(?=\d)/i, '');
  if (!normalized) return undefined;
  if (channel === 'testflight') {
    const separator = normalized.indexOf('_');
    if (separator > 0) return normalized.slice(0, separator);
  }
  return normalized;
}

function normalizeArtifactRecord(record: ArtifactRecord): ArtifactRecord {
  const versionLabel = normalizeArtifactVersionLabel(record.versionLabel, record.channel);
  return versionLabel === record.versionLabel && record.projectIds.length === 1 && record.projectIds[0] === 'default'
    ? record
    : { ...record, versionLabel, projectIds: ['default'] };
}

function inMemoryArtifact(artifact: ArtifactRecord | undefined): ArtifactRecord | undefined {
  return artifact ? index.artifacts.find((candidate) => candidate.id === artifact.id) ?? artifact : undefined;
}

function loadIndex(): ArtifactIndex {
  mkdirSync(config.stateDir, { recursive: true });
  const storedArtifacts = artifactRepository.load().map(normalizeArtifactRecord);
  if (storedArtifacts.length > 0) return { version: 1, artifacts: storedArtifacts };
  try {
    const artifacts = artifactRepository.importLegacyIndex(indexPath).map(normalizeArtifactRecord);
    return { version: 1, artifacts };
  } catch (err) {
    throw new Error(`could not initialize artifact metadata: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function persistIndex(): void {
  artifactRepository.replace(index.artifacts);
}

export function reloadArtifactIndex(): void {
  index = { version: 1, artifacts: artifactRepository.load().map(normalizeArtifactRecord) };
}

export function closeArtifactDatabase(): void {
  artifactRepository.close();
}

function withMutation<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutationChain.then(fn, fn);
  mutationChain = next.then(() => undefined, () => undefined);
  return next;
}

function updateArtifactMetadata(artifact: ArtifactRecord, channel: ArtifactChannel, versionLabel?: string, buildNumber?: string, platform?: AppStorePlatform): boolean {
  const normalizedVersion = normalizeArtifactVersionLabel(versionLabel, channel);
  const normalizedBuild = buildNumber?.trim() || undefined;
  let changed = false;
  if (normalizedVersion && artifact.versionLabel !== normalizedVersion) {
    artifact.versionLabel = normalizedVersion;
    changed = true;
  }
  if (normalizedBuild && artifact.buildNumber !== normalizedBuild) {
    artifact.buildNumber = normalizedBuild;
    changed = true;
  }
  if (platform !== undefined && artifact.platform !== platform) {
    artifact.platform = platform;
    changed = true;
  }
  return changed;
}

function mergeArtifactWarnings(artifact: ArtifactRecord, warnings: string[] | undefined): boolean {
  const currentWarnings = artifact.warnings ?? [];
  const mergedWarnings = [...new Set([
    ...currentWarnings,
    ...(warnings ?? []).filter((warning) => typeof warning === 'string' && warning.length > 0),
  ])];
  const changed = mergedWarnings.length !== currentWarnings.length || mergedWarnings.some((warning, index) => warning !== currentWarnings[index]);
  if (!changed) return false;
  artifact.warnings = mergedWarnings.length ? mergedWarnings : undefined;
  return true;
}

export function artifactKeyForAppStore(bundleId: string, externalVersionId: string, platform: AppStorePlatform = 'ios'): string {
  return platform === 'ios' ? `${bundleId}|appstore|${externalVersionId}` : `${bundleId}|appstore|${platform}|${externalVersionId}`;
}

export function artifactKeyForAppStoreVersion(bundleId: string, versionLabel: string, externalVersionId?: string, platform: AppStorePlatform = 'ios'): string {
  return externalVersionId ? artifactKeyForAppStore(bundleId, externalVersionId, platform) : `${bundleId}|appstore|${platform === 'ios' ? '' : `${platform}|`}version:${versionLabel}`;
}

export function artifactKeyForTestFlight(bundleId: string, buildId: number): string {
  return `${bundleId}|testflight|${buildId}`;
}

export function artifactKeyForJob(job: {
  id: string;
  bundleId: string;
  externalVersionId?: string;
  testflight?: { build: { id: number } };
  versionLabel?: string;
  platform?: AppStorePlatform;
}): string {
  if (job.testflight) return artifactKeyForTestFlight(job.bundleId, job.testflight.build.id);
  if (job.externalVersionId) return artifactKeyForAppStore(job.bundleId, job.externalVersionId, job.platform);
  if (job.versionLabel && job.versionLabel !== 'Current App Store release') {
    return artifactKeyForAppStoreVersion(job.bundleId, job.versionLabel, undefined, job.platform);
  }
  return `${job.bundleId}|legacy|${job.id}`;
}

export function migrateLegacyPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  if (existsSync(filePath)) return filePath;
  const basename = path.basename(filePath);
  const migrated = path.join(config.artifactDir, basename);
  return existsSync(migrated) ? migrated : undefined;
}

export function getArtifactById(id: string): ArtifactRecord | undefined {
  return inMemoryArtifact(artifactRepository.findById(id));
}

export function getArtifactBySourceJobId(jobId: string): ArtifactRecord | undefined {
  return inMemoryArtifact(artifactRepository.findBySourceJobId(jobId));
}

export function getArtifactByKey(key: string): ArtifactRecord | undefined {
  const artifact = inMemoryArtifact(artifactRepository.findByKey(key));
  if (!artifact || !existsSync(artifact.filePath)) return undefined;
  return artifact;
}

export async function setArtifactPinned(id: string, pinned: boolean): Promise<{ artifact?: ArtifactRecord; changed: boolean; previousPinnedAt?: number }> {
  const result = await setArtifactsPinned([id], pinned);
  return { artifact: result.artifacts[0], changed: result.changedIds.includes(id), previousPinnedAt: result.previousPinnedAtById[id] };
}

export async function setArtifactsPinned(ids: string[], pinned: boolean): Promise<ArtifactPinBatchResult> {
  return withMutation(async () => {
    const uniqueIds = [...new Set(ids)];
    const artifacts = uniqueIds.map(getArtifactById);
    const missingIds = uniqueIds.filter((_id, index) => artifacts[index] === undefined);
    if (missingIds.length > 0) return { artifacts: [], changedIds: [], missingIds, previousPinnedAtById: {} };

    const currentArtifacts = artifacts as ArtifactRecord[];
    const changedArtifacts = currentArtifacts.filter((artifact) => (artifact.pinnedAt !== undefined) !== pinned);
    if (changedArtifacts.length === 0) return { artifacts: currentArtifacts, changedIds: [], missingIds: [], previousPinnedAtById: {} };

    const previousStates = changedArtifacts.map((artifact) => ({ pinnedAt: artifact.pinnedAt, pinnedStateChangedAt: artifact.pinnedStateChangedAt }));
    const previousPinnedAtById = Object.fromEntries(changedArtifacts.map((artifact) => [artifact.id, artifact.pinnedAt]));
    const pinnedAt = pinned ? Date.now() : undefined;
    for (const artifact of changedArtifacts) {
      artifact.pinnedAt = pinnedAt;
      artifact.pinnedStateChangedAt = nextArtifactStateRevision(artifact.pinnedStateChangedAt);
    }
    try {
      persistIndex();
    } catch (error) {
      changedArtifacts.forEach((artifact, index) => Object.assign(artifact, previousStates[index]));
      throw error;
    }
    return { artifacts: currentArtifacts, changedIds: changedArtifacts.map((artifact) => artifact.id), missingIds: [], previousPinnedAtById };
  });
}

export async function setArtifactArchived(id: string, archived: boolean): Promise<{ artifact?: ArtifactRecord; changed: boolean; previousArchivedAt?: number }> {
  const result = await setArtifactsArchived([id], archived);
  return { artifact: result.artifacts[0], changed: result.changedIds.includes(id), previousArchivedAt: result.previousArchivedAtById[id] };
}

export async function setArtifactsArchived(ids: string[], archived: boolean): Promise<ArtifactArchiveBatchResult> {
  return withMutation(async () => {
    const uniqueIds = [...new Set(ids)];
    const artifacts = uniqueIds.map(getArtifactById);
    const missingIds = uniqueIds.filter((_id, index) => artifacts[index] === undefined);
    if (missingIds.length > 0) return { artifacts: [], changedIds: [], missingIds, previousArchivedAtById: {} };

    const currentArtifacts = artifacts as ArtifactRecord[];
    const changedArtifacts = currentArtifacts.filter((artifact) => (artifact.archivedAt !== undefined) !== archived);
    if (changedArtifacts.length === 0) return { artifacts: currentArtifacts, changedIds: [], missingIds: [], previousArchivedAtById: {} };

    const previousStates = changedArtifacts.map((artifact) => ({ archivedAt: artifact.archivedAt, archivedStateChangedAt: artifact.archivedStateChangedAt }));
    const previousArchivedAtById = Object.fromEntries(changedArtifacts.map((artifact) => [artifact.id, artifact.archivedAt]));
    const archivedAt = archived ? Date.now() : undefined;
    for (const artifact of changedArtifacts) {
      artifact.archivedAt = archivedAt;
      artifact.archivedStateChangedAt = nextArtifactStateRevision(artifact.archivedStateChangedAt);
    }
    try {
      persistIndex();
    } catch (error) {
      changedArtifacts.forEach((artifact, index) => Object.assign(artifact, previousStates[index]));
      throw error;
    }
    return { artifacts: currentArtifacts, changedIds: changedArtifacts.map((artifact) => artifact.id), missingIds: [], previousArchivedAtById };
  });
}

export async function undoArtifactStateChanges(changes: ArtifactUndoChange[]): Promise<{ undoneIds: string[]; conflictIds: string[] }> {
  return withMutation(async () => {
    const undoneIds: string[] = [];
    const conflictIds: string[] = [];
    const snapshots: Array<{ artifact: ArtifactRecord; state: Partial<ArtifactRecord> }> = [];
    for (const change of changes) {
      const artifact = getArtifactById(change.id);
      if (!artifact) {
        conflictIds.push(change.id);
        continue;
      }
      const stateKey = change.kind === 'pin' ? 'pinnedAt' : 'archivedAt';
      const revisionKey = change.kind === 'pin' ? 'pinnedStateChangedAt' : 'archivedStateChangedAt';
      if (artifact[revisionKey] !== change.expectedStateChangedAt || (artifact[stateKey] !== undefined) !== change.expectedCurrentState) {
        conflictIds.push(change.id);
        continue;
      }
      snapshots.push({ artifact, state: { [stateKey]: artifact[stateKey], [revisionKey]: artifact[revisionKey] } });
      artifact[stateKey] = change.restoreAt;
      artifact[revisionKey] = nextArtifactStateRevision(artifact[revisionKey]);
      undoneIds.push(change.id);
    }
    if (undoneIds.length === 0) return { undoneIds, conflictIds };
    try {
      persistIndex();
    } catch (error) {
      for (const snapshot of snapshots) Object.assign(snapshot.artifact, snapshot.state);
      throw error;
    }
    return { undoneIds, conflictIds };
  });
}

export function linkArtifactToProject(id: string, _projectId: string): ArtifactRecord | undefined {
  const artifact = getArtifactById(id);
  if (!artifact) return undefined;
  if (artifact.projectIds.length === 1 && artifact.projectIds[0] === 'default') return artifact;
  artifact.projectIds = ['default'];
  persistIndex();
  return artifact;
}

export function artifactFileAvailable(artifact: ArtifactRecord | undefined): boolean {
  return !!artifact && existsSync(artifact.filePath);
}

export function getArtifactStorageStats(bundleIds?: string[], _projectIds?: string[]): { usedBytes: number; maxBytes: number; count: number } {
  const available = index.artifacts
    .filter((artifact) => existsSync(artifact.filePath))
    .filter((artifact) => !bundleIds || bundleIds.includes(artifact.bundleId));
  const scoped = available;
  return {
    usedBytes: scoped.reduce((total, artifact) => total + artifact.fileSizeBytes, 0),
    maxBytes: config.artifactMaxBytes,
    count: scoped.length,
  };
}

export function previewArtifactQuotaRetention(targetMaxBytes: number): ArtifactQuotaRetentionPreview {
  if (!Number.isSafeInteger(targetMaxBytes) || targetMaxBytes < 1) {
    throw new Error('artifact quota must be a positive safe integer');
  }
  const available = index.artifacts.filter((artifact) => existsSync(artifact.filePath));
  const evicted = planArtifactEvictions(available, 0, targetMaxBytes, new Set(), false);
  const evictedIds = new Set(evicted.map((artifact) => artifact.id));
  const retained = available.filter((artifact) => !evictedIds.has(artifact.id));
  const currentBytes = available.reduce((total, artifact) => total + artifact.fileSizeBytes, 0);
  const reclaimedBytes = evicted.reduce((total, artifact) => total + artifact.fileSizeBytes, 0);
  const pinned = available.filter((artifact) => artifact.pinnedAt !== undefined);
  const retainedBytes = retained.reduce((total, artifact) => total + artifact.fileSizeBytes, 0);
  return {
    targetMaxBytes,
    currentMaxBytes: config.artifactMaxBytes,
    currentCount: available.length,
    currentBytes,
    retainedCount: retained.length,
    retainedBytes: retained.reduce((total, artifact) => total + artifact.fileSizeBytes, 0),
    evictedCount: evicted.length,
    reclaimedBytes,
    pinnedCount: pinned.length,
    pinnedBytes: pinned.reduce((total, artifact) => total + artifact.fileSizeBytes, 0),
    remainingOverQuotaBytes: Math.max(0, retainedBytes - targetMaxBytes),
    evictionExamples: evicted.slice(0, 8).map(({ id, bundleId, channel, versionLabel, fileSizeBytes, lastAccessedAt }) => ({
      id,
      bundleId,
      channel,
      versionLabel,
      fileSizeBytes,
      lastAccessedAt,
    })),
    additionalEvictions: Math.max(0, evicted.length - 8),
  };
}

export function listArtifacts(options: ArtifactListOptions = {}): ArtifactListResult {
  const filtered = artifactRepository.list({
    query: options.query,
    channel: options.channel,
    archived: options.archived,
    bundleIds: options.bundleIds,
  }).filter(artifactFileAvailable);

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const page = paginateCursor(filtered, {
    cursor: options.cursor,
    offset: options.offset,
    limit,
    keyOf: (artifact) => [artifact.createdAt, artifact.id],
    order: 'desc',
  });
  const stats = getArtifactStorageStats(options.bundleIds);
  return {
    artifacts: page.items,
    total: filtered.length,
    totalBytes: stats.usedBytes,
    maxBytes: stats.maxBytes,
    nextCursor: page.nextCursor,
  };
}

export async function touchArtifact(artifact: ArtifactRecord): Promise<void> {
  await withMutation(async () => {
    touchArtifactUnsafe(artifact);
  });
}

function touchArtifactUnsafe(artifact: ArtifactRecord): void {
  const current = index.artifacts.find((candidate) => candidate.id === artifact.id);
  if (!current) return;
  current.lastAccessedAt = Date.now();
  current.accessCount += 1;
  persistIndex();
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function planArtifactEvictions(
  available: ArtifactRecord[],
  requiredBytes: number,
  maxBytes: number,
  protectedKeys: Set<string>,
  rejectIfOverQuota = true,
): ArtifactRecord[] {
  let usedBytes = available.reduce((total, artifact) => total + artifact.fileSizeBytes, 0);
  if (requiredBytes > maxBytes) {
    throw new Error(`artifact is ${requiredBytes} bytes, larger than the ${maxBytes}-byte storage limit`);
  }

  const candidates = available
    .filter((artifact) => artifact.pinnedAt === undefined && !protectedKeys.has(artifact.key))
    .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt || a.createdAt - b.createdAt);
  const evictions: ArtifactRecord[] = [];

  for (const candidate of candidates) {
    if (usedBytes + requiredBytes <= maxBytes) break;
    evictions.push(candidate);
    usedBytes -= candidate.fileSizeBytes;
  }

  if (rejectIfOverQuota && usedBytes + requiredBytes > maxBytes) {
    throw new Error('unable to free enough artifact storage');
  }

  return evictions;
}

function artifactsToEvict(requiredBytes: number, protectedKeys: Set<string>): ArtifactRecord[] {
  const available = index.artifacts.filter((artifact) => existsSync(artifact.filePath));
  return planArtifactEvictions(available, requiredBytes, config.artifactMaxBytes, protectedKeys);
}

export async function promoteArtifact(input: {
  key: string;
  bundleId: string;
  channel: ArtifactChannel;
  platform?: AppStorePlatform;
  externalVersionId?: string;
  testflightBuildId?: number;
  versionLabel?: string;
  buildNumber?: string;
  stagingPath: string;
  sourceJobId?: string;
  warnings?: string[];
  projectId?: string;
  signal?: AbortSignal;
}): Promise<ArtifactRecord> {
  return withCorrelationSpan('artifact.promotion', {
    'artifact.bundle_id': input.bundleId,
    'artifact.channel': input.channel,
    'artifact.source_job_id': input.sourceJobId,
  }, (span) => withMutation(async () => {
    throwIfAborted(input.signal);
    await mkdir(config.artifactDir, { recursive: true });
    throwIfAborted(input.signal);
    const existing = getArtifactByKey(input.key);
    if (existing) {
      await rm(input.stagingPath, { force: true });
      throwIfAborted(input.signal);
      const metadataChanged = updateArtifactMetadata(existing, input.channel, input.versionLabel, input.buildNumber, input.platform);
      const warningsChanged = mergeArtifactWarnings(existing, input.warnings);
      if (metadataChanged || warningsChanged) persistIndex();
      touchArtifactUnsafe(existing);
      span.setAttributes({ 'artifact.id': existing.id, 'artifact.reused': true, 'artifact.size_bytes': existing.fileSizeBytes });
      return existing;
    }

    const file = await stat(input.stagingPath);
    throwIfAborted(input.signal);
    const sha256 = await sha256File(input.stagingPath);
    throwIfAborted(input.signal);
    const previousArtifacts = index.artifacts;
    const staleArtifacts = previousArtifacts.filter((artifact) => !existsSync(artifact.filePath));
    const evictedArtifacts = artifactsToEvict(file.size, new Set([input.key]));
    throwIfAborted(input.signal);
    const now = Date.now();
    const artifact: ArtifactRecord = {
      id: randomUUID(),
      key: input.key,
      projectIds: ['default'],
      bundleId: input.bundleId,
      channel: input.channel,
      platform: input.platform === 'ios' ? undefined : input.platform,
      externalVersionId: input.externalVersionId,
      testflightBuildId: input.testflightBuildId,
      versionLabel: normalizeArtifactVersionLabel(input.versionLabel, input.channel),
      buildNumber: input.buildNumber?.trim() || undefined,
      filePath: path.join(config.artifactDir, `${now}-${randomUUID()}.ipa`),
      fileSizeBytes: file.size,
      sha256,
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      sourceJobId: input.sourceJobId,
      warnings: input.warnings?.filter((warning) => typeof warning === 'string' && warning.length > 0),
    };
    await rename(input.stagingPath, artifact.filePath);
    if (input.signal?.aborted) {
      await rm(artifact.filePath, { force: true }).catch((error) => log.warn('failed to remove an artifact after cancellation', { path: artifact.filePath, error: String(error) }));
      throwIfAborted(input.signal);
    }
    const removedIds = new Set([...staleArtifacts, ...evictedArtifacts].map((candidate) => candidate.id));
    index.artifacts = [...previousArtifacts.filter((candidate) => !removedIds.has(candidate.id)), artifact];
    try {
      persistIndex();
    } catch (error) {
      index.artifacts = previousArtifacts;
      await rm(artifact.filePath, { force: true }).catch((cleanupError) => log.warn('failed to remove an artifact after promotion failed', { path: artifact.filePath, error: String(cleanupError) }));
      throw error;
    }
    for (const evicted of evictedArtifacts) {
      try {
        rmSync(evicted.filePath, { force: true });
        log.info('evicted artifact for storage quota', { artifactId: evicted.id, bundleId: evicted.bundleId, sizeBytes: evicted.fileSizeBytes });
      } catch (error) {
        log.warn('failed to remove an evicted artifact file', { artifactId: evicted.id, path: evicted.filePath, error: String(error) });
      }
    }
    for (const stale of staleArtifacts) {
      try {
        rmSync(stale.filePath, { force: true });
      } catch (error) {
        log.warn('failed to remove a stale artifact file', { artifactId: stale.id, path: stale.filePath, error: String(error) });
      }
    }
    span.setAttributes({
      'artifact.id': artifact.id,
      'artifact.reused': false,
      'artifact.size_bytes': artifact.fileSizeBytes,
      'artifact.evicted_count': evictedArtifacts.length,
    });
    return artifact;
  }));
}

export async function registerLegacyJobArtifact(job: {
  id: string;
  projectId?: string;
  bundleId: string;
  externalVersionId?: string;
  testflight?: { build: { id: number; cfBundleShortVersion: string; cfBundleVersion: string } };
  versionLabel?: string;
  ipaMetadata?: { shortVersion?: string; bundleVersion?: string };
  filePath?: string;
  fileSizeBytes?: number;
}): Promise<ArtifactRecord | undefined> {
  const migratedPath = migrateLegacyPath(job.filePath);
  if (!migratedPath) return undefined;
  return withMutation(async () => {
    const key = artifactKeyForJob(job);
    const existing = getArtifactByKey(key);
    const channel = job.testflight ? 'testflight' : 'appstore';
    const versionLabel = job.ipaMetadata?.shortVersion ?? job.testflight?.build.cfBundleShortVersion ?? job.versionLabel;
    const buildNumber = job.ipaMetadata?.bundleVersion ?? job.testflight?.build.cfBundleVersion;
    if (existing && existsSync(existing.filePath)) {
      if (updateArtifactMetadata(existing, channel, versionLabel, buildNumber)) persistIndex();
      return existing;
    }
    const file = await stat(migratedPath);
    index.artifacts = index.artifacts.filter((artifact) => artifact.key !== key || existsSync(artifact.filePath));
    const now = Date.now();
    const record: ArtifactRecord = {
      id: randomUUID(),
      key,
      projectIds: ['default'],
      bundleId: job.bundleId,
      channel,
      externalVersionId: job.externalVersionId,
      testflightBuildId: job.testflight?.build.id,
      versionLabel: normalizeArtifactVersionLabel(versionLabel, channel),
      buildNumber: buildNumber?.trim() || undefined,
      filePath: migratedPath,
      fileSizeBytes: file.size,
      sha256: await sha256File(migratedPath),
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      sourceJobId: job.id,
    };
    index.artifacts.push(record);
    persistIndex();
    return record;
  });
}

export async function reconcileArtifactStore(): Promise<void> {
  await withMutation(async () => {
    await mkdir(stagingDir, { recursive: true });
    for (const name of await readdir(stagingDir)) await rm(path.join(stagingDir, name), { force: true });

    const normalized: ArtifactRecord[] = [];
    for (const artifact of index.artifacts) {
      const migrated = migrateLegacyPath(artifact.filePath);
      if (!migrated) continue;
      artifact.filePath = migrated;
      artifact.fileSizeBytes = (await stat(migrated)).size;
      normalized.push(artifact);
    }
    index.artifacts = normalized;

    const indexedPaths = new Set(index.artifacts.map((artifact) => path.resolve(artifact.filePath)));
    for (const name of await readdir(config.artifactDir)) {
      if (!name.endsWith('.ipa')) continue;
      const candidate = path.resolve(config.artifactDir, name);
      if (!indexedPaths.has(candidate)) {
        await rm(candidate, { force: true });
        log.warn('removed unindexed IPA from artifact storage', { path: candidate });
      }
    }

    const stats = getArtifactStorageStats();
    if (stats.usedBytes > config.artifactMaxBytes) {
      const previousArtifacts = index.artifacts;
      const evictedArtifacts = planArtifactEvictions(index.artifacts, 0, config.artifactMaxBytes, new Set(), false);
      const evictedIds = new Set(evictedArtifacts.map((artifact) => artifact.id));
      index.artifacts = previousArtifacts.filter((artifact) => !evictedIds.has(artifact.id));
      try {
        persistIndex();
      } catch (error) {
        index.artifacts = previousArtifacts;
        throw error;
      }
      for (const evicted of evictedArtifacts) {
        try {
          await rm(evicted.filePath, { force: true });
          log.info('evicted artifact for storage quota', { artifactId: evicted.id, bundleId: evicted.bundleId, sizeBytes: evicted.fileSizeBytes });
        } catch (error) {
          log.warn('failed to remove an evicted artifact file', { artifactId: evicted.id, path: evicted.filePath, error: String(error) });
        }
      }
      const remaining = getArtifactStorageStats();
      if (remaining.usedBytes > remaining.maxBytes) {
        log.warn('pinned artifacts exceed the configured storage quota', { usedBytes: remaining.usedBytes, maxBytes: remaining.maxBytes });
      }
    } else {
      persistIndex();
    }
  });
}

export async function initializeArtifactStore(jobs: Array<{
  id: string;
  bundleId: string;
  externalVersionId?: string;
  testflight?: { build: { id: number; cfBundleShortVersion: string; cfBundleVersion: string } };
  versionLabel?: string;
  ipaMetadata?: { shortVersion?: string; bundleVersion?: string };
  filePath?: string;
  fileSizeBytes?: number;
  artifactId?: string;
}>): Promise<void> {
  for (const job of jobs) {
    if (!job.filePath) continue;
    const artifact = await registerLegacyJobArtifact(job);
    if (artifact) {
      job.artifactId = artifact.id;
      job.filePath = artifact.filePath;
      job.fileSizeBytes = artifact.fileSizeBytes;
    }
  }
  await reconcileArtifactStore();
}

export function getArtifactForJob(job: { artifactId?: string; filePath?: string; projectId?: string }): ArtifactRecord | undefined {
  if (job.artifactId) return getArtifactById(job.artifactId);
  return index.artifacts.find((artifact) => artifact.filePath === job.filePath);
}

export function artifactDownloadName(artifact: ArtifactRecord): string {
  const version = artifact.versionLabel ? `-${artifact.versionLabel.replace(/[^A-Za-z0-9._-]/g, '_')}` : '';
  return `${artifact.bundleId}${version}.ipa`;
}

export function buildArtifactFileUrl(id: string): string {
  return `${config.publicBaseUrl}/v1/artifacts/${encodeURIComponent(id)}/file`;
}

export function buildDashboardArtifactFileUrl(id: string): string {
  return `${config.publicBaseUrl}/v1/dashboard/artifacts/${encodeURIComponent(id)}/file`;
}
