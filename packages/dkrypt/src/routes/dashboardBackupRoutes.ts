import { createReadStream } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { validate as validateCronExpr } from 'node-cron';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type {
  DashboardBackupDrillRoute,
  DashboardBackupExportRoute,
  DashboardBackupHistoryCreateRoute,
  DashboardBackupHistoryDeleteRoute,
  DashboardBackupHistoryDrillRoute,
  DashboardBackupHistoryDownloadRoute,
  DashboardBackupHistoryGetRoute,
  DashboardBackupImportRoute,
  DashboardBackupPreviewRoute,
  DashboardBackupScheduleGetRoute,
  DashboardBackupScheduleSetRoute,
} from '#dashboardBackupContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { emitJobsChanged } from '#events.js';
import { getRouteContract } from '#contracts.js';
import { reloadArtifactIndex } from '#artifacts.js';
import { PermissionFlag } from '#permissions.js';
import { applyBackupSchedule } from '#backupScheduler.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import {
  createBackupSnapshot,
  deleteBackupSnapshot,
  drillBackupSnapshot,
  drillBackupRestore,
  exportBackup,
  getBackupHistory,
  getBackupSchedule,
  getBackupSnapshotPath,
  importBackup,
  previewBackup,
  setBackupSchedule,
  verifyLatestDatabaseBackup,
} from '#store/state.js';
import { createHttpErrorEnvelope, sendHttpErrorEnvelope } from '#util/httpResponse.js';

const canViewBackup = fastifyRequirePermission(PermissionFlag.viewBackup, PermissionFlag.manageBackup);
const canManageBackup = fastifyRequirePermission(PermissionFlag.manageBackup);

function rejectInvalidBackupRequest(request: FastifyRequest, reply: FastifyReply, message: string): boolean {
  if (!request.validationError) return false;
  sendHttpErrorEnvelope(reply, request.id, 400, message);
  return true;
}

export const dashboardBackupRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get<DashboardBackupExportRoute>('/v1/dashboard/backup/export', {
    schema: getRouteContract('GET', '/v1/dashboard/backup/export'),
    preHandler: canManageBackup,
  }, (_request, reply) => {
    reply.header('Content-Disposition', 'attachment; filename="dkrypt-backup.json"');
    return exportBackup();
  });

  server.post<DashboardBackupImportRoute>('/v1/dashboard/backup/import', {
    schema: getRouteContract('POST', '/v1/dashboard/backup/import'),
    attachValidation: true,
    preHandler: canManageBackup,
  }, (request, reply) => {
    if (rejectInvalidBackupRequest(request, reply, 'backup payload is malformed')) return;
    const session = getFastifySession(request)!;
    const result = importBackup(request.body, session.sub);
    if (!result.ok) {
      sendHttpErrorEnvelope(reply, request.id, 400, result.error ?? 'backup restore was rejected');
      return;
    }
    reloadArtifactIndex();
    emitJobsChanged();
    return { ok: true };
  });

  server.post<DashboardBackupPreviewRoute>('/v1/dashboard/backup/preview', {
    schema: getRouteContract('POST', '/v1/dashboard/backup/preview'),
    attachValidation: true,
    preHandler: canManageBackup,
  }, (request, reply) => {
    if (rejectInvalidBackupRequest(request, reply, 'backup payload is malformed')) return;
    const result = previewBackup(request.body);
    if (!result.ok) {
      sendHttpErrorEnvelope(reply, request.id, 400, result.error);
      return;
    }
    return result.summary;
  });

  server.post<DashboardBackupDrillRoute>('/v1/dashboard/backup/drill', {
    schema: getRouteContract('POST', '/v1/dashboard/backup/drill'),
    attachValidation: true,
    preHandler: canManageBackup,
  }, (request, reply) => {
    if (rejectInvalidBackupRequest(request, reply, 'backup payload is malformed')) return;
    const result = drillBackupRestore(request.body);
    if (!result.ok) {
      sendHttpErrorEnvelope(reply, request.id, 400, result.error);
      return;
    }
    return {
      ...result.drill,
      restoreDrillStatus: result.drill.ok ? 'passed' : 'failed',
      checkedAt: Date.now(),
      database: verifyLatestDatabaseBackup(),
    };
  });

  server.get<DashboardBackupScheduleGetRoute>('/v1/dashboard/backup/schedule', {
    schema: getRouteContract('GET', '/v1/dashboard/backup/schedule'),
    preHandler: canViewBackup,
  }, getBackupSchedule);

  server.post<DashboardBackupScheduleSetRoute>('/v1/dashboard/backup/schedule', {
    schema: getRouteContract('POST', '/v1/dashboard/backup/schedule'),
    attachValidation: true,
    preHandler: canManageBackup,
  }, (request, reply) => {
    if (rejectInvalidBackupRequest(request, reply, 'backup schedule contains invalid fields')) return;
    const { enabled, cron, retentionCount } = request.body;
    if (cron !== undefined && !validateCronExpr(cron)) {
      sendHttpErrorEnvelope(reply, request.id, 400, 'invalid cron expression');
      return;
    }
    const session = getFastifySession(request)!;
    const schedule = setBackupSchedule({ enabled, cron, retentionCount }, session.sub);
    applyBackupSchedule();
    return schedule;
  });

  server.get<DashboardBackupHistoryGetRoute>('/v1/dashboard/backup/history', {
    schema: getRouteContract('GET', '/v1/dashboard/backup/history'),
    preHandler: canViewBackup,
  }, getBackupHistory);

  server.post<DashboardBackupHistoryCreateRoute>('/v1/dashboard/backup/history', {
    schema: getRouteContract('POST', '/v1/dashboard/backup/history'),
    preHandler: canManageBackup,
  }, (request) => {
    const actor = getFastifySession(request)!.sub;
    return createBackupSnapshot('manual', actor);
  });

  server.get<DashboardBackupHistoryDownloadRoute>('/v1/dashboard/backup/history/:id/download', {
    schema: getRouteContract('GET', '/v1/dashboard/backup/history/:id/download'),
    preHandler: canViewBackup,
  }, (request, reply) => {
    const filePath = getBackupSnapshotPath(request.params.id);
    if (!filePath) {
      reply.code(404);
      return createHttpErrorEnvelope(request.id, 404, 'backup snapshot not found');
    }
    reply.header('Content-Disposition', 'attachment; filename="dkrypt-backup.json"');
    reply.type('application/octet-stream');
    return createReadStream(filePath);
  });

  server.post<DashboardBackupHistoryDrillRoute>('/v1/dashboard/backup/history/:id/drill', {
    schema: getRouteContract('POST', '/v1/dashboard/backup/history/:id/drill'),
    preHandler: canManageBackup,
  }, (request, reply) => {
    const result = drillBackupSnapshot(request.params.id, getFastifySession(request)!.sub);
    if (!result) {
      reply.code(404);
      return createHttpErrorEnvelope(request.id, 404, 'backup snapshot not found');
    }
    return result;
  });

  server.delete<DashboardBackupHistoryDeleteRoute>('/v1/dashboard/backup/history/:id', {
    schema: getRouteContract('DELETE', '/v1/dashboard/backup/history/:id'),
    preHandler: canManageBackup,
  }, (request, reply) => {
    if (!deleteBackupSnapshot(request.params.id, getFastifySession(request)!.sub)) {
      reply.code(404);
      return createHttpErrorEnvelope(request.id, 404, 'backup snapshot not found');
    }
    return { ok: true };
  });
};
