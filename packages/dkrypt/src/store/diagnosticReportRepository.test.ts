import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStateCollectionDatabase, readStateCollection, replaceStateCollection } from '#store/sqlite.js';
import { createDiagnosticReportRepository, type DiagnosticReportRecord } from '#store/diagnosticReportRepository.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('diagnostic reports persist across restart and are removed at their expiry', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'dkrypt-report-repository-'));
  temporaryDirectories.push(stateDir);
  const now = Date.now();
  const report: DiagnosticReportRecord = {
    id: 'report-1',
    userId: 'member',
    projectId: 'project-a',
    category: 'job',
    summary: 'Job failed',
    details: 'Redacted details',
    createdAt: now,
    expiresAt: now + 30 * 24 * 60 * 60 * 1000,
    status: 'received',
  };
  const initialRepository = createDiagnosticReportRepository(openStateCollectionDatabase({ stateDir }, ['diagnostic_reports']));
  initialRepository.create(report);
  initialRepository.close();

  const restoredRepository = createDiagnosticReportRepository(openStateCollectionDatabase({ stateDir }, ['diagnostic_reports']));
  try {
    expect(restoredRepository.listByUser('member', 10)).toEqual([report]);
    expect(restoredRepository.appendMessage(report.id, { id: 'reply-1', authorId: 'support', body: 'Try again now.', createdAt: now + 10 }, now + 10)).toMatchObject({ messages: [{ id: 'reply-1', body: 'Try again now.' }] });
    expect(restoredRepository.findById(report.id)?.messages).toHaveLength(1);
    expect(restoredRepository.pruneExpired(report.expiresAt)).toBe(1);
    expect(restoredRepository.listRecent(10)).toEqual([]);
  } finally {
    restoredRepository.close();
  }
});

test('diagnostic report collection replacement fills indexed columns', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'dkrypt-report-replacement-'));
  temporaryDirectories.push(stateDir);
  const database = openStateCollectionDatabase({ stateDir }, ['diagnostic_reports']);
  const report: DiagnosticReportRecord = {
    id: 'report-replaced',
    userId: 'member',
    projectId: 'project-a',
    category: 'other',
    summary: 'Replacement report',
    details: 'Redacted details',
    createdAt: 100,
    expiresAt: 200,
    status: 'received',
  };
  try {
    replaceStateCollection(database, 'diagnostic_reports', [{ id: report.id, payload: report, updatedAt: report.createdAt }]);
    expect(readStateCollection(database, 'diagnostic_reports')).toEqual([report]);
  } finally {
    database.close();
  }
});
