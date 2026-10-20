import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type {
  DashboardApiKeyBulkApproveRoute,
  DashboardApiKeyBulkDailyLimitRoute,
  DashboardApiKeyBulkExpiryRoute,
  DashboardApiKeyBulkRevokeRoute,
  DashboardApiKeyBulkScopeRoute,
  DashboardApiKeyBundleUsageRoute,
  DashboardApiKeyConcurrencyRoute,
  DashboardApiKeyCreateRequestRoute,
  DashboardApiKeyCreateRoute,
  DashboardApiKeyIdRoute,
  DashboardApiKeyListRoute,
  DashboardApiKeyOutcomeRoute,
  DashboardApiKeyPageRoute,
  DashboardApiKeyPriorityRoute,
  DashboardApiKeyRegenerateRoute,
  DashboardApiKeyRevealRoute,
  DashboardApiKeyTestFlightRoute,
  DashboardApiKeyUsageRoute,
} from '#dashboardApiKeyContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { getAuthProfile } from '#identity.js';
import { getRouteContract } from '#contracts.js';
import { EMBED_COLOR, notify } from '#notify.js';
import { hasPermission, PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import {
  approveApiKey,
  bulkApproveApiKeys,
  bulkExtendApiKeyExpiry,
  bulkSetApiKeyAllowedBundleIds,
  bulkSetApiKeyDailyLimit,
  createApiKey,
  denyApiKey,
  getApiKeyBundleUsage,
  getApiKeyById,
  getApiKeyOutcomeUsage,
  getApiKeyUsage,
  getUserEffectivePermissions,
  listAllApiKeysPage,
  listApiKeysForOwner,
  listPendingApiKeys,
  regenerateApiKey,
  requestApiKey,
  revealApiKeySecret,
  revokeApiKey,
  setApiKeyAllowTestFlight,
  setApiKeyMaxConcurrent,
  setApiKeyPriority,
} from '#store/state.js';
import { decodeCursor, nextCursor } from '#util/cursor.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';
import { publicApiOperations } from '#publicApi.js';
import { canAccessProject } from '#dashboardJobPresentation.js';
import { getProject } from '#store/state.js';
import { getActiveJobs } from '#jobs/store.js';
import { apiKeyCanAccessProject, isBundleIdAllowed } from '#apiKeyAccess.js';

const canRequestApiKeys = fastifyRequirePermission(PermissionFlag.requestApiKeys);
const canAccessApi = fastifyRequirePermission(PermissionFlag.createApiKeys);
const canViewOwnApiKeys = fastifyRequirePermission(PermissionFlag.requestApiKeys, PermissionFlag.createApiKeys);
const canManageOrUseApiKeys = fastifyRequirePermission(PermissionFlag.requestApiKeys, PermissionFlag.createApiKeys, PermissionFlag.manageApiKeys);
const canRevokeOwnedOrAnyApiKeys = fastifyRequirePermission(PermissionFlag.createApiKeys, PermissionFlag.manageApiKeys);
const canViewApiKeys = fastifyRequirePermission(PermissionFlag.viewApiKeys, PermissionFlag.manageApiKeys);
const canApproveApiKeys = fastifyRequirePermission(PermissionFlag.manageApiKeys);
const canManageApiKeySettings = fastifyRequirePermission(PermissionFlag.manageApiKeys);
const canInspectApiKeyUsage = fastifyRequirePermission(PermissionFlag.createApiKeys, PermissionFlag.viewApiKeys, PermissionFlag.manageApiKeys);

const EXPIRY_OPTIONS = new Set([1, 7, 30, 90]);
const MAX_SCOPED_BUNDLE_IDS = 25;
const MIN_DAILY_LIMIT = 1;
const MAX_DAILY_LIMIT = 10_000;
const MIN_EXPIRY_EXTEND_DAYS = 1;
const MAX_EXPIRY_EXTEND_DAYS = 3650;
const BUNDLE_ID_RE = /^[A-Za-z0-9.-]{3,200}$/;

function presentKey<T extends { ownerId: string }>(key: T): T & { ownerDisplayName?: string; ownerUsername?: string } {
  const owner = getAuthProfile(key.ownerId);
  return { ...key, ownerDisplayName: owner?.displayName, ownerUsername: owner?.username };
}

function parseDailyLimit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(Math.round(value), MIN_DAILY_LIMIT), MAX_DAILY_LIMIT);
}

function parseAllowedBundleIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value
    .filter((id): id is string => typeof id === 'string')
    .map((id) => id.trim())
    .filter((id) => BUNDLE_ID_RE.test(id))
    .slice(0, MAX_SCOPED_BUNDLE_IDS);
  return ids.length > 0 ? [...new Set(ids)] : undefined;
}

function parseApiKeyInput(request: FastifyRequest): {
  name: string;
  expiresInDays?: number;
  allowedBundleIds?: string[];
  dailyLimit?: number;
  allowTestFlight?: boolean;
} | undefined {
  const raw = rawBody(request);
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return undefined;
  return {
    name,
    expiresInDays: typeof raw.expiresInDays === 'number' && EXPIRY_OPTIONS.has(raw.expiresInDays) ? raw.expiresInDays : undefined,
    allowedBundleIds: parseAllowedBundleIds(raw.allowedBundleIds),
    dailyLimit: parseDailyLimit(raw.dailyLimit),
    allowTestFlight: typeof raw.allowTestFlight === 'boolean' ? raw.allowTestFlight : undefined,
  };
}

function rawBody(request: FastifyRequest): Record<string, unknown> {
  const body = rawBodies.get(request);
  return typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
}

function respondWithError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: 400 | 403 | 404,
  message: string,
) {
  reply.code(statusCode);
  return createHttpErrorEnvelope(request.id, statusCode, message);
}

function hasUsageAccess(ownerId: string, username: string, permissions: bigint): boolean {
  return ownerId === username || hasPermission(permissions, PermissionFlag.viewApiKeys) || hasPermission(permissions, PermissionFlag.manageApiKeys);
}

const rawBodies = new WeakMap<FastifyRequest, unknown>();

