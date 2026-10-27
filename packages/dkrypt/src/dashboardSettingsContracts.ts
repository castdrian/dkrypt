import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';
import { bundleIdSchema as BundleId, identifierSchema } from '#apiCommonContracts.js';
import { dashboardSettingsResponseSchema } from '#dashboardModelsContracts.js';

export const dashboardSettingsPatchBodySchema = Type.Object({
  notifyWebhookUrl: Type.Optional(Type.String({ maxLength: 2048 })),
  notifyOnKeyRequest: Type.Optional(Type.Boolean()),
  notifyOnAutomationSuccess: Type.Optional(Type.Boolean()),
  notifyOnAutomationFailure: Type.Optional(Type.Boolean()),
  notifyOnKeyExpiringSoon: Type.Optional(Type.Boolean()),
  notifyOnDeviceOffline: Type.Optional(Type.Boolean()),
  notifyOnDeviceBatteryHot: Type.Optional(Type.Boolean()),
  notifyOnDeviceBatteryLow: Type.Optional(Type.Boolean()),
  notifyOnDiskFull: Type.Optional(Type.Boolean()),
  notifyOnDeviceStorageLow: Type.Optional(Type.Boolean()),
  notifyOnTestFlightBridgeDown: Type.Optional(Type.Boolean()),
  notifyOnJobCompleted: Type.Optional(Type.Boolean()),
  notifyOnQueueSloBreach: Type.Optional(Type.Boolean()),
  maintenanceMode: Type.Optional(Type.Boolean()),
  notifyFormat: Type.Optional(Type.Union([Type.Literal('embed'), Type.Literal('plain')])),
  notifySuccessMode: Type.Optional(Type.Union([Type.Literal('instant'), Type.Literal('daily'), Type.Literal('weekly')])),
  notifyQuietHoursStart: Type.Optional(Type.String({ maxLength: 5, pattern: '^(?:|\\d{2}:\\d{2})$' })),
  notifyQuietHoursEnd: Type.Optional(Type.String({ maxLength: 5, pattern: '^(?:|\\d{2}:\\d{2})$' })),
  deviceOfflineAlertMinutes: Type.Optional(Type.Number()),
  batteryHotAlertC: Type.Optional(Type.Number()),
  batteryLowAlertPercent: Type.Optional(Type.Number()),
  diskFullAlertPercent: Type.Optional(Type.Number()),
  deviceStorageAlertPercent: Type.Optional(Type.Number()),
  testFlightBridgeAlertMinutes: Type.Optional(Type.Number()),
  jobHistoryRetentionDays: Type.Optional(Type.Number()),
}, { additionalProperties: true });

export const dashboardSettingsRetentionQuerySchema = Type.Object({
  retentionDays: Type.Integer({ minimum: 0 }),
}, { additionalProperties: true });

export const dashboardSettingsCronQuerySchema = Type.Object({
  expr: Type.Optional(Type.String({ maxLength: 100 })),
}, { additionalProperties: true });

export const dashboardSettingsWebhookTestBodySchema = Type.Object({
  url: Type.Optional(Type.String({ maxLength: 2048 })),
}, { additionalProperties: false });

export const dashboardArtifactRetentionQuerySchema = Type.Object({
  maxBytes: Type.Integer({ minimum: 1 }),
}, { additionalProperties: true });

export const dashboardArtifactStorageResponseSchema = Type.Object({
  count: Type.Integer({ minimum: 0 }),
  usedBytes: Type.Number({ minimum: 0 }),
  maxBytes: Type.Number({ minimum: 0 }),
}, { additionalProperties: true });

