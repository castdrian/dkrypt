import type { NextFunction, Request, Response } from '#http.js';
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';
import { getUserEffectivePermissions, isGeneratedApiKey, recordApiKeyOutcome, verifyApiKey, type ApiKeyAuthResult } from '#store/state.js';
import { hasPermission, PermissionFlag } from '#permissions.js';
import { isPublicApiKeyRoute } from '#publicApi.js';
import { authenticateGithubOidc } from '#githubOidc.js';
import { getBillingEntitlements } from '#billing.js';
import { setRateLimitHeaders, SlidingWindowRateLimiter } from '#util/rateLimit.js';

const fastifyApiKeyContext = new WeakMap<FastifyRequest, ApiKeyAuthResult>();
const fastifyApiKeyRequestStartedAt = new WeakMap<FastifyRequest, number>();
const accountApiRateLimiter = new SlidingWindowRateLimiter(60_000);

function permitAccountApiRequest(ownerId: string, request: FastifyRequest, reply: FastifyReply): boolean {
  const limit = getBillingEntitlements(ownerId).apiRatePerMinute;
  if (limit === undefined) return true;
  const decision = accountApiRateLimiter.consume(ownerId.toLowerCase(), limit);
  setRateLimitHeaders(reply, decision, 'account-api', accountApiRateLimiter.windowMs);
  if (decision.allowed) return true;
  reply.header('Retry-After', String(decision.retryAfterSeconds));
  reply.code(429).send({ error: 'account API rate limit exceeded', code: 'api_rate_limited', message: 'account API rate limit exceeded', requestId: request.id, retryable: true });
  return false;
}

export function getFastifyApiKeyContext(request: FastifyRequest): ApiKeyAuthResult | undefined {
  return fastifyApiKeyContext.get(request);
}

export function getAccountApiRateUsage(ownerId: string): { limit: number; used: number; remaining: number; resetAt: number } | undefined {
  const limit = getBillingEntitlements(ownerId).apiRatePerMinute;
  if (limit === undefined) return undefined;
  const usage = accountApiRateLimiter.inspect(ownerId.toLowerCase(), limit);
  return { limit, used: limit - usage.remaining, remaining: usage.remaining, resetAt: usage.resetAt };
}

function recordFastifyApiKeyOutcome(request: FastifyRequest, reply: FastifyReply, keyId: string, route: string): void {
  const startedAt = fastifyApiKeyRequestStartedAt.get(request);
  reply.raw.once('finish', () => recordApiKeyOutcome(
    keyId,
    request.method,
    route,
    reply.raw.statusCode,
    startedAt === undefined ? undefined : Math.max(0, performance.now() - startedAt),
  ));
}

function trackApiKeyOutcome(req: Request, res: Response, keyId: string | undefined): void {
  if (!keyId) return;
  res.raw.once('finish', () => recordApiKeyOutcome(keyId, req.method, req.path ?? req.url.split('?')[0], res.raw.statusCode));
}

function rejectOutOfScopeApiKey(request: FastifyRequest, reply: FastifyReply, keyId?: string): void {
  const route = request.routeOptions.url ?? request.url.split('?')[0];
  if (keyId) recordFastifyApiKeyOutcome(request, reply, keyId, route);
  const message = 'this API key is limited to decrypt and IPA artifact routes';
  reply.code(403).send({ error: message, code: 'public_api_scope_denied', message, requestId: request.id, retryable: false });
}

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  const result = scheme === 'Bearer' && token ? verifyApiKey(token, req.ip) : undefined;
  if (result === 'rate-limited') {
    res.error('api_key_rate_limited', 'this API key has hit its daily request limit', 429, true);
    return;
  }
  if (!result) {
    res.error('unauthorized', 'unauthorized', 401, false);
    return;
  }

  if (result.ownerId && result.ownerId !== 'root' && getBillingEntitlements(result.ownerId).freeTier) {
    res.error('free_api_unavailable', 'API access is available on paid plans', 403, false);
    return;
  }

  res.locals.apiKeyScope = result.allowedBundleIds;
  res.locals.apiKeyOwner = result.ownerId;
  res.locals.apiKeyPriority = result.priority ?? 0;
  res.locals.apiKeyId = result.keyId;
  res.locals.apiKeyAllowTestFlight = result.allowTestFlight ?? true;
  trackApiKeyOutcome(req, res, result.keyId);
  next();
}

