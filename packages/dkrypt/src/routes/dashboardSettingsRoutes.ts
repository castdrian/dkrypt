import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { validate as validateCronExpr } from 'node-cron';
import type {
  DashboardArtifactRetentionPreviewRoute,
  DashboardArtifactStorageRoute,
  DashboardSettingsCronRoute,
  DashboardSettingsGetRoute,
  DashboardSettingsRetentionPreviewRoute,
  DashboardSettingsUpdateRoute,
  DashboardSettingsWebhookTestRoute,
} from '#dashboardSettingsContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { getArtifactStorageStats, previewArtifactQuotaRetention } from '#artifacts.js';
import { getRouteContract } from '#contracts.js';
import { sendTestNotification } from '#notify.js';
import { PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import { getEffectiveSettings, previewJobHistoryRetention, updateSettings, type DashboardSettings } from '#store/state.js';
import { sendHttpErrorEnvelope } from '#util/httpResponse.js';
import { validatePublicWebhookEndpoint } from '#util/webhookEndpoint.js';

const canViewSettings = fastifyRequirePermission(PermissionFlag.viewAutomation, PermissionFlag.manageAutomation);
const canManageAutomation = fastifyRequirePermission(PermissionFlag.manageAutomation);
const canManageSettings = canManageAutomation;
const canManageRetention = [
  canManageAutomation,
  fastifyRequirePermission(PermissionFlag.requestDecrypt),
];
const canTestWebhook = fastifyRequirePermission(PermissionFlag.manageAutomation);

const minDeviceOfflineAlertMinutes = 5;
const maxDeviceOfflineAlertMinutes = 180;
const minBatteryHotAlertC = 30;
const maxBatteryHotAlertC = 60;
const minBatteryLowAlertPercent = 5;
const maxBatteryLowAlertPercent = 50;
const minDiskFullAlertPercent = 50;
const maxDiskFullAlertPercent = 99;
const minDeviceStorageAlertPercent = 50;
const maxDeviceStorageAlertPercent = 99;
const minTestFlightBridgeAlertMinutes = 5;
const maxTestFlightBridgeAlertMinutes = 180;
const maxJobHistoryRetentionDays = 365;

function clampRounded(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

export const dashboardSettingsRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get<DashboardSettingsGetRoute>('/v1/dashboard/settings', {
    schema: getRouteContract('GET', '/v1/dashboard/settings'),
    preHandler: canViewSettings,
  }, () => getEffectiveSettings());

  server.put<DashboardSettingsUpdateRoute>('/v1/dashboard/settings', {
    schema: getRouteContract('PUT', '/v1/dashboard/settings'),
    attachValidation: true,
    preHandler: canManageSettings,
  }, (request, reply) => {
    if (request.validationError && request.body !== undefined) {
      sendHttpErrorEnvelope(reply, request.id, 400, 'settings update is malformed');
      return;
    }
    const body = request.body ?? {};
    const patch: Partial<DashboardSettings> = {};

    if (typeof body.notifyWebhookUrl === 'string') patch.notifyWebhookUrl = body.notifyWebhookUrl.trim();
    const booleanFields: Array<keyof DashboardSettings> = [
      'notifyOnKeyRequest',
      'notifyOnAutomationSuccess',
      'notifyOnAutomationFailure',
      'notifyOnKeyExpiringSoon',
      'notifyOnDeviceOffline',
      'notifyOnDeviceBatteryHot',
      'notifyOnDeviceBatteryLow',
      'notifyOnDiskFull',
      'notifyOnDeviceStorageLow',
      'notifyOnTestFlightBridgeDown',
      'notifyOnJobCompleted',
      'notifyOnQueueSloBreach',
      'maintenanceMode',
    ];
    for (const field of booleanFields) {
      const value = body[field];
      if (typeof value === 'boolean') Object.assign(patch, { [field]: value });
    }

    if (body.notifyFormat === 'embed' || body.notifyFormat === 'plain') patch.notifyFormat = body.notifyFormat;
    if (body.notifySuccessMode === 'instant' || body.notifySuccessMode === 'daily' || body.notifySuccessMode === 'weekly') {
      patch.notifySuccessMode = body.notifySuccessMode;
    }
    if (typeof body.notifyQuietHoursStart === 'string') patch.notifyQuietHoursStart = body.notifyQuietHoursStart;
    if (typeof body.notifyQuietHoursEnd === 'string') patch.notifyQuietHoursEnd = body.notifyQuietHoursEnd;
    if (typeof body.deviceOfflineAlertMinutes === 'number') {
      patch.deviceOfflineAlertMinutes = clampRounded(body.deviceOfflineAlertMinutes, minDeviceOfflineAlertMinutes, maxDeviceOfflineAlertMinutes);
    }
    if (typeof body.batteryHotAlertC === 'number') {
      patch.batteryHotAlertC = clampRounded(body.batteryHotAlertC, minBatteryHotAlertC, maxBatteryHotAlertC);
    }
    if (typeof body.batteryLowAlertPercent === 'number') {
      patch.batteryLowAlertPercent = clampRounded(body.batteryLowAlertPercent, minBatteryLowAlertPercent, maxBatteryLowAlertPercent);
    }
    if (typeof body.diskFullAlertPercent === 'number') {
      patch.diskFullAlertPercent = clampRounded(body.diskFullAlertPercent, minDiskFullAlertPercent, maxDiskFullAlertPercent);
    }
    if (typeof body.deviceStorageAlertPercent === 'number') {
      patch.deviceStorageAlertPercent = clampRounded(body.deviceStorageAlertPercent, minDeviceStorageAlertPercent, maxDeviceStorageAlertPercent);
    }
    if (typeof body.testFlightBridgeAlertMinutes === 'number') {
      patch.testFlightBridgeAlertMinutes = clampRounded(body.testFlightBridgeAlertMinutes, minTestFlightBridgeAlertMinutes, maxTestFlightBridgeAlertMinutes);
    }
    if (typeof body.jobHistoryRetentionDays === 'number') {
      patch.jobHistoryRetentionDays = clampRounded(body.jobHistoryRetentionDays, 0, maxJobHistoryRetentionDays);
    }

    return updateSettings(patch, getFastifySession(request)!.sub);
  });

  server.get<DashboardSettingsRetentionPreviewRoute>('/v1/dashboard/settings/job-history-retention/preview', {
    schema: getRouteContract('GET', '/v1/dashboard/settings/job-history-retention/preview'),
    preHandler: canManageSettings,
  }, (request) => {
    const now = Date.now();
    const storage = getArtifactStorageStats();
    return {
      ...previewJobHistoryRetention(request.query.retentionDays, now),
      artifacts: {
        retained: storage.count,
        retainedBytes: storage.usedBytes,
        maxBytes: storage.maxBytes,
        reclaimable: 0,
        reclaimableBytes: 0,
      },
    };
  });

  server.get<DashboardArtifactRetentionPreviewRoute>('/v1/dashboard/artifacts/retention-preview', {
    schema: getRouteContract('GET', '/v1/dashboard/artifacts/retention-preview'),
    preHandler: canManageRetention,
  }, (request) => previewArtifactQuotaRetention(request.query.maxBytes));

  server.get<DashboardArtifactStorageRoute>('/v1/dashboard/settings/artifact-storage', {
    schema: getRouteContract('GET', '/v1/dashboard/settings/artifact-storage'),
    preHandler: canManageRetention,
  }, () => getArtifactStorageStats());

  server.get<DashboardSettingsCronRoute>('/v1/dashboard/settings/validate-cron', {
    schema: getRouteContract('GET', '/v1/dashboard/settings/validate-cron'),
    preHandler: canManageAutomation,
  }, (request) => {
    const expression = request.query.expr ?? '';
    return { valid: expression !== '' && validateCronExpr(expression) };
  });

  server.post<DashboardSettingsWebhookTestRoute>('/v1/dashboard/settings/test-webhook', {
    schema: getRouteContract('POST', '/v1/dashboard/settings/test-webhook'),
    attachValidation: true,
    preHandler: canTestWebhook,
  }, async (request, reply) => {
    if (request.validationError && request.body !== undefined) {
      sendHttpErrorEnvelope(reply, request.id, 400, 'webhook test request is malformed');
      return;
    }
    const requestedUrl = typeof request.body?.url === 'string' && request.body.url.trim() ? request.body.url.trim() : getEffectiveSettings().notifyWebhookUrl;
    if (!requestedUrl) return reply.code(400).send({ ok: false, error: 'Save a webhook URL before testing it.', durationMs: 0 });
    let endpoint: { url: string; addresses: string[] };
    try {
      endpoint = await validatePublicWebhookEndpoint(requestedUrl);
    } catch (error) {
      return reply.code(400).send({ ok: false, error: error instanceof Error ? error.message : 'Webhook URL is not safe to test.', durationMs: 0 });
    }
    const result = await sendTestNotification(endpoint.url, endpoint.addresses);
    reply.code(result.ok ? 200 : 400);
    return result;
  });
};
