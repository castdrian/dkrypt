import { existsSync } from 'node:fs';
import path from 'node:path';
import { runDeploymentPreflight } from '../src/deploymentPreflight.js';

const stateDirectory = path.resolve(process.env.STATE_DIR ?? '/data/state');
const databaseName = process.env.STATE_DATABASE_FILE ?? 'dkrypt.sqlite';
const databasePath = path.resolve(stateDirectory, databaseName);
if (databasePath !== stateDirectory && !databasePath.startsWith(`${stateDirectory}${path.sep}`)) throw new Error('STATE_DATABASE_FILE must stay inside STATE_DIR');

if (!existsSync(databasePath)) {
  process.stdout.write(`No SQLite database found at ${databasePath}; there are no migrations to check.\n`);
} else {
  const result = runDeploymentPreflight(databasePath);
  if (result.status !== 'verified') throw new Error('SQLite migration preflight did not verify the database');
  process.stdout.write(`SQLite migration dry run passed: schema ${result.sourceSchemaVersion} → ${result.candidateSchemaVersion}, integrity ${result.integrity}, state restore verified. The source database was not modified.\n`);
}