export const dashboardSettingsRetentionPreviewResponseSchema = Type.Object({
  retentionDays: Type.Integer({ minimum: 0 }),
  cutoff: Type.Optional(Type.Number()),
  currentEntries: Type.Integer({ minimum: 0 }),
  retained: Type.Integer({ minimum: 0 }),
  removed: Type.Integer({ minimum: 0 }),
  agePruned: Type.Integer({ minimum: 0 }),
  capacityPruned: Type.Integer({ minimum: 0 }),
  afterNextWrite: Type.Integer({ minimum: 0 }),
  maxEntries: Type.Integer({ minimum: 1 }),
  artifacts: Type.Object({
    retained: Type.Integer({ minimum: 0 }),
    retainedBytes: Type.Number({ minimum: 0 }),
    maxBytes: Type.Number({ minimum: 0 }),
    reclaimable: Type.Integer({ minimum: 0 }),
    reclaimableBytes: Type.Number({ minimum: 0 }),
  }, { additionalProperties: true }),
}, { additionalProperties: true });

export const dashboardArtifactRetentionPreviewResponseSchema = Type.Object({
  targetMaxBytes: Type.Integer({ minimum: 1 }),
  currentMaxBytes: Type.Number({ minimum: 0 }),
  currentCount: Type.Integer({ minimum: 0 }),
  currentBytes: Type.Number({ minimum: 0 }),
  retainedCount: Type.Integer({ minimum: 0 }),
  retainedBytes: Type.Number({ minimum: 0 }),
  evictedCount: Type.Integer({ minimum: 0 }),
  reclaimedBytes: Type.Number({ minimum: 0 }),
  pinnedCount: Type.Integer({ minimum: 0 }),
  pinnedBytes: Type.Number({ minimum: 0 }),
  remainingOverQuotaBytes: Type.Number({ minimum: 0 }),
  evictionExamples: Type.Array(Type.Object({
    id: identifierSchema,
    bundleId: BundleId,
    channel: Type.Union([Type.Literal('appstore'), Type.Literal('testflight')]),
    versionLabel: Type.Optional(Type.String()),
    fileSizeBytes: Type.Number({ minimum: 0 }),
    lastAccessedAt: Type.Number(),
  }, { additionalProperties: true })),
  additionalEvictions: Type.Integer({ minimum: 0 }),
}, { additionalProperties: true });

export const dashboardWebhookTestResponseSchema = Type.Object({
  ok: Type.Boolean(),
  error: Type.Optional(Type.String()),
  status: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
  durationMs: Type.Number({ minimum: 0 }),
  eventId: Type.Optional(Type.String()),
  targetHost: Type.Optional(Type.String()),
  signatureIncluded: Type.Optional(Type.Boolean()),
  signatureAcknowledged: Type.Optional(Type.Boolean()),
}, { additionalProperties: true });

export type DashboardSettingsGetRoute = {
  Reply: { 200: Static<typeof dashboardSettingsResponseSchema>; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope };
};

export type DashboardSettingsUpdateRoute = {
  Body: Static<typeof dashboardSettingsPatchBodySchema>;
  Reply: { 200: Static<typeof dashboardSettingsResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope };
};

export type DashboardSettingsRetentionPreviewRoute = {
  Querystring: Static<typeof dashboardSettingsRetentionQuerySchema>;
  Reply: { 200: Static<typeof dashboardSettingsRetentionPreviewResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope };
};

export type DashboardArtifactRetentionPreviewRoute = {
  Querystring: Static<typeof dashboardArtifactRetentionQuerySchema>;
  Reply: { 200: Static<typeof dashboardArtifactRetentionPreviewResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope };
};

export type DashboardArtifactStorageRoute = {
  Reply: { 200: Static<typeof dashboardArtifactStorageResponseSchema>; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope };
};

export type DashboardSettingsCronRoute = {
  Querystring: Static<typeof dashboardSettingsCronQuerySchema>;
  Reply: { 200: { valid: boolean }; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope };
};

export type DashboardSettingsWebhookTestRoute = {
  Body: Static<typeof dashboardSettingsWebhookTestBodySchema>;
  Reply: {
    200: Static<typeof dashboardWebhookTestResponseSchema>;
    400: Static<typeof dashboardWebhookTestResponseSchema> | ApiErrorEnvelope;
    401: ApiErrorEnvelope;
    403: ApiErrorEnvelope;
  };
};
