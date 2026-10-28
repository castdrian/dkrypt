import { createHash, randomBytes } from 'node:crypto';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { config } from '#config.js';
import { getBillingEntitlements } from '#billing.js';
import { getFastifySession, fastifyRequireSession } from '#session.js';
import { PermissionFlag, hasPermission } from '#permissions.js';
import { createApiKey, getUserEffectivePermissions, hasManuallyAssignedPermission, revealApiKeySecret } from '#store/state.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

type DeviceAuthorizationStatus = 'pending' | 'approved' | 'denied' | 'issuing';

interface DeviceAuthorizationRecord {
  id: string;
  type: 'cli_device_authorization';
  userCodeHash: string;
  status: DeviceAuthorizationStatus;
  createdAt: number;
  expiresAt: number;
  userId?: string;
  approvedAt?: number;
}

const authorizationTtlMs = 10 * 60_000;
const authorizationDatabase = openStateCollectionDatabase(
  { stateDir: config.stateDir, filename: config.stateDatabaseFile, busyTimeoutMs: config.stateDbBusyTimeoutMs },
  ['mcp_records'],
);
const startAttempts = new Map<string, { count: number; resetAt: number }>();
const pollAttempts = new Map<string, { count: number; resetAt: number }>();

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function recordId(deviceCodeHash: string): string {
  return `cli_device:${deviceCodeHash}`;
}

function readByDeviceHash(deviceCodeHash: string): DeviceAuthorizationRecord | undefined {
  const row = authorizationDatabase.query('SELECT payload FROM mcp_records WHERE id = ?').get(recordId(deviceCodeHash)) as { payload: string } | null;
  if (!row) return undefined;
  try {
    const record = JSON.parse(row.payload) as DeviceAuthorizationRecord;
    return record.type === 'cli_device_authorization' ? record : undefined;
  } catch {
    return undefined;
  }
}

function readByUserCode(userCode: string): DeviceAuthorizationRecord | undefined {
  const userCodeHash = hash(userCode.replace(/-/g, '').toUpperCase());
  const row = authorizationDatabase.query("SELECT payload FROM mcp_records WHERE json_extract(payload, '$.type') = ? AND json_extract(payload, '$.userCodeHash') = ? LIMIT 1").get('cli_device_authorization', userCodeHash) as { payload: string } | null;
  if (!row) return undefined;
  try {
    return JSON.parse(row.payload) as DeviceAuthorizationRecord;
  } catch {
    return undefined;
  }
}

function writeRecord(record: DeviceAuthorizationRecord): void {
  authorizationDatabase.query('INSERT INTO mcp_records (id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at').run(record.id, JSON.stringify(record), Date.now());
}

function decidePending(record: DeviceAuthorizationRecord, decision: DeviceAuthorizationRecord): boolean {
  return authorizationDatabase.query("UPDATE mcp_records SET payload = ?, updated_at = ? WHERE id = ? AND json_extract(payload, '$.status') = 'pending' AND json_extract(payload, '$.expiresAt') > ?")
    .run(JSON.stringify(decision), Date.now(), record.id, Date.now()).changes === 1;
}

function claimApproved(record: DeviceAuthorizationRecord): boolean {
  const claimed = { ...record, status: 'issuing' as const };
  return authorizationDatabase.query("UPDATE mcp_records SET payload = ?, updated_at = ? WHERE id = ? AND json_extract(payload, '$.status') = 'approved' AND json_extract(payload, '$.expiresAt') > ?")
    .run(JSON.stringify(claimed), Date.now(), record.id, Date.now()).changes === 1;
}

function deleteRecord(record: DeviceAuthorizationRecord): void {
  authorizationDatabase.query('DELETE FROM mcp_records WHERE id = ?').run(record.id);
}

function cleanExpired(): void {
  const rows = authorizationDatabase.query("SELECT id, payload FROM mcp_records WHERE json_extract(payload, '$.type') = ? AND json_extract(payload, '$.expiresAt') <= ?").all('cli_device_authorization', Date.now()) as Array<{ id: string; payload: string }>;
  for (const row of rows) authorizationDatabase.query('DELETE FROM mcp_records WHERE id = ?').run(row.id);
}

const cleanupTimer = setInterval(cleanExpired, 60_000).unref();

function rateLimited(map: Map<string, { count: number; resetAt: number }>, key: string, maximum: number): boolean {
  const now = Date.now();
  if (!map.has(key) && map.size >= 4096) {
    for (const [candidate, attempt] of map) {
      if (attempt.resetAt <= now) map.delete(candidate);
    }
    if (map.size >= 4096) map.delete(map.keys().next().value!);
  }
  const prior = map.get(key);
  const current = !prior || prior.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : prior;
  current.count += 1;
  map.set(key, current);
  return current.count > maximum;
}

function canCreateApiKey(userId: string): boolean {
  const permissions = getUserEffectivePermissions(userId);
  if (!hasPermission(permissions, PermissionFlag.createApiKeys)) return false;
  if (hasPermission(permissions, PermissionFlag.administrator)) return true;
  if (!getBillingEntitlements(userId).freeTier) return true;
  return hasManuallyAssignedPermission(userId, PermissionFlag.createApiKeys | PermissionFlag.accessApi);
}

function normalizeUserCode(value: string): string | undefined {
  const normalized = value.trim().replace(/-/g, '').toUpperCase();
  return /^[A-F0-9]{12}$/.test(normalized) ? normalized : undefined;
}

export function closeCliAuthDatabase(): void {
  clearInterval(cleanupTimer);
  authorizationDatabase.close();
}