export const dashboardApiKeyRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);
  server.addHook('preValidation', async (request) => {
    rawBodies.set(request, request.body === undefined ? undefined : structuredClone(request.body));
  });

  server.post('/v1/dashboard/keys/simulate', {
    schema: { hide: true, body: Type.Object({ keyId: Type.Optional(Type.String()), projectId: Type.String(), bundleId: Type.String({ minLength: 3, maxLength: 200, pattern: '^[A-Za-z0-9.-]+$' }), source: Type.Union([Type.Literal('appstore'), Type.Literal('testflight')]), allowedBundleIds: Type.Optional(Type.Array(Type.String(), { maxItems: 25 })), allowTestFlight: Type.Optional(Type.Boolean()), dailyLimit: Type.Optional(Type.Union([Type.Number(), Type.Null()])), maxConcurrent: Type.Optional(Type.Union([Type.Number(), Type.Null()])) }, { additionalProperties: false }) },
    preHandler: canViewOwnApiKeys,
  }, (request, reply) => {
    const session = getFastifySession(request)!;
    const project = getProject(request.body.projectId);
    if (!project || !canAccessProject(session.sub, session.permissions, request.body.projectId)) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'project not found'));
    const key = request.body.keyId ? getApiKeyById(request.body.keyId) : undefined;
    if (request.body.keyId && (!key || !hasUsageAccess(key.ownerId, session.sub, session.permissions))) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'key not found'));
    const ownerId = key?.ownerId ?? session.sub;
    const warnings = request.body.allowedBundleIds?.some((bundleId) => !BUNDLE_ID_RE.test(bundleId.trim())) ? ['Invalid bundle IDs are ignored when a key scope is saved'] : [];
    const allowedBundleIds = request.body.allowedBundleIds === undefined ? key?.allowedBundleIds : parseAllowedBundleIds(request.body.allowedBundleIds);
    const allowTestFlight = request.body.allowTestFlight ?? key?.allowTestFlight ?? true;
    const dailyLimit = request.body.dailyLimit === null ? undefined : request.body.dailyLimit === undefined ? key?.dailyLimit : parseDailyLimit(request.body.dailyLimit);
    const maxConcurrent = request.body.maxConcurrent === null ? undefined : request.body.maxConcurrent === undefined ? key?.maxConcurrent : request.body.maxConcurrent > 0 ? Math.floor(request.body.maxConcurrent) : undefined;
    const dailyUsed = key ? getApiKeyUsage(key.id, 1)[0]?.count ?? 0 : 0;
    const concurrentRunning = key ? getActiveJobs().filter((job) => job.status === 'running' && job.apiKeyId === key.id).length : 0;
    const commonReasons: string[] = [];
    if (ownerId !== 'root' && !hasPermission(getUserEffectivePermissions(ownerId), PermissionFlag.createApiKeys)) commonReasons.push('API key access is not active for this account');
    if (key && key.status !== 'approved') commonReasons.push(`key is ${key.status}`);
    if (key?.expiresAt && key.expiresAt <= Date.now()) commonReasons.push('key has expired');
    if (!apiKeyCanAccessProject({ ownerId }, request.body.projectId)) commonReasons.push('key owner cannot access this project');
    if (!isBundleIdAllowed(allowedBundleIds, request.body.bundleId)) commonReasons.push('bundle ID is outside the proposed scope');
    if (dailyLimit && dailyUsed >= dailyLimit) commonReasons.push('daily request limit is exhausted');
    const operations = Object.entries(publicApiOperations).flatMap(([path, methods]) => methods.map((method) => {
      const route = `${method.toUpperCase()} ${path}`;
      const reasons = [...commonReasons];
      const submitsDecrypt = path === '/v1/decrypt' || path === '/v1/decrypts' || path === '/v1/testflight/decrypt';
      if (submitsDecrypt && project.archivedAt) reasons.push('project is archived');
      if (submitsDecrypt && request.body.source === 'testflight' && !allowTestFlight) reasons.push('TestFlight is disabled for this key');
      if (path === '/v1/testflight/decrypt' && request.body.source !== 'testflight') reasons.push('route accepts TestFlight builds only');
      return { route, allowed: reasons.length === 0, reasons };
    }));
    const selectedRoute = request.body.source === 'testflight' ? 'POST /v1/testflight/decrypt' : 'POST /v1/decrypts';
    const selectedOperation = operations.find((operation) => operation.route === selectedRoute)!;
    return { allowed: selectedOperation.allowed, reasons: selectedOperation.reasons, warnings, operations, routes: operations.filter((operation) => operation.allowed).map((operation) => operation.route), projectId: request.body.projectId, bundleId: request.body.bundleId, source: request.body.source, limits: { daily: dailyLimit ?? null, dailyUsed, dailyRemaining: dailyLimit === undefined ? null : Math.max(0, dailyLimit - dailyUsed), concurrent: maxConcurrent ?? null, concurrentRunning, queueWait: maxConcurrent !== undefined && concurrentRunning >= maxConcurrent } };
  });

  server.get<DashboardApiKeyListRoute>('/v1/dashboard/keys/mine', {
    schema: getRouteContract('GET', '/v1/dashboard/keys/mine'),
    preHandler: canViewOwnApiKeys,
  }, (request) => ({ keys: listApiKeysForOwner(getFastifySession(request)!.sub).map(presentKey) }));

  server.post<DashboardApiKeyCreateRequestRoute>('/v1/dashboard/keys/request', {
    schema: getRouteContract('POST', '/v1/dashboard/keys/request'),
    attachValidation: true,
    preHandler: canRequestApiKeys,
  }, (request, reply) => {
    const input = parseApiKeyInput(request);
    if (!input) return respondWithError(request, reply, 400, 'name is required');
    const record = requestApiKey(input.name, getFastifySession(request)!.sub, input.expiresInDays, input.allowedBundleIds, input.dailyLimit, input.allowTestFlight);
    void notify('keyRequest', {
      title: 'New API key request',
      description: `**${getFastifySession(request)!.sub}** requested a new key ("${input.name}") - approve it on the API Keys tab.`,
      color: EMBED_COLOR.info,
    });
    reply.code(201);
    return record;
  });

  server.post<DashboardApiKeyCreateRoute>('/v1/dashboard/keys/create', {
    schema: getRouteContract('POST', '/v1/dashboard/keys/create'),
    attachValidation: true,
    preHandler: canAccessApi,
  }, (request, reply) => {
    const input = parseApiKeyInput(request);
    if (!input) return respondWithError(request, reply, 400, 'name is required');
    reply.code(201);
    return createApiKey(input.name, getFastifySession(request)!.sub, input.expiresInDays, input.allowedBundleIds, input.dailyLimit, input.allowTestFlight);
  });

  server.post<DashboardApiKeyRevealRoute>('/v1/dashboard/keys/:id/reveal', {
    schema: getRouteContract('POST', '/v1/dashboard/keys/:id/reveal'),
    preHandler: canManageOrUseApiKeys,
  }, (request, reply) => {
    const secret = revealApiKeySecret(request.params.id, getFastifySession(request)!.sub);
    if (!secret) return respondWithError(request, reply, 404, 'no unrevealed secret for that key');
    return { key: secret };
  });

  server.post<DashboardApiKeyRegenerateRoute>('/v1/dashboard/keys/:id/regenerate', {
    schema: getRouteContract('POST', '/v1/dashboard/keys/:id/regenerate'),
    attachValidation: true,
    preHandler: canManageOrUseApiKeys,
  }, (request, reply) => {
    const raw = rawBody(request).graceMinutes;
    const graceMinutes = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
    const username = getFastifySession(request)!.sub;
    if (!regenerateApiKey(request.params.id, username, graceMinutes)) {
      return respondWithError(request, reply, 404, 'key not found, not yours, or not yet approved');
    }
    return { ok: true, key: getApiKeyById(request.params.id) };
  });

  server.delete<DashboardApiKeyIdRoute>('/v1/dashboard/keys/:id', {
    schema: getRouteContract('DELETE', '/v1/dashboard/keys/:id'),
    preHandler: canManageOrUseApiKeys,
  }, (request, reply) => {
    const { sub, permissions } = getFastifySession(request)!;
    if (!revokeApiKey(request.params.id, sub, hasPermission(permissions, PermissionFlag.manageApiKeys))) {
      return respondWithError(request, reply, 404, 'key not found or not yours');
    }
    return { ok: true };
  });

  server.post<DashboardApiKeyBulkRevokeRoute>('/v1/dashboard/keys/bulk-revoke', {
    schema: getRouteContract('POST', '/v1/dashboard/keys/bulk-revoke'),
    attachValidation: true,
    preHandler: canRevokeOwnedOrAnyApiKeys,
  }, (request, reply) => {
    if (request.validationError) return respondWithError(request, reply, 400, 'ids must be an array of API key ids');
    const { sub, permissions } = getFastifySession(request)!;
    const canRevokeAny = hasPermission(permissions, PermissionFlag.manageApiKeys);
    const revoked = request.body.ids.filter((id) => revokeApiKey(id, sub, canRevokeAny));
    return { revoked };
  });

  server.post<DashboardApiKeyBulkExpiryRoute>('/v1/dashboard/keys/bulk-extend-expiry', {
    schema: getRouteContract('POST', '/v1/dashboard/keys/bulk-extend-expiry'),
    attachValidation: true,
    preHandler: canManageApiKeySettings,
  }, (request, reply) => {
    if (request.validationError) {
      return respondWithError(request, reply, 400, `days must be between ${MIN_EXPIRY_EXTEND_DAYS} and ${MAX_EXPIRY_EXTEND_DAYS}`);
    }
    return { extended: bulkExtendApiKeyExpiry(request.body.ids, request.body.days) };
  });

  server.post<DashboardApiKeyBulkDailyLimitRoute>('/v1/dashboard/keys/bulk-set-daily-limit', {
    schema: getRouteContract('POST', '/v1/dashboard/keys/bulk-set-daily-limit'),
    attachValidation: true,
    preHandler: canManageApiKeySettings,
  }, (request, reply) => {
    if (request.validationError) return respondWithError(request, reply, 400, 'dailyLimit must be a number, or null to clear it');
    const raw = request.body.dailyLimit;
    const dailyLimit = raw === null ? undefined : parseDailyLimit(raw);
    if (raw !== null && dailyLimit === undefined) {
      return respondWithError(request, reply, 400, 'dailyLimit must be a number, or null to clear it');
    }
    return { updated: bulkSetApiKeyDailyLimit(request.body.ids, dailyLimit) };
  });

  server.post<DashboardApiKeyBulkScopeRoute>('/v1/dashboard/keys/bulk-set-scope', {
    schema: getRouteContract('POST', '/v1/dashboard/keys/bulk-set-scope'),
    attachValidation: true,
    preHandler: canManageApiKeySettings,
  }, (request, reply) => {
    if (request.validationError) {
      return respondWithError(request, reply, 400, 'allowedBundleIds must be an array of bundle ids, or null to clear it');
    }
    const allowedBundleIds = request.body.allowedBundleIds === null
      ? undefined
      : parseAllowedBundleIds(request.body.allowedBundleIds);
    return { updated: bulkSetApiKeyAllowedBundleIds(request.body.ids, allowedBundleIds) };
  });

  server.get<DashboardApiKeyUsageRoute>('/v1/dashboard/keys/:id/usage', {
    schema: getRouteContract('GET', '/v1/dashboard/keys/:id/usage'),
    preHandler: canInspectApiKeyUsage,
  }, (request, reply) => {
    const key = getApiKeyById(request.params.id);
    if (!key) return respondWithError(request, reply, 404, 'key not found');
    const { sub, permissions } = getFastifySession(request)!;
    if (!hasUsageAccess(key.ownerId, sub, permissions)) return respondWithError(request, reply, 403, 'not your key');
    const days = Math.min(Math.max(Number.parseInt(String(request.query.days ?? '14'), 10) || 14, 1), 90);
    return { usage: getApiKeyUsage(request.params.id, days) };
  });

  server.get<DashboardApiKeyBundleUsageRoute>('/v1/dashboard/keys/:id/bundle-usage', {
    schema: getRouteContract('GET', '/v1/dashboard/keys/:id/bundle-usage'),
    preHandler: canInspectApiKeyUsage,
  }, (request, reply) => {
    const key = getApiKeyById(request.params.id);
    if (!key) return respondWithError(request, reply, 404, 'key not found');
    const { sub, permissions } = getFastifySession(request)!;
    if (!hasUsageAccess(key.ownerId, sub, permissions)) return respondWithError(request, reply, 403, 'not your key');
    const limit = Math.min(Math.max(Number.parseInt(String(request.query.limit ?? '10'), 10) || 10, 1), 50);
    return { bundles: getApiKeyBundleUsage(request.params.id, limit) };
  });

  server.get<DashboardApiKeyOutcomeRoute>('/v1/dashboard/keys/:id/outcomes', {
    schema: getRouteContract('GET', '/v1/dashboard/keys/:id/outcomes'),
    preHandler: canInspectApiKeyUsage,
  }, (request, reply) => {
    const key = getApiKeyById(request.params.id);
    if (!key) return respondWithError(request, reply, 404, 'key not found');
    const { sub, permissions } = getFastifySession(request)!;
    if (!hasUsageAccess(key.ownerId, sub, permissions)) return respondWithError(request, reply, 403, 'not your key');
    const limit = Math.min(Math.max(Number.parseInt(String(request.query.limit ?? '10'), 10) || 10, 1), 30);
    return { outcomes: getApiKeyOutcomeUsage(request.params.id, limit) };
  });

  server.get<DashboardApiKeyListRoute>('/v1/dashboard/keys/pending', {
    schema: getRouteContract('GET', '/v1/dashboard/keys/pending'),
    preHandler: canApproveApiKeys,
  }, () => ({ keys: listPendingApiKeys().map(presentKey) }));

  server.get<DashboardApiKeyPageRoute>('/v1/dashboard/keys/all', {
    schema: getRouteContract('GET', '/v1/dashboard/keys/all'),
    preHandler: canViewApiKeys,
  }, (request) => {
    const limit = Math.min(Math.max(Number.parseInt(String(request.query.limit ?? '25'), 10) || 25, 1), 100);
    const offset = typeof request.query.cursor === 'string'
      ? decodeCursor(request.query.cursor)
      : Math.max(Number.parseInt(String(request.query.offset ?? '0'), 10) || 0, 0);
    const page = listAllApiKeysPage(offset, limit, request.query.search);
    return { ...page, keys: page.keys.map(presentKey), nextCursor: nextCursor(offset, page.keys.length, page.total) };
  });

  server.post<DashboardApiKeyIdRoute>('/v1/dashboard/keys/:id/approve', {
    schema: getRouteContract('POST', '/v1/dashboard/keys/:id/approve'),
    preHandler: canApproveApiKeys,
  }, (request, reply) => {
    if (!approveApiKey(request.params.id)) return respondWithError(request, reply, 404, 'no pending request with that id');
    return { ok: true };
  });

  server.post<DashboardApiKeyBulkApproveRoute>('/v1/dashboard/keys/bulk-approve', {
    schema: getRouteContract('POST', '/v1/dashboard/keys/bulk-approve'),
    attachValidation: true,
    preHandler: canApproveApiKeys,
  }, (request, reply) => {
    if (request.validationError) return respondWithError(request, reply, 400, 'ids must be an array of API key ids');
    return { approved: bulkApproveApiKeys(request.body.ids) };
  });

  server.patch<DashboardApiKeyPriorityRoute>('/v1/dashboard/keys/:id/priority', {
    schema: getRouteContract('PATCH', '/v1/dashboard/keys/:id/priority'),
    attachValidation: true,
    preHandler: canManageApiKeySettings,
  }, (request, reply) => {
    if (request.validationError || typeof rawBody(request).priority !== 'number' || !Number.isFinite(rawBody(request).priority)) {
      return respondWithError(request, reply, 400, 'priority (a number) is required');
    }
    const updated = setApiKeyPriority(request.params.id, rawBody(request).priority as number);
    if (!updated) return respondWithError(request, reply, 404, 'key not found');
    return { ok: true, priority: updated.priority ?? 0 };
  });

  server.patch<DashboardApiKeyConcurrencyRoute>('/v1/dashboard/keys/:id/max-concurrent', {
    schema: getRouteContract('PATCH', '/v1/dashboard/keys/:id/max-concurrent'),
    attachValidation: true,
    preHandler: canManageApiKeySettings,
  }, (request, reply) => {
    if (request.validationError) return respondWithError(request, reply, 400, 'maxConcurrent must be a positive number, or null to clear it');
    const raw = rawBody(request).maxConcurrent;
    const maxConcurrent = raw === null || raw === undefined ? undefined : Number(raw);
    if (maxConcurrent !== undefined && (!Number.isFinite(maxConcurrent) || maxConcurrent <= 0)) {
      return respondWithError(request, reply, 400, 'maxConcurrent must be a positive number, or null to clear it');
    }
    const updated = setApiKeyMaxConcurrent(request.params.id, maxConcurrent);
    if (!updated) return respondWithError(request, reply, 404, 'key not found');
    return { ok: true, maxConcurrent: updated.maxConcurrent };
  });

  server.patch<DashboardApiKeyTestFlightRoute>('/v1/dashboard/keys/:id/allow-testflight', {
    schema: getRouteContract('PATCH', '/v1/dashboard/keys/:id/allow-testflight'),
    attachValidation: true,
    preHandler: canManageApiKeySettings,
  }, (request, reply) => {
    const allowTestFlight = rawBody(request).allowTestFlight;
    if (request.validationError || typeof allowTestFlight !== 'boolean') {
      return respondWithError(request, reply, 400, 'allowTestFlight (boolean) is required');
    }
    const updated = setApiKeyAllowTestFlight(request.params.id, allowTestFlight);
    if (!updated) return respondWithError(request, reply, 404, 'key not found');
    return { ok: true, allowTestFlight: updated.allowTestFlight ?? true };
  });

  server.post<DashboardApiKeyIdRoute>('/v1/dashboard/keys/:id/deny', {
    schema: getRouteContract('POST', '/v1/dashboard/keys/:id/deny'),
    preHandler: canApproveApiKeys,
  }, (request, reply) => {
    if (!denyApiKey(request.params.id)) return respondWithError(request, reply, 404, 'no pending request with that id');
    return { ok: true };
  });
};
