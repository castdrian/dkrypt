import type { AppStorePlatform } from '#platform.js';

export type ArtifactChannel = 'appstore' | 'testflight';

export interface ArtifactRecord {
  id: string;
  key: string;
  projectIds: string[];
  bundleId: string;
  channel: ArtifactChannel;
  platform?: AppStorePlatform;
  externalVersionId?: string;
  testflightBuildId?: number;
  versionLabel?: string;
  buildNumber?: string;
  filePath: string;
  fileSizeBytes: number;
  sha256: string;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  pinnedAt?: number;
  archivedAt?: number;
  pinnedStateChangedAt?: number;
  archivedStateChangedAt?: number;
  sourceJobId?: string;
  warnings?: string[];
}

export function isArtifactRecord(value: unknown): value is ArtifactRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ArtifactRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.key === 'string' &&
    typeof record.bundleId === 'string' &&
    (record.channel === 'appstore' || record.channel === 'testflight') &&
    (record.platform === undefined || record.platform === 'ios' || record.platform === 'tvos' || record.platform === 'visionos') &&
    typeof record.filePath === 'string' &&
    typeof record.fileSizeBytes === 'number' &&
    typeof record.sha256 === 'string' &&
    typeof record.createdAt === 'number' &&
    typeof record.lastAccessedAt === 'number' &&
    typeof record.accessCount === 'number' &&
    (record.pinnedAt === undefined || Number.isFinite(record.pinnedAt)) &&
    (record.archivedAt === undefined || Number.isFinite(record.archivedAt)) &&
    (record.pinnedStateChangedAt === undefined || Number.isFinite(record.pinnedStateChangedAt)) &&
    (record.archivedStateChangedAt === undefined || Number.isFinite(record.archivedStateChangedAt)) &&
    (record.sourceJobId === undefined || typeof record.sourceJobId === 'string') &&
    (record.warnings === undefined || (Array.isArray(record.warnings) && record.warnings.every((warning) => typeof warning === 'string')))
  );
}
