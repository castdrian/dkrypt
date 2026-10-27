import { createHash, randomBytes } from 'node:crypto';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  type AuthConnectionRoute,
  type AuthIdentifierRoute,
  type AuthLoginRoute,
  type AuthOAuthCallbackRoute,
  type AuthPasskeyPayloadRoute,
  type AuthPrivacyDeleteRoute,
  type AuthProfileRoute,
  type AuthReauthenticateRoute,
  type AuthTokenRoute,
} from '#authContracts.js';
import { linkOauthAccount, resolveOauthAccount } from '#account.js';
import { getRouteContract } from '#contracts.js';
import { getBillingEntitlements } from '#billing.js';
import { config, isDiscordBotEnabled, isDiscordOauthEnabled, isGithubOauthEnabled } from '#config.js';
import { fetchMemberRoleIds } from '#discord.js';
import {
  type AuthIdentity,
  getAuthProfile,
  getLinkedAuthIdentities,
  getLinkedAuthProviders,
  removeAuthIdentity,
  setAuthDisplayName,
  setAuthUsername,
} from '#identity.js';
import { log } from '#logger.js';
import { beginMfaEnrollment, confirmMfaEnrollment, disableMfa, mfaStatus, regenerateRecoveryCodes, verifyMfa } from '#mfa.js';
import { PermissionFlag, serializeBits } from '#permissions.js';
import { accountDeletionBlocker, buildAccountExport, deleteAccount } from '#privacy.js';
import { beginPasskeyAuthentication, beginPasskeyReauthentication, beginPasskeyRegistration, finishPasskeyAuthentication, finishPasskeyReauthentication, finishPasskeyRegistration, listUserPasskeys, removeUserPasskey } from '#passkeys.js';
import {
  bumpSessionVersion,
  getDiscordGuildIds,
  getUserEffectivePermissions,
  listAllowedUsers,
  listSessionsForUser,
  revokeOtherSessionRecords,
  revokeSessionRecord,
  syncDiscordPerkRoles,
  recordAudit,
} from '#store/state.js';
import {
  checkRootPassword,
  clearFastifySessionCookie,
  fastifyRequireRecentAuthentication,
  fastifyRequireSession,
  fastifySessionOptsFromRequest,
  getFastifySession,
  parseCookieHeader,
  setFastifySessionCookie,
} from '#session.js';
import { FixedWindowRateLimiter } from '#util/rateLimit.js';
import { getDeploymentMetadata } from '#deployment.js';
import { createPendingOauthLink, deletePendingOauthLink, getPendingOauthLink, pendingOauthLinkPreview } from '#store/oauthLinkReview.js';

const LOCKOUT_AFTER = 5;
const MAX_LOCKOUT_MS = 5 * 60_000;
const FAILURE_WINDOW_MS = 15 * 60_000;
const SESSION_ROUTE = '/v1/auth/session';
const MFA_ROUTE = '/v1/auth/mfa';
const PASSKEY_ROUTE = '/v1/auth/passkeys';

interface LoginAttempts {
  failures: number;
  lockedUntil: number;
  lastAttemptAt: number;
}

const loginAttempts = new Map<string, LoginAttempts>();
const publicAuthRateLimiter = new FixedWindowRateLimiter(30, 60_000);

function loginLockoutMs(key: string): number {
  const entry = loginAttempts.get(key);
  if (!entry) return 0;
  if (Date.now() - entry.lastAttemptAt > FAILURE_WINDOW_MS) {
    loginAttempts.delete(key);
    return 0;
  }
  return Math.max(0, entry.lockedUntil - Date.now());
}

function recordLoginFailure(key: string): void {
  const entry = loginAttempts.get(key) ?? { failures: 0, lockedUntil: 0, lastAttemptAt: 0 };
  entry.failures += 1;
  entry.lastAttemptAt = Date.now();
  if (entry.failures >= LOCKOUT_AFTER) {
    entry.lockedUntil = Date.now() + Math.min(2 ** (entry.failures - LOCKOUT_AFTER) * 1000, MAX_LOCKOUT_MS);
  }
  loginAttempts.set(key, entry);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    if (now - entry.lastAttemptAt > FAILURE_WINDOW_MS) loginAttempts.delete(key);
  }
}, 60_000).unref();

