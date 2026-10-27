import { config } from '#config.js';
import type { Job } from '#jobs/types.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';
import type { Database, SQLQueryBindings } from 'bun:sqlite';

type StoredJob = Omit<Job, 'childProcess' | 'waiters'>;
const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
const FREE_QUOTA_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface DecryptQuotaUsage {
  limit: number | null;
  used: number;
  remaining: number | null;
  nextAvailableAt?: number;
  windowMs?: number;
}

export interface FreeDecryptQuotaCompletion {
  ownerId: string;
  completedAt: number;
}

export interface DecryptCreditBalance {
  available: number;
  grants: Array<{ id: string; remaining: number; expiresAt?: number; source: string }>;
}

export class DailyDecryptLimitError extends Error {
  readonly statusCode = 429;
  readonly code = 'daily_decrypt_limit';

  constructor(readonly nextAvailableAt: number) {
    super('daily decrypt allowance exhausted');
    this.name = 'DailyDecryptLimitError';
  }
}

export class FreeDecryptLimitError extends Error {
  readonly statusCode = 429;
  readonly code = 'free_decrypt_limit';

  constructor(readonly nextAvailableAt: number) {
    super('free decrypt allowance exhausted');
    this.name = 'FreeDecryptLimitError';
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

export interface JobWorkerLease {
  jobId: string;
  workerId: string;
  resourceId: string;
  generation: number;
  leaseUntil: number;
}

export interface WorkerRuntimeConfiguration {
  runtimeVersion: string;
  offlineConcurrency: number;
  maxJobWaitSeconds: number;
  maxRetries: number;
  databaseBusyTimeoutMs: number;
}

export interface PersistedWorkerInstance {
  workerId: string;
  startedAt: number;
  heartbeatAt: number;
  state: 'active' | 'draining' | 'drained' | 'offline';
  configuration: WorkerRuntimeConfiguration;
  activeLeases: number;
  resources: string[];
}

export function sharedOfflineWorkerCapacity(workers: readonly PersistedWorkerInstance[]): number {
  return workers.reduce((capacity, worker) =>
    worker.state === 'active' ? Math.max(capacity, worker.configuration.offlineConcurrency) : capacity, 0);
}

export function workerRuntimeConfigurationConsistent(workers: readonly PersistedWorkerInstance[]): boolean {
  const liveWorkers = workers.filter((worker) => worker.state === 'active' || worker.state === 'draining');
  return new Set(liveWorkers.map((worker) => JSON.stringify(worker.configuration))).size <= 1;
}

export interface JobRepository {
  load(): StoredJob[];
  loadActive(): StoredJob[];
  findById(jobId: string): StoredJob | undefined;
  replace(jobs: Iterable<Job>, workerId?: string): string[];
  delete(jobId: string): boolean;
  requestCancellation(jobId: string, cancelledBy: string, now?: number): StoredJob | undefined;
  findActiveId(lookup: JobBuildLookup): string | undefined;
  findReusableCompletedIds(lookup: JobBuildLookup): string[];
  claimWorker(jobId: string, workerId: string, resourceId: string, leaseMs: number, now?: number): JobWorkerLease | undefined;
  renewWorker(lease: JobWorkerLease, leaseMs: number, now?: number): boolean;
  releaseWorker(lease: JobWorkerLease): void;
  releaseWorkersById(workerId: string): void;
  isResourceActive(resourceId: string, now?: number): boolean;
  listExpiredRunning(now?: number): StoredJob[];
  requeueExpiredRunning(job: Job, now?: number): boolean;
  countActiveWorkers(resourcePrefix: string, now?: number): number;
  registerWorker(workerId: string, configuration: WorkerRuntimeConfiguration, now?: number): void;
  heartbeatWorker(workerId: string, configuration: WorkerRuntimeConfiguration, now?: number): void;
  listWorkers(now?: number, staleAfterMs?: number): PersistedWorkerInstance[];
  setWorkerDrain(workerId: string, draining: boolean, now?: number, staleAfterMs?: number): boolean;
  markWorkerOffline(workerId: string): void;
  countRunningJobs(filter: { queuedBy?: string; apiKeyId?: string }): number;
  quotaUsage(ownerId: string, limit: number | undefined, now?: number): DecryptQuotaUsage;
  freeQuotaUsage(ownerId: string, now?: number): DecryptQuotaUsage;
  freeQuotaCompletions(now?: number): FreeDecryptQuotaCompletion[];
  replaceFreeQuotaCompletions(completions: readonly FreeDecryptQuotaCompletion[]): void;
  deleteFreeQuotaOwner(ownerId: string): void;
  quotaJournal(ownerId: string, limit?: number): Array<{ jobId: string; ownerId: string; admittedAt: number; state: 'reserved' | 'consumed'; bundleId?: string; projectId?: string; source?: string; status?: string; versionLabel?: string; executionPath?: string }>;
  quotaReceipt(jobId: string, ownerId: string): { admittedAt: number; state: 'reserved' | 'consumed' } | undefined;
  admit(job: Job, ownerId?: string, limit?: number, freeTier?: boolean): string;
  settleQuota(jobId: string, success: boolean): void;
  reconcileQuota(): void;
  mergeQuotaOwner(targetUserId: string, sourceUserId: string): void;
  quotaSnapshot(): Array<{ jobId: string; ownerId: string; admittedAt: number; state: 'reserved' | 'consumed' }>;
  creditBalance(ownerId: string, now?: number): DecryptCreditBalance;
  grantCredits(ownerId: string, quantity: number, source: 'stripe' | 'outage' | 'manual', reference: string, expiresAt?: number, now?: number): { id: string; granted: boolean };
  findStripeCreditOwner(paymentIntentId: string): string | undefined;
  revokeStripeCreditGrant(ownerId: string, paymentIntentId: string, quantity?: number, now?: number): { id: string; revoked: boolean };
  close(): void;
}

function serializableJob(job: Job): StoredJob {
  const { childProcess: _childProcess, waiters: _waiters, ...rest } = job;
  return rest;
}

function loadJobs(database: Database, knownPayloads: Map<string, string>, activeOnly = false): StoredJob[] {
  const rows = activeOnly
    ? database.query(`
        SELECT jobs.id, jobs.payload, job_timelines.payload AS timeline_payload
        FROM jobs LEFT JOIN job_timelines ON job_timelines.id = jobs.id
        WHERE jobs.status IN ('queued', 'running')
        ORDER BY jobs.created_at, jobs.id;
      `).all() as Array<{ id: string; payload: string; timeline_payload?: string }>
    : database.query(`
        SELECT jobs.id, jobs.payload, job_timelines.payload AS timeline_payload
        FROM jobs LEFT JOIN job_timelines ON job_timelines.id = jobs.id
        ORDER BY jobs.created_at, jobs.id;
      `).all() as Array<{ id: string; payload: string; timeline_payload?: string }>;
  const jobs: StoredJob[] = [];
  for (const row of rows) {
    const job = JSON.parse(row.payload) as StoredJob;
    if (typeof job.id !== 'string' || job.id !== row.id || !['queued', 'running', 'done', 'failed'].includes(job.status)) throw new Error('persisted job record is malformed');
    knownPayloads.set(job.id, row.payload);
    const timelineRecord = row.timeline_payload ? JSON.parse(row.timeline_payload) as { events?: unknown } : undefined;
    jobs.push(Array.isArray(timelineRecord?.events) && !job.timeline ? { ...job, timeline: timelineRecord.events as Job['timeline'] } : job);
  }
  return jobs;
}

function replaceJobs(database: Database, jobs: Iterable<Job>, knownPayloads: Map<string, string>, workerId?: string): string[] {
  const conflicts: string[] = [];
  database.exec('BEGIN IMMEDIATE;');
  try {
    for (const job of jobs) {
      const record = serializableJob(job);
      const payload = JSON.stringify(record);
      const expectedPayload = knownPayloads.get(job.id);
      if (expectedPayload === payload) continue;
      const updatedAt = Date.now();
      const values = indexedJobValues(job, payload, updatedAt);
      let changes = 0;
      if (expectedPayload === undefined) {
        const result = database.query(`
          INSERT INTO jobs (
            id, payload, updated_at, status, bundle_id, external_version_id, testflight_build_id,
            project_id, source, priority, created_at, started_at, finished_at, attempt, deadline_at,
            failure_class, correlation_id, device_id, file_path
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING;
        `).run(...values);
        changes = result.changes;
      } else {
        const result = database.query(`
          UPDATE jobs SET
            payload = ?, updated_at = ?, status = ?, bundle_id = ?, external_version_id = ?,
            testflight_build_id = ?, project_id = ?, source = ?, priority = ?, created_at = ?,
            started_at = ?, finished_at = ?, attempt = ?, deadline_at = ?, failure_class = ?,
            correlation_id = ?, device_id = ?, file_path = ?
          WHERE id = ? AND payload = ?
            AND (? = 1 OR EXISTS (
              SELECT 1 FROM job_worker_leases
              WHERE job_worker_leases.job_id = jobs.id
                AND job_worker_leases.worker_id = ?
                AND job_worker_leases.lease_until > ?
            ));
        `).run(...values.slice(1), job.id, expectedPayload, job.startedAt === undefined ? 1 : 0, workerId ?? '', Date.now());
        changes = result.changes;
      }
      if (changes === 0) {
        conflicts.push(job.id);
        continue;
      }
      writeJobTimeline(database, job, updatedAt);
      if (job.status !== 'running') database.query('DELETE FROM job_worker_leases WHERE job_id = ?;').run(job.id);
      knownPayloads.set(job.id, payload);
    }
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
  return conflicts;
}

function indexedJobValues(job: Job, payload: string, updatedAt: number): SQLQueryBindings[] {
  return [
    job.id,
    payload,
    updatedAt,
    job.status,
    job.bundleId,
    job.externalVersionId ?? null,
    job.testflight?.build.id ?? null,
    job.projectId ?? 'default',
    job.source,
    job.priority,
    job.createdAt,
    job.startedAt ?? null,
    job.finishedAt ?? null,
    job.attempt ?? null,
    job.deadlineAt ?? null,
    job.failureClass ?? null,
    job.correlationId ?? null,
    job.deviceId ?? null,
    job.filePath ?? null,
  ];
}

function writeJobTimeline(database: Database, job: Job, updatedAt: number): void {
  database.query(`
    INSERT INTO job_timelines (id, payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at;
  `).run(job.id, JSON.stringify({ jobId: job.id, events: job.timeline ?? [] }), updatedAt);
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

function freeQuotaUsage(database: Database, ownerId: string, now: number): DecryptQuotaUsage {
  const normalizedOwnerId = ownerId.trim().toLowerCase();
  const cutoff = now - FREE_QUOTA_WINDOW_MS;
  database.query('DELETE FROM free_decrypt_quota WHERE completed_at <= ?').run(cutoff);
  const rows = database.query(`
    SELECT COALESCE(completed_at, reserved_at) AS window_start
    FROM free_decrypt_quota
    WHERE owner_id = ? AND (completed_at > ? OR job_id IS NOT NULL)
    ORDER BY COALESCE(completed_at, reserved_at) ASC, id ASC;
  `).all(normalizedOwnerId, cutoff) as Array<{ window_start: number }>;
  const used = rows.length;
  const oldestBlockingRecord = used >= 3 ? rows[used - 3] : undefined;
  return {
    limit: 3,
    used,
    remaining: Math.max(0, 3 - used),
    nextAvailableAt: oldestBlockingRecord ? oldestBlockingRecord.window_start + FREE_QUOTA_WINDOW_MS : undefined,
  };
}

function freeQuotaCompletions(database: Database, now: number): FreeDecryptQuotaCompletion[] {
  const cutoff = now - FREE_QUOTA_WINDOW_MS;
  database.query('DELETE FROM free_decrypt_quota WHERE completed_at <= ?').run(cutoff);
  return (database.query(`
    SELECT owner_id, completed_at
    FROM free_decrypt_quota
    WHERE job_id IS NULL AND completed_at > ?
    ORDER BY owner_id, completed_at, id;
  `).all(cutoff) as Array<{ owner_id: string; completed_at: number }>).map((row) => ({
    ownerId: row.owner_id,
    completedAt: row.completed_at,
  }));
}

function replaceFreeQuotaCompletions(database: Database, completions: readonly FreeDecryptQuotaCompletion[]): void {
  database.query('DELETE FROM free_decrypt_quota').run();
  const insert = database.query('INSERT INTO free_decrypt_quota (owner_id, job_id, reserved_at, completed_at) VALUES (?, NULL, NULL, ?)');
  for (const completion of completions) {
    insert.run(completion.ownerId.trim().toLowerCase(), completion.completedAt);
  }
}

function admitJob(database: Database, job: Job, ownerId?: string, limit?: number, freeTier = false): string {
  const normalizedOwnerId = ownerId?.trim().toLowerCase();
  database.exec('BEGIN IMMEDIATE;');
  try {
    const existing = database.query(`
      SELECT id FROM jobs
      WHERE ${exactBuildFilter} AND status IN ('queued', 'running')
        AND (
          (? = 1 AND json_extract(payload, '$.freeTierResult') = 1 AND lower(json_extract(payload, '$.billingOwnerId')) = ?)
          OR (? = 0 AND COALESCE(json_extract(payload, '$.freeTierResult'), 0) != 1)
        )
      ORDER BY updated_at DESC LIMIT 1;
    `).get(job.projectId ?? 'default', job.bundleId, job.externalVersionId ?? null, job.testflight?.build.id ?? null, Number(freeTier), normalizedOwnerId ?? '', Number(freeTier)) as { id: string } | null;
    if (existing) {
      database.exec('COMMIT;');
      return existing.id;
    }
    if (normalizedOwnerId && freeTier) {
      const usage = freeQuotaUsage(database, normalizedOwnerId, job.createdAt);
      if (usage.used >= 3) throw new FreeDecryptLimitError(usage.nextAvailableAt ?? job.createdAt + FREE_QUOTA_WINDOW_MS);
    }
    if (normalizedOwnerId) {
      const usage = freeTier ? undefined : quotaUsage(database, normalizedOwnerId, limit, job.createdAt);
      if (!freeTier && limit !== undefined && usage!.used >= limit) {
        const credit = database.query(`
          SELECT id, payload FROM decrypt_credit_records
          WHERE json_extract(payload, '$.type') = 'grant'
            AND json_extract(payload, '$.ownerId') = ?
            AND json_extract(payload, '$.remaining') > 0
            AND (json_type(payload, '$.expiresAt') IS NULL OR json_extract(payload, '$.expiresAt') > ?)
          ORDER BY updated_at ASC, id ASC LIMIT 1;
        `).get(normalizedOwnerId, job.createdAt) as { id: string; payload: string } | null;
        if (!credit) throw new DailyDecryptLimitError(usage!.nextAvailableAt ?? job.createdAt + QUOTA_WINDOW_MS);
        const grant = JSON.parse(credit.payload) as { remaining: number };
        const updatedGrant = { ...JSON.parse(credit.payload), remaining: grant.remaining - 1 };
        database.query('UPDATE decrypt_credit_records SET payload = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(updatedGrant), job.createdAt, credit.id);
        const usageId = `usage:${job.id}`;
        database.query('INSERT INTO decrypt_credit_records (id, payload, updated_at) VALUES (?, ?, ?)').run(usageId, JSON.stringify({ id: usageId, type: 'usage', ownerId: normalizedOwnerId, jobId: job.id, grantId: credit.id, state: 'reserved', createdAt: job.createdAt }), job.createdAt);
      }
    }
    database.query(`
      INSERT INTO jobs (
        id, payload, updated_at, status, bundle_id, external_version_id, testflight_build_id,
        project_id, source, priority, created_at, started_at, finished_at, attempt, deadline_at,
        failure_class, correlation_id, device_id, file_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(job.id, JSON.stringify(serializableJob(job)), job.createdAt, job.status, job.bundleId, job.externalVersionId ?? null, job.testflight?.build.id ?? null, job.projectId ?? 'default', job.source, job.priority, job.createdAt, null, null, job.attempt ?? null, job.deadlineAt ?? null, null, job.correlationId ?? null, null, null);
    database.query('INSERT INTO job_timelines (id, payload, updated_at) VALUES (?, ?, ?)').run(job.id, JSON.stringify({ jobId: job.id, events: job.timeline ?? [] }), job.createdAt);
    if (normalizedOwnerId && freeTier) database.query('INSERT INTO free_decrypt_quota (owner_id, job_id, reserved_at, completed_at) VALUES (?, ?, ?, NULL)').run(normalizedOwnerId, job.id, job.createdAt);
    else if (normalizedOwnerId) database.query('INSERT INTO decrypt_quota_ledger (job_id, owner_id, admitted_at, state) VALUES (?, ?, ?, ?)').run(job.id, normalizedOwnerId, job.createdAt, 'reserved');
    database.exec('COMMIT;');
    return job.id;
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

function reconcileQuota(database: Database): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec("UPDATE decrypt_quota_ledger SET state = 'consumed' WHERE state = 'reserved' AND job_id IN (SELECT id FROM jobs WHERE status = 'done')");
    database.exec("UPDATE decrypt_credit_records SET payload = json_set(payload, '$.state', 'consumed') WHERE json_extract(payload, '$.type') = 'usage' AND json_extract(payload, '$.state') = 'reserved' AND json_extract(payload, '$.jobId') IN (SELECT id FROM jobs WHERE status = 'done')");
    const reservations = database.query(`
      SELECT id, payload FROM decrypt_credit_records
      WHERE json_extract(payload, '$.type') = 'usage' AND json_extract(payload, '$.state') = 'reserved'
        AND json_extract(payload, '$.jobId') NOT IN (SELECT id FROM jobs WHERE status IN ('queued', 'running', 'done'))
    `).all() as Array<{ id: string; payload: string }>;
    for (const reservation of reservations) {
      const usage = JSON.parse(reservation.payload) as { grantId: string };
      const grantRow = database.query('SELECT payload FROM decrypt_credit_records WHERE id = ?').get(usage.grantId) as { payload: string } | null;
      if (grantRow) {
        const grant = JSON.parse(grantRow.payload) as { remaining: number };
        if (!('refundedAt' in grant)) {
          database.query('UPDATE decrypt_credit_records SET payload = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ ...grant, remaining: grant.remaining + 1 }), Date.now(), usage.grantId);
        }
      }
      database.query('DELETE FROM decrypt_credit_records WHERE id = ?').run(reservation.id);
    }
    database.exec("DELETE FROM decrypt_quota_ledger WHERE state = 'reserved' AND job_id NOT IN (SELECT id FROM jobs WHERE status IN ('queued', 'running', 'done'))");
    database.query(`
      UPDATE free_decrypt_quota
      SET job_id = NULL, reserved_at = NULL,
          completed_at = COALESCE((SELECT finished_at FROM jobs WHERE jobs.id = free_decrypt_quota.job_id), ?)
      WHERE job_id IN (SELECT id FROM jobs WHERE status = 'done');
    `).run(Date.now());
    database.exec("DELETE FROM free_decrypt_quota WHERE job_id NOT IN (SELECT id FROM jobs WHERE status IN ('queued', 'running', 'done'))");
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

export function createJobRepository(database: Database): JobRepository {
  const knownPayloads = new Map<string, string>();
  return {
    load() {
      knownPayloads.clear();
      return loadJobs(database, knownPayloads);
    },
    loadActive: () => loadJobs(database, knownPayloads, true),
    findById(jobId) {
      const row = database.query(`
        SELECT jobs.id, jobs.payload, job_timelines.payload AS timeline_payload
        FROM jobs LEFT JOIN job_timelines ON job_timelines.id = jobs.id
        WHERE jobs.id = ?;
      `).get(jobId) as { id: string; payload: string; timeline_payload?: string } | null;
      if (!row) return undefined;
      const job = JSON.parse(row.payload) as StoredJob;
      if (typeof job.id !== 'string' || job.id !== row.id || !['queued', 'running', 'done', 'failed'].includes(job.status)) throw new Error('persisted job record is malformed');
      knownPayloads.set(job.id, row.payload);
      const timelineRecord = row.timeline_payload ? JSON.parse(row.timeline_payload) as { events?: unknown } : undefined;
      return Array.isArray(timelineRecord?.events) && !job.timeline ? { ...job, timeline: timelineRecord.events as Job['timeline'] } : job;
    },
    replace: (jobs, workerId) => replaceJobs(database, jobs, knownPayloads, workerId),
    delete(jobId) {
      const expectedPayload = knownPayloads.get(jobId);
      if (expectedPayload === undefined) return false;
      database.exec('BEGIN IMMEDIATE;');
      try {
        const result = database.query(`
          DELETE FROM jobs
          WHERE id = ? AND payload = ? AND status IN ('done', 'failed')
            AND NOT EXISTS (
              SELECT 1 FROM job_worker_leases
              WHERE job_worker_leases.job_id = jobs.id AND job_worker_leases.lease_until > ?
            );
        `).run(jobId, expectedPayload, Date.now());
        if (result.changes === 1) database.query('DELETE FROM job_timelines WHERE id = ?;').run(jobId);
        database.exec('COMMIT;');
        if (result.changes === 1) knownPayloads.delete(jobId);
        return result.changes === 1;
      } catch (error) {
        database.exec('ROLLBACK;');
        throw error;
      }
    },
    requestCancellation(jobId, cancelledBy, now = Date.now()) {
      database.exec('BEGIN IMMEDIATE;');
      try {
        const row = database.query('SELECT payload, status FROM jobs WHERE id = ?;').get(jobId) as { payload: string; status: string } | null;
        if (!row || row.status !== 'running') {
          database.exec('COMMIT;');
          return undefined;
        }
        const job = JSON.parse(row.payload) as Job;
        if (job.cancelledBy) {
          database.exec('COMMIT;');
          knownPayloads.set(jobId, row.payload);
          return job;
        }
        const updated = {
          ...job,
          cancelledBy,
          progress: 'cancelling…',
          timeline: [...(job.timeline ?? []), { at: now, label: 'cancelling…', status: 'running' as const }],
        };
        const payload = JSON.stringify(updated);
        const values = indexedJobValues(updated, payload, now);
        const result = database.query(`
          UPDATE jobs SET
            payload = ?, updated_at = ?, status = ?, bundle_id = ?, external_version_id = ?,
            testflight_build_id = ?, project_id = ?, source = ?, priority = ?, created_at = ?,
            started_at = ?, finished_at = ?, attempt = ?, deadline_at = ?, failure_class = ?,
            correlation_id = ?, device_id = ?, file_path = ?
          WHERE id = ? AND status = 'running' AND payload = ?;
        `).run(...values.slice(1), jobId, row.payload);
        if (result.changes !== 1) {
          database.exec('COMMIT;');
          return undefined;
        }
        writeJobTimeline(database, updated, now);
        database.exec('COMMIT;');
        knownPayloads.set(jobId, payload);
        return updated;
      } catch (error) {
        database.exec('ROLLBACK;');
        throw error;
      }
    },
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
    claimWorker(jobId, workerId, resourceId, leaseMs, now = Date.now()) {
      database.exec('BEGIN IMMEDIATE;');
      try {
        const worker = database.query('SELECT state, heartbeat_at FROM worker_instances WHERE worker_id = ?;').get(workerId) as { state: string; heartbeat_at: number } | null;
        if (!worker || worker.state !== 'active' || worker.heartbeat_at <= now - 20_000) {
          database.exec('COMMIT;');
          return undefined;
        }
        const job = database.query('SELECT payload, status FROM jobs WHERE id = ?;').get(jobId) as { payload: string; status: string } | null;
        const expectedPayload = knownPayloads.get(jobId);
        if (!job || job.status !== 'queued' || expectedPayload === undefined || job.payload !== expectedPayload) {
          database.exec('COMMIT;');
          return undefined;
        }
        const activeResource = database.query('SELECT job_id FROM job_worker_leases WHERE resource_id = ? AND lease_until > ?;').get(resourceId, now) as { job_id: string } | null;
        if (activeResource) {
          database.exec('COMMIT;');
          return undefined;
        }
        const activeJob = database.query('SELECT job_id FROM job_worker_leases WHERE job_id = ? AND lease_until > ?;').get(jobId, now) as { job_id: string } | null;
        if (activeJob) {
          database.exec('COMMIT;');
          return undefined;
        }
        const priorResource = database.query('SELECT generation FROM job_worker_generations WHERE resource_id = ?;').get(resourceId) as { generation: number } | null;
        const generation = (priorResource?.generation ?? 0) + 1;
        database.query(`
          INSERT INTO job_worker_generations (resource_id, generation) VALUES (?, ?)
          ON CONFLICT(resource_id) DO UPDATE SET generation = excluded.generation;
        `).run(resourceId, generation);
        const storedJob = JSON.parse(job.payload) as Job;
        const claimedJob = { ...storedJob, status: 'running' as const, startedAt: storedJob.startedAt ?? now };
        const payload = JSON.stringify(claimedJob);
        const values = indexedJobValues(claimedJob, payload, now);
        database.query('DELETE FROM job_worker_leases WHERE (job_id = ? OR resource_id = ?) AND lease_until <= ?;').run(jobId, resourceId, now);
        database.query(`
          INSERT INTO job_worker_leases (job_id, worker_id, resource_id, generation, lease_until, updated_at)
          VALUES (?, ?, ?, ?, ?, ?);
        `).run(jobId, workerId, resourceId, generation, now + leaseMs, now);
        const changed = database.query(`
          UPDATE jobs SET
            payload = ?, updated_at = ?, status = ?, bundle_id = ?, external_version_id = ?,
            testflight_build_id = ?, project_id = ?, source = ?, priority = ?, created_at = ?,
            started_at = ?, finished_at = ?, attempt = ?, deadline_at = ?, failure_class = ?,
            correlation_id = ?, device_id = ?, file_path = ?
          WHERE id = ? AND payload = ? AND status = 'queued';
        `).run(...values.slice(1), jobId, expectedPayload);
        if (changed.changes !== 1) {
          database.query('DELETE FROM job_worker_leases WHERE job_id = ? AND worker_id = ? AND resource_id = ? AND generation = ?;').run(jobId, workerId, resourceId, generation);
          database.exec('COMMIT;');
          return undefined;
        }
        database.exec('COMMIT;');
        knownPayloads.set(jobId, payload);
        return { jobId, workerId, resourceId, generation, leaseUntil: now + leaseMs };
      } catch (error) {
        database.exec('ROLLBACK;');
        throw error;
      }
    },
    renewWorker(lease, leaseMs, now = Date.now()) {
      const result = database.query(`
        UPDATE job_worker_leases SET lease_until = ?, updated_at = ?
        WHERE job_id = ? AND worker_id = ? AND resource_id = ? AND generation = ? AND lease_until > ?;
      `).run(now + leaseMs, now, lease.jobId, lease.workerId, lease.resourceId, lease.generation, now);
      return result.changes === 1;
    },
    releaseWorker(lease) {
      database.query('DELETE FROM job_worker_leases WHERE job_id = ? AND worker_id = ? AND resource_id = ? AND generation = ?;').run(lease.jobId, lease.workerId, lease.resourceId, lease.generation);
    },
    releaseWorkersById(workerId) {
      database.query('DELETE FROM job_worker_leases WHERE worker_id = ?;').run(workerId);
    },
    isResourceActive(resourceId, now = Date.now()) {
      return Boolean(database.query('SELECT 1 AS active FROM job_worker_leases WHERE resource_id = ? AND lease_until > ?;').get(resourceId, now));
    },
    listExpiredRunning(now = Date.now()) {
      const rows = database.query(`
        SELECT jobs.payload FROM jobs
        WHERE jobs.status = 'running'
          AND NOT EXISTS (
            SELECT 1 FROM job_worker_leases
            WHERE job_worker_leases.job_id = jobs.id AND job_worker_leases.lease_until > ?
          );
      `).all(now) as Array<{ payload: string }>;
      return rows.map(({ payload }) => JSON.parse(payload) as StoredJob);
    },
    requeueExpiredRunning(job, now = Date.now()) {
      const record = serializableJob(job);
      const expectedPayload = knownPayloads.get(job.id);
      if (expectedPayload === undefined) return false;
      const payload = JSON.stringify(record);
      database.exec('BEGIN IMMEDIATE;');
      try {
        const changed = database.query(`
          UPDATE jobs SET
            payload = ?, updated_at = ?, status = ?, bundle_id = ?, external_version_id = ?,
            testflight_build_id = ?, project_id = ?, source = ?, priority = ?, created_at = ?,
            started_at = ?, finished_at = ?, attempt = ?, deadline_at = ?, failure_class = ?,
            correlation_id = ?, device_id = ?, file_path = ?
          WHERE id = ? AND status = 'running' AND payload = ?
            AND NOT EXISTS (
              SELECT 1 FROM job_worker_leases
              WHERE job_worker_leases.job_id = jobs.id AND job_worker_leases.lease_until > ?
            );
        `).run(...indexedJobValues(job, payload, now).slice(1), job.id, expectedPayload, now);
        if (changed.changes !== 1) {
          database.exec('COMMIT;');
          return false;
        }
        writeJobTimeline(database, job, now);
        database.query('DELETE FROM job_worker_leases WHERE job_id = ? AND lease_until <= ?;').run(job.id, now);
        database.exec('COMMIT;');
        knownPayloads.set(job.id, payload);
        return true;
      } catch (error) {
        database.exec('ROLLBACK;');
        throw error;
      }
    },
    countActiveWorkers(resourcePrefix, now = Date.now()) {
      const row = database.query('SELECT COUNT(*) AS count FROM job_worker_leases WHERE resource_id LIKE ? AND lease_until > ?;').get(`${resourcePrefix}%`, now) as { count?: number } | null;
      return row?.count ?? 0;
    },
    registerWorker(workerId, configuration, now = Date.now()) {
      database.query(`
        INSERT INTO worker_instances (worker_id, started_at, heartbeat_at, state, configuration)
        VALUES (?, ?, ?, 'active', ?)
        ON CONFLICT(worker_id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at, configuration = excluded.configuration;
      `).run(workerId, now, now, JSON.stringify(configuration));
    },
    heartbeatWorker(workerId, configuration, now = Date.now()) {
      database.query(`
        UPDATE worker_instances
        SET heartbeat_at = ?, configuration = ?,
          state = CASE
            WHEN state = 'draining' AND NOT EXISTS (
              SELECT 1 FROM job_worker_leases WHERE worker_id = ? AND lease_until > ?
            ) THEN 'drained'
            ELSE state
          END
        WHERE worker_id = ?;
      `).run(now, JSON.stringify(configuration), workerId, now, workerId);
    },
    listWorkers(now = Date.now(), staleAfterMs = 20_000) {
      const rows = database.query(`
        SELECT worker_instances.worker_id, worker_instances.started_at, worker_instances.heartbeat_at,
          worker_instances.state, worker_instances.configuration,
          COUNT(job_worker_leases.job_id) AS active_leases,
          GROUP_CONCAT(job_worker_leases.resource_id, char(10)) AS resources
        FROM worker_instances
        LEFT JOIN job_worker_leases ON job_worker_leases.worker_id = worker_instances.worker_id AND job_worker_leases.lease_until > ?
        GROUP BY worker_instances.worker_id
        ORDER BY worker_instances.started_at DESC;
      `).all(now) as Array<{ worker_id: string; started_at: number; heartbeat_at: number; state: string; configuration: string; active_leases: number; resources: string | null }>;
      return rows.map((row) => ({
        workerId: row.worker_id,
        startedAt: row.started_at,
        heartbeatAt: row.heartbeat_at,
        state: now - row.heartbeat_at > staleAfterMs ? 'offline' as const : row.state as PersistedWorkerInstance['state'],
        configuration: JSON.parse(row.configuration) as WorkerRuntimeConfiguration,
        activeLeases: row.active_leases,
        resources: row.resources ? row.resources.split('\n').filter(Boolean) : [],
      }));
    },
    setWorkerDrain(workerId, draining, now = Date.now(), staleAfterMs = 20_000) {
      database.exec('BEGIN IMMEDIATE;');
      try {
        const worker = database.query('SELECT heartbeat_at FROM worker_instances WHERE worker_id = ?;').get(workerId) as { heartbeat_at: number } | null;
        if (!worker || now - worker.heartbeat_at > staleAfterMs) {
          database.exec('COMMIT;');
          return false;
        }
        const hasActiveLease = database.query('SELECT 1 AS active FROM job_worker_leases WHERE worker_id = ? AND lease_until > ? LIMIT 1;').get(workerId, now);
        const state = draining ? hasActiveLease ? 'draining' : 'drained' : 'active';
        database.query('UPDATE worker_instances SET state = ? WHERE worker_id = ?;').run(state, workerId);
        database.exec('COMMIT;');
        return true;
      } catch (error) {
        database.exec('ROLLBACK;');
        throw error;
      }
    },
    markWorkerOffline(workerId) {
      database.query("UPDATE worker_instances SET state = 'offline' WHERE worker_id = ?;").run(workerId);
    },
    countRunningJobs(filter) {
      if (filter.queuedBy !== undefined) {
        const row = database.query("SELECT COUNT(*) AS count FROM jobs WHERE status = 'running' AND json_extract(payload, '$.queuedBy') = ? COLLATE NOCASE;").get(filter.queuedBy) as { count?: number } | null;
        return row?.count ?? 0;
      }
      if (filter.apiKeyId !== undefined) {
        const row = database.query("SELECT COUNT(*) AS count FROM jobs WHERE status = 'running' AND json_extract(payload, '$.apiKeyId') = ?;").get(filter.apiKeyId) as { count?: number } | null;
        return row?.count ?? 0;
      }
      return 0;
    },
    quotaUsage: (ownerId, limit, now = Date.now()) => quotaUsage(database, ownerId, limit, now),
    freeQuotaUsage: (ownerId, now = Date.now()) => freeQuotaUsage(database, ownerId, now),
    freeQuotaCompletions: (now = Date.now()) => freeQuotaCompletions(database, now),
    replaceFreeQuotaCompletions: (completions) => replaceFreeQuotaCompletions(database, completions),
    deleteFreeQuotaOwner(ownerId) {
      database.query('DELETE FROM free_decrypt_quota WHERE owner_id = ?').run(ownerId.trim().toLowerCase());
    },
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
    quotaReceipt(jobId, ownerId) {
      const row = database.query('SELECT admitted_at, state FROM decrypt_quota_ledger WHERE job_id = ? AND owner_id = ?').get(jobId, ownerId.trim().toLowerCase()) as { admitted_at: number; state: 'reserved' | 'consumed' } | null;
      return row ? { admittedAt: row.admitted_at, state: row.state } : undefined;
    },
    admit(job, ownerId, limit, freeTier) {
      const admittedId = admitJob(database, job, ownerId, limit, freeTier);
      if (admittedId === job.id) knownPayloads.set(job.id, JSON.stringify(serializableJob(job)));
      return admittedId;
    },
    settleQuota(jobId, success) {
      database.exec('BEGIN IMMEDIATE;');
      try {
        const usageRow = database.query("SELECT id, payload FROM decrypt_credit_records WHERE json_extract(payload, '$.type') = 'usage' AND json_extract(payload, '$.jobId') = ? AND json_extract(payload, '$.state') = 'reserved'").get(jobId) as { id: string; payload: string } | null;
        if (success) {
          database.query('UPDATE free_decrypt_quota SET job_id = NULL, reserved_at = NULL, completed_at = ? WHERE job_id = ?').run(Date.now(), jobId);
          database.query("UPDATE decrypt_quota_ledger SET state = 'consumed' WHERE job_id = ? AND state = 'reserved'").run(jobId);
          if (usageRow) database.query("UPDATE decrypt_credit_records SET payload = json_set(payload, '$.state', 'consumed'), updated_at = ? WHERE id = ?").run(Date.now(), usageRow.id);
        } else {
          database.query('DELETE FROM free_decrypt_quota WHERE job_id = ?').run(jobId);
          database.query("DELETE FROM decrypt_quota_ledger WHERE job_id = ? AND state = 'reserved'").run(jobId);
          if (usageRow) {
            const usage = JSON.parse(usageRow.payload) as { grantId: string };
            const grantRow = database.query('SELECT payload FROM decrypt_credit_records WHERE id = ?').get(usage.grantId) as { payload: string } | null;
            if (grantRow) {
              const grant = JSON.parse(grantRow.payload) as { remaining: number };
              if (!('refundedAt' in grant)) {
                database.query('UPDATE decrypt_credit_records SET payload = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ ...grant, remaining: grant.remaining + 1 }), Date.now(), usage.grantId);
              }
            }
            database.query('DELETE FROM decrypt_credit_records WHERE id = ?').run(usageRow.id);
          }
        }
        database.exec('COMMIT;');
      } catch (error) {
        database.exec('ROLLBACK;');
        throw error;
      }
    },
    reconcileQuota: () => reconcileQuota(database),
    mergeQuotaOwner: (targetUserId, sourceUserId) => {
      const target = targetUserId.trim().toLowerCase();
      const source = sourceUserId.trim().toLowerCase();
      database.query('UPDATE decrypt_quota_ledger SET owner_id = ? WHERE owner_id = ?').run(target, source);
      database.query('UPDATE free_decrypt_quota SET owner_id = ? WHERE owner_id = ?').run(target, source);
    },
    quotaSnapshot: () => (database.query('SELECT job_id, owner_id, admitted_at, state FROM decrypt_quota_ledger').all() as Array<{ job_id: string; owner_id: string; admitted_at: number; state: 'reserved' | 'consumed' }>).map((row) => ({ jobId: row.job_id, ownerId: row.owner_id, admittedAt: row.admitted_at, state: row.state })),
    creditBalance(ownerId, now = Date.now()) {
      const normalizedOwnerId = ownerId.trim().toLowerCase();
      const rows = database.query(`
        SELECT id, payload FROM decrypt_credit_records
        WHERE json_extract(payload, '$.type') = 'grant'
          AND json_extract(payload, '$.ownerId') = ?
          AND (json_type(payload, '$.expiresAt') IS NULL OR json_extract(payload, '$.expiresAt') > ?)
        ORDER BY updated_at ASC, id ASC
      `).all(normalizedOwnerId, now) as Array<{ id: string; payload: string }>;
      const grants = rows.map(({ id, payload }) => {
        const grant = JSON.parse(payload) as { remaining: number; expiresAt?: number; source: string };
        return { id, remaining: grant.remaining, expiresAt: grant.expiresAt, source: grant.source };
      }).filter((grant) => grant.remaining > 0);
      return { available: grants.reduce((total, grant) => total + grant.remaining, 0), grants };
    },
    grantCredits(ownerId, quantity, source, reference, expiresAt, now = Date.now()) {
      const normalizedOwnerId = ownerId.trim().toLowerCase();
      if (!normalizedOwnerId || !Number.isInteger(quantity) || quantity < 1 || quantity > 100_000 || !reference || reference.length > 200) throw new Error('invalid decrypt credit grant');
      const id = `grant:${source}:${reference}:${normalizedOwnerId}`;
      const payload = { id, type: 'grant', ownerId: normalizedOwnerId, quantity, remaining: quantity, source, reference, createdAt: now, ...(expiresAt ? { expiresAt } : {}) };
      const result = database.query('INSERT INTO decrypt_credit_records (id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING').run(id, JSON.stringify(payload), now);
      return { id, granted: result.changes === 1 };
    },
    findStripeCreditOwner(paymentIntentId) {
      const row = database.query("SELECT json_extract(payload, '$.ownerId') AS owner_id FROM decrypt_credit_records WHERE json_extract(payload, '$.type') = 'grant' AND json_extract(payload, '$.source') = 'stripe' AND json_extract(payload, '$.reference') = ? LIMIT 1").get(paymentIntentId) as { owner_id: string } | null;
      return row?.owner_id;
    },
    revokeStripeCreditGrant(ownerId, paymentIntentId, quantity = 0, now = Date.now()) {
      const normalizedOwnerId = ownerId.trim().toLowerCase();
      const id = `grant:stripe:${paymentIntentId}:${normalizedOwnerId}`;
      if (!normalizedOwnerId || !paymentIntentId || !Number.isInteger(quantity) || quantity < 0 || quantity > 100_000) throw new Error('invalid Stripe credit refund');
      database.exec('BEGIN IMMEDIATE;');
      try {
        const row = database.query('SELECT payload FROM decrypt_credit_records WHERE id = ?').get(id) as { payload: string } | null;
        if (!row) {
          const tombstone = { id, type: 'grant', ownerId: normalizedOwnerId, quantity, remaining: 0, source: 'stripe', reference: paymentIntentId, createdAt: now, refundedAt: now };
          database.query('INSERT INTO decrypt_credit_records (id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING').run(id, JSON.stringify(tombstone), now);
          database.exec('COMMIT;');
          return { id, revoked: true };
        }
        const grant = JSON.parse(row.payload) as { remaining: number; refundedAt?: number };
        if (grant.refundedAt) {
          database.exec('COMMIT;');
          return { id, revoked: false };
        }
        database.query('UPDATE decrypt_credit_records SET payload = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ ...grant, remaining: 0, refundedAt: now }), now, id);
        database.exec('COMMIT;');
        return { id, revoked: true };
      } catch (error) {
        database.exec('ROLLBACK;');
        throw error;
      }
    },
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

export function loadPersistedActiveJobs(): StoredJob[] {
  return repository.loadActive();
}

export function findPersistedJobById(jobId: string): StoredJob | undefined {
  return repository.findById(jobId);
}

export function replacePersistedJobs(jobs: Iterable<Job>, workerId?: string): string[] {
  return repository.replace(jobs, workerId);
}

export function deletePersistedJob(jobId: string): boolean {
  return repository.delete(jobId);
}

export function requestPersistedJobCancellation(jobId: string, cancelledBy: string): ReturnType<JobRepository['requestCancellation']> {
  return repository.requestCancellation(jobId, cancelledBy);
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

export function claimPersistedJobWorker(jobId: string, workerId: string, resourceId: string, leaseMs: number): JobWorkerLease | undefined {
  return repository.claimWorker(jobId, workerId, resourceId, leaseMs);
}

export function renewPersistedJobWorker(lease: JobWorkerLease, leaseMs: number): boolean {
  return repository.renewWorker(lease, leaseMs);
}

export function releasePersistedJobWorker(lease: JobWorkerLease): void {
  repository.releaseWorker(lease);
}

export function releasePersistedWorkersById(workerId: string): void {
  repository.releaseWorkersById(workerId);
}

export function isPersistedWorkerResourceActive(resourceId: string): boolean {
  return repository.isResourceActive(resourceId);
}

export function listPersistedExpiredRunningJobs(): StoredJob[] {
  return repository.listExpiredRunning();
}

export function requeuePersistedExpiredRunningJob(job: Job): boolean {
  return repository.requeueExpiredRunning(job);
}

export function countPersistedActiveWorkers(resourcePrefix: string): number {
  return repository.countActiveWorkers(resourcePrefix);
}

export function registerPersistedWorker(workerId: string, configuration: WorkerRuntimeConfiguration): void {
  repository.registerWorker(workerId, configuration);
}

export function heartbeatPersistedWorker(workerId: string, configuration: WorkerRuntimeConfiguration): void {
  repository.heartbeatWorker(workerId, configuration);
}

export function listPersistedWorkers(): PersistedWorkerInstance[] {
  return repository.listWorkers();
}

export function setPersistedWorkerDrain(workerId: string, draining: boolean): boolean {
  return repository.setWorkerDrain(workerId, draining);
}

export function markPersistedWorkerOffline(workerId: string): void {
  repository.markWorkerOffline(workerId);
}

export function countPersistedRunningJobs(filter: { queuedBy?: string; apiKeyId?: string }): number {
  return repository.countRunningJobs(filter);
}

export function getDecryptQuotaUsage(ownerId: string, limit: number | undefined, now = Date.now()): DecryptQuotaUsage {
  return repository.quotaUsage(ownerId, limit, now);
}

export function getFreeDecryptQuotaUsage(ownerId: string, now = Date.now()): DecryptQuotaUsage {
  return repository.freeQuotaUsage(ownerId, now);
}

export function exportFreeDecryptQuotaCompletions(now = Date.now()): FreeDecryptQuotaCompletion[] {
  return repository.freeQuotaCompletions(now);
}

export function replaceFreeDecryptQuotaCompletionsInDatabase(database: Database, completions: readonly FreeDecryptQuotaCompletion[]): void {
  replaceFreeQuotaCompletions(database, completions);
}

export function deleteFreeDecryptQuotaOwner(ownerId: string): void {
  repository.deleteFreeQuotaOwner(ownerId);
}

export function getDecryptQuotaJournal(ownerId: string, limit = 10_000): ReturnType<JobRepository['quotaJournal']> {
  return repository.quotaJournal(ownerId, limit);
}

export function getDecryptQuotaReceipt(jobId: string, ownerId: string): ReturnType<JobRepository['quotaReceipt']> {
  return repository.quotaReceipt(jobId, ownerId);
}

export function admitPersistedJob(job: Job, ownerId?: string, limit?: number, freeTier = false): string {
  return repository.admit(job, ownerId, limit, freeTier);
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

export function getDecryptCreditBalance(ownerId: string, now = Date.now()): DecryptCreditBalance {
  return repository.creditBalance(ownerId, now);
}

export function grantDecryptCredits(
  ownerId: string,
  quantity: number,
  source: 'stripe' | 'outage' | 'manual',
  reference: string,
  expiresAt?: number,
  now = Date.now(),
): { id: string; granted: boolean } {
  return repository.grantCredits(ownerId, quantity, source, reference, expiresAt, now);
}

export function findStripeDecryptCreditOwner(paymentIntentId: string): string | undefined {
  return repository.findStripeCreditOwner(paymentIntentId);
}

export function revokeStripeDecryptCredits(ownerId: string, paymentIntentId: string, quantity?: number, now?: number): { id: string; revoked: boolean } {
  return repository.revokeStripeCreditGrant(ownerId, paymentIntentId, quantity, now);
}

export function exportDecryptQuotaLedger(): ReturnType<JobRepository['quotaSnapshot']> {
  return repository.quotaSnapshot();
}
