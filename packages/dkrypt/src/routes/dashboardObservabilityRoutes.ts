import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { DashboardAuditLogExportRoute, DashboardAuditLogRoute, DashboardLogsRoute } from '#dashboardObservabilityContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { getRouteContract } from '#contracts.js';
import { getAuthProfile } from '#identity.js';
import { getRecentLogs } from '#logger.js';
import { PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession } from '#session.js';
import { getAuditLog, getAuditLogByTarget, getAuditLogPage } from '#store/state.js';
import { csvCell } from '#util/csv.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

const canViewLogs = fastifyRequirePermission(PermissionFlag.viewLogs);
const canViewAuditLog = fastifyRequirePermission(PermissionFlag.viewUsers, PermissionFlag.manageUsers);

export const dashboardObservabilityRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get<DashboardLogsRoute>('/v1/dashboard/logs', {
    schema: getRouteContract('GET', '/v1/dashboard/logs'),
    preHandler: canViewLogs,
  }, (request, reply) => {
    const query = request.query;
    const scope = query.scope && query.scope !== 'all' ? query.scope.slice(0, 100) : undefined;
    const search = query.q?.trim().slice(0, 100) || undefined;
    const cursor = query.cursor;
    const offset = cursor ? 0 : query.offset ?? 0;
    const limit = Math.min(query.limit ?? 100, 200);
    try {
      return getRecentLogs({
        scope,
        level: query.level,
        query: search,
        regex: query.regex === '1',
        cursor,
        offset,
        limit,
      });
    } catch {
      reply.code(400);
      return createHttpErrorEnvelope(request.id, 400, 'log search pattern is invalid or unsafe');
    }
  });

  server.get<DashboardAuditLogRoute>('/v1/dashboard/audit-log', {
    schema: getRouteContract('GET', '/v1/dashboard/audit-log'),
    preHandler: canViewAuditLog,
  }, (request) => {
    const { cursor, limit, offset } = request.query;
    const page = getAuditLogPage(cursor ? 0 : offset ?? 0, Math.min(limit ?? 100, 200), cursor);
    return { ...page, entries: page.entries.map((entry) => ({ ...entry, actorDisplayName: getAuthProfile(entry.actor)?.displayName })) };
  });

  server.get('/v1/dashboard/audit-log/target/:target', {
    schema: { hide: true, params: Type.Object({ target: Type.String({ minLength: 1, maxLength: 200 }) }) },
    preHandler: canViewAuditLog,
  }, (request) => ({ entries: getAuditLogByTarget(request.params.target, 5).map((entry) => ({ ...entry, actorDisplayName: getAuthProfile(entry.actor)?.displayName })) }));

  server.get<DashboardAuditLogExportRoute>('/v1/dashboard/audit-log/export', {
    schema: getRouteContract('GET', '/v1/dashboard/audit-log/export'),
    preHandler: canViewAuditLog,
  }, (request, reply) => {
    const entries = getAuditLog(200);
    if (request.query.format !== 'csv') {
      reply.header('Content-Disposition', 'attachment; filename="dkrypt-audit-log.json"');
      return entries;
    }
    const columns = ['id', 'ts', 'actor', 'action', 'target', 'detail'] as const;
    const rows = [columns.join(',')];
    for (const entry of entries) rows.push(columns.map((column) => csvCell(entry[column])).join(','));
    reply.type('text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="dkrypt-audit-log.csv"');
    return rows.join('\n');
  });
};
