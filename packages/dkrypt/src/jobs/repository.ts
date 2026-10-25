import { config } from '#config.js';
import type { Job } from '#jobs/types.js';
import { openStateCollectionDatabase, readStateCollection, replaceStateCollections } from '#store/sqlite.js';
import type { Database } from 'bun:sqlite';

type StoredJob = Omit<Job, 'childProcess' | 'waiters'>;
const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface DecryptQuotaUsage {
  limit: number | null;
  used: number;
  remaining: number | null;
  nextAvailableAt?: number;
}

export class DailyDecryptLimitError extends Error {
  readonly statusCode = 429;
  readonly code = 'daily_decrypt_limit';

  constructor(readonly nextAvailableAt: number) {
    super('daily decrypt allowance exhausted');
    this.name = 'DailyDecryptLimitError';
  }
}
const exactBuildFilter = `
  project_id = ?
  AND bundle_id = ?
  AND external_version_id IS ?
  AND testflight_build_id IS ?
`;

export interface JobBuildLookup {
  projectId: string;
  bundleId: string;
  externalVersionId?: string;
  testFlightBuildId?: number;
}

export interface JobRepository {
  load(): StoredJob[];
  replace(jobs: Iterable<Job>): void;
  findActiveId(lookup: JobBuildLookup): string | undefined;
  findReusableCompletedIds(lookup: JobBuildLookup): string[];
  quotaUsage(ownerId: string, limit: number | undefined, now?: number): DecryptQuotaUsage;
  quotaJournal(ownerId: string, limit?: number): Array<{ jobId: string; ownerId: string; admittedAt: number; state: 'reserved' | 'consumed'; bundleId?: string; projectId?: string; source?: string; status?: string; versionLabel?: string; executionPath?: string }>;
  admit(job: Job, ownerId: string, limit: number | undefined): void;
  settleQuota(jobId: string, success: boolean): void;
  reconcileQuota(): void;
  mergeQuotaOwner(targetUserId: string, sourceUserId: string): void;
  quotaSnapshot(): Array<{ jobId: string; ownerId: string; admittedAt: number; state: 'reserved' | 'consumed' }>;
  close(): void;
}

function serializableJob(job: Job): StoredJob {
  const { childProcess: _childProcess, waiters: _waiters, ...rest } = job;
  return rest;
}

function loadJobs(database: Database): StoredJob[] {
  const rows = readStateCollection(database, 'jobs');
  const timelines = new Map<string, unknown>();
  for (const value of readStateCollection(database, 'job_timelines')) {
    if (typeof value !== 'object' || value === null || typeof (value as { jobId?: unknown }).jobId !== 'string') throw new Error('persisted job timeline record is malformed');
    timelines.set((value as { jobId: string }).jobId, (value as { events?: unknown }).events);
  }
  const jobs: StoredJob[] = [];
  for (const value of rows) {
    if (typeof value !== 'object' || value === null) throw new Error('persisted job record is malformed');
    const job = value as StoredJob;
    if (typeof job.id !== 'string' || !['queued', 'running', 'done', 'failed'].includes(job.status)) throw new Error('persisted job record is malformed');
    const timeline = timelines.get(job.id);
    jobs.push(Array.isArray(timeline) && !job.timeline ? { ...job, timeline: timeline as Job['timeline'] } : job);
  }
  return jobs;
}

function replaceJobs(database: Database, jobs: Iterable<Job>): void {
  const values = [...jobs];
  replaceStateCollections(database, [
    { table: 'jobs', rows: values.map((job) => ({ id: job.id, payload: serializableJob(job), updatedAt: job.finishedAt ?? job.startedAt ?? job.createdAt })) },
    { table: 'job_timelines', rows: values.map((job) => ({ id: job.id, payload: { jobId: job.id, events: job.timeline ?? [] }, updatedAt: job.finishedAt ?? job.startedAt ?? job.createdAt })) },
  ]);
}

