import { expect, test } from 'bun:test';
import { formatSunsetHeader, validatePublicApiDeprecation } from '#publicApiLifecycle.js';

test('API deprecations enforce the published 180-day minimum notice period', () => {
  const deprecatedAt = Date.UTC(2026, 0, 1);
  const accepted = { method: 'GET', path: '/v1/jobs/:id', deprecatedAt, sunsetAt: new Date(deprecatedAt + 180 * 24 * 60 * 60 * 1000).toISOString(), migrationUrl: '/docs/api/migrate' };
  expect(() => validatePublicApiDeprecation(accepted)).not.toThrow();
  expect(() => validatePublicApiDeprecation({ ...accepted, sunsetAt: new Date(deprecatedAt + 179 * 24 * 60 * 60 * 1000).toISOString() })).toThrow('at least 180 days');
  expect(() => validatePublicApiDeprecation({ ...accepted, path: '/internal/job' })).toThrow('versioned HTTP operation');
});

test('Sunset response headers use the HTTP-date format', () => {
  expect(formatSunsetHeader('2026-07-01T00:00:00.000Z')).toBe('Wed, 01 Jul 2026 00:00:00 GMT');
  expect(() => formatSunsetHeader('invalid')).toThrow('valid date');
});
