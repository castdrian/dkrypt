import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { fastifyRateLimitPerUser, FixedWindowRateLimiter, SlidingWindowRateLimiter } from '#util/rateLimit.js';

test('sliding account limit cannot be bypassed by using another key', () => {
  const limiter = new SlidingWindowRateLimiter(60_000);
  expect(limiter.consume('owner', 2, 1_000).allowed).toBe(true);
  expect(limiter.consume('owner', 2, 2_000).allowed).toBe(true);
  expect(limiter.consume('owner', 2, 3_000)).toMatchObject({ allowed: false, retryAfterSeconds: 58 });
  expect(limiter.consume('owner', 2, 61_001).allowed).toBe(true);
});

test('fixed-window rate limiter exposes bounded retry metadata', () => {
  const limiter = new FixedWindowRateLimiter(2, 60_000);
  expect(limiter.consume('client', 1_000)).toMatchObject({ allowed: true, remaining: 1, resetAt: 61_000 });
  expect(limiter.consume('client', 2_000)).toMatchObject({ allowed: true, remaining: 0, resetAt: 61_000 });
  expect(limiter.consume('client', 3_000)).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 58, resetAt: 61_000 });
  expect(limiter.consume('client', 61_001)).toMatchObject({ allowed: true, remaining: 1, resetAt: 121_001 });
});

test('sliding-window inspection reports current API usage without consuming a request', () => {
  const limiter = new SlidingWindowRateLimiter(60_000);
  expect(limiter.consume('account', 4, 10_000).remaining).toBe(3);
  expect(limiter.consume('account', 4, 20_000).remaining).toBe(2);
  expect(limiter.inspect('account', 4, 30_000)).toEqual({
    allowed: true,
    limit: 4,
    remaining: 2,
    resetAt: 70_000,
    retryAfterSeconds: 0,
  });
  expect(limiter.consume('account', 4, 30_001).remaining).toBe(1);
});

test('Fastify rate limiting preserves the default dashboard error envelope', async () => {
  const server = Fastify();
  const limiter = new FixedWindowRateLimiter(1, 60_000);
  server.get('/limited', { preHandler: fastifyRateLimitPerUser(limiter, (request) => request.ip) }, async () => ({ ok: true }));

  try {
    expect((await server.inject({ method: 'GET', url: '/limited' })).statusCode).toBe(200);
    const response = await server.inject({ method: 'GET', url: '/limited' });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: 'request_error', retryable: false });
  } finally {
    await server.close();
  }
});
