import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { cleanupBackupSnapshotDirectories } from '#store/backupSnapshotCleanup.js';

test('backup snapshot cleanup continues when an orphan cannot be removed', () => {
  const backupsDir = mkdtempSync(path.join(tmpdir(), 'dkrypt-backup-cleanup-'));
  const protectedDirectory = 'snapshot-00000000-0000-4000-8000-000000000001';
  const removableDirectory = 'snapshot-00000000-0000-4000-8000-000000000002';
  const referencedDirectory = 'snapshot-00000000-0000-4000-8000-000000000003';
  for (const name of [protectedDirectory, removableDirectory, referencedDirectory]) {
    mkdirSync(path.join(backupsDir, name));
  }
  const inaccessibleError = Object.assign(new Error('permission denied'), { code: 'EACCES' });

  try {
    const failures = cleanupBackupSnapshotDirectories(backupsDir, new Set([referencedDirectory]), directory => {
      if (path.basename(directory) === protectedDirectory) throw inaccessibleError;
      rmSync(directory, { recursive: true, force: true });
    });
    expect(failures).toEqual([{ directory: protectedDirectory, error: inaccessibleError }]);
    expect(existsSync(path.join(backupsDir, protectedDirectory))).toBe(true);
    expect(existsSync(path.join(backupsDir, removableDirectory))).toBe(false);
    expect(existsSync(path.join(backupsDir, referencedDirectory))).toBe(true);
  } finally {
    rmSync(backupsDir, { recursive: true, force: true });
  }
});
