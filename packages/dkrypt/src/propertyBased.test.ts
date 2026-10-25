import AdmZip from 'adm-zip';
import { expect, test } from 'bun:test';
import fc from 'fast-check';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { build as buildPlist } from 'plist';
import { tmpdir } from 'node:os';
import { createBridgeEnvelope, createDeviceAgentEnvelope, parseDeviceAgentResponse, type DeviceAgentEnvelope } from '#idevice.js';
import { BRIDGE_PROTOCOL_VERSION } from '#bridgeProtocol.js';
import { createSessionRepository } from '#store/sessionRepository.js';
import { LATEST_SQLITE_SCHEMA_VERSION, openStateDatabase, verifyDatabaseBackup } from '#store/sqlite.js';
import { rewindApiKeySearchMigration, rewindSessionSearchMigration } from '#store/sqliteTestHelpers.js';
import { normalizeTestFlightInvite } from '#testflightSubscriptions.js';
import { extractIpaMetadata } from '#util/ipaMetadata.js';
import { compareVersions, normalizeVersion } from '#util/version.js';

const versionPartsArbitrary = fc.array(fc.integer({ min: 0, max: 100_000 }), { minLength: 1, maxLength: 6 });
const versionArbitrary = versionPartsArbitrary.map((parts) => parts.join('.'));
const inviteCharacters = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'];
const inviteCodeArbitrary = fc.array(fc.constantFrom(...inviteCharacters), { minLength: 4, maxLength: 32 }).map((characters) => characters.join(''));
const cpuTypeNames = new Map<number, string>([
  [7, 'i386'],
  [12, 'arm'],
  [18, 'ppc'],
  [0x01000007, 'x86_64'],
  [0x0100000c, 'arm64'],
  [0x01000012, 'ppc64'],
  [0x0100000d, 'cpu-16777229'],
]);

function compareNumericParts(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function bridgeSignature(secret: string, channel: string, requestId: string, issuedAt: number, payload: string): string {
  return createHmac('sha256', secret)
    .update(`${BRIDGE_PROTOCOL_VERSION}|${channel}|${requestId}|${issuedAt}|${payload}`)
    .digest('hex');
}

function deviceAgentSignature(secret: string, requestId: string, issuedAt: number, payload: string): string {
  return createHmac('sha256', secret)
    .update(`dkrypt-autoinstall-agent-v1|${requestId}|${issuedAt}|${payload}`)
    .digest('hex');
}

function signDeviceAgentResponse(secret: string, requestId: string, issuedAt: number, result: Record<string, unknown>): DeviceAgentEnvelope {
  const payload = Buffer.from(JSON.stringify({ ok: true, result })).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`dkrypt-autoinstall-agent-response-v1|${requestId}|${issuedAt}|${payload}`)
    .digest('hex');
  return { version: 1, requestId, issuedAt, payload, signature };
}

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sortById<T extends { id: string }>(records: T[]): T[] {
  return [...records].sort((left, right) => left.id.localeCompare(right.id));
}