export const cliAuthRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.post('/v1/cli/device/start', {
    schema: { hide: true, body: Type.Object({}, { additionalProperties: false }) },
  }, (request, reply) => {
    if (rateLimited(startAttempts, request.ip ?? 'unknown', 8)) return reply.code(429).send(createHttpErrorEnvelope(request.id, 429, 'Too many CLI sign-in attempts. Try again shortly.'));
    cleanExpired();
    const deviceCode = randomBytes(32).toString('base64url');
    const userCode = randomBytes(6).toString('hex').toUpperCase();
    const codeHash = hash(deviceCode);
    const createdAt = Date.now();
    const record: DeviceAuthorizationRecord = {
      id: recordId(codeHash),
      type: 'cli_device_authorization',
      userCodeHash: hash(userCode),
      status: 'pending',
      createdAt,
      expiresAt: createdAt + authorizationTtlMs,
    };
    writeRecord(record);
    const verificationUri = new URL('/cli/authorize', config.publicBaseUrl);
    verificationUri.searchParams.set('user_code', userCode.match(/.{1,4}/g)?.join('-') ?? userCode);
    return reply.header('Cache-Control', 'no-store').send({ deviceCode, userCode: userCode.match(/.{1,4}/g)?.join('-') ?? userCode, verificationUri: verificationUri.toString(), expiresIn: Math.floor(authorizationTtlMs / 1000), interval: 5 });
  });

  server.post('/v1/cli/device/token', {
    schema: { hide: true, body: Type.Object({ deviceCode: Type.String({ minLength: 30, maxLength: 128 }) }, { additionalProperties: false }) },
  }, (request, reply) => {
    if (rateLimited(pollAttempts, request.ip ?? 'unknown', 180)) return reply.code(429).send({ error: 'slow_down', interval: 10 });
    const record = readByDeviceHash(hash(request.body.deviceCode));
    if (!record) return reply.code(400).send({ error: 'expired_token' });
    if (record.expiresAt <= Date.now()) {
      deleteRecord(record);
      return reply.code(400).send({ error: 'expired_token' });
    }
    if (record.status === 'pending' || record.status === 'issuing') return reply.code(400).send({ error: 'authorization_pending' });
    if (record.status === 'denied' || !record.userId) {
      deleteRecord(record);
      return reply.code(400).send({ error: 'access_denied' });
    }
    if (record.status !== 'approved') return reply.code(400).send({ error: 'expired_token' });
    if (!canCreateApiKey(record.userId)) {
      deleteRecord(record);
      return reply.code(403).send({ error: 'access_revoked', message: 'Your account no longer has permission to create API keys.' });
    }
    if (!claimApproved(record)) return reply.code(400).send({ error: 'authorization_pending' });
    const issued = createApiKey('dkrypt CLI', record.userId, 90);
    const accessToken = revealApiKeySecret(issued.id, record.userId);
    if (!accessToken) {
      deleteRecord(record);
      return reply.code(500).send({ error: 'server_error' });
    }
    deleteRecord(record);
    return reply.header('Cache-Control', 'no-store').send({ accessToken, tokenType: 'Bearer', expiresAt: issued.expiresAt });
  });

  server.get('/v1/cli/device/authorization', {
    schema: { hide: true, querystring: Type.Object({ user_code: Type.String({ minLength: 14, maxLength: 14 }) }) },
    preHandler: fastifyRequireSession,
  }, (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const userCode = normalizeUserCode(request.query.user_code);
    const record = userCode ? readByUserCode(userCode) : undefined;
    if (!record || record.expiresAt <= Date.now() || record.status !== 'pending') return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'This sign-in code is invalid, expired, or already used. Start a new CLI sign-in.'));
    const userId = getFastifySession(request)!.sub;
    const allowed = canCreateApiKey(userId);
    return { application: 'dkrypt CLI', permissions: ['Submit decrypt jobs', 'Read your job status', 'Download IPA artifacts'], expiresAt: record.expiresAt, canApprove: allowed, reason: allowed ? undefined : 'This account needs API key access and an active plan or a manually assigned API permission.' };
  });

  server.post('/v1/cli/device/authorization', {
    schema: { hide: true, body: Type.Object({ user_code: Type.String({ minLength: 14, maxLength: 14 }), decision: Type.Union([Type.Literal('approve'), Type.Literal('deny')]) }, { additionalProperties: false }) },
    preHandler: fastifyRequireSession,
  }, (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const userCode = normalizeUserCode(request.body.user_code);
    const record = userCode ? readByUserCode(userCode) : undefined;
    if (!record || record.expiresAt <= Date.now() || record.status !== 'pending') return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'This sign-in code is invalid, expired, or already used. Start a new CLI sign-in.'));
    if (request.body.decision === 'approve') {
      const userId = getFastifySession(request)!.sub;
      if (!canCreateApiKey(userId)) return reply.code(403).send(createHttpErrorEnvelope(request.id, 403, 'This account needs API key access and an active plan or a manually assigned API permission.'));
      if (!decidePending(record, { ...record, status: 'approved', userId, approvedAt: Date.now() })) return reply.code(409).send(createHttpErrorEnvelope(request.id, 409, 'This sign-in request has already been decided.'));
    } else {
      if (!decidePending(record, { ...record, status: 'denied' })) return reply.code(409).send(createHttpErrorEnvelope(request.id, 409, 'This sign-in request has already been decided.'));
    }
    return { ok: true, decision: request.body.decision };
  });
};