const publicAuthRateLimit = (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void => {
  const key = request.ip ?? 'unknown';
  const decision = publicAuthRateLimiter.consume(key);
  reply.header('X-RateLimit-Limit', String(decision.limit));
  reply.header('X-RateLimit-Remaining', String(decision.remaining));
  reply.header('X-RateLimit-Reset', String(Math.ceil(decision.resetAt / 1000)));
  if (!decision.allowed) {
    reply.header('Retry-After', String(decision.retryAfterSeconds));
    sendAuthError(request, reply, 'rate_limited', `too many requests - try again in ${decision.retryAfterSeconds}s`, 429, true);
    return;
  }
  done();
};

function sendAuthError(
  request: FastifyRequest,
  reply: FastifyReply,
  code: string,
  message: string,
  status: number,
  retryable: boolean,
  extra: Record<string, unknown> = {},
): FastifyReply {
  return reply.code(status).send({ ...extra, error: message, code, message, requestId: request.id, retryable });
}

function sendValidationError(request: FastifyRequest, reply: FastifyReply, status: number, message: string): FastifyReply {
  return sendAuthError(request, reply, status >= 500 ? 'internal_error' : 'request_error', message, status, status >= 500 || status === 429 || status === 503);
}

export const authRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.get(SESSION_ROUTE, { schema: getRouteContract('GET', SESSION_ROUTE) }, async (request, reply) => {
    const session = getFastifySession(request);
    const profile = session ? getAuthProfile(session.sub) : undefined;
    return reply.send({
      loggedIn: !!session,
      freeTier: session ? getBillingEntitlements(session.sub).freeTier === true : false,
      sub: session?.sub,
      username: profile?.username,
      displayName: profile?.displayName,
      avatarUrl: profile?.avatarUrl,
      identities: session ? getLinkedAuthIdentities(session.sub) : [],
      linkedProviders: session ? getLinkedAuthProviders(session.sub) : [],
      permissions: session ? serializeBits(session.permissions) : undefined,
      expiresAt: session?.exp,
      githubOauthEnabled: isGithubOauthEnabled(),
      discordOauthEnabled: isDiscordOauthEnabled(),
      deployment: { ref: getDeploymentMetadata().ref },
      publicBaseUrl: config.publicBaseUrl,
      mfa: session ? { ...mfaStatus(session.sub), required: !session.mfaVerified } : undefined,
    });
  });

  server.get(MFA_ROUTE, { schema: getRouteContract('GET', MFA_ROUTE), preHandler: fastifyRequireSession }, async (request, reply) => {
    return reply.send(mfaStatus(getFastifySession(request)!.sub));
  });

  server.post(`${MFA_ROUTE}/setup`, { schema: getRouteContract('POST', `${MFA_ROUTE}/setup`), preHandler: fastifyRequireSession }, async (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    if (mfaStatus(userId).enabled) return sendValidationError(request, reply, 409, 'multi-factor authentication is already enabled');
    return reply.send(beginMfaEnrollment(userId));
  });

  server.post<AuthTokenRoute>(`${MFA_ROUTE}/confirm`, { schema: getRouteContract('POST', `${MFA_ROUTE}/confirm`), preHandler: fastifyRequireSession }, async (request, reply) => {
    const result = confirmMfaEnrollment(getFastifySession(request)!.sub, request.body.token);
    if (!result) return sendValidationError(request, reply, 400, 'the authenticator code is invalid or the enrollment has expired');
    return reply.send({ enabled: true, recoveryCodes: result.recoveryCodes });
  });

  server.post<AuthTokenRoute>(`${MFA_ROUTE}/verify`, { schema: getRouteContract('POST', `${MFA_ROUTE}/verify`) }, async (request, reply) => {
    const session = getFastifySession(request);
    if (!session) return sendValidationError(request, reply, 401, 'not signed in');
    if (!verifyMfa(session.sub, request.body.token).ok) return sendValidationError(request, reply, 401, 'the authenticator or recovery code is invalid');
    const expiresAt = setFastifySessionCookie(reply, { sub: session.sub, permissions: session.permissions, mfaVerified: true, reauthenticatedAt: Date.now() }, { sid: session.sid });
    return reply.send({ ok: true, expiresAt });
  });

  server.post<AuthReauthenticateRoute>('/v1/auth/reauthenticate', { schema: getRouteContract('POST', '/v1/auth/reauthenticate'), preHandler: fastifyRequireSession }, async (request, reply) => {
    const session = getFastifySession(request)!;
    const password = request.body.password ?? '';
    const token = request.body.mfaToken ?? '';
    const valid = session.sub === 'root' ? checkRootPassword(password) : mfaStatus(session.sub).enabled && verifyMfa(session.sub, token).ok;
    if (!valid) return sendAuthError(request, reply, 'reauthentication_failed', 'the supplied reauthentication proof is invalid', 401, false);
    const expiresAt = setFastifySessionCookie(reply, { sub: session.sub, permissions: session.permissions, mfaVerified: session.mfaVerified, reauthenticatedAt: Date.now() }, { sid: session.sid });
    return reply.send({ ok: true, expiresAt });
  });

  server.get(PASSKEY_ROUTE, { schema: getRouteContract('GET', PASSKEY_ROUTE), preHandler: fastifyRequireSession }, async (request, reply) => {
    return reply.send({ passkeys: listUserPasskeys(getFastifySession(request)!.sub) });
  });

  server.post(`${PASSKEY_ROUTE}/register/options`, {
    schema: getRouteContract('POST', `${PASSKEY_ROUTE}/register/options`),
    preHandler: [fastifyRequireSession, fastifyRequireRecentAuthentication()],
  }, async (request, reply) => {
    try {
      return reply.send(await beginPasskeyRegistration(getFastifySession(request)!.sub));
    } catch (error) {
      return sendAuthError(request, reply, 'passkey_unavailable', error instanceof Error ? error.message : String(error), 503, true);
    }
  });

  server.post<AuthPasskeyPayloadRoute>(`${PASSKEY_ROUTE}/register`, {
    schema: getRouteContract('POST', `${PASSKEY_ROUTE}/register`),
    preHandler: [fastifyRequireSession, fastifyRequireRecentAuthentication()],
  }, async (request, reply) => {
    const response = request.body as Record<string, unknown>;
    if (typeof response.id !== 'string' || typeof response.rawId !== 'string' || typeof response.response !== 'object' || response.response === null) {
      return sendAuthError(request, reply, 'invalid_passkey_response', 'the passkey registration response is malformed', 400, false);
    }
    try {
      const session = getFastifySession(request)!;
      const credential = await finishPasskeyRegistration(session.sub, response as never, typeof response.name === 'string' ? response.name : undefined);
      recordAudit(session.sub, 'auth.passkey.add', credential.id, credential.name ?? 'passkey registered');
      return reply.code(201).send({ passkey: listUserPasskeys(session.sub).find((candidate) => candidate.id === credential.id) });
    } catch (error) {
      return sendAuthError(request, reply, 'passkey_registration_failed', error instanceof Error ? error.message : String(error), 400, false);
    }
  });

  server.delete<AuthIdentifierRoute>(`${PASSKEY_ROUTE}/:id`, {
    schema: getRouteContract('DELETE', `${PASSKEY_ROUTE}/:id`),
    preHandler: [fastifyRequireSession, fastifyRequireRecentAuthentication()],
  }, async (request, reply) => {
    const session = getFastifySession(request)!;
    if (!removeUserPasskey(session.sub, request.params.id)) return sendAuthError(request, reply, 'passkey_not_found', 'passkey not found', 404, false);
    recordAudit(session.sub, 'auth.passkey.remove', request.params.id, 'passkey removed');
    return reply.send({ ok: true });
  });

  server.post(`${PASSKEY_ROUTE}/options`, { schema: getRouteContract('POST', `${PASSKEY_ROUTE}/options`), onRequest: publicAuthRateLimit }, async (request, reply) => {
    try {
      return reply.send(await beginPasskeyAuthentication());
    } catch (error) {
      return sendAuthError(request, reply, 'passkey_unavailable', error instanceof Error ? error.message : String(error), 503, true);
    }
  });

  server.post<AuthPasskeyPayloadRoute>(`${PASSKEY_ROUTE}/verify`, { schema: getRouteContract('POST', `${PASSKEY_ROUTE}/verify`), onRequest: publicAuthRateLimit }, async (request, reply) => {
    const response = request.body as Record<string, unknown>;
    if (typeof response.id !== 'string' || typeof response.rawId !== 'string' || typeof response.response !== 'object' || response.response === null) {
      return sendAuthError(request, reply, 'invalid_passkey_response', 'the passkey authentication response is malformed', 400, false);
    }
    try {
      const result = await finishPasskeyAuthentication(response as never);
      const permissions = result.userId === 'root' ? PermissionFlag.administrator : getUserEffectivePermissions(result.userId);
      const expiresAt = setFastifySessionCookie(reply, { sub: result.userId, permissions, mfaVerified: true, reauthenticatedAt: Date.now() }, fastifySessionOptsFromRequest(request));
      recordAudit(result.userId, 'auth.passkey.login', result.credential.id, 'passkey login succeeded');
      return reply.send({ ok: true, expiresAt });
    } catch (error) {
      return sendAuthError(request, reply, 'passkey_authentication_failed', error instanceof Error ? error.message : String(error), 401, false);
    }
  });

  server.post(`${PASSKEY_ROUTE}/reauth/options`, {
    schema: getRouteContract('POST', `${PASSKEY_ROUTE}/reauth/options`),
    preHandler: fastifyRequireSession,
  }, async (request, reply) => {
    try {
      return reply.send(await beginPasskeyReauthentication(getFastifySession(request)!.sub));
    } catch (error) {
      return sendAuthError(request, reply, 'passkey_unavailable', error instanceof Error ? error.message : String(error), 503, true);
    }
  });

  server.post<AuthPasskeyPayloadRoute>(`${PASSKEY_ROUTE}/reauth/verify`, {
    schema: getRouteContract('POST', `${PASSKEY_ROUTE}/reauth/verify`),
    preHandler: fastifyRequireSession,
  }, async (request, reply) => {
    const response = request.body as Record<string, unknown>;
    if (typeof response.id !== 'string' || typeof response.rawId !== 'string' || typeof response.response !== 'object' || response.response === null) {
      return sendAuthError(request, reply, 'invalid_passkey_response', 'the passkey authentication response is malformed', 400, false);
    }
    try {
      const session = getFastifySession(request)!;
      const credential = await finishPasskeyReauthentication(session.sub, response as never);
      const expiresAt = setFastifySessionCookie(
        reply,
        { sub: session.sub, permissions: session.permissions, mfaVerified: session.mfaVerified, reauthenticatedAt: Date.now() },
        { sid: session.sid },
      );
      recordAudit(session.sub, 'auth.passkey.reauthenticate', credential.id, 'passkey reauthentication succeeded');
      return reply.send({ ok: true, expiresAt });
    } catch (error) {
      return sendAuthError(request, reply, 'passkey_reauthentication_failed', error instanceof Error ? error.message : String(error), 401, false);
    }
  });

  server.post<AuthTokenRoute>(`${MFA_ROUTE}/disable`, { schema: getRouteContract('POST', `${MFA_ROUTE}/disable`), preHandler: fastifyRequireSession }, async (request, reply) => {
    if (!disableMfa(getFastifySession(request)!.sub, request.body.token)) return sendValidationError(request, reply, 400, 'the authenticator or recovery code is invalid');
    return reply.send({ enabled: false, recoveryCodesRemaining: 0 });
  });

  server.post<AuthTokenRoute>(`${MFA_ROUTE}/recovery-codes`, { schema: getRouteContract('POST', `${MFA_ROUTE}/recovery-codes`), preHandler: fastifyRequireSession }, async (request, reply) => {
    const recoveryCodes = regenerateRecoveryCodes(getFastifySession(request)!.sub, request.body.token);
    if (!recoveryCodes) return sendValidationError(request, reply, 400, 'the authenticator or recovery code is invalid');
    return reply.send({ recoveryCodes });
  });

  server.get('/v1/auth/privacy/export', { schema: getRouteContract('GET', '/v1/auth/privacy/export'), preHandler: fastifyRequireSession }, async (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    const payload = buildAccountExport(userId);
    recordAudit(userId, 'privacy.export', userId, 'account export generated');
    const filename = `dkrypt-account-export-${userId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
    return reply.header('Content-Disposition', `attachment; filename="${filename}"`).type('application/json').send(`${JSON.stringify(payload, null, 2)}\n`);
  });

  server.post<AuthPrivacyDeleteRoute>('/v1/auth/privacy/delete', {
    schema: getRouteContract('POST', '/v1/auth/privacy/delete'),
    preHandler: [fastifyRequireSession, fastifyRequireRecentAuthentication()],
  }, async (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    const confirmation = request.body.confirmation.trim();
    if (confirmation !== 'DELETE MY ACCOUNT') return sendAuthError(request, reply, 'confirmation_required', 'type DELETE MY ACCOUNT to confirm account deletion', 400, false);
    const blocker = accountDeletionBlocker(userId);
    if (blocker) return sendAuthError(request, reply, 'account_deletion_blocked', blocker, 409, false);
    const result = deleteAccount(userId);
    if (!result.ok) return sendAuthError(request, reply, 'account_deletion_failed', result.error ?? 'account deletion failed', 400, false);
    clearFastifySessionCookie(reply);
    return reply.send({ ok: true });
  });

  server.patch<AuthProfileRoute>('/v1/auth/profile', { schema: getRouteContract('PATCH', '/v1/auth/profile'), preHandler: fastifyRequireSession }, async (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    if (userId === 'root') return sendValidationError(request, reply, 400, 'the root account does not have an OAuth profile');
    const displayName = request.body.displayName?.trim();
    const username = request.body.username?.trim();
    if (displayName !== undefined && (!displayName || displayName.length > 64 || /[\u0000-\u001f\u007f]/.test(displayName))) {
      return sendValidationError(request, reply, 400, 'displayName must be between 1 and 64 characters');
    }
    if (displayName === undefined && username === undefined) return sendValidationError(request, reply, 400, 'provide a displayName or username');
    let profile;
    try {
      profile = username === undefined ? getAuthProfile(userId) : setAuthUsername(userId, username);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid username';
      return sendValidationError(request, reply, message === 'username is already taken' || message === 'username is unavailable' ? 409 : 400, message);
    }
    if (displayName !== undefined) profile = setAuthDisplayName(userId, displayName);
    if (!profile) return sendValidationError(request, reply, 404, 'profile not found');
    return reply.send({ username: profile.username, displayName: profile.displayName, linkedProviders: getLinkedAuthProviders(userId) });
  });

  server.delete<AuthConnectionRoute>('/v1/auth/connections/:provider', {
    schema: getRouteContract('DELETE', '/v1/auth/connections/:provider'),
    preHandler: [fastifyRequireSession, fastifyRequireRecentAuthentication()],
  }, async (request, reply) => {
    const session = getFastifySession(request)!;
    const userId = session.sub;
    const provider = request.params.provider;
    if (userId === 'root') return sendValidationError(request, reply, 400, 'the root account does not have OAuth connections');
    if (request.body.confirmation !== 'DISCONNECT') return sendValidationError(request, reply, 400, 'confirm the sign-in method removal');
    const remainingOauthMethods = new Set((getAuthProfile(userId)?.identities ?? []).filter((identity) => identity.source !== 'discord_connection' && identity.provider !== provider).map((identity) => identity.provider));
    if (remainingOauthMethods.size === 0 && listUserPasskeys(userId).length === 0) return sendValidationError(request, reply, 400, 'connect another usable sign-in method before removing this one');
    const profile = removeAuthIdentity(userId, provider);
    if (!profile) return sendValidationError(request, reply, 404, 'connection not found');
    bumpSessionVersion(userId);
    setFastifySessionCookie(reply, { sub: userId, permissions: getUserEffectivePermissions(userId) ?? 0n, reauthenticatedAt: session.reauthenticatedAt }, fastifySessionOptsFromRequest(request));
    return reply.send({ identities: getLinkedAuthIdentities(userId), linkedProviders: getLinkedAuthProviders(userId) });
  });

  server.get('/v1/auth/connections/:provider/preview', { schema: { hide: true, params: Type.Object({ provider: Type.Union([Type.Literal('github'), Type.Literal('discord')]) }) }, preHandler: fastifyRequireSession }, (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    const connected = (getAuthProfile(userId)?.identities ?? []).some((identity) => identity.provider === request.params.provider && identity.source !== 'discord_connection');
    if (!connected) return reply.code(404).send({ error: 'sign-in method not found' });
    const remaining = new Set((getAuthProfile(userId)?.identities ?? []).filter((identity) => identity.source !== 'discord_connection' && identity.provider !== request.params.provider).map((identity) => identity.provider));
    return { provider: request.params.provider, canUnlink: remaining.size > 0 || listUserPasskeys(userId).length > 0, affectedCategories: ['sign-in methods', 'active sessions'] };
  });

  server.get('/v1/auth/link-review/:id', { schema: { hide: true, params: Type.Object({ id: Type.String() }) }, preHandler: fastifyRequireSession }, (request, reply) => {
    const link = getPendingOauthLink(request.params.id, getFastifySession(request)!.sub);
    if (!link) return reply.code(404).send({ error: 'link review expired or unavailable' });
    return pendingOauthLinkPreview(link);
  });

  server.post('/v1/auth/link-review/:id/confirm', { schema: { hide: true, params: Type.Object({ id: Type.String() }), body: Type.Object({ confirmation: Type.Union([Type.Literal('LINK ACCOUNT'), Type.Literal('MERGE ACCOUNTS')]) }) }, preHandler: [fastifyRequireSession, fastifyRequireRecentAuthentication()] }, (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    const link = getPendingOauthLink(request.params.id, userId);
    if (!link) return reply.code(404).send({ error: 'link review expired or unavailable' });
    const preview = pendingOauthLinkPreview(link);
    if (request.body.confirmation !== (preview.willMerge ? 'MERGE ACCOUNTS' : 'LINK ACCOUNT')) return reply.code(400).send({ error: 'confirmation does not match the requested action' });
    const profile = linkOauthAccount(userId, link.identity);
    deletePendingOauthLink(link.id, userId);
    recordAudit(userId, preview.willMerge ? 'auth.account.merge' : 'auth.account.link', profile.userId, link.identity.provider);
    const permissions = getUserEffectivePermissions(userId);
    setFastifySessionCookie(reply, { sub: userId, permissions, reauthenticatedAt: getFastifySession(request)!.reauthenticatedAt }, fastifySessionOptsFromRequest(request));
    return { ok: true, linkedProviders: getLinkedAuthProviders(userId) };
  });

  server.post('/v1/auth/refresh', { schema: getRouteContract('POST', '/v1/auth/refresh'), preHandler: fastifyRequireSession }, async (request, reply) => {
    const session = getFastifySession(request);
    if (!session) return sendValidationError(request, reply, 401, 'not signed in');
    const permissions = session.sub === 'root' ? PermissionFlag.administrator : getUserEffectivePermissions(session.sub);
    const expiresAt = setFastifySessionCookie(reply, { sub: session.sub, permissions, mfaVerified: session.mfaVerified, reauthenticatedAt: session.reauthenticatedAt }, { sid: session.sid });
    return reply.send({ ok: true, expiresAt });
  });

  server.post<AuthLoginRoute>('/v1/auth/login', { schema: getRouteContract('POST', '/v1/auth/login'), onRequest: publicAuthRateLimit }, async (request, reply) => {
    const key = request.ip ?? 'unknown';
    const lockedForMs = loginLockoutMs(key);
    if (lockedForMs > 0) return sendValidationError(request, reply, 429, `too many failed attempts - try again in ${Math.ceil(lockedForMs / 1000)}s`);
    const password = request.body.password;
    if (!password || !checkRootPassword(password)) {
      recordLoginFailure(key);
      const failures = loginAttempts.get(key)?.failures ?? 0;
      return sendAuthError(request, reply, 'request_error', 'invalid password', 401, false, { attemptsRemaining: Math.max(0, LOCKOUT_AFTER - failures) });
    }
    const mfa = mfaStatus('root');
    const mfaToken = request.body.mfaToken ?? '';
    if (mfa.enabled && (!mfaToken || !verifyMfa('root', mfaToken).ok)) {
      return sendAuthError(request, reply, 'mfa_required', 'multi-factor authentication is required', 401, false);
    }
    loginAttempts.delete(key);
    setFastifySessionCookie(reply, { sub: 'root', permissions: PermissionFlag.administrator, mfaVerified: true, reauthenticatedAt: Date.now() }, fastifySessionOptsFromRequest(request));
    return reply.send({ ok: true });
  });

  server.post('/v1/auth/logout', { schema: getRouteContract('POST', '/v1/auth/logout') }, async (request, reply) => {
    const session = getFastifySession(request);
    if (session) revokeSessionRecord(session.sid, session.sub);
    clearFastifySessionCookie(reply);
    return reply.send({ ok: true });
  });

  server.post('/v1/auth/logout-everywhere', { schema: getRouteContract('POST', '/v1/auth/logout-everywhere'), preHandler: fastifyRequireSession }, async (request, reply) => {
    const session = getFastifySession(request);
    if (!session) return sendValidationError(request, reply, 401, 'not signed in');
    bumpSessionVersion(session.sub);
    clearFastifySessionCookie(reply);
    return reply.send({ ok: true });
  });

  server.get('/v1/auth/sessions', { schema: getRouteContract('GET', '/v1/auth/sessions'), preHandler: fastifyRequireSession }, async (request, reply) => {
    const session = getFastifySession(request);
    if (!session) return sendValidationError(request, reply, 401, 'not signed in');
    return reply.send(listSessionsForUser(session.sub).map((item) => ({ ...item, current: item.id === session.sid })));
  });

  server.delete<AuthIdentifierRoute>('/v1/auth/sessions/:id', {
    schema: getRouteContract('DELETE', '/v1/auth/sessions/:id'),
    preHandler: fastifyRequireSession,
  }, async (request, reply) => {
    const session = getFastifySession(request);
    if (!session) return sendValidationError(request, reply, 401, 'not signed in');
    const ok = revokeSessionRecord(request.params.id, session.sub);
    if (!ok) return sendValidationError(request, reply, 404, 'session not found');
    if (request.params.id === session.sid) clearFastifySessionCookie(reply);
    return reply.send({ ok: true });
  });

  server.post('/v1/auth/sessions/revoke-others', {
    schema: getRouteContract('POST', '/v1/auth/sessions/revoke-others'),
    preHandler: fastifyRequireSession,
  }, async (request, reply) => {
    const session = getFastifySession(request);
    if (!session) return sendValidationError(request, reply, 401, 'not signed in');
    return reply.send({ ok: true, revoked: revokeOtherSessionRecords(session.sub, session.sid) });
  });

  registerOAuthRoutes(server);
};

type OAuthProvider = 'github' | 'discord';

interface OAuthProviderConfig {
  enabled: () => boolean;
  clientId: () => string;
  callbackPath: string;
  authorizationUrl: string;
  scope: string;
  stateCookieName: string;
  responseType?: string;
}

const oauthProviders: Record<OAuthProvider, OAuthProviderConfig> = {
  github: {
    enabled: isGithubOauthEnabled,
    clientId: () => config.githubOauthClientId,
    callbackPath: '/v1/auth/github/callback',
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    scope: 'read:user user:email',
    stateCookieName: 'github_oauth_state',
  },
  discord: {
    enabled: isDiscordOauthEnabled,
    clientId: () => config.discordOauthClientId,
    callbackPath: '/v1/auth/discord/callback',
    authorizationUrl: 'https://discord.com/oauth2/authorize',
    scope: 'identify email connections',
    stateCookieName: 'discord_oauth_state',
    responseType: 'code',
  },
};

const oauthConnections = new Map<string, { provider: OAuthProvider; userId?: string; codeVerifier: string; returnTo?: string; expiresAt: number }>();

interface OAuthTokenResponse {
  access_token?: string;
  error?: string;
}

async function exchangeOAuthTokenWithRotation(
  provider: OAuthProvider,
  currentSecret: string,
  previousSecret: string,
  credentialError: string,
  exchange: (secret: string) => Promise<OAuthTokenResponse>,
): Promise<OAuthTokenResponse> {
  const token = await exchange(currentSecret);
  if (token.error !== credentialError || currentSecret.length < 16 || previousSecret.length < 16 || previousSecret === currentSecret) return token;
  const previousToken = await exchange(previousSecret);
  if (previousToken.access_token) log.warn(`${provider} OAuth token exchange used previous client secret`);
  return previousToken;
}

function oauthCookie(name: string, value: string, maxAge: number): string {
  const secure = config.publicBaseUrl.startsWith('https://') ? '; Secure' : '';
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function oauthUserId(provider: OAuthProvider, providerId: string, username: string): string {
  const stableId = `${provider}:${providerId}`;
  const legacy = listAllowedUsers().find((user) => user.username === username.toLowerCase());
  return legacy?.username ?? stableId;
}

function oauthReturnPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const target = new URL(value, config.publicBaseUrl);
    const origin = new URL(config.publicBaseUrl).origin;
    if (target.origin !== origin || target.username || target.password || target.hash) return undefined;
    if (target.pathname !== '/oauth/authorize' && !/^\/mcp\/approval\/[A-Za-z0-9_-]{20,128}$/.test(target.pathname)) return undefined;
    return `${target.pathname}${target.search}`;
  } catch {
    return undefined;
  }
}

function createOauthState(provider: OAuthProvider, userId?: string, returnTo?: string): { state: string; codeVerifier: string } {
  const state = randomBytes(16).toString('hex');
  const codeVerifier = randomBytes(32).toString('base64url');
  oauthConnections.set(state, { provider, userId, codeVerifier, returnTo, expiresAt: Date.now() + 600_000 });
  return { state, codeVerifier };
}

function consumeOauthConnection(provider: OAuthProvider, state: string): { userId?: string; codeVerifier: string; returnTo?: string } | undefined {
  const connection = oauthConnections.get(state);
  oauthConnections.delete(state);
  if (!connection || connection.provider !== provider || connection.expiresAt < Date.now()) return undefined;
  return { userId: connection.userId, codeVerifier: connection.codeVerifier, returnTo: connection.returnTo };
}

setInterval(() => {
  const now = Date.now();
  for (const [state, connection] of oauthConnections) {
    if (connection.expiresAt < now) oauthConnections.delete(state);
  }
}, 60_000).unref();

function startOAuthLogin(request: FastifyRequest, reply: FastifyReply, provider: OAuthProvider, userId?: string): void {
  const providerConfig = oauthProviders[provider];
  if (!providerConfig.enabled()) {
    sendValidationError(request, reply, 404, `${provider === 'github' ? 'GitHub' : 'Discord'} OAuth is not configured`);
    return;
  }
  const query = request.query as Record<string, unknown>;
  const { state, codeVerifier } = createOauthState(provider, userId, oauthReturnPath(query.return_to));
  reply.header('Set-Cookie', oauthCookie(providerConfig.stateCookieName, state, 600));
  const url = new URL(providerConfig.authorizationUrl);
  url.searchParams.set('client_id', providerConfig.clientId());
  url.searchParams.set('redirect_uri', `${config.publicBaseUrl}${providerConfig.callbackPath}`);
  if (providerConfig.responseType) url.searchParams.set('response_type', providerConfig.responseType);
  url.searchParams.set('scope', providerConfig.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', createHash('sha256').update(codeVerifier).digest('base64url'));
  url.searchParams.set('code_challenge_method', 'S256');
  reply.redirect(url.toString());
}

async function exchangeGithubCode(code: string, codeVerifier?: string): Promise<OAuthTokenResponse> {
  const currentSecret = config.githubOauthClientSecret;
  const previousSecret = config.githubOauthClientSecretPrevious;
  const exchange = async (clientSecret: string) => {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.githubOauthClientId,
        client_secret: clientSecret,
        code,
        redirect_uri: `${config.publicBaseUrl}/v1/auth/github/callback`,
        code_verifier: codeVerifier,
      }),
    });
    return (await response.json()) as OAuthTokenResponse;
  };
  return exchangeOAuthTokenWithRotation('github', currentSecret, previousSecret, 'incorrect_client_credentials', exchange);
}

async function exchangeDiscordCode(code: string, redirectUri: string, codeVerifier: string): Promise<OAuthTokenResponse> {
  const currentSecret = config.discordOauthClientSecret;
  const previousSecret = config.discordOauthClientSecretPrevious;
  const exchange = async (clientSecret: string) => {
    const body = new URLSearchParams({
      client_id: config.discordOauthClientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    const response = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    return (await response.json()) as OAuthTokenResponse;
  };
  return exchangeOAuthTokenWithRotation('discord', currentSecret, previousSecret, 'invalid_client', exchange);
}

function registerOAuthRoutes(server: Parameters<FastifyPluginAsyncTypebox>[0]): void {
  server.get('/v1/auth/github/login', { schema: getRouteContract('GET', '/v1/auth/github/login') }, async (request, reply) => {
    startOAuthLogin(request, reply, 'github');
  });

  server.get('/v1/auth/github/connect', {
    schema: getRouteContract('GET', '/v1/auth/github/connect'),
    preHandler: fastifyRequireSession,
  }, async (request, reply) => {
    const session = getFastifySession(request)!;
    if (session.sub === 'root') return sendValidationError(request, reply, 400, 'the root account cannot connect OAuth identities');
    startOAuthLogin(request, reply, 'github', session.sub);
  });

  server.get<AuthOAuthCallbackRoute>('/v1/auth/github/callback', {
    schema: getRouteContract('GET', '/v1/auth/github/callback'),
  }, async (request, reply) => {
    if (!isGithubOauthEnabled()) return reply.redirect('/?auth_error=disabled');
    const code = request.query.code ?? '';
    const state = request.query.state ?? '';
    const cookieState = parseCookieHeader(request.headers.cookie)[oauthProviders.github.stateCookieName];
    reply.header('Set-Cookie', oauthCookie(oauthProviders.github.stateCookieName, '', 0));
    if (!code || !state || !cookieState || state !== cookieState) {
      log.warn('github oauth state mismatch', { hasCode: !!code, hasState: !!state, hasCookieState: !!cookieState });
      return reply.redirect('/?auth_error=state_mismatch');
    }
    const oauthConnection = consumeOauthConnection('github', state);
    const linkUserId = oauthConnection?.userId;
    try {
      const tokenBody = await exchangeGithubCode(code, oauthConnection?.codeVerifier);
      if (!tokenBody.access_token) throw new Error(tokenBody.error ?? 'no access_token in response');
      const userRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${tokenBody.access_token}`, Accept: 'application/vnd.github+json' },
      });
      if (!userRes.ok) throw new Error(`GET /user failed: HTTP ${userRes.status}`);
      const user = (await userRes.json()) as {
        id: number;
        login: string;
        name?: string | null;
        email?: string | null;
        avatar_url?: string;
      };
      let email = user.email ?? undefined;
      if (!email) {
        const emailsRes = await fetch('https://api.github.com/user/emails', {
          headers: { Authorization: `Bearer ${tokenBody.access_token}`, Accept: 'application/vnd.github+json' },
        });
        if (emailsRes.ok) {
          const emails = (await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[];
          email = emails.find((candidate) => candidate.primary && candidate.verified)?.email;
        }
      }
      const identity: AuthIdentity = {
        provider: 'github',
        providerId: String(user.id),
        username: user.login,
        displayName: user.name || user.login,
        email,
        avatarUrl: user.avatar_url,
        source: 'oauth',
        updatedAt: new Date().toISOString(),
      };
      if (linkUserId) {
        const pending = createPendingOauthLink(linkUserId, identity);
        return reply.redirect(`/?link_review=${encodeURIComponent(pending.id)}`);
      }
      const profile = resolveOauthAccount({ fallbackUserId: oauthUserId('github', String(user.id), user.login), identity });
      const userId = profile.userId;
      const permissions = getUserEffectivePermissions(userId) ?? 0n;
      setFastifySessionCookie(reply, { sub: userId, permissions, mfaVerified: !mfaStatus(userId).enabled, reauthenticatedAt: Date.now() }, fastifySessionOptsFromRequest(request));
      log.info('github oauth login succeeded', { login: user.login, permissions: serializeBits(permissions) });
      return reply.redirect(oauthConnection?.returnTo ?? '/');
    } catch (error) {
      log.error('github oauth callback failed', { error: String(error) });
      return reply.redirect('/?auth_error=failed');
    }
  });

  server.get('/v1/auth/discord/login', { schema: getRouteContract('GET', '/v1/auth/discord/login') }, async (request, reply) => {
    startOAuthLogin(request, reply, 'discord');
  });

  server.get('/v1/auth/discord/connect', {
    schema: getRouteContract('GET', '/v1/auth/discord/connect'),
    preHandler: fastifyRequireSession,
  }, async (request, reply) => {
    const session = getFastifySession(request)!;
    if (session.sub === 'root') return sendValidationError(request, reply, 400, 'the root account cannot connect OAuth identities');
    startOAuthLogin(request, reply, 'discord', session.sub);
  });

  server.get<AuthOAuthCallbackRoute>('/v1/auth/discord/callback', {
    schema: getRouteContract('GET', '/v1/auth/discord/callback'),
  }, async (request, reply) => {
    if (!isDiscordOauthEnabled()) return reply.redirect('/?auth_error=discord_disabled');
    const code = request.query.code ?? '';
    const state = request.query.state ?? '';
    const cookieState = parseCookieHeader(request.headers.cookie)[oauthProviders.discord.stateCookieName];
    reply.header('Set-Cookie', oauthCookie(oauthProviders.discord.stateCookieName, '', 0));
    if (!code || !state || !cookieState || state !== cookieState) {
      log.warn('discord oauth state mismatch', { hasCode: !!code, hasState: !!state, hasCookieState: !!cookieState });
      return reply.redirect('/?auth_error=state_mismatch');
    }
    const oauthConnection = consumeOauthConnection('discord', state);
    const linkUserId = oauthConnection?.userId;
    try {
      const redirectUri = `${config.publicBaseUrl}/v1/auth/discord/callback`;
      const token = await exchangeDiscordCode(code, redirectUri, oauthConnection?.codeVerifier ?? '');
      if (!token.access_token) throw new Error(token.error ?? 'no access_token in response');
      const userRes = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      if (!userRes.ok) throw new Error(`GET /users/@me failed: HTTP ${userRes.status}`);
      const user = (await userRes.json()) as {
        id: string;
        username: string;
        global_name?: string | null;
        email?: string;
        avatar?: string | null;
      };
      const updatedAt = new Date().toISOString();
      const identity: AuthIdentity = {
        provider: 'discord',
        providerId: user.id,
        username: user.username,
        displayName: user.global_name || user.username,
        email: user.email,
        avatarUrl: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : undefined,
        source: 'oauth',
        updatedAt,
      };
      if (linkUserId) {
        const pending = createPendingOauthLink(linkUserId, identity);
        return reply.redirect(`/?link_review=${encodeURIComponent(pending.id)}`);
      }
      const profile = resolveOauthAccount({ fallbackUserId: oauthUserId('discord', user.id, `discord:${user.username}`), identity });
      const userId = profile.userId;
      const guildIds = getDiscordGuildIds();
      if (isDiscordBotEnabled() && guildIds.length > 0) {
        syncDiscordPerkRoles(userId, await Promise.all(guildIds.map(async (guildId) => ({ guildId, roleIds: await fetchMemberRoleIds(guildId, user.id) }))));
      }
      const permissions = getUserEffectivePermissions(userId) ?? 0n;
      setFastifySessionCookie(reply, { sub: userId, permissions, mfaVerified: !mfaStatus(userId).enabled, reauthenticatedAt: Date.now() }, fastifySessionOptsFromRequest(request));
      log.info('discord oauth login succeeded', { username: user.username, permissions: serializeBits(permissions) });
      return reply.redirect(oauthConnection?.returnTo ?? '/');
    } catch (error) {
      log.error('discord oauth callback failed', { error: String(error) });
      return reply.redirect('/?auth_error=discord_failed');
    }
  });
}