function restoreSchemaAtVersion(database: ReturnType<typeof openStateDatabase>, version: number): void {
  if (version < 32) {
    database.db.exec('DROP TABLE job_worker_leases; DROP TABLE job_worker_generations; DELETE FROM schema_migrations WHERE version = 32;');
  }
  if (version < 19) {
    rewindApiKeySearchMigration(database.db);
  }
  if (version < 18) {
    rewindSessionSearchMigration(database.db);
  }
  if (version >= 6) {
    database.db.exec(`
      UPDATE jobs SET payload = json_set(payload, '$.projectId', 'default')
      WHERE json_valid(payload) = 1 AND json_type(payload, '$.projectId') IS NULL;
      UPDATE artifacts SET payload = json_set(payload, '$.projectIds', json_array('default'))
      WHERE json_valid(payload) = 1 AND json_type(payload, '$.projectIds') IS NULL;
    `);
  }
  if (version < 7) {
    database.db.exec('DROP INDEX IF EXISTS jobs_active_exact_build; DROP INDEX IF EXISTS jobs_completed_exact_build;');
    for (const column of [
      'file_path',
      'device_id',
      'correlation_id',
      'failure_class',
      'deadline_at',
      'attempt',
      'finished_at',
      'started_at',
      'created_at',
      'priority',
      'source',
      'project_id',
      'testflight_build_id',
      'external_version_id',
      'bundle_id',
      'status',
    ]) database.db.exec(`ALTER TABLE jobs DROP COLUMN ${column};`);
  }
  if (version < 8) {
    database.db.exec('DROP INDEX IF EXISTS artifacts_key_index; DROP INDEX IF EXISTS artifacts_source_job_index; DROP INDEX IF EXISTS artifacts_bundle_channel_recent;');
    for (const column of [
      'source_job_id',
      'pinned_at',
      'access_count',
      'last_accessed_at',
      'created_at',
      'sha256',
      'file_size_bytes',
      'file_path',
      'build_number',
      'version_label',
      'testflight_build_id',
      'external_version_id',
      'channel',
      'bundle_id',
      'artifact_key',
    ]) database.db.exec(`ALTER TABLE artifacts DROP COLUMN ${column};`);
  }
  if (version < 9) {
    database.db.exec('DROP INDEX IF EXISTS artifact_projects_by_project; DROP TABLE IF EXISTS artifact_projects;');
  }
  if (version < 10) {
    database.db.exec('DROP INDEX IF EXISTS device_history_by_device_time;');
    for (const column of ['bundle_id', 'occurred_at', 'history_kind', 'device_id']) {
      database.db.exec(`ALTER TABLE device_history DROP COLUMN ${column};`);
    }
  }
  if (version < 11) {
    database.db.exec('DROP INDEX IF EXISTS device_health_by_device_time;');
    for (const column of ['storage_used_percent', 'battery_temperature_c', 'battery_percent', 'reachable', 'checked_at', 'device_id']) {
      database.db.exec(`ALTER TABLE device_health DROP COLUMN ${column};`);
    }
  }
  if (version < 12) {
    database.db.exec('DROP INDEX IF EXISTS notifications_by_user_time; DROP INDEX IF EXISTS notifications_unread_by_user;');
    for (const column of ['job_id', 'severity', 'read_at', 'created_at', 'user_id']) {
      database.db.exec(`ALTER TABLE notifications DROP COLUMN ${column};`);
    }
  }
  if (version < 13) {
    database.db.exec('DROP INDEX IF EXISTS audit_events_by_time;');
    for (const column of ['occurred_at', 'target', 'action', 'actor']) {
      database.db.exec(`ALTER TABLE audit_events DROP COLUMN ${column};`);
    }
  }
  if (version < 14) {
    database.db.exec('DROP INDEX IF EXISTS testflight_subscriptions_by_invite; DROP INDEX IF EXISTS testflight_subscriptions_by_requester; DROP INDEX IF EXISTS testflight_subscription_devices_by_device; DROP TABLE IF EXISTS testflight_subscription_devices;');
    for (const column of ['created_at', 'bundle_id', 'subscription_status', 'requester_id', 'invite_code']) {
      database.db.exec(`ALTER TABLE testflight_subscriptions DROP COLUMN ${column};`);
    }
  }
  if (version < 15) {
    database.db.exec('DROP INDEX IF EXISTS job_history_by_project_time; DROP INDEX IF EXISTS job_history_by_user_time; DROP INDEX IF EXISTS job_history_by_device_time; DROP TABLE IF EXISTS job_history;');
  }
  if (version < 16) {
    database.db.exec('DROP INDEX IF EXISTS webhook_inbox_by_event; DROP INDEX IF EXISTS webhook_inbox_by_provider_time; DROP INDEX IF EXISTS webhook_inbox_by_status_time;');
    for (const column of ['last_error', 'attempts', 'processed_at', 'received_at', 'raw_body_sha256', 'status', 'event_id', 'provider']) {
      database.db.exec(`ALTER TABLE webhook_inbox DROP COLUMN ${column};`);
    }
  }
  if (version < 17) {
    database.db.exec(`
      DROP TABLE IF EXISTS billing_customers;
      DROP TABLE IF EXISTS billing_subscriptions;
      DROP TABLE IF EXISTS billing_checkouts;
      DROP TABLE IF EXISTS billing_charges;
      DROP TABLE IF EXISTS billing_entitlement_history;
      DROP INDEX IF EXISTS billing_events_by_provider_event;
      DROP INDEX IF EXISTS billing_events_by_processed_at;
      ALTER TABLE billing_events DROP COLUMN provider;
      ALTER TABLE billing_events DROP COLUMN event_id;
      ALTER TABLE billing_events DROP COLUMN occurred_at;
      ALTER TABLE billing_events DROP COLUMN processed_at;
    `);
  }
  if (version < 5) database.db.exec('DROP TABLE IF EXISTS projects;');
  if (version < 4) database.db.exec('DROP TABLE IF EXISTS scheduler_runs;');
  if (version < 3) database.db.exec('DROP INDEX IF EXISTS artifacts_updated_at;');
  if (version < 2) {
    database.db.exec('DROP TABLE IF EXISTS auth_profiles;');
    database.db.exec('DROP TABLE IF EXISTS device_history;');
    database.db.exec('DROP TABLE IF EXISTS billing_events;');
    database.db.exec('DROP TABLE IF EXISTS correlation_events;');
    database.db.exec('DROP TABLE IF EXISTS webhook_attempts;');
  }
  database.db.query('DELETE FROM schema_migrations WHERE version > ?').run(version);
}

