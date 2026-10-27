import { createHash, randomInt } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';

type StateRecord = Record<string, unknown>;

interface StateSnapshotRow {
  payload: string;
  sha256: string;
}

interface DomainRow {
  id: string;
  payload: unknown;
  updatedAt?: number;
}

export interface StateCollectionReplacement {
  table: string;
  rows: Array<{ id: string; payload: unknown; updatedAt?: number; ordinal?: number }>;
}

export interface StateDatabaseOptions {
  stateDir: string;
  filename?: string;
  busyTimeoutMs?: number;
  migrationDryRun?: boolean;
}

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS state_snapshots (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS device_health (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS job_timelines (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS watches (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS billing_records (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS testflight_subscriptions (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS webhook_inbox (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS backups (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS idempotency_keys (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS auth_profiles (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS device_history (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS billing_events (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS correlation_events (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS webhook_attempts (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE INDEX IF NOT EXISTS artifacts_updated_at ON artifacts(updated_at);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS scheduler_runs (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO scheduler_runs (id, payload, updated_at)
      SELECT id, payload, updated_at
      FROM job_timelines
      WHERE json_valid(payload) = 1 AND json_extract(payload, '$.jobId') IS NULL
      ON CONFLICT(id) DO NOTHING;
      DELETE FROM job_timelines
      WHERE json_valid(payload) = 1 AND json_extract(payload, '$.jobId') IS NULL;
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `,
  },
  {
    version: 6,
    sql: `
      UPDATE jobs
      SET payload = json_set(payload, '$.projectId', 'default')
      WHERE json_valid(payload) = 1 AND json_type(payload, '$.projectId') IS NULL;
      UPDATE artifacts
      SET payload = json_set(payload, '$.projectIds', json_array('default'))
      WHERE json_valid(payload) = 1 AND json_type(payload, '$.projectIds') IS NULL;
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE jobs ADD COLUMN status TEXT;
      ALTER TABLE jobs ADD COLUMN bundle_id TEXT;
      ALTER TABLE jobs ADD COLUMN external_version_id TEXT;
      ALTER TABLE jobs ADD COLUMN testflight_build_id INTEGER;
      ALTER TABLE jobs ADD COLUMN project_id TEXT;
      ALTER TABLE jobs ADD COLUMN source TEXT;
      ALTER TABLE jobs ADD COLUMN priority INTEGER;
      ALTER TABLE jobs ADD COLUMN created_at INTEGER;
      ALTER TABLE jobs ADD COLUMN started_at INTEGER;
      ALTER TABLE jobs ADD COLUMN finished_at INTEGER;
      ALTER TABLE jobs ADD COLUMN attempt INTEGER;
      ALTER TABLE jobs ADD COLUMN deadline_at INTEGER;
      ALTER TABLE jobs ADD COLUMN failure_class TEXT;
      ALTER TABLE jobs ADD COLUMN correlation_id TEXT;
      ALTER TABLE jobs ADD COLUMN device_id TEXT;
      ALTER TABLE jobs ADD COLUMN file_path TEXT;
      UPDATE jobs
      SET status = json_extract(payload, '$.status'),
          bundle_id = json_extract(payload, '$.bundleId'),
          external_version_id = json_extract(payload, '$.externalVersionId'),
          testflight_build_id = json_extract(payload, '$.testflight.build.id'),
          project_id = COALESCE(json_extract(payload, '$.projectId'), 'default'),
          source = json_extract(payload, '$.source'),
          priority = COALESCE(json_extract(payload, '$.priority'), 0),
          created_at = COALESCE(json_extract(payload, '$.createdAt'), updated_at),
          started_at = json_extract(payload, '$.startedAt'),
          finished_at = json_extract(payload, '$.finishedAt'),
          attempt = json_extract(payload, '$.attempt'),
          deadline_at = json_extract(payload, '$.deadlineAt'),
          failure_class = json_extract(payload, '$.failureClass'),
          correlation_id = json_extract(payload, '$.correlationId'),
          device_id = json_extract(payload, '$.deviceId'),
          file_path = json_extract(payload, '$.filePath')
      WHERE json_valid(payload) = 1;
      CREATE INDEX IF NOT EXISTS jobs_active_exact_build ON jobs(project_id, bundle_id, external_version_id, testflight_build_id, status);
      CREATE INDEX IF NOT EXISTS jobs_completed_exact_build ON jobs(project_id, bundle_id, external_version_id, testflight_build_id, status, file_path);
    `,
  },
  {
    version: 8,
    sql: `
      ALTER TABLE artifacts ADD COLUMN artifact_key TEXT;
      ALTER TABLE artifacts ADD COLUMN bundle_id TEXT;
      ALTER TABLE artifacts ADD COLUMN channel TEXT;
      ALTER TABLE artifacts ADD COLUMN external_version_id TEXT;
      ALTER TABLE artifacts ADD COLUMN testflight_build_id INTEGER;
      ALTER TABLE artifacts ADD COLUMN version_label TEXT;
      ALTER TABLE artifacts ADD COLUMN build_number TEXT;
      ALTER TABLE artifacts ADD COLUMN file_path TEXT;
      ALTER TABLE artifacts ADD COLUMN file_size_bytes INTEGER;
      ALTER TABLE artifacts ADD COLUMN sha256 TEXT;
      ALTER TABLE artifacts ADD COLUMN created_at INTEGER;
      ALTER TABLE artifacts ADD COLUMN last_accessed_at INTEGER;
      ALTER TABLE artifacts ADD COLUMN access_count INTEGER;
      ALTER TABLE artifacts ADD COLUMN pinned_at INTEGER;
      ALTER TABLE artifacts ADD COLUMN source_job_id TEXT;
      UPDATE artifacts
      SET artifact_key = json_extract(payload, '$.key'),
          bundle_id = json_extract(payload, '$.bundleId'),
          channel = json_extract(payload, '$.channel'),
          external_version_id = json_extract(payload, '$.externalVersionId'),
          testflight_build_id = json_extract(payload, '$.testflightBuildId'),
          version_label = json_extract(payload, '$.versionLabel'),
          build_number = json_extract(payload, '$.buildNumber'),
          file_path = json_extract(payload, '$.filePath'),
          file_size_bytes = json_extract(payload, '$.fileSizeBytes'),
          sha256 = json_extract(payload, '$.sha256'),
          created_at = json_extract(payload, '$.createdAt'),
          last_accessed_at = COALESCE(json_extract(payload, '$.lastAccessedAt'), updated_at),
          access_count = COALESCE(json_extract(payload, '$.accessCount'), 0),
          pinned_at = json_extract(payload, '$.pinnedAt'),
          source_job_id = json_extract(payload, '$.sourceJobId')
      WHERE json_valid(payload) = 1;
      CREATE INDEX IF NOT EXISTS artifacts_key_index ON artifacts(artifact_key);
      CREATE INDEX IF NOT EXISTS artifacts_source_job_index ON artifacts(source_job_id);
      CREATE INDEX IF NOT EXISTS artifacts_bundle_channel_recent ON artifacts(bundle_id, channel, created_at DESC);
    `,
  },
  {
    version: 9,
    sql: `
      CREATE TABLE IF NOT EXISTS artifact_projects (
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        PRIMARY KEY (artifact_id, project_id)
      );
      INSERT OR IGNORE INTO artifact_projects (artifact_id, project_id)
      SELECT artifacts.id, project_link.value
      FROM artifacts,
           json_each(CASE WHEN json_valid(artifacts.payload) = 1 THEN artifacts.payload ELSE '{}' END, '$.projectIds') AS project_link
      WHERE project_link.type = 'text';
      CREATE INDEX IF NOT EXISTS artifact_projects_by_project ON artifact_projects(project_id, artifact_id);
    `,
  },
  {
    version: 10,
    sql: `
      ALTER TABLE device_history ADD COLUMN device_id TEXT;
      ALTER TABLE device_history ADD COLUMN history_kind TEXT;
      ALTER TABLE device_history ADD COLUMN occurred_at INTEGER;
      ALTER TABLE device_history ADD COLUMN bundle_id TEXT;
      CREATE INDEX IF NOT EXISTS device_history_by_device_time ON device_history(device_id, occurred_at DESC, id DESC);
      INSERT OR IGNORE INTO device_history (id, payload, updated_at, device_id, history_kind, occurred_at, bundle_id)
      SELECT json_extract(activity.value, '$.id'),
             activity.value,
             COALESCE(json_extract(activity.value, '$.ts'), state_snapshots.updated_at),
             json_extract(activity.value, '$.deviceId'),
             json_extract(activity.value, '$.kind'),
             json_extract(activity.value, '$.ts'),
             json_extract(activity.value, '$.bundleId')
      FROM state_snapshots,
           json_each(CASE WHEN json_valid(state_snapshots.payload) = 1 THEN state_snapshots.payload ELSE '{}' END, '$.deviceActivity') AS activity
      WHERE json_type(activity.value, '$.id') = 'text';
    `,
  },
  {
    version: 11,
    sql: `
      ALTER TABLE device_health ADD COLUMN device_id TEXT;
      ALTER TABLE device_health ADD COLUMN checked_at INTEGER;
      ALTER TABLE device_health ADD COLUMN reachable INTEGER;
      ALTER TABLE device_health ADD COLUMN battery_percent REAL;
      ALTER TABLE device_health ADD COLUMN battery_temperature_c REAL;
      ALTER TABLE device_health ADD COLUMN storage_used_percent REAL;
      CREATE INDEX IF NOT EXISTS device_health_by_device_time ON device_health(device_id, checked_at DESC, id DESC);
      INSERT OR IGNORE INTO device_health (
        id, payload, updated_at, device_id, checked_at, reachable, battery_percent,
        battery_temperature_c, storage_used_percent
      )
      SELECT printf('%s:%04d', per_device_history.key, CAST(health_check.key AS INTEGER)),
             json_set(health_check.value, '$.deviceId', per_device_history.key),
             COALESCE(json_extract(health_check.value, '$.ts'), state_snapshots.updated_at),
             per_device_history.key,
             json_extract(health_check.value, '$.ts'),
             CASE json_type(health_check.value, '$.reachable')
               WHEN 'true' THEN 1
               WHEN 'false' THEN 0
               ELSE NULL
             END,
             json_extract(health_check.value, '$.batteryPercent'),
             json_extract(health_check.value, '$.batteryTemperatureC'),
             json_extract(health_check.value, '$.storageUsedPercent')
      FROM state_snapshots,
           json_each(CASE WHEN json_valid(state_snapshots.payload) = 1 THEN state_snapshots.payload ELSE '{}' END, '$.deviceHealthHistory') AS per_device_history,
           json_each(per_device_history.value) AS health_check
      WHERE json_type(health_check.value) = 'object';
      INSERT OR IGNORE INTO device_health (
        id, payload, updated_at, device_id, checked_at, reachable, battery_percent,
        battery_temperature_c, storage_used_percent
      )
      SELECT printf('%s:%04d', json_extract(previous_history.payload, '$.key'), CAST(health_check.key AS INTEGER)),
             json_set(health_check.value, '$.deviceId', json_extract(previous_history.payload, '$.key')),
             COALESCE(json_extract(health_check.value, '$.ts'), previous_history.updated_at),
             json_extract(previous_history.payload, '$.key'),
             json_extract(health_check.value, '$.ts'),
             CASE json_type(health_check.value, '$.reachable')
               WHEN 'true' THEN 1
               WHEN 'false' THEN 0
               ELSE NULL
             END,
             json_extract(health_check.value, '$.batteryPercent'),
             json_extract(health_check.value, '$.batteryTemperatureC'),
             json_extract(health_check.value, '$.storageUsedPercent')
      FROM device_health AS previous_history,
           json_each(CASE WHEN json_valid(previous_history.payload) = 1 THEN previous_history.payload ELSE '{}' END, '$.value') AS health_check
      WHERE json_type(previous_history.payload, '$.key') = 'text'
        AND json_type(previous_history.payload, '$.value') = 'array'
        AND json_type(health_check.value) = 'object';
      DELETE FROM device_health WHERE device_id IS NULL;
    `,
  },
  {
    version: 12,
    sql: `
      ALTER TABLE notifications ADD COLUMN user_id TEXT;
      ALTER TABLE notifications ADD COLUMN created_at INTEGER;
      ALTER TABLE notifications ADD COLUMN read_at INTEGER;
      ALTER TABLE notifications ADD COLUMN severity TEXT;
      ALTER TABLE notifications ADD COLUMN job_id TEXT;
      UPDATE notifications
      SET user_id = lower(json_extract(payload, '$.userId')),
          created_at = COALESCE(json_extract(payload, '$.createdAt'), updated_at),
          read_at = json_extract(payload, '$.readAt'),
          severity = json_extract(payload, '$.severity'),
          job_id = json_extract(payload, '$.jobId')
      WHERE json_valid(payload) = 1;
      CREATE INDEX IF NOT EXISTS notifications_by_user_time ON notifications(user_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS notifications_unread_by_user ON notifications(user_id, read_at) WHERE read_at IS NULL;
    `,
  },
  {
    version: 13,
    sql: `
      ALTER TABLE audit_events ADD COLUMN actor TEXT;
      ALTER TABLE audit_events ADD COLUMN action TEXT;
      ALTER TABLE audit_events ADD COLUMN target TEXT;
      ALTER TABLE audit_events ADD COLUMN occurred_at INTEGER;
      UPDATE audit_events
      SET actor = json_extract(payload, '$.actor'),
          action = json_extract(payload, '$.action'),
          target = json_extract(payload, '$.target'),
          occurred_at = COALESCE(json_extract(payload, '$.ts'), updated_at)
      WHERE json_valid(payload) = 1;
      CREATE INDEX IF NOT EXISTS audit_events_by_time ON audit_events(occurred_at DESC, id DESC);
    `,
  },
  {
    version: 14,
    sql: `
      ALTER TABLE testflight_subscriptions ADD COLUMN invite_code TEXT;
      ALTER TABLE testflight_subscriptions ADD COLUMN requester_id TEXT;
      ALTER TABLE testflight_subscriptions ADD COLUMN subscription_status TEXT;
      ALTER TABLE testflight_subscriptions ADD COLUMN bundle_id TEXT;
      ALTER TABLE testflight_subscriptions ADD COLUMN created_at INTEGER;
      UPDATE testflight_subscriptions
      SET invite_code = json_extract(payload, '$.inviteCode'),
          requester_id = lower(json_extract(payload, '$.requestedBy')),
          subscription_status = json_extract(payload, '$.status'),
          bundle_id = json_extract(payload, '$.bundleId'),
          created_at = COALESCE(json_extract(payload, '$.createdAt'), updated_at)
      WHERE json_valid(payload) = 1;
      CREATE INDEX IF NOT EXISTS testflight_subscriptions_by_invite ON testflight_subscriptions(invite_code, subscription_status);
      CREATE INDEX IF NOT EXISTS testflight_subscriptions_by_requester ON testflight_subscriptions(requester_id, created_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS testflight_subscription_devices (
        subscription_id TEXT NOT NULL REFERENCES testflight_subscriptions(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        status TEXT NOT NULL,
        apple_membership TEXT,
        last_verified_at INTEGER,
        last_synced_at INTEGER,
        last_error TEXT,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (subscription_id, device_id)
      );
      INSERT OR IGNORE INTO testflight_subscription_devices (
        subscription_id, device_id, status, apple_membership, last_verified_at,
        last_synced_at, last_error, payload, updated_at
      )
      SELECT subscriptions.id,
             json_extract(device.value, '$.deviceId'),
             json_extract(device.value, '$.status'),
             json_extract(device.value, '$.appleMembership'),
             json_extract(device.value, '$.lastVerifiedAt'),
             json_extract(device.value, '$.lastSyncedAt'),
             json_extract(device.value, '$.lastError'),
             device.value,
             COALESCE(json_extract(device.value, '$.lastSyncedAt'), json_extract(device.value, '$.lastVerifiedAt'), subscriptions.updated_at)
      FROM testflight_subscriptions AS subscriptions,
           json_each(CASE WHEN json_valid(subscriptions.payload) = 1 THEN subscriptions.payload ELSE '{}' END, '$.devices') AS device
      WHERE json_type(device.value, '$.deviceId') = 'text'
        AND json_type(device.value, '$.status') = 'text';
      CREATE INDEX IF NOT EXISTS testflight_subscription_devices_by_device ON testflight_subscription_devices(device_id, status, subscription_id);
    `,
  },
  {
    version: 15,
    sql: `
      CREATE TABLE IF NOT EXISTS job_history (
        id TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        project_id TEXT,
        bundle_id TEXT,
        source TEXT,
        status TEXT,
        queued_by TEXT,
        device_id TEXT,
        finished_at INTEGER,
        error_text TEXT,
        failure_class TEXT
      );
      INSERT OR IGNORE INTO job_history (
        id, payload, updated_at, project_id, bundle_id, source, status, queued_by,
        device_id, finished_at, error_text, failure_class
      )
      SELECT json_extract(history.value, '$.id'),
             history.value,
             COALESCE(json_extract(history.value, '$.finishedAt'), state_snapshots.updated_at),
             COALESCE(json_extract(history.value, '$.projectId'), 'default'),
             json_extract(history.value, '$.bundleId'),
             json_extract(history.value, '$.source'),
             json_extract(history.value, '$.status'),
             lower(json_extract(history.value, '$.queuedBy')),
             json_extract(history.value, '$.deviceId'),
             json_extract(history.value, '$.finishedAt'),
             json_extract(history.value, '$.error'),
             json_extract(history.value, '$.failureClass')
      FROM state_snapshots,
           json_each(CASE WHEN json_valid(state_snapshots.payload) = 1 THEN state_snapshots.payload ELSE '{}' END, '$.jobHistory') AS history
      WHERE json_type(history.value, '$.id') = 'text';
      CREATE INDEX IF NOT EXISTS job_history_by_project_time ON job_history(project_id, finished_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS job_history_by_user_time ON job_history(queued_by, finished_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS job_history_by_device_time ON job_history(device_id, finished_at DESC, id DESC);
    `,
  },
  {
    version: 16,
    sql: `
      ALTER TABLE webhook_inbox ADD COLUMN provider TEXT;
      ALTER TABLE webhook_inbox ADD COLUMN event_id TEXT;
      ALTER TABLE webhook_inbox ADD COLUMN status TEXT;
      ALTER TABLE webhook_inbox ADD COLUMN raw_body_sha256 TEXT;
      ALTER TABLE webhook_inbox ADD COLUMN received_at INTEGER;
      ALTER TABLE webhook_inbox ADD COLUMN processed_at INTEGER;
      ALTER TABLE webhook_inbox ADD COLUMN attempts INTEGER;
      ALTER TABLE webhook_inbox ADD COLUMN last_error TEXT;
      UPDATE webhook_inbox
      SET provider = json_extract(payload, '$.provider'),
          event_id = json_extract(payload, '$.eventId'),
          status = json_extract(payload, '$.status'),
          raw_body_sha256 = json_extract(payload, '$.rawBodySha256'),
          received_at = COALESCE(json_extract(payload, '$.receivedAt'), updated_at),
          processed_at = json_extract(payload, '$.processedAt'),
          attempts = COALESCE(json_extract(payload, '$.attempts'), 0),
          last_error = json_extract(payload, '$.lastError')
      WHERE json_valid(payload) = 1;
      CREATE INDEX IF NOT EXISTS webhook_inbox_by_event ON webhook_inbox(provider, event_id, received_at, id);
      CREATE INDEX IF NOT EXISTS webhook_inbox_by_provider_time ON webhook_inbox(provider, received_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS webhook_inbox_by_status_time ON webhook_inbox(status, received_at DESC, id DESC);
    `,
  },
  {
    version: 17,
    sql: `
      CREATE TABLE IF NOT EXISTS billing_customers (
        id TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        provider TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        user_id TEXT,
        email TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS billing_subscriptions (
        id TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        provider TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        user_id TEXT,
        status TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        wallet_address TEXT,
        checkout_id TEXT,
        provider_payment_id TEXT
      );
      CREATE TABLE IF NOT EXISTS billing_checkouts (
        id TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        provider TEXT NOT NULL,
        checkout_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        provider_checkout_id TEXT,
        provider_payment_id TEXT
      );
      CREATE TABLE IF NOT EXISTS billing_charges (
        id TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        provider TEXT NOT NULL,
        charge_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        charge_nonce INTEGER,
        tx_hash TEXT
      );
      CREATE TABLE IF NOT EXISTS billing_entitlement_history (
        id TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        user_id TEXT,
        subscription_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        status TEXT NOT NULL
      );
      ALTER TABLE billing_events ADD COLUMN provider TEXT;
      ALTER TABLE billing_events ADD COLUMN event_id TEXT;
      ALTER TABLE billing_events ADD COLUMN occurred_at INTEGER;
      ALTER TABLE billing_events ADD COLUMN processed_at INTEGER;
      UPDATE billing_events
      SET payload = json_set(payload, '$.provider', 'legacy')
      WHERE json_valid(payload) = 1 AND json_extract(payload, '$.provider') = 'exodus';
      UPDATE billing_events
      SET provider = CASE json_extract(payload, '$.provider') WHEN 'exodus' THEN 'legacy' ELSE json_extract(payload, '$.provider') END,
          event_id = json_extract(payload, '$.eventId'),
          occurred_at = CAST((julianday(json_extract(payload, '$.occurredAt')) - 2440587.5) * 86400000 AS INTEGER),
          processed_at = COALESCE(CAST((julianday(json_extract(payload, '$.processedAt')) - 2440587.5) * 86400000 AS INTEGER), updated_at)
      WHERE json_valid(payload) = 1;
      INSERT OR IGNORE INTO billing_events (id, payload, updated_at, provider, event_id, occurred_at, processed_at)
      SELECT CASE json_extract(event.value, '$.provider') WHEN 'exodus' THEN 'legacy' ELSE json_extract(event.value, '$.provider') END || ':' || json_extract(event.value, '$.eventId'),
             CASE WHEN json_extract(event.value, '$.provider') = 'exodus' THEN json_set(event.value, '$.provider', 'legacy') ELSE event.value END,
             COALESCE(CAST((julianday(json_extract(event.value, '$.processedAt')) - 2440587.5) * 86400000 AS INTEGER), records.updated_at),
             CASE json_extract(event.value, '$.provider') WHEN 'exodus' THEN 'legacy' ELSE json_extract(event.value, '$.provider') END,
             json_extract(event.value, '$.eventId'),
             CAST((julianday(json_extract(event.value, '$.occurredAt')) - 2440587.5) * 86400000 AS INTEGER),
             COALESCE(CAST((julianday(json_extract(event.value, '$.processedAt')) - 2440587.5) * 86400000 AS INTEGER), records.updated_at)
      FROM billing_records AS records,
           json_each(CASE WHEN json_valid(records.payload) = 1 THEN records.payload ELSE '{}' END, '$.value.processedEvents') AS event
      WHERE json_extract(records.payload, '$.kind') = 'snapshot'
        AND NOT EXISTS (
          SELECT 1 FROM billing_events AS existing
          WHERE existing.provider = CASE json_extract(event.value, '$.provider') WHEN 'exodus' THEN 'legacy' ELSE json_extract(event.value, '$.provider') END
            AND existing.event_id = json_extract(event.value, '$.eventId')
        );
      INSERT OR IGNORE INTO billing_customers (id, payload, updated_at, ordinal, provider, customer_id, user_id, email)
      SELECT CASE json_extract(customer.value, '$.provider') WHEN 'exodus' THEN 'legacy' ELSE json_extract(customer.value, '$.provider') END || ':' || json_extract(customer.value, '$.customerId'),
             CASE WHEN json_extract(customer.value, '$.provider') = 'exodus' THEN json_set(customer.value, '$.provider', 'legacy') ELSE customer.value END,
             COALESCE(CAST((julianday(json_extract(customer.value, '$.updatedAt')) - 2440587.5) * 86400000 AS INTEGER), records.updated_at),
             CAST(customer.key AS INTEGER),
             CASE json_extract(customer.value, '$.provider') WHEN 'exodus' THEN 'legacy' ELSE json_extract(customer.value, '$.provider') END,
             json_extract(customer.value, '$.customerId'),
             json_extract(customer.value, '$.userId'),
             json_extract(customer.value, '$.email')
      FROM billing_records AS records,
           json_each(CASE WHEN json_valid(records.payload) = 1 THEN records.payload ELSE '{}' END, '$.value.customers') AS customer
      WHERE json_extract(records.payload, '$.kind') = 'snapshot';
      INSERT OR IGNORE INTO billing_subscriptions (
        id, payload, updated_at, ordinal, provider, subscription_id, customer_id, user_id,
        status, plan_id, wallet_address, checkout_id, provider_payment_id
      )
      SELECT CASE json_extract(subscription.value, '$.provider') WHEN 'exodus' THEN 'legacy' ELSE json_extract(subscription.value, '$.provider') END || ':' || json_extract(subscription.value, '$.subscriptionId'),
             CASE WHEN json_extract(subscription.value, '$.provider') = 'exodus' THEN json_set(subscription.value, '$.provider', 'legacy') ELSE subscription.value END,
             COALESCE(CAST((julianday(json_extract(subscription.value, '$.updatedAt')) - 2440587.5) * 86400000 AS INTEGER), records.updated_at),
             CAST(subscription.key AS INTEGER),
             CASE json_extract(subscription.value, '$.provider') WHEN 'exodus' THEN 'legacy' ELSE json_extract(subscription.value, '$.provider') END,
             json_extract(subscription.value, '$.subscriptionId'),
             json_extract(subscription.value, '$.customerId'),
             json_extract(subscription.value, '$.userId'),
             json_extract(subscription.value, '$.status'),
             json_extract(subscription.value, '$.planId'),
             json_extract(subscription.value, '$.walletAddress'),
             json_extract(subscription.value, '$.checkoutId'),
             json_extract(subscription.value, '$.providerPaymentId')
      FROM billing_records AS records,
           json_each(CASE WHEN json_valid(records.payload) = 1 THEN records.payload ELSE '{}' END, '$.value.subscriptions') AS subscription
      WHERE json_extract(records.payload, '$.kind') = 'snapshot';
      INSERT OR IGNORE INTO billing_checkouts (
        id, payload, updated_at, ordinal, provider, checkout_id, user_id, idempotency_key, status, plan_id,
        provider_checkout_id, provider_payment_id
      )
      SELECT CASE json_extract(checkout.value, '$.provider') WHEN 'exodus' THEN 'legacy' ELSE json_extract(checkout.value, '$.provider') END || ':' || json_extract(checkout.value, '$.checkoutId'),
             CASE WHEN json_extract(checkout.value, '$.provider') = 'exodus' THEN json_set(checkout.value, '$.provider', 'legacy') ELSE checkout.value END,
             COALESCE(CAST((julianday(json_extract(checkout.value, '$.updatedAt')) - 2440587.5) * 86400000 AS INTEGER), records.updated_at),
             CAST(checkout.key AS INTEGER),
             CASE json_extract(checkout.value, '$.provider') WHEN 'exodus' THEN 'legacy' ELSE json_extract(checkout.value, '$.provider') END,
             json_extract(checkout.value, '$.checkoutId'),
             json_extract(checkout.value, '$.userId'),
             json_extract(checkout.value, '$.idempotencyKey'),
             json_extract(checkout.value, '$.status'),
             json_extract(checkout.value, '$.planId'),
             json_extract(checkout.value, '$.providerCheckoutId'),
             json_extract(checkout.value, '$.providerPaymentId')
      FROM billing_records AS records,
           json_each(CASE WHEN json_valid(records.payload) = 1 THEN records.payload ELSE '{}' END, '$.value.cryptoCheckouts') AS checkout
      WHERE json_extract(records.payload, '$.kind') = 'snapshot';
      INSERT OR IGNORE INTO billing_charges (
        id, payload, updated_at, ordinal, provider, charge_id, subscription_id, user_id, status, charge_nonce, tx_hash
      )
      SELECT CASE json_extract(charge.value, '$.provider') WHEN 'exodus' THEN 'legacy' ELSE json_extract(charge.value, '$.provider') END || ':' || json_extract(charge.value, '$.chargeId'),
             CASE WHEN json_extract(charge.value, '$.provider') = 'exodus' THEN json_set(charge.value, '$.provider', 'legacy') ELSE charge.value END,
             COALESCE(CAST((julianday(json_extract(charge.value, '$.updatedAt')) - 2440587.5) * 86400000 AS INTEGER), records.updated_at),
             CAST(charge.key AS INTEGER),
             CASE json_extract(charge.value, '$.provider') WHEN 'exodus' THEN 'legacy' ELSE json_extract(charge.value, '$.provider') END,
             json_extract(charge.value, '$.chargeId'),
             json_extract(charge.value, '$.subscriptionId'),
             json_extract(charge.value, '$.userId'),
             json_extract(charge.value, '$.status'),
             json_extract(charge.value, '$.chargeNonce'),
             json_extract(charge.value, '$.txHash')
      FROM billing_records AS records,
           json_each(CASE WHEN json_valid(records.payload) = 1 THEN records.payload ELSE '{}' END, '$.value.cryptoCharges') AS charge
      WHERE json_extract(records.payload, '$.kind') = 'snapshot';
      INSERT OR IGNORE INTO billing_entitlement_history (
        id, payload, updated_at, user_id, subscription_id, provider, plan_id, event_kind, status
      )
      SELECT json_extract(event.value, '$.id'),
             CASE WHEN json_extract(event.value, '$.provider') = 'exodus' THEN json_set(event.value, '$.provider', 'legacy') ELSE event.value END,
             COALESCE(CAST((julianday(json_extract(event.value, '$.at')) - 2440587.5) * 86400000 AS INTEGER), records.updated_at),
             json_extract(event.value, '$.userId'),
             json_extract(event.value, '$.subscriptionId'),
             CASE json_extract(event.value, '$.provider') WHEN 'exodus' THEN 'legacy' ELSE json_extract(event.value, '$.provider') END,
             json_extract(event.value, '$.planId'),
             json_extract(event.value, '$.kind'),
             json_extract(event.value, '$.status')
      FROM billing_records AS records,
           json_each(CASE WHEN json_valid(records.payload) = 1 THEN records.payload ELSE '{}' END, '$.value.entitlementHistory') AS event
      WHERE json_extract(records.payload, '$.kind') = 'snapshot';
      CREATE INDEX IF NOT EXISTS billing_customers_by_user ON billing_customers(user_id, provider, ordinal);
      CREATE INDEX IF NOT EXISTS billing_customers_by_provider_customer ON billing_customers(provider, customer_id);
      CREATE INDEX IF NOT EXISTS billing_subscriptions_by_user ON billing_subscriptions(user_id, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS billing_subscriptions_by_user_subscription ON billing_subscriptions(user_id, subscription_id, ordinal);
      CREATE INDEX IF NOT EXISTS billing_subscriptions_by_id ON billing_subscriptions(subscription_id, ordinal);
      CREATE INDEX IF NOT EXISTS billing_subscriptions_by_provider_status ON billing_subscriptions(provider, status, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS billing_subscriptions_by_plan ON billing_subscriptions(plan_id, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS billing_subscriptions_by_wallet ON billing_subscriptions(wallet_address);
      CREATE INDEX IF NOT EXISTS billing_subscriptions_by_invoice ON billing_subscriptions(checkout_id, provider_payment_id);
      CREATE INDEX IF NOT EXISTS billing_checkouts_by_user_key ON billing_checkouts(user_id, idempotency_key, provider);
      CREATE INDEX IF NOT EXISTS billing_checkouts_by_checkout_id ON billing_checkouts(checkout_id, provider);
      CREATE INDEX IF NOT EXISTS billing_checkouts_by_payment ON billing_checkouts(provider_checkout_id, provider_payment_id);
      CREATE INDEX IF NOT EXISTS billing_charges_by_subscription_time ON billing_charges(subscription_id, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS billing_charges_by_subscription_order ON billing_charges(subscription_id, ordinal, id);
      CREATE INDEX IF NOT EXISTS billing_charges_by_charge_id ON billing_charges(charge_id, ordinal);
      CREATE INDEX IF NOT EXISTS billing_charges_by_nonce ON billing_charges(subscription_id, charge_nonce) WHERE charge_nonce IS NOT NULL;
      CREATE INDEX IF NOT EXISTS billing_entitlement_history_by_subscription_time ON billing_entitlement_history(subscription_id, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS billing_entitlement_history_by_user_time ON billing_entitlement_history(user_id, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS billing_events_by_provider_event ON billing_events(provider, event_id);
      CREATE INDEX IF NOT EXISTS billing_events_by_processed_at ON billing_events(processed_at DESC, id DESC);
    `,
  },
  {
    version: 18,
    sql: `
      ALTER TABLE sessions ADD COLUMN user_id TEXT;
      ALTER TABLE sessions ADD COLUMN created_at INTEGER;
      ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
      UPDATE sessions
      SET user_id = lower(json_extract(payload, '$.sub')),
          created_at = CAST(json_extract(payload, '$.createdAt') AS INTEGER),
          last_seen_at = CAST(json_extract(payload, '$.lastSeenAt') AS INTEGER)
      WHERE json_valid(payload) = 1;
      CREATE INDEX IF NOT EXISTS sessions_by_user_last_seen ON sessions(user_id, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(last_seen_at);
    `,
  },
  {
    version: 19,
    sql: `
      ALTER TABLE api_keys ADD COLUMN owner_id TEXT GENERATED ALWAYS AS (
        CASE WHEN json_valid(payload) = 1 THEN lower(json_extract(payload, '$.ownerId')) END
      ) VIRTUAL;
      ALTER TABLE api_keys ADD COLUMN status TEXT GENERATED ALWAYS AS (
        CASE WHEN json_valid(payload) = 1 THEN json_extract(payload, '$.status') END
      ) VIRTUAL;
      ALTER TABLE api_keys ADD COLUMN key_hash TEXT GENERATED ALWAYS AS (
        CASE WHEN json_valid(payload) = 1 THEN json_extract(payload, '$.hash') END
      ) VIRTUAL;
      ALTER TABLE api_keys ADD COLUMN previous_hash TEXT GENERATED ALWAYS AS (
        CASE WHEN json_valid(payload) = 1 THEN json_extract(payload, '$.previousHash') END
      ) VIRTUAL;
      ALTER TABLE api_keys ADD COLUMN previous_hash_expires_at INTEGER GENERATED ALWAYS AS (
        CASE WHEN json_valid(payload) = 1 THEN CAST(json_extract(payload, '$.previousHashExpiresAt') AS INTEGER) END
      ) VIRTUAL;
      ALTER TABLE api_keys ADD COLUMN created_at INTEGER GENERATED ALWAYS AS (
        CASE WHEN json_valid(payload) = 1 THEN CAST(json_extract(payload, '$.createdAt') AS INTEGER) END
      ) VIRTUAL;
      ALTER TABLE api_keys ADD COLUMN expires_at INTEGER GENERATED ALWAYS AS (
        CASE WHEN json_valid(payload) = 1 THEN CAST(json_extract(payload, '$.expiresAt') AS INTEGER) END
      ) VIRTUAL;
      CREATE INDEX IF NOT EXISTS api_keys_by_owner_created ON api_keys(owner_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS api_keys_by_status_created ON api_keys(status, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS api_keys_by_current_hash ON api_keys(key_hash, expires_at, created_at DESC) WHERE status = 'approved' AND key_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS api_keys_by_previous_hash ON api_keys(previous_hash, previous_hash_expires_at, expires_at, created_at DESC) WHERE status = 'approved' AND previous_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS api_keys_by_expiry ON api_keys(expires_at) WHERE expires_at IS NOT NULL;
    `,
  },
  {
    version: 20,
    sql: `
      CREATE TABLE IF NOT EXISTS backup_schedule (
        id TEXT PRIMARY KEY NOT NULL CHECK (id = 'active'),
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO backup_schedule (id, payload, updated_at)
      SELECT 'active', json_extract(payload, '$.backupSchedule'), updated_at
      FROM state_snapshots
      WHERE id = 1 AND json_valid(payload) = 1 AND json_type(payload, '$.backupSchedule') = 'object';
    `,
  },
  {
    version: 21,
    sql: `
      INSERT OR IGNORE INTO projects (id, payload, updated_at)
      SELECT json_extract(project.value, '$.id'),
             project.value,
             COALESCE(json_extract(project.value, '$.updatedAt'), state_snapshots.updated_at)
      FROM state_snapshots,
           json_each(CASE WHEN json_valid(state_snapshots.payload) = 1 THEN state_snapshots.payload ELSE '{}' END, '$.projects') AS project
      WHERE json_type(project.value, '$.id') = 'text';
    `,
  },
  {
    version: 22,
    sql: `
      CREATE TABLE IF NOT EXISTS diagnostic_reports (
        id TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS diagnostic_reports_by_user_time ON diagnostic_reports(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS diagnostic_reports_by_expiry ON diagnostic_reports(expires_at);
    `,
  },
  {
    version: 23,
    sql: `
      CREATE TABLE IF NOT EXISTS watch_drafts (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL, owner_id TEXT NOT NULL, project_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS watch_drafts_by_owner ON watch_drafts(owner_id, project_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS watch_revisions (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL, watch_id TEXT NOT NULL, project_id TEXT NOT NULL, deleted_at INTEGER);
      CREATE INDEX IF NOT EXISTS watch_revisions_by_watch ON watch_revisions(watch_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS operational_incidents (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL, project_id TEXT NOT NULL, source_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS operational_incidents_by_project ON operational_incidents(project_id, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS integration_policies (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL, kind TEXT NOT NULL, project_id TEXT NOT NULL, enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS integration_deliveries (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL, integration_id TEXT NOT NULL, event_id TEXT NOT NULL, UNIQUE(integration_id, event_id));
      CREATE INDEX IF NOT EXISTS integration_deliveries_by_time ON integration_deliveries(updated_at);
    `,
  },
  {
    version: 24,
    sql: `
      CREATE TABLE IF NOT EXISTS pending_oauth_links (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL, owner_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS pending_oauth_links_by_expiry ON pending_oauth_links(expires_at);
    `,
  },
  {
    version: 25,
    sql: `
      CREATE TABLE IF NOT EXISTS device_setup_operations (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS device_setup_operations_by_owner ON device_setup_operations(json_extract(payload, '$.ownerId'), updated_at DESC);
    `,
  },
  {
    version: 26,
    sql: `
      CREATE TABLE IF NOT EXISTS decrypt_quota_ledger (
        job_id TEXT PRIMARY KEY NOT NULL,
        owner_id TEXT NOT NULL,
        admitted_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reserved', 'consumed'))
      );
      CREATE INDEX IF NOT EXISTS decrypt_quota_by_owner_time ON decrypt_quota_ledger(owner_id, admitted_at);
    `,
  },
  {
    version: 27,
    sql: `
      CREATE TABLE IF NOT EXISTS appstore_offline_account (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `,
  },
  {
    version: 28,
    sql: `
      CREATE TABLE IF NOT EXISTS appstore_offline_credential_operations (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `,
  },
  {
    version: 29,
    sql: `
      CREATE TABLE IF NOT EXISTS appstore_offline_authentication_operations (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `,
  },
  {
    version: 30,
    sql: `
      UPDATE jobs SET project_id = 'default', payload = json_set(payload, '$.projectId', 'default') WHERE json_valid(payload) = 1;
      UPDATE job_history SET project_id = 'default', payload = json_set(payload, '$.projectId', 'default') WHERE json_valid(payload) = 1;
      UPDATE artifacts SET payload = json_set(payload, '$.projectIds', json_array('default')) WHERE json_valid(payload) = 1;
      DELETE FROM artifact_projects;
      INSERT INTO artifact_projects (artifact_id, project_id) SELECT id, 'default' FROM artifacts;
      UPDATE watches SET payload = json_set(payload, '$.projectId', 'default') WHERE json_valid(payload) = 1;
      UPDATE watch_drafts SET project_id = 'default', payload = json_set(payload, '$.projectId', 'default') WHERE json_valid(payload) = 1;
      UPDATE watch_revisions SET project_id = 'default', payload = json_set(payload, '$.projectId', 'default') WHERE json_valid(payload) = 1;
      UPDATE operational_incidents SET project_id = 'default', payload = json_set(payload, '$.projectId', 'default') WHERE json_valid(payload) = 1;
      UPDATE integration_policies SET project_id = 'default', payload = json_set(payload, '$.projectId', 'default') WHERE json_valid(payload) = 1;
      UPDATE diagnostic_reports SET project_id = 'default', payload = json_set(payload, '$.projectId', 'default') WHERE json_valid(payload) = 1;
      DELETE FROM projects;
      INSERT INTO projects (id, payload, updated_at)
      SELECT 'default', json_object('id', 'default', 'name', 'dkrypt', 'memberIds', json('[]'), 'isDefault', 1, 'createdBy', 'system', 'createdAt', updated_at, 'updatedAt', updated_at), updated_at
      FROM state_snapshots WHERE id = 1
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at;
      DROP INDEX IF EXISTS jobs_active_exact_build;
      DROP INDEX IF EXISTS jobs_completed_exact_build;
      CREATE INDEX jobs_active_exact_build ON jobs(bundle_id, external_version_id, testflight_build_id, status);
      CREATE INDEX jobs_completed_exact_build ON jobs(bundle_id, external_version_id, testflight_build_id, status, file_path);
    `,
  },
  {
    version: 31,
    sql: `
      UPDATE projects
      SET payload = json_set(payload, '$.isDefault', json(CASE WHEN json_extract(payload, '$.isDefault') = 1 THEN 'true' ELSE 'false' END))
      WHERE json_valid(payload) = 1
        AND json_type(payload, '$.isDefault') IN ('integer', 'real')
        AND json_extract(payload, '$.isDefault') IN (0, 1);
    `,
  },
  {
    version: 32,
    sql: `
      CREATE TABLE job_worker_leases (
        job_id TEXT PRIMARY KEY NOT NULL,
        worker_id TEXT NOT NULL,
        resource_id TEXT NOT NULL UNIQUE,
        generation INTEGER NOT NULL,
        lease_until INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX job_worker_leases_by_resource ON job_worker_leases(resource_id, lease_until);
      CREATE TABLE job_worker_generations (
        resource_id TEXT PRIMARY KEY NOT NULL,
        generation INTEGER NOT NULL
      );
    `,
  },
  {
    version: 33,
    sql: `
      CREATE TABLE IF NOT EXISTS worker_instances (
        worker_id TEXT PRIMARY KEY NOT NULL,
        started_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'draining', 'drained', 'offline')),
        configuration TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS worker_instances_by_heartbeat ON worker_instances(heartbeat_at);
    `,
  },
  {
    version: 34,
    sql: `
      CREATE TABLE IF NOT EXISTS mcp_records (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS mcp_records_type_updated ON mcp_records(json_extract(payload, '$.type'), updated_at DESC);
      CREATE TABLE IF NOT EXISTS decrypt_credit_records (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS decrypt_credit_records_owner_type ON decrypt_credit_records(json_extract(payload, '$.ownerId'), json_extract(payload, '$.type'), updated_at DESC);
      CREATE TABLE IF NOT EXISTS service_monitor_state (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `,
  },
  {
    version: 35,
    sql: `
      CREATE TABLE IF NOT EXISTS free_decrypt_quota (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id TEXT NOT NULL,
        job_id TEXT UNIQUE,
        reserved_at INTEGER,
        completed_at INTEGER,
        CHECK (
          (job_id IS NOT NULL AND reserved_at IS NOT NULL AND completed_at IS NULL)
          OR (job_id IS NULL AND reserved_at IS NULL AND completed_at IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS free_decrypt_quota_by_owner_completion ON free_decrypt_quota(owner_id, completed_at);
      CREATE INDEX IF NOT EXISTS free_decrypt_quota_by_owner_reservation ON free_decrypt_quota(owner_id, reserved_at);
    `,
  },
  {
    version: 36,
    sql: `
      CREATE TABLE abuse_signup_events (
        id TEXT PRIMARY KEY NOT NULL,
        network_hash TEXT NOT NULL,
        address_hash TEXT NOT NULL,
        browser_hash TEXT,
        browser_expires_at INTEGER,
        turnstile_hash TEXT,
        turnstile_expires_at INTEGER,
        email_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX abuse_signup_events_by_network_time ON abuse_signup_events(network_hash, created_at);
      CREATE INDEX abuse_signup_events_by_address_time ON abuse_signup_events(address_hash, created_at);
      CREATE INDEX abuse_signup_events_by_browser_time ON abuse_signup_events(browser_hash, created_at);
      CREATE INDEX abuse_signup_events_by_turnstile_time ON abuse_signup_events(turnstile_hash, created_at);
      CREATE INDEX abuse_signup_events_by_email_time ON abuse_signup_events(email_hash, created_at);
      CREATE INDEX abuse_signup_events_by_expiry ON abuse_signup_events(expires_at);
      CREATE TABLE abuse_signup_challenges (
        id TEXT PRIMARY KEY NOT NULL,
        network_hash TEXT NOT NULL,
        browser_hash TEXT,
        turnstile_hash TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE INDEX abuse_signup_challenges_by_expiry ON abuse_signup_challenges(expires_at);
      CREATE TABLE abuse_ip_reputation (
        address_hash TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL,
        checked_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 37,
    sql: `
      CREATE TABLE free_decrypt_abuse_quota (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT UNIQUE,
        network_hash TEXT NOT NULL,
        address_hash TEXT NOT NULL,
        browser_hash TEXT,
        browser_expires_at INTEGER,
        turnstile_hash TEXT,
        turnstile_expires_at INTEGER,
        reserved_at INTEGER,
        completed_at INTEGER,
        CHECK (
          (job_id IS NOT NULL AND reserved_at IS NOT NULL AND completed_at IS NULL)
          OR (job_id IS NULL AND reserved_at IS NULL AND completed_at IS NOT NULL)
        )
      );
      CREATE INDEX free_decrypt_abuse_quota_by_network ON free_decrypt_abuse_quota(network_hash, completed_at, reserved_at);
      CREATE INDEX free_decrypt_abuse_quota_by_address ON free_decrypt_abuse_quota(address_hash, completed_at, reserved_at);
      CREATE INDEX free_decrypt_abuse_quota_by_browser ON free_decrypt_abuse_quota(browser_hash, completed_at, reserved_at);
      CREATE INDEX free_decrypt_abuse_quota_by_turnstile ON free_decrypt_abuse_quota(turnstile_hash, completed_at, reserved_at);
      CREATE INDEX free_decrypt_abuse_quota_by_expiry ON free_decrypt_abuse_quota(completed_at, browser_expires_at, turnstile_expires_at);
    `,
  },
] as const;

export const LATEST_SQLITE_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;

const domainTables = [
  'users',
  'roles',
  'projects',
  'sessions',
  'api_keys',
  'devices',
  'device_health',
  'device_history',
  'jobs',
  'job_history',
  'job_timelines',
  'artifacts',
  'watches',
  'notifications',
  'audit_events',
  'billing_records',
  'testflight_subscriptions',
  'webhook_inbox',
  'backups',
  'backup_schedule',
  'idempotency_keys',
  'settings',
  'scheduler_runs',
] as const;

const stateOwnedDomainTables = domainTables.filter(
  (table): table is Exclude<(typeof domainTables)[number], 'jobs' | 'job_timelines' | 'billing_records' | 'artifacts' | 'idempotency_keys' | 'webhook_inbox'> =>
    table !== 'jobs' && table !== 'job_timelines' && table !== 'billing_records' && table !== 'artifacts' && table !== 'idempotency_keys' && table !== 'webhook_inbox',
);

const collectionTables = new Set([
  ...domainTables,
  'auth_profiles',
  'device_history',
  'billing_events',
  'billing_customers',
  'billing_subscriptions',
  'billing_checkouts',
  'billing_charges',
  'billing_entitlement_history',
  'correlation_events',
  'webhook_attempts',
  'diagnostic_reports',
  'watch_drafts',
  'watch_revisions',
  'operational_incidents',
  'integration_policies',
  'integration_deliveries',
  'pending_oauth_links',
  'device_setup_operations',
  'device_recovery_operations',
  'decrypt_quota_ledger',
  'appstore_offline_account',
  'appstore_offline_credential_operations',
  'appstore_offline_authentication_operations',
  'mcp_records',
  'decrypt_credit_records',
  'service_monitor_state',
]);

function assertCollectionTable(table: string): void {
  if (!collectionTables.has(table)) throw new Error(`unknown SQLite collection: ${table}`);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === 'string' ? record[key] as string : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  return typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] as number : null;
}

function timestampField(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = stringField(record, key);
  if (!value) return fallback;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function jobIndexValues(payload: unknown, updatedAt: number): Array<string | number | null> {
  const job = asRecord(payload);
  const testflight = asRecord(job.testflight);
  const build = asRecord(testflight.build);
  return [
    stringField(job, 'status'),
    stringField(job, 'bundleId'),
    stringField(job, 'externalVersionId'),
    numberField(build, 'id'),
    stringField(job, 'projectId') ?? 'default',
    stringField(job, 'source'),
    numberField(job, 'priority') ?? 0,
    numberField(job, 'createdAt') ?? updatedAt,
    numberField(job, 'startedAt'),
    numberField(job, 'finishedAt'),
    numberField(job, 'attempt'),
    numberField(job, 'deadlineAt'),
    stringField(job, 'failureClass'),
    stringField(job, 'correlationId'),
    stringField(job, 'deviceId'),
    stringField(job, 'filePath'),
  ];
}

function artifactIndexValues(payload: unknown, updatedAt: number): Array<string | number | null> {
  const artifact = asRecord(payload);
  return [
    stringField(artifact, 'key'),
    stringField(artifact, 'bundleId'),
    stringField(artifact, 'channel'),
    stringField(artifact, 'externalVersionId'),
    numberField(artifact, 'testflightBuildId'),
    stringField(artifact, 'versionLabel'),
    stringField(artifact, 'buildNumber'),
    stringField(artifact, 'filePath'),
    numberField(artifact, 'fileSizeBytes'),
    stringField(artifact, 'sha256'),
    numberField(artifact, 'createdAt') ?? updatedAt,
    numberField(artifact, 'lastAccessedAt') ?? updatedAt,
    numberField(artifact, 'accessCount') ?? 0,
    numberField(artifact, 'pinnedAt'),
    stringField(artifact, 'sourceJobId'),
  ];
}

function deviceHistoryIndexValues(payload: unknown, updatedAt: number): Array<string | number | null> {
  const entry = asRecord(payload);
  return [
    stringField(entry, 'deviceId'),
    stringField(entry, 'kind'),
    numberField(entry, 'ts') ?? updatedAt,
    stringField(entry, 'bundleId'),
  ];
}

function deviceHealthIndexValues(payload: unknown, updatedAt: number): Array<string | number | null> {
  const check = asRecord(payload);
  return [
    stringField(check, 'deviceId'),
    numberField(check, 'ts') ?? updatedAt,
    typeof check.reachable === 'boolean' ? Number(check.reachable) : null,
    numberField(check, 'batteryPercent'),
    numberField(check, 'batteryTemperatureC'),
    numberField(check, 'storageUsedPercent'),
  ];
}

function notificationIndexValues(payload: unknown, updatedAt: number): Array<string | number | null> {
  const notification = asRecord(payload);
  const userId = stringField(notification, 'userId');
  return [
    userId?.toLowerCase() ?? null,
    numberField(notification, 'createdAt') ?? updatedAt,
    numberField(notification, 'readAt'),
    stringField(notification, 'severity'),
    stringField(notification, 'jobId'),
  ];
}

function sessionIndexValues(payload: unknown, updatedAt: number): Array<string | number | null> {
  const session = asRecord(payload);
  const userId = stringField(session, 'sub');
  return [
    userId?.toLowerCase() ?? null,
    numberField(session, 'createdAt') ?? updatedAt,
    numberField(session, 'lastSeenAt') ?? updatedAt,
  ];
}

function auditIndexValues(payload: unknown, updatedAt: number): Array<string | number | null> {
  const entry = asRecord(payload);
  return [
    stringField(entry, 'actor'),
    stringField(entry, 'action'),
    stringField(entry, 'target'),
    numberField(entry, 'ts') ?? updatedAt,
  ];
}

function testFlightSubscriptionIndexValues(payload: unknown, updatedAt: number): Array<string | number | null> {
  const subscription = asRecord(payload);
  const requestedBy = stringField(subscription, 'requestedBy');
  return [
    stringField(subscription, 'inviteCode'),
    requestedBy?.toLowerCase() ?? null,
    stringField(subscription, 'status'),
    stringField(subscription, 'bundleId'),
    numberField(subscription, 'createdAt') ?? updatedAt,
  ];
}

function jobHistoryIndexValues(payload: unknown, updatedAt: number): Array<string | number | null> {
  const entry = asRecord(payload);
  const queuedBy = stringField(entry, 'queuedBy');
  return [
    stringField(entry, 'projectId') ?? 'default',
    stringField(entry, 'bundleId'),
    stringField(entry, 'source'),
    stringField(entry, 'status'),
    queuedBy?.toLowerCase() ?? null,
    stringField(entry, 'deviceId'),
    numberField(entry, 'finishedAt') ?? updatedAt,
    stringField(entry, 'error'),
    stringField(entry, 'failureClass'),
  ];
}

function testFlightSubscriptionDevices(payload: unknown): Array<{ deviceId: string; payload: Record<string, unknown> }> {
  const subscription = asRecord(payload);
  if (!Array.isArray(subscription.devices)) return [];
  return subscription.devices.flatMap((value) => {
    const device = asRecord(value);
    const deviceId = stringField(device, 'deviceId');
    const status = stringField(device, 'status');
    return deviceId && status ? [{ deviceId, payload: device }] : [];
  });
}

function deviceHealthRows(value: unknown): DomainRow[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value as StateRecord).flatMap(([deviceId, rawHistory]) => {
    if (!Array.isArray(rawHistory)) return [];
    return rawHistory.map((rawCheck, index) => {
      const check = asRecord(rawCheck);
      const updatedAt = numberField(check, 'ts') ?? Date.now();
      return {
        id: `${deviceId}:${String(index).padStart(4, '0')}`,
        payload: { ...check, deviceId },
        updatedAt,
      };
    });
  });
}

function replaceCollectionRows(database: Database, replacement: StateCollectionReplacement): void {
  database.exec(`DELETE FROM ${replacement.table};`);
  if (replacement.table === 'decrypt_quota_ledger') {
    const statement = database.query('INSERT INTO decrypt_quota_ledger (job_id, owner_id, admitted_at, state) VALUES (?, ?, ?, ?)');
    for (const row of replacement.rows) {
      const entry = asRecord(row.payload);
      statement.run(stringField(entry, 'jobId'), stringField(entry, 'ownerId'), numberField(entry, 'admittedAt'), stringField(entry, 'state'));
    }
    return;
  }
  if (replacement.table === 'sessions') {
    const statement = database.query('INSERT INTO sessions (id, payload, updated_at, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?);');
    for (const row of replacement.rows) {
      const updatedAt = row.updatedAt ?? Date.now();
      statement.run(row.id, json(row.payload), updatedAt, ...sessionIndexValues(row.payload, updatedAt));
    }
    return;
  }
  if (replacement.table === 'billing_customers') {
    const statement = database.query('INSERT INTO billing_customers (id, payload, updated_at, ordinal, provider, customer_id, user_id, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?);');
    for (const [index, row] of replacement.rows.entries()) {
      const customer = asRecord(row.payload);
      const updatedAt = row.updatedAt ?? timestampField(customer, 'updatedAt', Date.now());
      statement.run(row.id, json(row.payload), updatedAt, row.ordinal ?? index, stringField(customer, 'provider'), stringField(customer, 'customerId'), stringField(customer, 'userId'), stringField(customer, 'email') ?? '');
    }
    return;
  }
  if (replacement.table === 'billing_subscriptions') {
    const statement = database.query(`
      INSERT INTO billing_subscriptions (
        id, payload, updated_at, ordinal, provider, subscription_id, customer_id, user_id,
        status, plan_id, wallet_address, checkout_id, provider_payment_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    for (const row of replacement.rows) {
      const subscription = asRecord(row.payload);
      const updatedAt = row.updatedAt ?? timestampField(subscription, 'updatedAt', Date.now());
      statement.run(
        row.id,
        json(row.payload),
        updatedAt,
        row.ordinal ?? 0,
        stringField(subscription, 'provider'),
        stringField(subscription, 'subscriptionId'),
        stringField(subscription, 'customerId'),
        stringField(subscription, 'userId'),
        stringField(subscription, 'status'),
        stringField(subscription, 'planId'),
        stringField(subscription, 'walletAddress'),
        stringField(subscription, 'checkoutId'),
        stringField(subscription, 'providerPaymentId'),
      );
    }
    return;
  }
  if (replacement.table === 'billing_checkouts') {
    const statement = database.query(`
      INSERT INTO billing_checkouts (
        id, payload, updated_at, ordinal, provider, checkout_id, user_id, idempotency_key, status, plan_id,
        provider_checkout_id, provider_payment_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    for (const [index, row] of replacement.rows.entries()) {
      const checkout = asRecord(row.payload);
      const updatedAt = row.updatedAt ?? timestampField(checkout, 'updatedAt', Date.now());
      statement.run(row.id, json(row.payload), updatedAt, row.ordinal ?? index, stringField(checkout, 'provider'), stringField(checkout, 'checkoutId'), stringField(checkout, 'userId'), stringField(checkout, 'idempotencyKey'), stringField(checkout, 'status'), stringField(checkout, 'planId'), stringField(checkout, 'providerCheckoutId'), stringField(checkout, 'providerPaymentId'));
    }
    return;
  }
  if (replacement.table === 'billing_charges') {
    const statement = database.query(`
      INSERT INTO billing_charges (
        id, payload, updated_at, ordinal, provider, charge_id, subscription_id, user_id, status, charge_nonce, tx_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    for (const [index, row] of replacement.rows.entries()) {
      const charge = asRecord(row.payload);
      const updatedAt = row.updatedAt ?? timestampField(charge, 'updatedAt', Date.now());
      statement.run(row.id, json(row.payload), updatedAt, row.ordinal ?? index, stringField(charge, 'provider'), stringField(charge, 'chargeId'), stringField(charge, 'subscriptionId'), stringField(charge, 'userId'), stringField(charge, 'status'), numberField(charge, 'chargeNonce'), stringField(charge, 'txHash'));
    }
    return;
  }
  if (replacement.table === 'billing_entitlement_history') {
    const statement = database.query(`
      INSERT INTO billing_entitlement_history (
        id, payload, updated_at, user_id, subscription_id, provider, plan_id, event_kind, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    for (const row of replacement.rows) {
      const event = asRecord(row.payload);
      const updatedAt = row.updatedAt ?? timestampField(event, 'at', Date.now());
      statement.run(row.id, json(row.payload), updatedAt, stringField(event, 'userId'), stringField(event, 'subscriptionId'), stringField(event, 'provider'), stringField(event, 'planId'), stringField(event, 'kind'), stringField(event, 'status'));
    }
    return;
  }
  if (replacement.table === 'billing_events') {
    const statement = database.query('INSERT INTO billing_events (id, payload, updated_at, provider, event_id, occurred_at, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?);');
    for (const row of replacement.rows) {
      const event = asRecord(row.payload);
      const updatedAt = row.updatedAt ?? timestampField(event, 'processedAt', Date.now());
      statement.run(row.id, json(row.payload), updatedAt, stringField(event, 'provider'), stringField(event, 'eventId'), timestampField(event, 'occurredAt', updatedAt), timestampField(event, 'processedAt', updatedAt));
    }
    return;
  }
  if (replacement.table === 'diagnostic_reports') {
    const statement = database.query('INSERT INTO diagnostic_reports (id, payload, updated_at, user_id, project_id, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?);');
    for (const row of replacement.rows) {
      const report = asRecord(row.payload);
      const createdAt = timestampField(report, 'createdAt', row.updatedAt ?? Date.now());
      statement.run(row.id, json(row.payload), row.updatedAt ?? createdAt, stringField(report, 'userId'), stringField(report, 'projectId'), createdAt, timestampField(report, 'expiresAt', createdAt), stringField(report, 'status'));
    }
    return;
  }
  if (replacement.table === 'jobs') {
    const statement = database.query(`
      INSERT INTO jobs (
        id, payload, updated_at, status, bundle_id, external_version_id, testflight_build_id,
        project_id, source, priority, created_at, started_at, finished_at, attempt, deadline_at,
        failure_class, correlation_id, device_id, file_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    for (const row of replacement.rows) {
      const updatedAt = row.updatedAt ?? Date.now();
      statement.run(row.id, json(row.payload), updatedAt, ...jobIndexValues(row.payload, updatedAt));
    }
    return;
  }
  if (replacement.table === 'artifacts') {
    const statement = database.query(`
      INSERT INTO artifacts (
        id, payload, updated_at, artifact_key, bundle_id, channel, external_version_id, testflight_build_id,
        version_label, build_number, file_path, file_size_bytes, sha256, created_at, last_accessed_at,
        access_count, pinned_at, source_job_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    const projectLinkStatement = database.query('INSERT OR IGNORE INTO artifact_projects (artifact_id, project_id) VALUES (?, ?);');
    for (const row of replacement.rows) {
      const updatedAt = row.updatedAt ?? Date.now();
      statement.run(row.id, json(row.payload), updatedAt, ...artifactIndexValues(row.payload, updatedAt));
      const projectIds = asRecord(row.payload).projectIds;
      if (Array.isArray(projectIds)) {
        for (const projectId of projectIds) {
          if (typeof projectId === 'string') projectLinkStatement.run(row.id, projectId);
        }
      }
    }
    return;
  }
  if (replacement.table === 'device_history') {
    const statement = database.query(`
      INSERT INTO device_history (id, payload, updated_at, device_id, history_kind, occurred_at, bundle_id)
      VALUES (?, ?, ?, ?, ?, ?, ?);
    `);
    for (const row of replacement.rows) {
      const updatedAt = row.updatedAt ?? Date.now();
      statement.run(row.id, json(row.payload), updatedAt, ...deviceHistoryIndexValues(row.payload, updatedAt));
    }
    return;
  }
  if (replacement.table === 'device_health') {
    const statement = database.query(`
      INSERT INTO device_health (
        id, payload, updated_at, device_id, checked_at, reachable, battery_percent,
        battery_temperature_c, storage_used_percent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    for (const row of replacement.rows) {
      const updatedAt = row.updatedAt ?? Date.now();
      statement.run(row.id, json(row.payload), updatedAt, ...deviceHealthIndexValues(row.payload, updatedAt));
    }
    return;
  }
  if (replacement.table === 'notifications') {
    const statement = database.query(`
      INSERT INTO notifications (id, payload, updated_at, user_id, created_at, read_at, severity, job_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `);
    for (const row of replacement.rows) {
      const updatedAt = row.updatedAt ?? Date.now();
      statement.run(row.id, json(row.payload), updatedAt, ...notificationIndexValues(row.payload, updatedAt));
    }
    return;
  }
  if (replacement.table === 'audit_events') {
    const statement = database.query(`
      INSERT INTO audit_events (id, payload, updated_at, actor, action, target, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?);
    `);
    for (const row of replacement.rows) {
      const updatedAt = row.updatedAt ?? Date.now();
      statement.run(row.id, json(row.payload), updatedAt, ...auditIndexValues(row.payload, updatedAt));
    }
    return;
  }
  if (replacement.table === 'testflight_subscriptions') {
    const statement = database.query(`
      INSERT INTO testflight_subscriptions (
        id, payload, updated_at, invite_code, requester_id, subscription_status, bundle_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `);
    const deviceStatement = database.query(`
      INSERT INTO testflight_subscription_devices (
        subscription_id, device_id, status, apple_membership, last_verified_at,
        last_synced_at, last_error, payload, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    for (const row of replacement.rows) {
      const updatedAt = row.updatedAt ?? Date.now();
      statement.run(row.id, json(row.payload), updatedAt, ...testFlightSubscriptionIndexValues(row.payload, updatedAt));
      for (const device of testFlightSubscriptionDevices(row.payload)) {
        const deviceUpdatedAt = numberField(device.payload, 'lastSyncedAt') ?? numberField(device.payload, 'lastVerifiedAt') ?? updatedAt;
        deviceStatement.run(
          row.id,
          device.deviceId,
          stringField(device.payload, 'status'),
          stringField(device.payload, 'appleMembership'),
          numberField(device.payload, 'lastVerifiedAt'),
          numberField(device.payload, 'lastSyncedAt'),
          stringField(device.payload, 'lastError'),
          json(device.payload),
          deviceUpdatedAt,
        );
      }
    }
    return;
  }
  if (replacement.table === 'job_history') {
    const statement = database.query(`
      INSERT INTO job_history (
        id, payload, updated_at, project_id, bundle_id, source, status, queued_by,
        device_id, finished_at, error_text, failure_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    for (const row of replacement.rows) {
      const updatedAt = row.updatedAt ?? Date.now();
      statement.run(row.id, json(row.payload), updatedAt, ...jobHistoryIndexValues(row.payload, updatedAt));
    }
    return;
  }
  const statement = database.query(`INSERT INTO ${replacement.table} (id, payload, updated_at) VALUES (?, ?, ?);`);
  for (const row of replacement.rows) statement.run(row.id, json(row.payload), row.updatedAt ?? Date.now());
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    writeFileSync(temporaryPath, content, { mode: 0o600 });
    const descriptor = openSync(temporaryPath, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function writeStateMirror(filePath: string, value: unknown): void {
  atomicWriteJson(filePath, value);
}

function recordId(value: unknown, fallback: string): string {
  if (typeof value === 'object' && value !== null && typeof (value as StateRecord).id === 'string') return (value as StateRecord).id as string;
  return fallback;
}

function recordUpdatedAt(value: unknown): number {
  if (typeof value === 'object' && value !== null && typeof (value as StateRecord).updatedAt === 'number') return (value as StateRecord).updatedAt as number;
  if (typeof value === 'object' && value !== null && typeof (value as StateRecord).createdAt === 'number') return (value as StateRecord).createdAt as number;
  return Date.now();
}

function arrayRows(value: unknown, prefix: string): DomainRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((payload, index) => ({ id: recordId(payload, `${prefix}-${index}`), payload, updatedAt: recordUpdatedAt(payload) }));
}

function objectRows(value: unknown, prefix: string): DomainRow[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value as StateRecord).map(([key, payload]) => ({ id: `${prefix}-${key}`, payload: { key, value: payload }, updatedAt: recordUpdatedAt(payload) }));
}

function rowsForState(state: unknown): Record<(typeof domainTables)[number], DomainRow[]> {
  const value = state as StateRecord;
  const healthRows = deviceHealthRows(value.deviceHealthHistory);
  const settings = objectRows(value.settings, 'setting');
  return {
    users: arrayRows(value.allowedUsers, 'user'),
    roles: arrayRows(value.roles, 'role'),
    projects: arrayRows(value.projects, 'project'),
    sessions: arrayRows(value.activeSessions, 'session'),
    api_keys: arrayRows(value.apiKeys, 'api-key'),
    devices: arrayRows(value.devices, 'device'),
    device_health: healthRows,
    device_history: arrayRows(value.deviceActivity, 'device-activity'),
    jobs: [],
    job_history: arrayRows(value.jobHistory, 'job-history'),
    job_timelines: [],
    scheduler_runs: arrayRows(value.schedulerRunHistory, 'scheduler-run'),
    artifacts: [],
    watches: arrayRows(value.watches, 'watch'),
    notifications: arrayRows(value.notifications, 'notification'),
    audit_events: arrayRows(value.auditLog, 'audit'),
    billing_records: [],
    testflight_subscriptions: arrayRows(value.testFlightSubscriptions, 'testflight'),
    webhook_inbox: arrayRows(value.webhookDeliveryLog, 'webhook'),
    backups: arrayRows(value.backupHistory, 'backup'),
    backup_schedule: typeof value.backupSchedule === 'object' && value.backupSchedule !== null && !Array.isArray(value.backupSchedule)
      ? [{ id: 'active', payload: value.backupSchedule, updatedAt: 0 }]
      : [],
    idempotency_keys: [],
    settings,
  };
}

function applyPragmas(db: Database, busyTimeoutMs: number): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.floor(busyTimeoutMs))};`);
  db.exec('PRAGMA synchronous = FULL;');
}

function migrationRows(db: Database): Array<{ version: number; checksum: string }> {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL);');
  return db.query('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as Array<{ version: number; checksum: string }>;
}

function backupBeforeMigrations(db: Database, databasePath: string, stateDir: string): void {
  const applied = migrationRows(db);
  const pending = migrations.some((migration) => !applied.some((row) => row.version === migration.version));
  if (!pending || !existsSync(databasePath)) return;
  const backupDir = path.join(stateDir, 'backups');
  mkdirSync(backupDir, { recursive: true });
  const destination = path.join(backupDir, `pre-migration-${Date.now()}.sqlite`);
  db.query('VACUUM INTO ?').run(destination);
  chmodSync(destination, 0o600);
}

function applyMigrations(db: Database, dryRun: boolean): void {
  const appliedRows = migrationRows(db);
  const appliedByVersion = new Map(appliedRows.map((row) => [row.version, row.checksum]));
  const pending = migrations.filter((migration) => {
    const applied = appliedByVersion.get(migration.version);
    if (applied && applied !== sha256(migration.sql)) throw new Error(`SQLite migration checksum mismatch for version ${migration.version}`);
    return !applied;
  });
  if (pending.length === 0) return;
  if (dryRun) {
    db.exec('BEGIN IMMEDIATE;');
    try {
      for (const migration of pending) {
        db.exec(migration.sql);
        db.query('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)').run(migration.version, sha256(migration.sql), Date.now());
      }
    } finally {
      db.exec('ROLLBACK;');
    }
    throw new Error(`SQLite migration dry run completed; ${pending.length} migration(s) were not applied`);
  }
  for (const migration of migrations) {
    const checksum = sha256(migration.sql);
    const applied = appliedByVersion.get(migration.version);
    if (applied && applied !== checksum) throw new Error(`SQLite migration checksum mismatch for version ${migration.version}`);
    if (applied) continue;
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(migration.sql);
      db.query('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)').run(migration.version, checksum, Date.now());
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  }
}

function verifyIntegrity(db: Database): void {
  const row = db.query('PRAGMA integrity_check;').get() as { integrity_check?: string } | null;
  if (row?.integrity_check !== 'ok') throw new Error(`SQLite integrity check failed: ${row?.integrity_check ?? 'unknown result'}`);
}

function verifyExistingDatabaseSchema(db: Database): void {
  const tableNames = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((table) => table.name));
  const hasMigrationLedger = tableNames.has('schema_migrations');
  const hasStateSnapshots = tableNames.has('state_snapshots');
  const migrationCount = hasMigrationLedger
    ? (db.query('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count?: number } | null)?.count ?? 0
    : 0;

  if (migrationCount > 0) {
    if (hasStateSnapshots) return;
    throw new Error('SQLite database has no recognized schema');
  }

  const legacyTables = [...tableNames].filter((table) => collectionTables.has(table));
  if (legacyTables.length === 0) throw new Error('SQLite database has no recognized schema');

  for (const table of legacyTables) {
    const columns = new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has('id') || !columns.has('payload') || !columns.has('updated_at')) throw new Error('SQLite database has no recognized schema');
  }
}

function sqliteSchemaObjects(db: Database): Array<{ type: string; name: string; tableName: string; sql: string | null }> {
  return db.query("SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name").all() as Array<{ type: string; name: string; tableName: string; sql: string | null }>;
}

function appliedMigrationRows(db: Database): Array<{ version: number; checksum: string }> {
  const columns = new Set((db.query('PRAGMA table_info(schema_migrations)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!['version', 'checksum', 'applied_at'].every((column) => columns.has(column))) throw new Error('SQLite database has no recognized schema');
  const applied = db.query('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as Array<{ version: number; checksum: string }>;
  if (applied.length > migrations.length) throw new Error('SQLite database has no recognized schema');
  for (const [index, row] of applied.entries()) {
    if (row.version !== index + 1 || row.checksum !== sha256(migrations[index].sql)) throw new Error('SQLite database has no recognized schema');
  }
  return applied;
}

function schemaMatchesMigrationPrefix(db: Database, migrationCount: number): boolean {
  const expected = new Database(':memory:', { create: true, strict: true });
  try {
    migrationRows(expected);
    for (const migration of migrations.slice(0, migrationCount)) {
      expected.exec(migration.sql);
      expected.query('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)').run(migration.version, sha256(migration.sql), 0);
    }
    return JSON.stringify(sqliteSchemaObjects(db)) === JSON.stringify(sqliteSchemaObjects(expected));
  } finally {
    expected.close();
  }
}

function initializationMarkerPath(databasePath: string): string {
  return `${databasePath}.initializing`;
}

interface InitializationMarker {
  applicationId: number;
  phase: 'unbound' | 'bound';
  device?: number;
  inode?: number;
}

function initializationMarkerContents(databasePath: string, marker: InitializationMarker): string {
  return `dkrypt-state-initialization-v1\n${sha256(path.resolve(databasePath))}\n${marker.applicationId}\n${marker.phase}\n${marker.device ?? '-'}\n${marker.inode ?? '-'}\n`;
}

function hasValidInitializationMarker(databasePath: string): InitializationMarker | undefined {
  const markerPath = initializationMarkerPath(databasePath);
  let status: ReturnType<typeof lstatSync>;
  try {
    status = lstatSync(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!status.isFile() || (status.mode & 0o777) !== 0o600) throw new Error('SQLite initialization marker is invalid');
  const contents = readFileSync(markerPath, 'utf8');
  const match = /^dkrypt-state-initialization-v1\n([a-f\d]{64})\n([1-9]\d*)\n(unbound|bound)\n(-|\d+)\n(-|\d+)\n$/.exec(contents);
  if (!match || match[1] !== sha256(path.resolve(databasePath))) throw new Error('SQLite initialization marker is invalid');
  const applicationId = Number(match[2]);
  if (!Number.isSafeInteger(applicationId) || applicationId > 0x7fffffff) throw new Error('SQLite initialization marker is invalid');
  if (match[3] === 'unbound' && (match[4] !== '-' || match[5] !== '-')) throw new Error('SQLite initialization marker is invalid');
  if (match[3] === 'bound' && (match[4] === '-' || match[5] === '-')) throw new Error('SQLite initialization marker is invalid');
  return {
    applicationId,
    phase: match[3] as InitializationMarker['phase'],
    ...(match[4] === '-' ? {} : { device: Number(match[4]) }),
    ...(match[5] === '-' ? {} : { inode: Number(match[5]) }),
  };
}

function verifyInterruptedFreshInitialization(db: Database): boolean {
  const tableNames = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((table) => table.name));
  const objects = sqliteSchemaObjects(db);
  if (objects.length === 0) return true;
  if (!tableNames.has('schema_migrations')) return false;
  const applied = appliedMigrationRows(db);
  if (!schemaMatchesMigrationPrefix(db, applied.length)) throw new Error('SQLite database has no recognized schema');

  if (tableNames.has('state_snapshots')) {
    const snapshot = db.query('SELECT 1 AS present FROM state_snapshots LIMIT 1').get() as { present?: number } | null;
    if (snapshot?.present === 1) return false;
  }
  const metadata = tableNames.has('metadata')
    ? db.query('SELECT key, value FROM metadata').all() as Array<{ key: string; value: string }>
    : [];
  if (metadata.some((entry) => entry.key === 'state_snapshot_initialized')) return false;
  if (metadata.some((entry) => entry.key !== 'state_snapshot_pending_initialization' || entry.value !== '1')) return false;

  for (const table of tableNames) {
    if (table === 'schema_migrations' || table === 'metadata') continue;
    const rows = db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: number } | null;
    if ((rows?.count ?? 0) > 0) return false;
  }
  return true;
}

function syncDirectory(directoryPath: string): void {
  const descriptor = openSync(directoryPath, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function bindInitializationMarkerToDatabase(db: Database, databasePath: string, marker: InitializationMarker | undefined): void {
  if (!marker) return;
  const row = db.query('PRAGMA application_id').get() as { application_id?: number } | null;
  const currentApplicationId = row?.application_id ?? 0;
  if (marker.phase === 'bound') {
    const status = statSync(databasePath);
    if (currentApplicationId !== marker.applicationId || status.dev !== marker.device || status.ino !== marker.inode) {
      throw new Error('SQLite initialization marker does not match the database');
    }
    return;
  }

  if (sqliteSchemaObjects(db).length > 0 || (currentApplicationId !== 0 && currentApplicationId !== marker.applicationId)) {
    throw new Error('SQLite initialization marker does not match the database');
  }
  db.exec('PRAGMA synchronous = FULL;');
  if (currentApplicationId === 0) db.exec(`PRAGMA application_id = ${marker.applicationId};`);
  const boundApplicationId = db.query('PRAGMA application_id').get() as { application_id?: number } | null;
  if (boundApplicationId?.application_id !== marker.applicationId) throw new Error('SQLite initialization marker does not match the database');
  const status = statSync(databasePath);
  replaceInitializationMarker(databasePath, { ...marker, phase: 'bound', device: status.dev, inode: status.ino });
}

function replaceInitializationMarker(databasePath: string, marker: InitializationMarker): void {
  const markerPath = initializationMarkerPath(databasePath);
  const temporaryPath = `${markerPath}.${process.pid}.${Date.now()}.${randomInt(1, 0x7fffffff)}.tmp`;
  try {
    const descriptor = openSync(temporaryPath, 'wx', 0o600);
    try {
      writeFileSync(descriptor, initializationMarkerContents(databasePath, marker));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, markerPath);
    syncDirectory(path.dirname(markerPath));
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function createInitializationMarker(databasePath: string): void {
  const markerPath = initializationMarkerPath(databasePath);
  const marker = { applicationId: randomInt(1, 0x7fffffff), phase: 'unbound' } satisfies InitializationMarker;
  const temporaryPath = `${markerPath}.${process.pid}.${Date.now()}.${randomInt(1, 0x7fffffff)}.tmp`;
  try {
    const descriptor = openSync(temporaryPath, 'wx', 0o600);
    try {
      writeFileSync(descriptor, initializationMarkerContents(databasePath, marker));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      linkSync(temporaryPath, markerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  syncDirectory(path.dirname(markerPath));
}

function clearInitializationMarker(databasePath: string): void {
  const markerPath = initializationMarkerPath(databasePath);
  if (!existsSync(markerPath)) return;
  rmSync(markerPath);
  syncDirectory(path.dirname(markerPath));
}

function rejectEmptyExistingDatabase(databasePath: string, existed: boolean, initializationPending: boolean): void {
  if (existed && !initializationPending && statSync(databasePath).size === 0) throw new Error('SQLite database has no recognized schema');
}

function markStateSnapshotInitialized(db: Database): void {
  db.query(`
    INSERT INTO metadata (key, value) VALUES ('state_snapshot_initialized', '1')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run();
  db.query('DELETE FROM metadata WHERE key = ?').run('state_snapshot_pending_initialization');
}

function markStateSnapshotPendingInitialization(db: Database): void {
  db.query(`
    INSERT INTO metadata (key, value) VALUES ('state_snapshot_pending_initialization', '1')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run();
}

function prepareStateDatabase(options: StateDatabaseOptions): { database: Database; databasePath: string } {
  mkdirSync(options.stateDir, { recursive: true });
  const databasePath = path.join(options.stateDir, options.filename ?? 'dkrypt.sqlite');
  const existed = existsSync(databasePath);
  if (!existed) createInitializationMarker(databasePath);
  const marker = hasValidInitializationMarker(databasePath);
  rejectEmptyExistingDatabase(databasePath, existed, marker !== undefined);
  const database = new Database(databasePath, { create: true, strict: true });
  try {
    verifyIntegrity(database);
    bindInitializationMarkerToDatabase(database, databasePath, marker);
    applyPragmas(database, options.busyTimeoutMs ?? 5000);
    const resumingInitialization = marker !== undefined && verifyInterruptedFreshInitialization(database);
    if (existed && !resumingInitialization) verifyExistingDatabaseSchema(database);
    if (existed && !resumingInitialization) backupBeforeMigrations(database, databasePath, options.stateDir);
    applyMigrations(database, options.migrationDryRun ?? false);
    if (!existed || resumingInitialization) markStateSnapshotPendingInitialization(database);
    return { database, databasePath };
  } catch (error) {
    database.close();
    throw error;
  }
}

export class StateDatabase {
  readonly db: Database;
  readonly path: string;

  constructor(options: StateDatabaseOptions) {
    const prepared = prepareStateDatabase(options);
    this.path = prepared.databasePath;
    this.db = prepared.database;
    try {
      if (this.readState({ legacyMirrorAvailable: true }) !== undefined) markStateSnapshotInitialized(this.db);
      clearInitializationMarker(this.path);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  get schemaVersion(): number {
    const row = this.db.query('SELECT MAX(version) AS version FROM schema_migrations').get() as { version?: number } | null;
    return row?.version ?? 0;
  }

  integrityStatus(): 'ok' {
    verifyIntegrity(this.db);
    return 'ok';
  }

  readState(options: { legacyMirrorAvailable?: boolean } = {}): unknown | undefined {
    const row = this.db.query('SELECT payload, sha256 FROM state_snapshots WHERE id = 1').get() as StateSnapshotRow | null;
    if (!row) {
      const initialized = this.db.query('SELECT value FROM metadata WHERE key = ?').get('state_snapshot_initialized') as { value?: string } | null;
      if (initialized?.value === '1') throw new Error('SQLite state snapshot is missing after initialization');
      const pending = this.db.query('SELECT value FROM metadata WHERE key = ?').get('state_snapshot_pending_initialization') as { value?: string } | null;
      if (pending?.value === '1') return undefined;
      if (!options.legacyMirrorAvailable) throw new Error('SQLite state snapshot is missing and initialization is not pending');
      return undefined;
    }
    if (sha256(row.payload) !== row.sha256) throw new Error('SQLite state snapshot checksum mismatch');
    return JSON.parse(row.payload) as unknown;
  }

  writeState(state: unknown, legacyMirrorPath?: string, additionalCollections: readonly StateCollectionReplacement[] = [], afterCollections?: (database: Database) => void): void {
    const updatedTables = new Set<string>();
    for (const replacement of additionalCollections) {
      assertCollectionTable(replacement.table);
      if (updatedTables.has(replacement.table)) throw new Error(`duplicate SQLite collection update: ${replacement.table}`);
      updatedTables.add(replacement.table);
    }
    const payload = json(state);
    const checksum = sha256(payload);
    const stateVersion = typeof state === 'object' && state !== null && typeof (state as StateRecord).version === 'number' ? (state as StateRecord).version as number : 0;
    const rows = rowsForState(state);
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.query(`
        INSERT INTO state_snapshots (id, state_version, payload, sha256, updated_at)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET state_version = excluded.state_version, payload = excluded.payload, sha256 = excluded.sha256, updated_at = excluded.updated_at
      `).run(stateVersion, payload, checksum, Date.now());
      markStateSnapshotInitialized(this.db);
      for (const table of stateOwnedDomainTables) {
        if (updatedTables.has(table)) continue;
        replaceCollectionRows(this.db, { table, rows: rows[table] });
      }
      for (const replacement of additionalCollections) {
        replaceCollectionRows(this.db, replacement);
      }
      afterCollections?.(this.db);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    if (legacyMirrorPath) atomicWriteJson(legacyMirrorPath, state);
  }

  backupTo(destination: string): void {
    if (existsSync(destination)) throw new Error(`backup destination already exists: ${destination}`);
    mkdirSync(path.dirname(destination), { recursive: true });
    const temporaryPath = `${destination}.${process.pid}.tmp`;
    rmSync(temporaryPath, { force: true });
    this.db.query('VACUUM INTO ?').run(temporaryPath);
    const backup = new Database(temporaryPath, { create: false, strict: true });
    try {
      applyPragmas(backup, 5000);
      verifyIntegrity(backup);
    } finally {
      backup.close();
    }
    renameSync(temporaryPath, destination);
    chmodSync(destination, 0o600);
  }

  readCollection(table: string): unknown[] {
    assertCollectionTable(table);
    const rows = this.db.query(`SELECT payload FROM ${table} ORDER BY updated_at DESC`).all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as unknown);
  }

  replaceCollection(table: string, rows: Array<{ id: string; payload: unknown; updatedAt?: number }>): void {
    replaceStateCollections(this.db, [{ table, rows }]);
  }

  close(): void {
    this.db.close();
  }
}

export function openStateCollectionDatabase(options: StateDatabaseOptions, tables: readonly string[]): Database {
  const prepared = prepareStateDatabase(options);
  const database = prepared.database;
  try {
    for (const table of tables) {
      assertCollectionTable(table);
      database.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
    }
    clearInitializationMarker(prepared.databasePath);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function readStateCollection(database: Database, table: string): unknown[] {
  assertCollectionTable(table);
  const rows = database.query(`SELECT payload FROM ${table} ORDER BY updated_at DESC`).all() as Array<{ payload: string }>;
  return rows.map((row) => JSON.parse(row.payload) as unknown);
}

export function firstStateOwnedCollectionMismatch(database: Database, candidates: unknown[], excludedTables: readonly string[] = []): string | undefined {
  const candidateRows = candidates.map(rowsForState);
  for (const table of stateOwnedDomainTables) {
    if (excludedTables.includes(table)) continue;
    const expected = candidateRows.map((rows) => rows[table]);
    const actual = database.query(`SELECT id, payload FROM ${table} ORDER BY id ASC;`).all() as Array<{ id: string; payload: string }>;
    if (!expected.some((rows) => sameDomainRows(table, rows, actual))) return table;
  }

  const expectedTestFlightDevices = candidates.map(testFlightSubscriptionDeviceRows);
  const actualTestFlightDevices = database.query('SELECT subscription_id, device_id, payload FROM testflight_subscription_devices ORDER BY subscription_id ASC, device_id ASC;').all() as Array<{
    subscription_id: string;
    device_id: string;
    payload: string;
  }>;
  if (!expectedTestFlightDevices.some((rows) => sameTestFlightSubscriptionDevices(rows, actualTestFlightDevices))) return 'testflight_subscription_devices';
  return undefined;
}

function sameDomainRows(table: string, expected: DomainRow[], actual: Array<{ id: string; payload: string }>): boolean {
  if (expected.length !== actual.length) return false;
  const projected = (rows: Array<{ id: string; payload: unknown }>, includeId: boolean): string[] => rows
    .map((row) => stableJson(includeId ? { id: row.id, payload: row.payload } : row.payload))
    .sort();
  const expectedRows = expected.map(({ id, payload }) => ({ id, payload }));
  const actualRows = actual.map(({ id, payload }) => ({ id, payload: JSON.parse(payload) as unknown }));
  return projected(expectedRows, table !== 'users').join('\n') === projected(actualRows, table !== 'users').join('\n');
}

function testFlightSubscriptionDeviceRows(value: unknown): Array<{ subscription_id: string; device_id: string; payload: Record<string, unknown> }> {
  const subscriptions = asRecord(value).testFlightSubscriptions;
  if (!Array.isArray(subscriptions)) return [];
  return subscriptions.flatMap((rawSubscription) => {
    const subscription = asRecord(rawSubscription);
    const subscriptionId = stringField(subscription, 'id');
    if (!subscriptionId) return [];
    return testFlightSubscriptionDevices(rawSubscription).map(({ deviceId, payload }) => ({
      subscription_id: subscriptionId,
      device_id: deviceId,
      payload,
    }));
  });
}

function sameTestFlightSubscriptionDevices(
  expected: Array<{ subscription_id: string; device_id: string; payload: Record<string, unknown> }>,
  actual: Array<{ subscription_id: string; device_id: string; payload: string }>,
): boolean {
  if (expected.length !== actual.length) return false;
  const serialize = (row: { subscription_id: string; device_id: string; payload: unknown }) => stableJson(row);
  return expected.map(serialize).sort().join('\n') === actual.map((row) => serialize({ ...row, payload: JSON.parse(row.payload) as unknown })).sort().join('\n');
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function replaceStateCollection(database: Database, table: string, rows: Array<{ id: string; payload: unknown; updatedAt?: number }>): void {
  replaceStateCollections(database, [{ table, rows }]);
}

export function replaceStateCollections(database: Database, replacements: readonly StateCollectionReplacement[]): void {
  const tables = new Set<string>();
  for (const replacement of replacements) {
    assertCollectionTable(replacement.table);
    if (tables.has(replacement.table)) throw new Error(`duplicate SQLite collection update: ${replacement.table}`);
    tables.add(replacement.table);
  }
  if (replacements.length === 0) return;
  database.exec('BEGIN IMMEDIATE;');
  try {
    for (const replacement of replacements) {
      replaceCollectionRows(database, replacement);
    }
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

export function importLegacyArtifactIndexOnce(database: Database, artifacts: Array<{ id: string; payload: unknown; updatedAt?: number }>): boolean {
  const metadataKey = 'legacy_artifact_index_imported';
  database.exec('BEGIN IMMEDIATE;');
  try {
    const imported = database.query('SELECT 1 AS imported FROM metadata WHERE key = ?;').get(metadataKey) as { imported?: number } | null;
    if (imported?.imported === 1) {
      database.exec('COMMIT;');
      return false;
    }
    replaceCollectionRows(database, { table: 'artifacts', rows: artifacts });
    database.query('INSERT INTO metadata (key, value) VALUES (?, ?);').run(metadataKey, String(Date.now()));
    database.exec('COMMIT;');
    return true;
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

export function openStateDatabase(options: StateDatabaseOptions): StateDatabase {
  return new StateDatabase(options);
}

export function verifyDatabaseBackup(databasePath: string): { schemaVersion: number; integrity: 'ok'; hasStateSnapshot: boolean } {
  if (!existsSync(databasePath)) throw new Error(`SQLite backup does not exist: ${databasePath}`);
  const database = new Database(databasePath, { create: false, strict: true });
  try {
    verifyIntegrity(database);
    const table = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get() as { name?: string } | null;
    if (table?.name !== 'schema_migrations') throw new Error('SQLite backup is missing schema migration records');
    const applied = database.query('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as Array<{ version: number; checksum: string }>;
    const schemaVersion = Math.max(...applied.map((row) => row.version), 0);
    if (schemaVersion > migrations.length) throw new Error(`SQLite backup schema ${schemaVersion} is newer than this release`);
    const appliedByVersion = new Map(applied.map((row) => [row.version, row.checksum]));
    for (let version = 1; version <= schemaVersion; version += 1) {
      const migration = migrations[version - 1];
      const checksum = appliedByVersion.get(version);
      if (!checksum) throw new Error(`SQLite backup is missing migration record ${version}`);
      if (checksum !== sha256(migration.sql)) throw new Error(`SQLite backup migration checksum mismatch for version ${version}`);
    }
    const snapshot = database.query('SELECT 1 AS present FROM state_snapshots WHERE id = 1').get() as { present?: number } | null;
    return { schemaVersion, integrity: 'ok', hasStateSnapshot: snapshot?.present === 1 };
  } finally {
    database.close();
  }
}

export function verifyDatabaseForMigration(databasePath: string): { schemaVersion: number; integrity: 'ok'; hasStateSnapshot: true; stateSnapshotChecksum: string } {
  if (!existsSync(databasePath)) throw new Error(`SQLite database does not exist: ${databasePath}`);
  const database = new Database(databasePath, { create: false, readonly: true, strict: true });
  try {
    verifyIntegrity(database);
    const migrationsTable = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get() as { name?: string } | null;
    if (migrationsTable?.name !== 'schema_migrations') throw new Error('SQLite database is missing schema migration records');
    const applied = database.query('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as Array<{ version: number; checksum: string }>;
    const latestVersion = Math.max(...applied.map((row) => row.version), 0);
    if (latestVersion > migrations.length) throw new Error(`SQLite database schema ${latestVersion} is newer than this release`);
    const appliedByVersion = new Map(applied.map((row) => [row.version, row.checksum]));
    for (let version = 1; version <= latestVersion; version += 1) {
      const migration = migrations[version - 1];
      const checksum = appliedByVersion.get(version);
      if (!checksum) throw new Error(`SQLite database is missing migration record ${version}`);
      if (checksum !== sha256(migration.sql)) throw new Error(`SQLite database migration checksum mismatch for version ${version}`);
    }
    const snapshotTable = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'state_snapshots'").get() as { name?: string } | null;
    if (snapshotTable?.name !== 'state_snapshots') throw new Error('SQLite database is missing its state snapshot table');
    const snapshot = database.query('SELECT payload, sha256 FROM state_snapshots WHERE id = 1').get() as StateSnapshotRow | null;
    if (!snapshot) throw new Error('SQLite database is missing its state snapshot');
    if (sha256(snapshot.payload) !== snapshot.sha256) throw new Error('SQLite state snapshot checksum mismatch');
    const state = JSON.parse(snapshot.payload) as unknown;
    if (typeof state !== 'object' || state === null || Array.isArray(state)) throw new Error('SQLite state snapshot is not an object');
    return { schemaVersion: latestVersion, integrity: 'ok', hasStateSnapshot: true, stateSnapshotChecksum: snapshot.sha256 };
  } finally {
    database.close();
  }
}
