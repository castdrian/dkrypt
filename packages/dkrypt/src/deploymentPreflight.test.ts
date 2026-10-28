import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { runDeploymentPreflight } from '#deploymentPreflight.js';
import { LATEST_SQLITE_SCHEMA_VERSION, openStateDatabase } from '#store/sqlite.js';
import { rewindApiKeySearchMigration, rewindSessionSearchMigration } from '#store/sqliteTestHelpers.js';

test('deployment preflight dry-runs and restores a database without changing the live schema', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dkrypt-deployment-preflight-'));
  const stateDir = path.join(root, 'live-state');
  await mkdir(stateDir, { recursive: true });
  const state = {
    version: 18,
    activeSessions: [{ id: 'session-preflight', sub: 'manager@example.com', createdAt: 100, lastSeenAt: 200 }],
    devices: [{ id: 'device-private', name: 'Test iPad' }],
    settings: { maintenanceMode: false },
  };
  const database = openStateDatabase({ stateDir, filename: 'dkrypt.sqlite' });
  try {
    database.writeState(state);
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
      DROP INDEX billing_events_by_provider_event;
      DROP INDEX billing_events_by_processed_at;
      ALTER TABLE billing_events DROP COLUMN provider;
      ALTER TABLE billing_events DROP COLUMN event_id;
      ALTER TABLE billing_events DROP COLUMN occurred_at;
      ALTER TABLE billing_events DROP COLUMN processed_at;
      DROP TABLE job_worker_leases;
      DROP TABLE job_worker_generations;
      DROP INDEX cloud_delivery_jobs_by_owner;
      DROP INDEX cloud_delivery_jobs_by_retry;
      DROP TABLE cloud_delivery_jobs;
      DROP INDEX cloud_delivery_destinations_by_owner;
      DROP TABLE cloud_delivery_destinations;
      DELETE FROM schema_migrations WHERE version > 16;
    `);

    const result = runDeploymentPreflight(path.join(stateDir, 'dkrypt.sqlite'), root);
    expect(result).toEqual({ status: 'verified', sourceSchemaVersion: 16, candidateSchemaVersion: LATEST_SQLITE_SCHEMA_VERSION, integrity: 'ok', restoredState: true });
    expect(database.schemaVersion).toBe(16);
    expect(database.readState()).toEqual(state);

    const liveDatabase = new Database(path.join(stateDir, 'dkrypt.sqlite'), { create: false, readonly: true, strict: true });
    try {
      expect(liveDatabase.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 16 });
      expect(JSON.parse((liveDatabase.query('SELECT payload FROM state_snapshots WHERE id = 1').get() as { payload: string }).payload)).toEqual(state);
      expect(liveDatabase.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      liveDatabase.close();
    }
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('deployment preflight rejects a corrupt existing database', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dkrypt-deployment-preflight-corrupt-'));
  const databasePath = path.join(root, 'dkrypt.sqlite');
  try {
    await writeFile(databasePath, 'not a SQLite database');
    expect(() => runDeploymentPreflight(databasePath, root)).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('deployment preflight permits a fresh state volume without a database', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dkrypt-deployment-preflight-empty-'));
  try {
    expect(runDeploymentPreflight(path.join(root, 'dkrypt.sqlite'), root)).toEqual({ status: 'no_database' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