test('version parsing agrees with numeric tuple ordering for generated releases', () => {
  fc.assert(fc.property(versionPartsArbitrary, versionPartsArbitrary, (leftParts, rightParts) => {
    const left = leftParts.join('.');
    const right = rightParts.join('.');
    const expected = compareNumericParts(leftParts, rightParts);
    expect(compareVersions(left, right)).toBe(expected);
    expect(compareVersions(`v${left}`, right)).toBe(expected);
    expect(compareVersions(left, `v${right}`)).toBe(expected);
    expect(compareVersions(left, right)).toBe(-compareVersions(right, left));
  }), { numRuns: 500, seed: 20260925 });

  fc.assert(fc.property(versionArbitrary, (version) => {
    expect(normalizeVersion(`  v${version}  `)).toBe(version);
    expect(compareVersions(version, `${version}.0`)).toBe(0);
  }), { numRuns: 250, seed: 20260926 });
});

test('TestFlight invite normalization is idempotent for generated public invite codes', () => {
  fc.assert(fc.property(inviteCodeArbitrary, fc.string({ maxLength: 32 }), (inviteCode, query) => {
    const input = ` https://testflight.apple.com/join/${inviteCode}?state=${encodeURIComponent(query)}#invite `;
    const normalized = normalizeTestFlightInvite(input);
    expect(normalized).toEqual({ url: `https://testflight.apple.com/join/${inviteCode}`, inviteCode });
    expect(normalizeTestFlightInvite(normalized.url)).toEqual(normalized);
  }), { numRuns: 350, seed: 20260927 });

  fc.assert(fc.property(inviteCodeArbitrary, (inviteCode) => {
    expect(() => normalizeTestFlightInvite(`https://testflight.apple.com.evil.invalid/join/${inviteCode}`)).toThrow();
    expect(() => normalizeTestFlightInvite(`https://evil.testflight.apple.com/join/${inviteCode}`)).toThrow();
  }), { numRuns: 150, seed: 20260928 });
});

