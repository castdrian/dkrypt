import type { NextFunction, Request, Response } from '#http.js';
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';

interface Bucket {
  count: number;
  windowStartedAt: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export function setRateLimitHeaders(
  reply: FastifyReply,
  decision: RateLimitDecision,
  policyId: 'shared-api' | 'account-api' | 'request-api',
  windowMs: number,
  now = Date.now(),
): void {
  reply.header('X-RateLimit-Limit', String(decision.limit));
  reply.header('X-RateLimit-Remaining', String(decision.remaining));
  reply.header('X-RateLimit-Reset', String(Math.ceil(decision.resetAt / 1000)));
  const policy = `${JSON.stringify(policyId)};q=${decision.limit};w=${Math.max(1, Math.ceil(windowMs / 1000))}`;
  const rate = `${JSON.stringify(policyId)};r=${decision.remaining};t=${Math.max(0, Math.ceil((decision.resetAt - now) / 1000))}`;
  reply.header('RateLimit-Policy', appendHeaderValue(reply.getHeader('RateLimit-Policy'), policy));
  reply.header('RateLimit', appendHeaderValue(reply.getHeader('RateLimit'), rate));
}

function appendHeaderValue(existing: number | string | string[] | undefined, value: string): string {
  if (existing === undefined) return value;
  return `${Array.isArray(existing) ? existing.join(', ') : String(existing)}, ${value}`;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(readonly maxRequests: number, readonly windowMs: number) {
    setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.buckets) {
        if (now - bucket.windowStartedAt > this.windowMs) this.buckets.delete(key);
      }
    }, windowMs).unref();
  }

  consume(key: string, now = Date.now()): RateLimitDecision {
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStartedAt > this.windowMs) {
      this.buckets.set(key, { count: 1, windowStartedAt: now });
      return { allowed: true, limit: this.maxRequests, remaining: Math.max(0, this.maxRequests - 1), resetAt: now + this.windowMs, retryAfterSeconds: 0 };
    }
    if (bucket.count >= this.maxRequests) {
      return {
        allowed: false,
        limit: this.maxRequests,
        remaining: 0,
        resetAt: bucket.windowStartedAt + this.windowMs,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStartedAt + this.windowMs - now) / 1000)),
      };
    }
    bucket.count += 1;
    return {
      allowed: true,
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - bucket.count),
      resetAt: bucket.windowStartedAt + this.windowMs,
      retryAfterSeconds: 0,
    };
  }
}

export class SlidingWindowRateLimiter {
  private readonly requests = new Map<string, number[]>();

  constructor(readonly windowMs: number) {
    setInterval(() => this.removeExpiredRequests(Date.now()), windowMs).unref();
  }

  private removeExpiredRequests(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.requests) {
      const active = timestamps.filter((timestamp) => timestamp > cutoff);
      if (active.length > 0) this.requests.set(key, active);
      else this.requests.delete(key);
    }
  }

  consume(key: string, limit: number, now = Date.now()): RateLimitDecision {
    const previous = this.requests.get(key) ?? [];
    const active = previous.filter((timestamp) => timestamp > now - this.windowMs);
    const allowed = active.length < limit;
    if (allowed) active.push(now);
    if (active.length > 0) this.requests.set(key, active);
    else this.requests.delete(key);
    const resetAt = (active[0] ?? now) + this.windowMs;
    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - active.length),
      resetAt,
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  }

  inspect(key: string, limit: number, now = Date.now()): RateLimitDecision {
    const active = (this.requests.get(key) ?? []).filter((timestamp) => timestamp > now - this.windowMs);
    const resetAt = (active[0] ?? now) + this.windowMs;
    const remaining = Math.max(0, limit - active.length);
    return {
      allowed: remaining > 0,
      limit,
      remaining,
      resetAt,
      retryAfterSeconds: remaining > 0 ? 0 : Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  }
}

export const externalRequestRateLimiter = new FixedWindowRateLimiter(10, 60_000);

export function fastifyRateLimitPerUser(
  limiter: FixedWindowRateLimiter,
  getKey: (request: FastifyRequest) => string,
  errorResponse: { code: string; retryable: boolean } = { code: 'request_error', retryable: false },
) {
  return (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void => {
    const decision = limiter.consume(getKey(request));
    setRateLimitHeaders(reply, decision, 'request-api', limiter.windowMs);
    if (!decision.allowed) {
      reply.header('Retry-After', String(decision.retryAfterSeconds));
      const message = `too many requests - try again in ${decision.retryAfterSeconds}s`;
      reply.code(429).send({ error: message, ...errorResponse, message, requestId: request.id });
      return;
    }
    done();
  };
}

export function rateLimitPerUser(
  maxRequests: number,
  windowMs: number,
  limiter = new FixedWindowRateLimiter(maxRequests, windowMs),
) {
  function setHeaders(res: Response, remaining: number, windowStartedAt: number): void {
    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, remaining)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil((windowStartedAt + windowMs) / 1000)));
    const rate = `"request-api";r=${Math.max(0, remaining)};t=${Math.max(0, Math.ceil((windowStartedAt + windowMs - Date.now()) / 1000))}`;
    res.setHeader('RateLimit-Policy', `"request-api";q=${maxRequests};w=${Math.max(1, Math.ceil(windowMs / 1000))}`);
    res.setHeader('RateLimit', rate);
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = res.locals.session?.sub ?? req.ip ?? 'unknown';
    const decision = limiter.consume(key);
    setHeaders(res, decision.remaining, decision.resetAt - windowMs);
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      res.error('rate_limited', `too many requests - try again in ${decision.retryAfterSeconds}s`, 429, true);
      return;
    }
    next();
  };
}
