import { existsSync, readFileSync } from 'node:fs';
import { importLegacyArtifactIndexOnce, readStateCollection, replaceStateCollection } from '#store/sqlite.js';
import { isArtifactRecord, type ArtifactChannel, type ArtifactRecord } from '#artifactTypes.js';
import type { Database } from 'bun:sqlite';

export interface ArtifactRepositoryFilter {
  query?: string;
  channel?: ArtifactChannel;
  archived?: boolean;
  bundleIds?: string[];
  projectIds?: string[];
}

export interface ArtifactRepository {
  load(): ArtifactRecord[];
  replace(artifacts: Iterable<ArtifactRecord>): void;
  importLegacyIndex(filePath: string): ArtifactRecord[];
  findById(id: string): ArtifactRecord | undefined;
  findByKey(key: string): ArtifactRecord | undefined;
  findBySourceJobId(jobId: string): ArtifactRecord | undefined;
  list(filter?: ArtifactRepositoryFilter): ArtifactRecord[];
  close(): void;
}

function findArtifact(database: Database, field: 'id' | 'artifact_key' | 'source_job_id', value: string): ArtifactRecord | undefined {
  const row = database.query(`
    SELECT payload
    FROM artifacts
    WHERE ${field} = ?
    ORDER BY updated_at DESC
    LIMIT 1;
  `).get(value) as { payload?: string } | null;
  if (!row?.payload) return undefined;
  const artifact: unknown = JSON.parse(row.payload);
  return isArtifactRecord(artifact) ? artifact : undefined;
}

function listArtifacts(database: Database, filter: ArtifactRepositoryFilter = {}): ArtifactRecord[] {
  const conditions = ['1 = 1'];
  const parameters: string[] = [];
  if (filter.bundleIds) {
    if (filter.bundleIds.length === 0) conditions.push('0 = 1');
    else {
      conditions.push(`bundle_id IN (${filter.bundleIds.map(() => '?').join(', ')})`);
      parameters.push(...filter.bundleIds);
    }
  }
  if (filter.channel) {
    conditions.push('channel = ?');
    parameters.push(filter.channel);
  }
  if (filter.archived !== undefined) {
    conditions.push(filter.archived
      ? "json_extract(payload, '$.archivedAt') IS NOT NULL"
      : "json_extract(payload, '$.archivedAt') IS NULL");
  }
  const query = filter.query?.trim().toLowerCase();
  if (query) {
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    const searchableFields = ['bundle_id', 'version_label', 'external_version_id', 'build_number', 'sha256'];
    conditions.push(`(${searchableFields.map((field) => `lower(COALESCE(${field}, '')) LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    parameters.push(...searchableFields.map(() => pattern));
  }
  const rows = database.query(`
    SELECT payload
    FROM artifacts
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC, id DESC;
  `).all(...parameters) as Array<{ payload: string }>;
  return rows.map((row) => JSON.parse(row.payload) as unknown).filter(isArtifactRecord);
}

export function createArtifactRepository(database: Database): ArtifactRepository {
  return {
    load: () => readStateCollection(database, 'artifacts').filter(isArtifactRecord),
    replace(artifacts) {
      const values = [...artifacts];
      replaceStateCollection(database, 'artifacts', values.map((artifact) => ({
        id: artifact.id,
        payload: artifact,
        updatedAt: artifact.lastAccessedAt,
      })));
    },
    importLegacyIndex(filePath) {
      let artifacts: ArtifactRecord[] = [];
      if (existsSync(filePath)) {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { version?: unknown; artifacts?: unknown };
        if (parsed.version !== 1 || !Array.isArray(parsed.artifacts)) throw new Error('unsupported artifact index');
        artifacts = parsed.artifacts.filter(isArtifactRecord);
      }
      const imported = importLegacyArtifactIndexOnce(database, artifacts.map((artifact) => ({
        id: artifact.id,
        payload: artifact,
        updatedAt: artifact.lastAccessedAt,
      })));
      return imported ? artifacts : [];
    },
    findById: (id) => findArtifact(database, 'id', id),
    findByKey: (key) => findArtifact(database, 'artifact_key', key),
    findBySourceJobId: (jobId) => findArtifact(database, 'source_job_id', jobId),
    list: (filter) => listArtifacts(database, filter),
    close: () => database.close(),
  };
}
