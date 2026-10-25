export interface PublicApiDeprecation {
  method: string;
  path: string;
  deprecatedAt: number;
  sunsetAt: string;
  migrationUrl: string;
}

export const publicApiDeprecations: PublicApiDeprecation[] = [];

export const publicApiLifecycle = {
  currentVersion: '1',
  policy: {
    compatibility: 'Additive changes remain within the current version; breaking changes receive a new compatibility version.',
    noticePeriodDays: 180,
    noticeHeaders: ['Deprecation', 'Sunset', 'Link'],
  },
  versions: [{ id: '1', status: 'current', documentation: '/reference' }],
  deprecations: publicApiDeprecations,
} as const;

export function validatePublicApiDeprecation(notice: PublicApiDeprecation, noticePeriodDays = publicApiLifecycle.policy.noticePeriodDays): void {
  const sunsetAt = Date.parse(notice.sunsetAt);
  const minimumNoticeMs = noticePeriodDays * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(notice.deprecatedAt) || !Number.isFinite(sunsetAt) || sunsetAt - notice.deprecatedAt < minimumNoticeMs) {
    throw new Error(`Public API deprecation for ${notice.method} ${notice.path} must provide at least ${noticePeriodDays} days of notice`);
  }
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(notice.method.toUpperCase()) || !notice.path.startsWith('/v1/')) {
    throw new Error('Public API deprecation must identify a versioned HTTP operation');
  }
}

export function formatSunsetHeader(sunsetAt: string): string {
  const timestamp = Date.parse(sunsetAt);
  if (!Number.isFinite(timestamp)) throw new Error('Public API sunset must be a valid date');
  return new Date(timestamp).toUTCString();
}

for (const notice of publicApiDeprecations) validatePublicApiDeprecation(notice);

export function findPublicApiDeprecation(method: string, path: string): PublicApiDeprecation | undefined {
  const normalizedPath = path.split('?', 1)[0].replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  return publicApiDeprecations.find((notice) => notice.method === method.toUpperCase() && notice.path === normalizedPath);
}
