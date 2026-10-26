import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

export type BackupSnapshotDirectoryRemoval = (directory: string) => void;

export interface BackupSnapshotCleanupFailure {
  directory: string;
  error: unknown;
}

export function cleanupBackupSnapshotDirectories(
  backupsDir: string,
  referencedDirectories: ReadonlySet<string>,
  removeDirectory: BackupSnapshotDirectoryRemoval = directory => rmSync(directory, { recursive: true, force: true }),
): BackupSnapshotCleanupFailure[] {
  const failures: BackupSnapshotCleanupFailure[] = [];
  if (!existsSync(backupsDir)) return failures;
  let entries;
  try {
    entries = readdirSync(backupsDir, { withFileTypes: true });
  } catch (error) {
    return [{ directory: path.basename(backupsDir), error }];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.staging-') || (/^snapshot-[0-9a-f-]{36}$/.test(entry.name) && !referencedDirectories.has(entry.name))) {
      try {
        removeDirectory(path.join(backupsDir, entry.name));
      } catch (error) {
        failures.push({ directory: entry.name, error });
      }
    }
  }
  return failures;
}
