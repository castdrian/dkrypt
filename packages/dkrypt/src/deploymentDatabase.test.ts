import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { prepareDeploymentRollback, restoreDeploymentRollback } from '#deploymentDatabase.js';
import { openStateDatabase, verifyDatabaseForMigration } from '#store/sqlite.js';
import { rewindApiKeySearchMigration, rewindSessionSearchMigration } from '#store/sqliteTestHelpers.js';

function rewindToSchemaVersion16(database: ReturnType<typeof openStateDatabase>): void {
  rewindApiKeySearchMigration(database.db);
  rewindSessionSearchMigration(database.db);
  database.db.exec(`
    DROP INDEX IF EXISTS free_decrypt_abuse_quota_by_expiry;
    DROP INDEX IF EXISTS free_decrypt_abuse_quota_by_turnstile;
    DROP INDEX IF EXISTS free_decrypt_abuse_quota_by_browser;
    DROP INDEX IF EXISTS free_decrypt_abuse_quota_by_address;
    DROP INDEX IF EXISTS free_decrypt_abuse_quota_by_network;
    DROP TABLE IF EXISTS free_decrypt_abuse_quota;
    DROP INDEX IF EXISTS abuse_signup_events_by_expiry;
    DROP INDEX IF EXISTS abuse_signup_events_by_email_time;
    DROP INDEX IF EXISTS abuse_signup_events_by_turnstile_time;
    DROP INDEX IF EXISTS abuse_signup_events_by_browser_time;
    DROP INDEX IF EXISTS abuse_signup_events_by_address_time;
    DROP INDEX IF EXISTS abuse_signup_events_by_network_time;
    DROP TABLE IF EXISTS abuse_ip_reputation;
    DROP INDEX IF EXISTS abuse_signup_challenges_by_expiry;
    DROP TABLE IF EXISTS abuse_signup_challenges;
    DROP TABLE IF EXISTS abuse_signup_events;
    DROP INDEX decrypt_quota_by_owner_time;
    DROP TABLE decrypt_quota_ledger;
    DROP INDEX billing_events_by_provider_event;
    DROP INDEX billing_events_by_processed_at;
    DROP TABLE billing_customers;
    DROP TABLE billing_subscriptions;
    DROP TABLE billing_checkouts;
    DROP TABLE billing_charges;
    DROP TABLE billing_entitlement_history;
    DROP TABLE backup_schedule;
    DROP INDEX diagnostic_reports_by_user_time;
    DROP INDEX diagnostic_reports_by_expiry;
    DROP TABLE diagnostic_reports;
    DROP TABLE pending_oauth_links;
    DROP TABLE integration_deliveries;
    DROP TABLE integration_policies;
    DROP TABLE operational_incidents;
    DROP TABLE watch_revisions;
    DROP TABLE watch_drafts;
      DROP TABLE appstore_offline_credential_operations;
      DROP TABLE appstore_offline_authentication_operations;
    DROP TABLE appstore_offline_account;
    ALTER TABLE billing_events DROP COLUMN provider;
    ALTER TABLE billing_events DROP COLUMN event_id;
    ALTER TABLE billing_events DROP COLUMN occurred_at;
    ALTER TABLE billing_events DROP COLUMN processed_at;
    DROP TABLE job_worker_leases;
    DROP TABLE job_worker_generations;
      DELETE FROM schema_migrations WHERE version > 16;
  `);
}

function readStateSnapshot(databasePath: string): unknown {
  const database = new Database(databasePath, { create: false, readonly: true, strict: true });
  try {
    const row = database.query('SELECT payload FROM state_snapshots WHERE id = 1').get() as { payload: string };
    return JSON.parse(row.payload) as unknown;
  } finally {
    database.close();
  }
}

test('deployment rollback restores the drained database state and preserves the failed candidate database', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-deployment-rollback-'));
  const stateBeforeDrain = { version: 18, devices: [{ id: 'device-before-deploy' }], settings: { maintenanceMode: true } };
  const originalState = { version: 18, devices: [{ id: 'device-before-deploy' }], settings: { maintenanceMode: false } };
  const candidateState = { ...originalState, settings: { maintenanceMode: true } };
  try {
    const previous = openStateDatabase({ stateDir, filename: 'dkrypt.sqlite' });
    previous.writeState(stateBeforeDrain);
    previous.writeState(originalState);
    rewindToSchemaVersion16(previous);
    previous.close();

    expect(prepareDeploymentRollback(stateDir, 'run-100-attempt-1')).toMatchObject({
      deploymentId: 'run-100-attempt-1',
      databasePresent: true,
      schemaVersion: 16,
    });

    const candidate = openStateDatabase({ stateDir, filename: 'dkrypt.sqlite' });
    candidate.writeState(candidateState);
    candidate.close();

    const restored = restoreDeploymentRollback(stateDir, 'run-100-attempt-1');

    expect(restored).toMatchObject({ databaseRestored: true, candidateDatabasePreserved: true });
    expect(verifyDatabaseForMigration(path.join(stateDir, 'dkrypt.sqlite')).schemaVersion).toBe(16);
    expect(readStateSnapshot(path.join(stateDir, 'dkrypt.sqlite'))).toEqual(originalState);
    expect(verifyDatabaseForMigration(restored.candidateRecoveryPath!).schemaVersion).toBeGreaterThan(16);
    expect(readStateSnapshot(restored.candidateRecoveryPath!)).toEqual(candidateState);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('deployment rollback returns a failed first-start database to the pre-deploy empty state', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-deployment-rollback-empty-'));
  try {
    expect(prepareDeploymentRollback(stateDir, 'run-101-attempt-1')).toMatchObject({
      deploymentId: 'run-101-attempt-1',
      databasePresent: false,
    });

    const candidate = openStateDatabase({ stateDir, filename: 'dkrypt.sqlite' });
    candidate.writeState({ version: 18, settings: { initializedByCandidate: true } });
    candidate.close();

    const restored = restoreDeploymentRollback(stateDir, 'run-101-attempt-1');

    expect(restored).toMatchObject({ databaseRestored: false, candidateDatabasePreserved: true });
    expect(verifyDatabaseForMigration(restored.candidateRecoveryPath!).schemaVersion).toBeGreaterThan(0);
    expect(() => verifyDatabaseForMigration(path.join(stateDir, 'dkrypt.sqlite'))).toThrow();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('deployment rollback refuses a damaged snapshot without replacing candidate state', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-deployment-rollback-damaged-'));
  const candidateState = { version: 18, settings: { initializedByCandidate: true } };
  try {
    const previous = openStateDatabase({ stateDir, filename: 'dkrypt.sqlite' });
    previous.writeState({ version: 18, settings: { initializedByCandidate: false } });
    previous.close();
    prepareDeploymentRollback(stateDir, 'run-102-attempt-1');
    await writeFile(path.join(stateDir, 'deployment-rollbacks', 'rollback-run-102-attempt-1.sqlite'), 'damaged snapshot');

    const candidate = openStateDatabase({ stateDir, filename: 'dkrypt.sqlite' });
    candidate.writeState(candidateState);
    candidate.close();

    expect(() => restoreDeploymentRollback(stateDir, 'run-102-attempt-1')).toThrow('database');
    expect(readStateSnapshot(path.join(stateDir, 'dkrypt.sqlite'))).toEqual(candidateState);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
