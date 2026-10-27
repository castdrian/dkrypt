import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope, DashboardJobHistoryPage, DashboardJobSummary, DashboardJobTimeline } from '#contracts.js';
import { bundleIdSchema as BundleId, deviceTransportSchema, identifierSchema, paginationQueryProperties } from '#apiCommonContracts.js';
import type { BundleStats } from '#store/state.js';
import { jobFailureClassSchema } from '#util/failureCategory.js';

const JobStatus = Type.Union([Type.Literal('queued'), Type.Literal('running'), Type.Literal('done'), Type.Literal('failed')]);
const JsonObject = Type.Object({}, { additionalProperties: true });
export const dashboardJobTimelineEventSchema = Type.Object({ at: Type.Number(), label: Type.String(), status: JobStatus, durationMs: Type.Optional(Type.Number({ minimum: 0 })) }, { additionalProperties: true });
const TestFlightBuild = Type.Object({
  id: Type.Number(),
  cfBundleShortVersion: Type.String(),
  cfBundleVersion: Type.String(),
  bundleId: BundleId,
}, { additionalProperties: true });
export const dashboardJobIpaMetadataSchema = Type.Object({
  bundleVersion: Type.Optional(Type.String()),
  shortVersion: Type.Optional(Type.String()),
  minOsVersion: Type.Optional(Type.String()),
  executable: Type.Optional(Type.String()),
  architectures: Type.Optional(Type.Array(Type.String())),
  entitlementKeys: Type.Optional(Type.Array(Type.String())),
  embeddedFrameworks: Type.Optional(Type.Array(Type.String())),
  fileCount: Type.Optional(Type.Number()),
  compressedSizeBytes: Type.Optional(Type.Number()),
  uncompressedSizeBytes: Type.Optional(Type.Number()),
  codeSignaturePresent: Type.Optional(Type.Boolean()),
}, { additionalProperties: true });
export const dashboardJobExportEntrySchema = Type.Object({
  id: identifierSchema,
  correlationId: Type.Optional(identifierSchema),
  bundleId: BundleId,
  externalVersionId: Type.Optional(identifierSchema),
  testflight: Type.Optional(Type.Object({ appId: Type.Number(), build: TestFlightBuild }, { additionalProperties: true })),
  versionLabel: Type.Optional(Type.String()),
  minimumOsVersion: Type.Optional(Type.String()),
  queuedBy: Type.Optional(Type.String()),
  status: Type.Union([Type.Literal('done'), Type.Literal('failed')]),
  warnings: Type.Optional(Type.Array(Type.String())),
  error: Type.Optional(Type.String()),
  artifactId: Type.Optional(identifierSchema),
  sizeBytes: Type.Optional(Type.Number()),
  sha256: Type.Optional(Type.String()),
  source: Type.Union([Type.Literal('manual'), Type.Literal('scheduler')]),
  createdAt: Type.Number(),
  startedAt: Type.Optional(Type.Number()),
  finishedAt: Type.Number(),
  deviceId: Type.Optional(identifierSchema),
  transport: Type.Optional(deviceTransportSchema),
  executionPath: Type.Optional(Type.Union([Type.Literal('appstore_offline'), Type.Literal('device'), Type.Literal('device_fallback')])),
  offlineAttemptedAt: Type.Optional(Type.Number()),
  offlineAttemptDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
  offlineDeviceFallbackStartedAt: Type.Optional(Type.Number()),
  deviceFallbackDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
  offlineFailureReason: Type.Optional(Type.String()),
  offlineCompatibility: Type.Optional(Type.Object({ supported: Type.Boolean(), licenseFormat: Type.Union([Type.Literal('sinf'), Type.Literal('supf'), Type.Literal('unknown')]), architectures: Type.Array(Type.String()), reason: Type.Optional(Type.String()) }, { additionalProperties: false })),
  ipaMetadata: Type.Optional(dashboardJobIpaMetadataSchema),
  ipaInfoPlist: Type.Optional(JsonObject),
  timeline: Type.Optional(Type.Array(dashboardJobTimelineEventSchema)),
  attempt: Type.Optional(Type.Number()),
  retryCount: Type.Optional(Type.Number()),
  deadlineAt: Type.Optional(Type.Number()),
  deadlineExceeded: Type.Optional(Type.Boolean()),
  failureClass: Type.Optional(jobFailureClassSchema),
  queueReason: Type.Optional(Type.String()),
  pausedAt: Type.Optional(Type.Number()),
}, { additionalProperties: true });
export const dashboardJobExportQuerySchema = Type.Object({
  format: Type.Optional(Type.Union([
    Type.String({ description: 'Only csv selects CSV output; other values return JSON.' }),
    Type.Array(Type.String()),
  ])),
}, { additionalProperties: true });
export const dashboardJobExportResponseSchema = {
  content: {
    'application/json': { schema: Type.Array(dashboardJobExportEntrySchema) },
    'text/csv': { schema: Type.String() },
  },
};
export const dashboardJobBulkPreviewBodySchema = Type.Object({
  ids: Type.Optional(Type.Unknown({ description: 'Non-array input is treated as empty; array entries are filtered to strings, deduplicated, and capped at 100.' })),
}, { additionalProperties: true });
export const dashboardJobBulkPreviewResponseSchema = Type.Object({
  requested: Type.Integer({ minimum: 0 }),
  eligible: Type.Integer({ minimum: 0 }),
  projectedQueueAdds: Type.Integer({ minimum: 0 }),
  estimatedDurationMs: Type.Number({ minimum: 0 }),
  previousSizeBytes: Type.Number({ minimum: 0 }),
  items: Type.Array(Type.Object({
    id: identifierSchema,
    bundleId: BundleId,
    versionLabel: Type.Optional(Type.String()),
    status: Type.Union([Type.Literal('done'), Type.Literal('failed')]),
    action: Type.Union([Type.Literal('join-existing'), Type.Literal('queue')]),
    reason: Type.Optional(Type.String()),
    estimatedDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
  }, { additionalProperties: true })),
}, { additionalProperties: true });
export const dashboardJobDiffQuerySchema = Type.Object({
  bundleId: BundleId,
  a: identifierSchema,
  b: identifierSchema,
}, { additionalProperties: true });
const dashboardJobDiffVersionSchema = Type.Object({
  id: identifierSchema,
  versionLabel: Type.Optional(Type.String()),
  buildNumber: Type.Optional(Type.String()),
  releaseNotes: Type.Optional(Type.String()),
  channel: Type.Optional(Type.Union([Type.Literal('appstore'), Type.Literal('testflight')])),
  cacheHit: Type.Optional(Type.Boolean()),
  sizeBytes: Type.Optional(Type.Number()),
  finishedAt: Type.Number(),
  metadata: Type.Optional(dashboardJobIpaMetadataSchema),
}, { additionalProperties: true });
export const dashboardJobDiffResponseSchema = Type.Object({
  a: dashboardJobDiffVersionSchema,
  b: dashboardJobDiffVersionSchema,
  sizeDeltaBytes: Type.Number(),
  plistDiff: Type.Array(Type.Object({
    key: Type.String(),
    before: Type.Optional(Type.Unknown()),
    after: Type.Optional(Type.Unknown()),
  }, { additionalProperties: true })),
}, { additionalProperties: true });
export const dashboardJobAttemptDiffQuerySchema = Type.Object({
  a: identifierSchema,
  b: identifierSchema,
}, { additionalProperties: true });
const dashboardJobAttemptSnapshotSchema = Type.Object({
  id: identifierSchema,
  status: Type.Union([Type.Literal('done'), Type.Literal('failed')]),
  attempt: Type.Optional(Type.Number()),
  retryCount: Type.Optional(Type.Number()),
  startedAt: Type.Optional(Type.Number()),
  finishedAt: Type.Number(),
  durationMs: Type.Optional(Type.Number()),
  deviceId: Type.Optional(identifierSchema),
  transport: Type.Optional(deviceTransportSchema),
  executionPath: Type.Optional(Type.Union([Type.Literal('appstore_offline'), Type.Literal('device'), Type.Literal('device_fallback')])),
  offlineAttemptedAt: Type.Optional(Type.Number()),
  offlineAttemptDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
  offlineDeviceFallbackStartedAt: Type.Optional(Type.Number()),
  deviceFallbackDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
  offlineFailureReason: Type.Optional(Type.String()),
  offlineCompatibility: Type.Optional(Type.Object({ supported: Type.Boolean(), licenseFormat: Type.Union([Type.Literal('sinf'), Type.Literal('supf'), Type.Literal('unknown')]), architectures: Type.Array(Type.String()), reason: Type.Optional(Type.String()) }, { additionalProperties: false })),
  cacheHit: Type.Optional(Type.Boolean()),
  deadlineExceeded: Type.Optional(Type.Boolean()),
  error: Type.Optional(Type.String()),
  warnings: Type.Optional(Type.Array(Type.String())),
  artifactId: Type.Optional(identifierSchema),
}, { additionalProperties: true });
export const dashboardJobAttemptDiffResponseSchema = Type.Object({
  a: dashboardJobAttemptSnapshotSchema,
  b: dashboardJobAttemptSnapshotSchema,
  durationDeltaMs: Type.Number(),
  changedFields: Type.Array(Type.String()),
}, { additionalProperties: true });
const Requester = Type.Object({
  username: Type.Optional(Type.String()),
  displayName: Type.String(),
  avatarUrl: Type.Optional(Type.String()),
}, { additionalProperties: true });
const DashboardJobHistoryEntry = Type.Object({
  id: identifierSchema,
  correlationId: Type.Optional(identifierSchema),
  bundleId: BundleId,
  externalVersionId: Type.Optional(identifierSchema),
  testflight: Type.Optional(Type.Object({ appId: Type.Number(), build: TestFlightBuild }, { additionalProperties: true })),
  versionLabel: Type.Optional(Type.String()),
  queuedBy: Type.Optional(Type.String()),
  requester: Type.Optional(Requester),
  status: Type.Union([Type.Literal('done'), Type.Literal('failed')]),
  warnings: Type.Optional(Type.Array(Type.String())),
  error: Type.Optional(Type.String()),
  artifactId: Type.Optional(identifierSchema),
  sizeBytes: Type.Optional(Type.Number()),
  sha256: Type.Optional(Type.String()),
  source: Type.Union([Type.Literal('manual'), Type.Literal('scheduler')]),
  createdAt: Type.Number(),
  startedAt: Type.Optional(Type.Number()),
  finishedAt: Type.Number(),
  deviceId: Type.Optional(identifierSchema),
  transport: Type.Optional(deviceTransportSchema),
  executionPath: Type.Optional(Type.Union([Type.Literal('appstore_offline'), Type.Literal('device'), Type.Literal('device_fallback')])),
  offlineAttemptedAt: Type.Optional(Type.Number()),
  offlineAttemptDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
  offlineDeviceFallbackStartedAt: Type.Optional(Type.Number()),
  deviceFallbackDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
  offlineFailureReason: Type.Optional(Type.String()),
  offlineCompatibility: Type.Optional(Type.Object({ supported: Type.Boolean(), licenseFormat: Type.Union([Type.Literal('sinf'), Type.Literal('supf'), Type.Literal('unknown')]), architectures: Type.Array(Type.String()), reason: Type.Optional(Type.String()) }, { additionalProperties: false })),
  ipaMetadata: Type.Optional(dashboardJobIpaMetadataSchema),
  ipaInfoPlist: Type.Optional(JsonObject),
  timeline: Type.Optional(Type.Array(dashboardJobTimelineEventSchema)),
  attempt: Type.Optional(Type.Number()),
  retryCount: Type.Optional(Type.Number()),
  cacheHit: Type.Optional(Type.Boolean()),
  deadlineAt: Type.Optional(Type.Number()),
  deadlineExceeded: Type.Optional(Type.Boolean()),
  failureClass: Type.Optional(jobFailureClassSchema),
  queueReason: Type.Optional(Type.String()),
  downloadUrl: Type.Optional(Type.String()),
  fileAvailable: Type.Boolean(),
}, { additionalProperties: true });