test('SQLite upgrades generated records from every prior schema and restores them from backup', async () => {
  const stateArbitrary = fc.record({
    version: fc.constant(16),
    activeSessions: fc.uniqueArray(
      fc.record({
        id: fc.uuid(),
        sub: fc.string({ minLength: 1, maxLength: 32 }),
        createdAt: fc.nat({ max: 2_000_000_000_000 }),
        lastSeenAt: fc.nat({ max: 2_000_000_000_000 }),
        userAgent: fc.string({ maxLength: 32 }),
        ip: fc.string({ maxLength: 40 }),
      }),
      { selector: (session) => session.id, maxLength: 8 },
    ),
    devices: fc.uniqueArray(
      fc.record({ id: fc.uuid(), name: fc.string({ maxLength: 32 }), enabled: fc.boolean(), updatedAt: fc.nat({ max: 2_000_000_000_000 }) }),
      { selector: (device) => device.id, maxLength: 8 },
    ),
    settings: fc.record({ maintenanceMode: fc.boolean(), jobHistoryRetentionDays: fc.integer({ min: 0, max: 365 }), opaqueValue: fc.jsonValue({ maxDepth: 3 }) }),
  });
  const legacyJobsArbitrary = fc.uniqueArray(
    fc.record({ id: fc.uuid(), bundleId: fc.string({ maxLength: 32 }), status: fc.constantFrom('queued', 'running', 'done', 'failed') }),
    { selector: (job) => job.id, maxLength: 8 },
  );
  const legacyArtifactsArbitrary = fc.uniqueArray(
    fc.record({ id: fc.uuid(), bundleId: fc.string({ maxLength: 32 }), sizeBytes: fc.nat({ max: 2_000_000_000 }) }),
    { selector: (artifact) => artifact.id, maxLength: 8 },
  );
  const jobTimelinesArbitrary = fc.uniqueArray(
    fc.record({ id: fc.uuid(), events: fc.array(fc.string({ maxLength: 24 }), { maxLength: 6 }) }),
    { selector: (timeline) => timeline.id, maxLength: 8 },
  );
  const schedulerRunsArbitrary = fc.uniqueArray(
    fc.record({ id: fc.uuid(), ts: fc.nat({ max: 2_000_000_000_000 }), label: fc.string({ maxLength: 24 }) }),
    { selector: (run) => run.id, maxLength: 8 },
  );

  for (const baselineVersion of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    await fc.assert(fc.asyncProperty(stateArbitrary, legacyJobsArbitrary, legacyArtifactsArbitrary, jobTimelinesArbitrary, schedulerRunsArbitrary, async (generatedState, legacyJobs, legacyArtifacts, jobTimelines, schedulerRuns) => {
      const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-property-sqlite-'));
      const backupPath = path.join(stateDir, 'restore.sqlite');
      let database: ReturnType<typeof openStateDatabase> | undefined;
      try {
        const expectedState = jsonRoundTrip(generatedState);
        const expectedJobs = sortById(legacyJobs.map((job) => ({ ...job, projectId: 'default' })));
        const expectedArtifacts = sortById(legacyArtifacts.map((artifact) => ({ ...artifact, projectIds: ['default'] })));
        const expectedTimelines = jobTimelines.map((timeline) => ({ jobId: timeline.id, events: timeline.events }));
        const expectedSchedulerRuns = schedulerRuns.map((run) => ({ id: run.id, ts: run.ts, appStore: { label: run.label }, testflight: {} }));
        database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
        database.writeState(generatedState);
        expect(database.readState()).toEqual(expectedState);
        database.replaceCollection('jobs', legacyJobs.map((job, index) => ({ id: job.id, payload: job, updatedAt: index + 1 })));
        database.replaceCollection('artifacts', legacyArtifacts.map((artifact, index) => ({ id: artifact.id, payload: artifact, updatedAt: index + 1 })));
        const legacyTimelineRows: Array<{ id: string; payload: unknown; updatedAt: number }> = jobTimelines.map((timeline, index) => ({ id: `timeline-${timeline.id}`, payload: { jobId: timeline.id, events: timeline.events }, updatedAt: index + 1 }));
        if (baselineVersion < 4) {
          legacyTimelineRows.push(...expectedSchedulerRuns.map((run, index) => ({ id: `legacy-scheduler-${run.id}`, payload: run, updatedAt: jobTimelines.length + index + 1 })));
        } else {
          database.replaceCollection('scheduler_runs', expectedSchedulerRuns.map((run, index) => ({ id: run.id, payload: run, updatedAt: index + 1 })));
        }
        database.replaceCollection('job_timelines', legacyTimelineRows);
        restoreSchemaAtVersion(database, baselineVersion);
        database.close();
        database = undefined;
        database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
        expect(database.schemaVersion).toBe(LATEST_SQLITE_SCHEMA_VERSION);
        expect(database.integrityStatus()).toBe('ok');
        expect(database.readState()).toEqual(expectedState);
        expect(createSessionRepository(database.db).listAll()).toEqual(expectedState.activeSessions);
        expect(sortById(database.readCollection('jobs') as typeof expectedJobs)).toEqual(expectedJobs);
        expect(sortById(database.readCollection('artifacts') as typeof expectedArtifacts)).toEqual(expectedArtifacts);
        const migratedTimelines = database.readCollection('job_timelines') as Array<{ jobId: string; events: string[] }>;
        expect(sortById(migratedTimelines.map((timeline) => ({ id: timeline.jobId, events: timeline.events })))).toEqual(sortById(expectedTimelines.map((timeline) => ({ id: timeline.jobId, events: timeline.events }))));
        expect(sortById(database.readCollection('scheduler_runs') as typeof expectedSchedulerRuns)).toEqual(sortById(expectedSchedulerRuns));
        database.backupTo(backupPath);
        expect(verifyDatabaseBackup(backupPath)).toEqual({ schemaVersion: LATEST_SQLITE_SCHEMA_VERSION, integrity: 'ok', hasStateSnapshot: true });
        database.close();
        database = undefined;
        database = openStateDatabase({ stateDir, filename: 'restore.sqlite' });
        expect(database.integrityStatus()).toBe('ok');
        expect(database.readState()).toEqual(expectedState);
        expect(createSessionRepository(database.db).listAll()).toEqual(expectedState.activeSessions);
        expect(sortById(database.readCollection('jobs') as typeof expectedJobs)).toEqual(expectedJobs);
        expect(sortById(database.readCollection('artifacts') as typeof expectedArtifacts)).toEqual(expectedArtifacts);
        const restoredTimelines = database.readCollection('job_timelines') as Array<{ jobId: string; events: string[] }>;
        expect(sortById(restoredTimelines.map((timeline) => ({ id: timeline.jobId, events: timeline.events })))).toEqual(sortById(expectedTimelines.map((timeline) => ({ id: timeline.jobId, events: timeline.events }))));
        expect(sortById(database.readCollection('scheduler_runs') as typeof expectedSchedulerRuns)).toEqual(sortById(expectedSchedulerRuns));
      } finally {
        database?.close();
        await rm(stateDir, { recursive: true, force: true });
      }
    }), { numRuns: 5, seed: 20260929 + baselineVersion });
  }
}, 60_000);