export function fastifyRequireApiKey(request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void {
  fastifyApiKeyRequestStartedAt.set(request, performance.now());
  const header = request.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  const result = scheme === 'Bearer' && token ? verifyApiKey(token, request.ip) : undefined;
  if (result === 'rate-limited') {
    reply.code(429).send({
      error: 'this API key has hit its daily request limit',
      code: 'api_key_rate_limited',
      message: 'this API key has hit its daily request limit',
      requestId: request.id,
      retryable: true,
    });
    return;
  }
  if (!result) {
    if (scheme === 'Bearer' && token && token.split('.').length === 3 && isPublicApiKeyRoute(request.method, request.routeOptions.url)) {
      void authenticateGithubOidc(token).then((policy) => {
        if (!policy) {
          reply.code(401).send({ error: 'unauthorized', code: 'unauthorized', message: 'unauthorized', requestId: request.id, retryable: false });
          return;
        }
        const ownerId = policy.billingOwnerId ?? 'root';
        if (ownerId !== 'root' && getBillingEntitlements(ownerId).freeTier) {
          reply.code(403).send({ error: 'API access is available on paid plans', code: 'free_api_unavailable', message: 'API access is available on paid plans', requestId: request.id, retryable: false });
          return;
        }
        if (policy.billingOwnerId && ownerId !== 'root' && !hasPermission(getUserEffectivePermissions(ownerId), PermissionFlag.requestDecrypt)) {
          reply.code(403).send({ error: 'the automation owner no longer has decrypt access', code: 'automation_owner_unavailable', message: 'the automation owner no longer has decrypt access', requestId: request.id, retryable: false });
          return;
        }
        if (!permitAccountApiRequest(ownerId, request, reply)) return;
        fastifyApiKeyContext.set(request, { ownerId, projectId: policy.projectId, allowedBundleIds: policy.bundleIds, allowTestFlight: policy.allowTestFlight });
        done();
      }, () => {
        reply.code(401).send({ error: 'unauthorized', code: 'unauthorized', message: 'unauthorized', requestId: request.id, retryable: false });
      });
      return;
    }
    reply.code(401).send({ error: 'unauthorized', code: 'unauthorized', message: 'unauthorized', requestId: request.id, retryable: false });
    return;
  }
  const keyId = result.keyId;
  if (result.ownerId && result.ownerId !== 'root' && getBillingEntitlements(result.ownerId).freeTier) {
    reply.code(403).send({ error: 'API access is available on paid plans', code: 'free_api_unavailable', message: 'API access is available on paid plans', requestId: request.id, retryable: false });
    return;
  }
  if (keyId && !isPublicApiKeyRoute(request.method, request.routeOptions.url)) {
    rejectOutOfScopeApiKey(request, reply, keyId);
    return;
  }
  if (result.ownerId && !permitAccountApiRequest(result.ownerId, request, reply)) return;
  fastifyApiKeyContext.set(request, result);
  if (keyId) {
    recordFastifyApiKeyOutcome(request, reply, keyId, request.routeOptions.url ?? request.url.split('?')[0]);
  }
  done();
}

export function fastifyRejectGeneratedApiKeyOutsidePublicApi(request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void {
  const route = request.routeOptions.url;
  const header = request.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token || !route?.startsWith('/v1/') || isPublicApiKeyRoute(request.method, route) || !isGeneratedApiKey(token)) {
    done();
    return;
  }

  rejectOutOfScopeApiKey(request, reply);
}

export function fastifyRequireTestFlightScope(request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void {
  const apiKey = getFastifyApiKeyContext(request);
  if (!apiKey) {
    reply.code(401).send({ error: 'unauthorized', code: 'unauthorized', message: 'unauthorized', requestId: request.id, retryable: false });
    return;
  }
  if (apiKey.allowTestFlight === false) {
    reply.code(403).send({
      error: 'this API key is not scoped for TestFlight',
      code: 'testflight_scope_denied',
      message: 'this API key is not scoped for TestFlight',
      requestId: request.id,
      retryable: false,
    });
    return;
  }
  done();
}

export function requireTestFlightScope(_req: Request, res: Response, next: NextFunction): void {
  if (res.locals.apiKeyAllowTestFlight === false) {
    res.error('testflight_scope_denied', 'this API key is not scoped for TestFlight', 403, false);
    return;
  }
  next();
}