export const dashboardJobListQuerySchema = Type.Object({
  ...paginationQueryProperties,
  q: Type.Optional(Type.String({ maxLength: 200 })),
  source: Type.Optional(Type.Union([Type.Literal('manual'), Type.Literal('scheduler')])),
  status: Type.Optional(Type.Union([Type.Literal('done'), Type.Literal('failed')])),
  queuedBy: Type.Optional(Type.String({ maxLength: 120 })),
  deviceId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  errorQ: Type.Optional(Type.String({ maxLength: 200 })),
  failureCategory: Type.Optional(Type.String({ maxLength: 64 })),
  fromTs: Type.Optional(Type.Integer()),
  toTs: Type.Optional(Type.Integer()),
}, { additionalProperties: true });

export const dashboardJobParamsSchema = Type.Object({ id: identifierSchema }, { additionalProperties: true });
export const dashboardJobBundleParamsSchema = Type.Object({ bundleId: BundleId }, { additionalProperties: true });
export const dashboardJobProjectQuerySchema = Type.Object({}, { additionalProperties: true });
export const dashboardJobEtaResponseSchema = Type.Object({ avgMs: Type.Union([Type.Number(), Type.Null()]), p50Ms: Type.Union([Type.Number(), Type.Null()]), p95Ms: Type.Union([Type.Number(), Type.Null()]), sampleCount: Type.Integer({ minimum: 0 }), confidence: Type.Union([Type.Literal('none'), Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]) }, { additionalProperties: true });
export const dashboardJobBundleStatsResponseSchema = Type.Object({
  bundleId: BundleId,
  totalRuns: Type.Integer({ minimum: 0 }),
  doneCount: Type.Integer({ minimum: 0 }),
  failedCount: Type.Integer({ minimum: 0 }),
  successRate: Type.Number({ minimum: 0, maximum: 1 }),
  avgDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
  lastRunAt: Type.Optional(Type.Number()),
  failureBreakdown: Type.Array(Type.Object({ category: Type.String(), count: Type.Integer({ minimum: 0 }) })),
}, { additionalProperties: true });
export const dashboardJobVolumeQuerySchema = Type.Object({
  days: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })),
}, { additionalProperties: true });
export const dashboardJobDailyVolumeResponseSchema = Type.Object({
  days: Type.Array(Type.Object({ date: Type.String(), count: Type.Integer({ minimum: 0 }) })),
}, { additionalProperties: true });
export const dashboardJobSloResponseSchema = Type.Object({
  targetMs: Type.Number(),
  historicalP95Ms: Type.Union([Type.Number(), Type.Null()]),
  jobs: Type.Array(Type.Object({
    id: identifierSchema,
    bundleId: BundleId,
    status: JobStatus,
    waitedMs: Type.Number(),
    predictedStartMs: Type.Union([Type.Number(), Type.Null()]),
    predictedCompletionMs: Type.Union([Type.Number(), Type.Null()]),
    parallelism: Type.Integer({ minimum: 0 }),
    objective: Type.Union([Type.Literal('within'), Type.Literal('breached')]),
  }, { additionalProperties: true })),
}, { additionalProperties: true });
export const dashboardJobActionResponseSchema = Type.Object({ ok: Type.Boolean() }, { additionalProperties: true });
export const dashboardJobResolutionNoticeResponseSchema = Type.Object({
  requester: Type.String(),
  emailAvailable: Type.Boolean(),
  message: Type.String(),
  notice: Type.Optional(Type.Object({
    sentAt: Type.Number(),
    sentBy: Type.String(),
    emailStatus: Type.Union([Type.Literal('pending'), Type.Literal('sent'), Type.Literal('unavailable'), Type.Literal('failed')]),
  })),
});
export const dashboardManualDecryptBodySchema = Type.Object({
  bundleId: BundleId,
  externalVersionId: Type.Optional(identifierSchema),
  versionLabel: Type.Optional(Type.String({ maxLength: 64 })),
  minimumOsVersion: Type.Optional(Type.String({ maxLength: 32, pattern: '^\\d+(?:\\.\\d+){0,3}$' })),
  preferPrimary: Type.Optional(Type.Boolean()),
}, { additionalProperties: true });
export const dashboardManualDecryptPreflightBodySchema = Type.Object({
  bundleId: BundleId,
  testflight: Type.Optional(Type.Boolean()),
  versionLabel: Type.Optional(Type.String({ maxLength: 64 })),
  installSizeBytes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  deviceId: Type.Optional(identifierSchema),
}, { additionalProperties: true });
const dashboardManualDecryptPreflightReadinessSchema = Type.Object({
  score: Type.Number({ minimum: 0, maximum: 100 }),
  state: Type.Union([Type.Literal('ready'), Type.Literal('caution'), Type.Literal('blocked')]),
  reasons: Type.Array(Type.String()),
}, { additionalProperties: true });
const dashboardManualDecryptPreflightDeviceSchema = Type.Object({
  id: identifierSchema,
  name: Type.String(),
  isPrimary: Type.Boolean(),
  ready: Type.Boolean(),
  checking: Type.Optional(Type.Boolean()),
  blockers: Type.Array(Type.String()),
  warnings: Type.Optional(Type.Array(Type.String())),
  readiness: Type.Optional(dashboardManualDecryptPreflightReadinessSchema),
  reachable: Type.Optional(Type.Boolean()),
  storageFreeBytes: Type.Optional(Type.Number({ minimum: 0 })),
  batteryPercent: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
}, { additionalProperties: true });
export const dashboardManualDecryptPreflightResponseSchema = Type.Object({
  bundleId: BundleId,
  versionLabel: Type.Optional(Type.String()),
  testflight: Type.Boolean(),
  installSizeBytes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  estimatedDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
  queueLength: Type.Optional(Type.Integer({ minimum: 0 })),
  canQueue: Type.Boolean(),
  quota: Type.Optional(Type.Object({ limit: Type.Union([Type.Number(), Type.Null()]), used: Type.Number(), remaining: Type.Union([Type.Number(), Type.Null()]), nextAvailableAt: Type.Optional(Type.Number()), windowMs: Type.Optional(Type.Number()), freeTier: Type.Optional(Type.Boolean()), legacy: Type.Optional(Type.Boolean()), apiRatePerMinute: Type.Optional(Type.Number()) }, { additionalProperties: false })),
  devices: Type.Array(dashboardManualDecryptPreflightDeviceSchema),
}, { additionalProperties: true });
export const dashboardJobReorderBodySchema = Type.Object({
  ids: Type.Array(identifierSchema, { maxItems: 100 }),
}, { additionalProperties: true });
export const dashboardJobRetryBodySchema = Type.Object({ preferPrimary: Type.Optional(Type.Boolean()) }, { additionalProperties: true });
export const dashboardJobDiagnosticJobSchema = Type.Object({
  id: identifierSchema,
  correlationId: Type.Optional(identifierSchema),
  bundleId: BundleId,
  externalVersionId: Type.Optional(identifierSchema),
  testflight: Type.Optional(Type.Object({ appId: Type.Number(), build: TestFlightBuild }, { additionalProperties: false })),
  versionLabel: Type.Optional(Type.String()),
  source: Type.Union([Type.Literal('manual'), Type.Literal('scheduler')]),
  queuedBy: Type.Optional(Type.String()),
  apiKeyId: Type.Optional(identifierSchema),
  preferredDeviceId: Type.Optional(identifierSchema),
  priority: Type.Optional(Type.Number()),
  status: JobStatus,
  progress: Type.Optional(Type.String()),
  timeline: Type.Optional(Type.Array(dashboardJobTimelineEventSchema)),
  warnings: Type.Optional(Type.Array(Type.String())),
  error: Type.Optional(Type.String()),
  retryCount: Type.Optional(Type.Number()),
  attempt: Type.Optional(Type.Number()),
  deadlineAt: Type.Optional(Type.Number()),
  deadlineExceeded: Type.Optional(Type.Boolean()),
  failureClass: Type.Optional(jobFailureClassSchema),
  queueReason: Type.Optional(Type.String()),
  cancelledBy: Type.Optional(Type.String()),
  artifactId: Type.Optional(identifierSchema),
  cacheHit: Type.Optional(Type.Boolean()),
  fileSizeBytes: Type.Optional(Type.Number()),
  sizeBytes: Type.Optional(Type.Number()),
  sha256: Type.Optional(Type.String()),
  deviceId: Type.Optional(identifierSchema),
  transport: Type.Optional(deviceTransportSchema),
  executionPath: Type.Optional(Type.Union([Type.Literal('appstore_offline'), Type.Literal('device'), Type.Literal('device_fallback')])),
  offlineAttemptedAt: Type.Optional(Type.Number()),
  offlineAttemptDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
  offlineDeviceFallbackStartedAt: Type.Optional(Type.Number()),
  deviceFallbackDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
  offlineFailureReason: Type.Optional(Type.String()),
  offlineCompatibility: Type.Optional(Type.Object({ supported: Type.Boolean(), licenseFormat: Type.Union([Type.Literal('sinf'), Type.Literal('supf'), Type.Literal('unknown')]), architectures: Type.Array(Type.String()), reason: Type.Optional(Type.String()) }, { additionalProperties: false })),
  ipaMetadata: Type.Optional(dashboardJobIpaMetadataSchema),
  ipaInfoPlist: Type.Optional(JsonObject),
  createdAt: Type.Number(),
  startedAt: Type.Optional(Type.Number()),
  finishedAt: Type.Optional(Type.Number()),
  downloadedAt: Type.Optional(Type.Number()),
}, { additionalProperties: false });
export const dashboardJobDiagnosticResponseSchema = Type.Object({
  generatedAt: Type.String(),
  correlationId: identifierSchema,
  job: dashboardJobDiagnosticJobSchema,
  timeline: Type.Array(dashboardJobTimelineEventSchema),
}, { additionalProperties: true });