test('IPA metadata extraction preserves generated versions and Mach-O architectures', async () => {
  const cpuTypes = [...cpuTypeNames.keys()];
  const cpuTypeArbitrary = fc.constantFrom(...cpuTypes);

  await fc.assert(fc.asyncProperty(versionArbitrary, versionArbitrary, cpuTypeArbitrary, async (bundleVersion, shortVersion, cpuType) => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-property-ipa-'));
    const ipaPath = path.join(stateDir, 'generated.ipa');
    try {
      const plist = buildPlist({
        CFBundleVersion: bundleVersion,
        CFBundleShortVersionString: shortVersion,
        CFBundleExecutable: 'Generated',
        NestedValue: { ignored: true },
      });
      const executable = Buffer.alloc(12);
      executable.writeUInt32BE(0xfeedfacf, 0);
      executable.writeUInt32BE(cpuType, 4);
      const archive = new AdmZip();
      archive.addFile('Payload/Generated.app/Info.plist', Buffer.from(plist));
      archive.addFile('Payload/Generated.app/Generated', executable);
      archive.writeZip(ipaPath);

      const result = await extractIpaMetadata(ipaPath);
      expect(result.summary).toMatchObject({ bundleVersion, shortVersion, executable: 'Generated', architectures: [cpuTypeNames.get(cpuType)] });
      expect(result.infoPlist).toEqual({ CFBundleVersion: bundleVersion, CFBundleShortVersionString: shortVersion, CFBundleExecutable: 'Generated' });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }), { numRuns: 36, seed: 20260930 });
}, 30_000);