function quotaUsage(database: Database, ownerId: string, limit: number | undefined, now: number): DecryptQuotaUsage {
  const normalizedOwnerId = ownerId.trim().toLowerCase();
  const rows = database.query('SELECT admitted_at FROM decrypt_quota_ledger WHERE owner_id = ? AND admitted_at > ? ORDER BY admitted_at ASC').all(normalizedOwnerId, now - QUOTA_WINDOW_MS) as Array<{ admitted_at: number }>;
  const used = rows.length;
  return {
    limit: limit ?? null,
    used,
    remaining: limit === undefined ? null : Math.max(0, limit - used),
    nextAvailableAt: limit !== undefined && used >= limit ? rows[used - limit]?.admitted_at + QUOTA_WINDOW_MS : undefined,
  };
}

function admitJob(database: Database, job: Job, ownerId: string, limit: number | undefined): void {
  const normalizedOwnerId = ownerId.trim().toLowerCase();
  database.exec('BEGIN IMMEDIATE;');
  try {
    const usage = quotaUsage(database, normalizedOwnerId, limit, job.createdAt);
    if (limit !== undefined && usage.used >= limit) throw new DailyDecryptLimitError(usage.nextAvailableAt ?? job.createdAt + QUOTA_WINDOW_MS);
    database.query(`
      INSERT INTO jobs (
        id, payload, updated_at, status, bundle_id, external_version_id, testflight_build_id,
        project_id, source, priority, created_at, started_at, finished_at, attempt, deadline_at,
        failure_class, correlation_id, device_id, file_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(job.id, JSON.stringify(serializableJob(job)), job.createdAt, job.status, job.bundleId, job.externalVersionId ?? null, job.testflight?.build.id ?? null, job.projectId ?? 'default', job.source, job.priority, job.createdAt, null, null, job.attempt ?? null, job.deadlineAt ?? null, null, job.correlationId ?? null, null, null);
    database.query('INSERT INTO job_timelines (id, payload, updated_at) VALUES (?, ?, ?)').run(job.id, JSON.stringify({ jobId: job.id, events: job.timeline ?? [] }), job.createdAt);
    database.query('INSERT INTO decrypt_quota_ledger (job_id, owner_id, admitted_at, state) VALUES (?, ?, ?, ?)').run(job.id, normalizedOwnerId, job.createdAt, 'reserved');
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

function reconcileQuota(database: Database): void {
  database.exec("UPDATE decrypt_quota_ledger SET state = 'consumed' WHERE state = 'reserved' AND job_id IN (SELECT id FROM jobs WHERE status = 'done')");
  database.exec("DELETE FROM decrypt_quota_ledger WHERE state = 'reserved' AND job_id NOT IN (SELECT id FROM jobs WHERE status IN ('queued', 'running', 'done'))");
}

export function createJobRepository(database: Database): JobRepository {
  return {
    load: () => loadJobs(database),
    replace: (jobs) => replaceJobs(database, jobs),
    findActiveId(lookup) {
      const row = database.query(`
        SELECT id
        FROM jobs
        WHERE ${exactBuildFilter}
          AND status IN ('queued', 'running')
        ORDER BY updated_at DESC
        LIMIT 1;
      `).get(lookup.projectId, lookup.bundleId, lookup.externalVersionId ?? null, lookup.testFlightBuildId ?? null) as { id?: string } | null;
      return row?.id;
    },
    findReusableCompletedIds(lookup) {
      const rows = database.query(`
        SELECT id
        FROM jobs
        WHERE ${exactBuildFilter}
          AND status = 'done'
          AND file_path IS NOT NULL
          AND file_path != ''
        ORDER BY updated_at DESC;
      `).all(lookup.projectId, lookup.bundleId, lookup.externalVersionId ?? null, lookup.testFlightBuildId ?? null) as Array<{ id: string }>;
      return rows.map((row) => row.id);
    },
    quotaUsage: (ownerId, limit, now = Date.now()) => quotaUsage(database, ownerId, limit, now),
    quotaJournal(ownerId, limit = 10_000) {
      const rows = database.query(`
        SELECT ledger.job_id, ledger.owner_id, ledger.admitted_at, ledger.state,
          jobs.bundle_id, jobs.project_id, jobs.source, jobs.status,
          json_extract(jobs.payload, '$.versionLabel') AS version_label,
          json_extract(jobs.payload, '$.executionPath') AS execution_path
        FROM decrypt_quota_ledger AS ledger
        LEFT JOIN jobs ON jobs.id = ledger.job_id
        WHERE ledger.owner_id = ?
        ORDER BY ledger.admitted_at DESC, ledger.job_id DESC
        LIMIT ?
      `).all(ownerId.trim().toLowerCase(), Math.max(1, Math.min(10_000, Math.floor(limit)))) as Array<{
        job_id: string; owner_id: string; admitted_at: number; state: 'reserved' | 'consumed'; bundle_id?: string; project_id?: string; source?: string; status?: string; version_label?: string; execution_path?: string;
      }>;
      return rows.map((row) => ({ jobId: row.job_id, ownerId: row.owner_id, admittedAt: row.admitted_at, state: row.state, bundleId: row.bundle_id, projectId: row.project_id, source: row.source, status: row.status, versionLabel: row.version_label, executionPath: row.execution_path }));
    },
    admit: (job, ownerId, limit) => admitJob(database, job, ownerId, limit),
    settleQuota(jobId, success) {
      if (success) database.query("UPDATE decrypt_quota_ledger SET state = 'consumed' WHERE job_id = ? AND state = 'reserved'").run(jobId);
      else database.query("DELETE FROM decrypt_quota_ledger WHERE job_id = ? AND state = 'reserved'").run(jobId);
    },
    reconcileQuota: () => reconcileQuota(database),
    mergeQuotaOwner: (targetUserId, sourceUserId) => { database.query('UPDATE decrypt_quota_ledger SET owner_id = ? WHERE owner_id = ?').run(targetUserId.trim().toLowerCase(), sourceUserId.trim().toLowerCase()); },
    quotaSnapshot: () => (database.query('SELECT job_id, owner_id, admitted_at, state FROM decrypt_quota_ledger').all() as Array<{ job_id: string; owner_id: string; admitted_at: number; state: 'reserved' | 'consumed' }>).map((row) => ({ jobId: row.job_id, ownerId: row.owner_id, admittedAt: row.admitted_at, state: row.state })),
    close: () => database.close(),
  };
}

const repository = createJobRepository(openStateCollectionDatabase(
  { stateDir: config.stateDir, filename: config.stateDatabaseFile, busyTimeoutMs: config.stateDbBusyTimeoutMs },
  ['jobs', 'job_timelines'],
));

export function loadPersistedJobs(): StoredJob[] {
  return repository.load();
}

export function replacePersistedJobs(jobs: Iterable<Job>): void {
  repository.replace(jobs);
}

export function findPersistedActiveJobId(lookup: JobBuildLookup): string | undefined {
  return repository.findActiveId(lookup);
}

export function findPersistedReusableCompletedJobIds(lookup: JobBuildLookup): string[] {
  return repository.findReusableCompletedIds(lookup);
}

export function closePersistedJobs(): void {
  repository.close();
}

export function getDecryptQuotaUsage(ownerId: string, limit: number | undefined, now = Date.now()): DecryptQuotaUsage {
  return repository.quotaUsage(ownerId, limit, now);
}

export function getDecryptQuotaJournal(ownerId: string, limit = 10_000): ReturnType<JobRepository['quotaJournal']> {
  return repository.quotaJournal(ownerId, limit);
}

export function admitQuotaJob(job: Job, ownerId: string, limit: number | undefined): void {
  repository.admit(job, ownerId, limit);
}

export function settleDecryptQuota(jobId: string, success: boolean): void {
  repository.settleQuota(jobId, success);
}

export function reconcileDecryptQuota(): void {
  repository.reconcileQuota();
}

export function mergeDecryptQuotaOwner(targetUserId: string, sourceUserId: string): void {
  repository.mergeQuotaOwner(targetUserId, sourceUserId);
}

export function exportDecryptQuotaLedger(): ReturnType<JobRepository['quotaSnapshot']> {
  return repository.quotaSnapshot();
}