export const dashboardJobHistoryPageSchema = Type.Object({
  history: Type.Array(DashboardJobHistoryEntry),
  total: Type.Integer({ minimum: 0 }),
  nextCursor: Type.Optional(Type.String()),
}, { additionalProperties: true });

export type DashboardJobListRoute = {
  Querystring: Static<typeof dashboardJobListQuerySchema>;
  Reply: { 200: DashboardJobHistoryPage; 404: ApiErrorEnvelope };
};

export type DashboardJobStatusRoute = {
  Params: Static<typeof dashboardJobParamsSchema>;
  Reply: { 200: DashboardJobSummary; 404: ApiErrorEnvelope };
};

export type DashboardJobTimelineRoute = {
  Params: Static<typeof dashboardJobParamsSchema>;
  Reply: { 200: DashboardJobTimeline; 404: ApiErrorEnvelope };
};

export type DashboardJobEtaRoute = {
  Params: Static<typeof dashboardJobBundleParamsSchema>;
  Querystring: Static<typeof dashboardJobProjectQuerySchema>;
  Reply: { 200: Static<typeof dashboardJobEtaResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 404: ApiErrorEnvelope; 429: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardJobStatsRoute = {
  Params: Static<typeof dashboardJobBundleParamsSchema>;
  Querystring: Static<typeof dashboardJobProjectQuerySchema>;
  Reply: { 200: BundleStats; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 404: ApiErrorEnvelope; 429: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardJobVolumeRoute = {
  Querystring: Static<typeof dashboardJobVolumeQuerySchema>;
  Reply: { 200: Static<typeof dashboardJobDailyVolumeResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 404: ApiErrorEnvelope; 429: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardJobSloRoute = {
  Querystring: Static<typeof dashboardJobProjectQuerySchema>;
  Reply: { 200: Static<typeof dashboardJobSloResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope; 429: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardJobHistoryExportRoute = {
  Querystring: Static<typeof dashboardJobExportQuerySchema>;
  Reply: { 200: Array<Static<typeof dashboardJobExportEntrySchema>> | string; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 404: ApiErrorEnvelope; 429: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardJobBulkPreviewRoute = {
  Body: Static<typeof dashboardJobBulkPreviewBodySchema>;
  Reply: { 200: Static<typeof dashboardJobBulkPreviewResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope; 429: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardJobDiffRoute = {
  Querystring: Static<typeof dashboardJobDiffQuerySchema>;
  Reply: { 200: Static<typeof dashboardJobDiffResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 404: ApiErrorEnvelope; 429: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};
export type DashboardJobAttemptDiffRoute = {
  Querystring: Static<typeof dashboardJobAttemptDiffQuerySchema>;
  Reply: { 200: Static<typeof dashboardJobAttemptDiffResponseSchema>; 400: ApiErrorEnvelope; 404: ApiErrorEnvelope };
};

type ActionErrors = { 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope; 429: ApiErrorEnvelope; 500: ApiErrorEnvelope };

export type DashboardJobCancelRoute = {
  Params: Static<typeof dashboardJobParamsSchema>;
  Reply: { 200: Static<typeof dashboardJobActionResponseSchema>; 409: ApiErrorEnvelope } & ActionErrors;
};

export type DashboardManualDecryptRoute = {
  Body: Static<typeof dashboardManualDecryptBodySchema>;
  Reply: { 202: DashboardJobSummary; 409: ApiErrorEnvelope; 503: ApiErrorEnvelope } & Pick<ActionErrors, 400 | 401 | 403 | 404 | 429 | 500>;
};

export type DashboardManualDecryptPreflightRoute = {
  Body: Static<typeof dashboardManualDecryptPreflightBodySchema>;
  Reply: {
    200: Static<typeof dashboardManualDecryptPreflightResponseSchema>;
    400: ApiErrorEnvelope;
    401: ApiErrorEnvelope;
    403: ApiErrorEnvelope;
    404: ApiErrorEnvelope;
    409: ApiErrorEnvelope;
    429: ApiErrorEnvelope;
    500: ApiErrorEnvelope;
    503: ApiErrorEnvelope;
  };
};

export type DashboardJobPrioritizeRoute = DashboardJobCancelRoute;

export type DashboardJobReorderRoute = {
  Body: Static<typeof dashboardJobReorderBodySchema>;
  Reply: { 200: Static<typeof dashboardJobActionResponseSchema>; 404: ApiErrorEnvelope } & Pick<ActionErrors, 400 | 401 | 403 | 429 | 500>;
};

export type DashboardJobRetryRoute = {
  Params: Static<typeof dashboardJobParamsSchema>;
  Body: Static<typeof dashboardJobRetryBodySchema>;
  Reply: { 202: DashboardJobSummary; 409: ApiErrorEnvelope; 503: ApiErrorEnvelope } & Pick<ActionErrors, 400 | 401 | 403 | 404 | 429 | 500>;
};

export type DashboardJobDiagnosticRoute = {
  Params: Static<typeof dashboardJobParamsSchema>;
  Reply: { 200: Static<typeof dashboardJobDiagnosticResponseSchema>; 404: ApiErrorEnvelope } & Pick<ActionErrors, 400 | 401 | 403 | 429 | 500>;
};

export type DashboardJobResolutionNoticeRoute = {
  Params: Static<typeof dashboardJobParamsSchema>;
  Reply: { 200: Static<typeof dashboardJobResolutionNoticeResponseSchema>; 409: ApiErrorEnvelope } & ActionErrors;
};
