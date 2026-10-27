import type { Database } from 'bun:sqlite';
import { DEFAULT_PROJECT_ID, type JobHistoryEntry } from '#store/state.js';

export interface JobHistoryRepositoryFilter {
  bundleIdSearch?: string;
  source?: 'manual' | 'scheduler';
  status?: 'done' | 'failed';
  queuedBy?: string;
  deviceId?: string;
  errorSearch?: string;
  fromTs?: number;
  toTs?: number;
  projectId?: string;
}

export interface JobHistoryRepository {
  list(filter?: JobHistoryRepositoryFilter): JobHistoryEntry[];
  listForUser(username: string): JobHistoryEntry[];
  delete(id: string): boolean;
}

function addContainsFilter(conditions: string[], parameters: Array<string | number>, field: string, value: string | undefined): void {
  const normalized = value?.toLowerCase();
  if (!normalized) return;
  conditions.push(`lower(COALESCE(${field}, '')) LIKE ? ESCAPE '\\'`);
  parameters.push(`%${normalized.replace(/[\\%_]/g, '\\$&')}%`);
}

export function createJobHistoryRepository(database: Database): JobHistoryRepository {
  const byUser = database.query('SELECT payload FROM job_history WHERE queued_by = ? ORDER BY finished_at DESC, id DESC;');
  return {
    list(filter = {}) {
      const conditions = ['1 = 1'];
      const parameters: Array<string | number> = [];
      addContainsFilter(conditions, parameters, 'bundle_id', filter.bundleIdSearch);
      if (filter.source) {
        conditions.push('source = ?');
        parameters.push(filter.source);
      }
      if (filter.status) {
        conditions.push('status = ?');
        parameters.push(filter.status);
      }
      addContainsFilter(conditions, parameters, 'queued_by', filter.queuedBy);
      if (filter.deviceId) {
        conditions.push("COALESCE(device_id, '') = ?");
        parameters.push(filter.deviceId);
      }
      addContainsFilter(conditions, parameters, 'error_text', filter.errorSearch);
      if (filter.fromTs) {
        conditions.push('finished_at >= ?');
        parameters.push(filter.fromTs);
      }
      if (filter.toTs) {
        conditions.push('finished_at <= ?');
        parameters.push(filter.toTs);
      }
      const rows = database.query(`
        SELECT payload
        FROM job_history
        WHERE ${conditions.join(' AND ')}
        ORDER BY finished_at DESC, id DESC;
      `).all(...parameters) as Array<{ payload: string }>;
      return rows.map((row) => {
        const entry = JSON.parse(row.payload) as JobHistoryEntry;
        return { ...entry, projectId: entry.projectId ?? DEFAULT_PROJECT_ID };
      });
    },
    listForUser(username) {
      const rows = byUser.all(username.toLowerCase()) as Array<{ payload: string }>;
      return rows.map((row) => JSON.parse(row.payload) as JobHistoryEntry);
    },
    delete(id) {
      return database.query('DELETE FROM job_history WHERE id = ?').run(id).changes === 1;
    },
  };
}