test('authenticated bridge envelopes bind generated payloads to their channel and request', () => {
  const channelArbitrary = fc.constantFrom('springboard' as const, 'testflight' as const, 'appstore' as const);
  const requestArbitrary = fc.record({ action: fc.string({ maxLength: 32 }), payload: fc.jsonValue({ maxDepth: 3 }), enabled: fc.boolean() });
  const secretArbitrary = fc.string({ minLength: 1, maxLength: 64 });

  fc.assert(fc.property(secretArbitrary, channelArbitrary, requestArbitrary, fc.uuid(), fc.integer({ min: 1, max: 2_000_000_000 }), (secret, channel, request, requestId, issuedAt) => {
    const envelope = createBridgeEnvelope(secret, channel, request, requestId, issuedAt);
    expect(JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'))).toEqual(jsonRoundTrip(request));
    expect(envelope.signature).toBe(bridgeSignature(secret, channel, requestId, issuedAt, envelope.payload));
    expect(envelope.signature).not.toBe(bridgeSignature(secret, channel === 'appstore' ? 'testflight' : 'appstore', requestId, issuedAt, envelope.payload));
    expect(envelope.signature).not.toBe(bridgeSignature(secret, channel, `${requestId}x`, issuedAt, envelope.payload));
  }), { numRuns: 400, seed: 20261001 });

  fc.assert(fc.property(secretArbitrary, requestArbitrary, fc.uuid(), fc.integer({ min: 1, max: 2_000_000_000 }), (secret, request, requestId, issuedAt) => {
    const envelope = createDeviceAgentEnvelope(secret, requestId, request, issuedAt);
    expect(JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'))).toEqual(jsonRoundTrip(request));
    expect(envelope.signature).toBe(deviceAgentSignature(secret, requestId, issuedAt, envelope.payload));
    expect(envelope.signature).not.toBe(deviceAgentSignature(secret, `${requestId}x`, issuedAt, envelope.payload));
  }), { numRuns: 400, seed: 20261002 });

  const responseArbitrary = fc.record({ result: fc.record({ value: fc.jsonValue({ maxDepth: 3 }), enabled: fc.boolean() }) });
  const responseIssuedAt = Math.floor(Date.now() / 1000);
  fc.assert(fc.property(secretArbitrary, fc.uuid(), responseArbitrary, (secret, requestId, { result }) => {
    const envelope = signDeviceAgentResponse(secret, requestId, responseIssuedAt, result);
    expect(parseDeviceAgentResponse(secret, envelope)).toEqual(jsonRoundTrip(result));
    expect(() => parseDeviceAgentResponse(secret, { ...envelope, requestId: `${requestId}x` })).toThrow('signature');
    expect(() => parseDeviceAgentResponse(secret, { ...envelope, payload: `${envelope.payload}x` })).toThrow('signature');
    const changedSignature = `${envelope.signature.slice(0, -1)}${envelope.signature.endsWith('0') ? '1' : '0'}`;
    expect(() => parseDeviceAgentResponse(secret, { ...envelope, signature: changedSignature })).toThrow('signature');
    expect(() => parseDeviceAgentResponse(secret, { ...envelope, issuedAt: responseIssuedAt - 121 })).toThrow('expired');
  }), { numRuns: 400, seed: 20261003 });
});
