import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { DashboardEventsRoute } from '#dashboardEventsContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { dashboardEvents, getOnlineUsernames, registerDashboardConnection, registerPresence, unregisterPresence } from '#events.js';
import type { LogEntry } from '#logger.js';
import { hasPermission, isSubsetPermission, PermissionFlag } from '#permissions.js';
import { getRouteContract } from '#contracts.js';
import { getAuthProfile } from '#identity.js';
import { dashboardHistoryEntry } from '#dashboardJobPresentation.js';
import { buildDashboardOverview } from '#dashboardOverview.js';
import { getUserEffectivePermissions, type JobHistoryEntry } from '#store/state.js';
import { fastifyRequireSession, getFastifySession } from '#session.js';
import { sendHttpErrorEnvelope } from '#util/httpResponse.js';

export const dashboardEventsRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get<DashboardEventsRoute>('/v1/dashboard/events', {
    schema: getRouteContract('GET', '/v1/dashboard/events'),
  }, (request, reply) => {
    const session = getFastifySession(request);
    if (!session) {
      sendHttpErrorEnvelope(reply, request.id, 401, 'authentication required');
      return;
    }

    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.hijack();
    reply.raw.setTimeout(0);
    reply.raw.flushHeaders();

    const { sub } = session;
    let accessRevoked = false;
    let sequenceNumber = 0;
    const nextSequence = () => ++sequenceNumber;
    const closeForRevokedPermissions = (): boolean => {
      if (accessRevoked) return false;
      const currentPermissions = sub === 'root' ? session.permissions : getUserEffectivePermissions(sub);
      const permissionsRemainValid = isSubsetPermission(session.permissions, currentPermissions);
      if (permissionsRemainValid) return true;
      accessRevoked = true;
      const sequence = nextSequence();
      reply.raw.write(`id: ${sequence}\nevent: access-revoked\ndata: ${JSON.stringify({ sequence, data: {} })}\n\n`);
      reply.raw.end();
      return false;
    };
    const sendEvent = (event: string, data: unknown) => {
      if (!closeForRevokedPermissions()) return;
      const sequence = nextSequence();
      const payload = Array.isArray(data) ? { sequence, data } : data && typeof data === 'object' ? { ...(data as Record<string, unknown>), sequence } : { sequence, data };
      reply.raw.write(`id: ${sequence}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    sendEvent('overview', buildDashboardOverview(session.permissions, sub));

    registerPresence(sub);
    const unregisterDashboardConnection = registerDashboardConnection(() => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    });
    const presentOnlineUsers = (usernames: string[]) => usernames.map((userId) => ({ userId, displayName: getAuthProfile(userId)?.displayName ?? (userId === 'root' ? 'Administrator' : userId) }));
    sendEvent('presence', presentOnlineUsers(getOnlineUsernames()));

    const onOverviewChanged = () => sendEvent('overview', buildDashboardOverview(session.permissions, sub));
    const onLogAdded = (entry: LogEntry) => sendEvent('log', entry);
    const onHistoryAdded = (entry: JobHistoryEntry) => sendEvent('history', dashboardHistoryEntry(entry));
    const onPresenceChanged = (usernames: string[]) => sendEvent('presence', presentOnlineUsers(usernames));
    const onBillingChanged = () => sendEvent('billing', {});

    dashboardEvents.on('jobsChanged', onOverviewChanged);
    dashboardEvents.on('deviceHealthChanged', onOverviewChanged);
    if (hasPermission(session.permissions, PermissionFlag.viewLogs)) dashboardEvents.on('logAdded', onLogAdded);
    dashboardEvents.on('historyAdded', onHistoryAdded);
    dashboardEvents.on('presenceChanged', onPresenceChanged);
    if (hasPermission(session.permissions, PermissionFlag.viewBilling) || hasPermission(session.permissions, PermissionFlag.manageBilling)) {
      dashboardEvents.on('billingChanged', onBillingChanged);
    }
    const heartbeat = setInterval(() => {
      if (closeForRevokedPermissions()) reply.raw.write(': ping\n\n');
    }, 15_000);

    reply.raw.once('close', () => {
      unregisterDashboardConnection();
      clearInterval(heartbeat);
      unregisterPresence(sub);
      dashboardEvents.off('jobsChanged', onOverviewChanged);
      dashboardEvents.off('deviceHealthChanged', onOverviewChanged);
      dashboardEvents.off('logAdded', onLogAdded);
      dashboardEvents.off('historyAdded', onHistoryAdded);
      dashboardEvents.off('presenceChanged', onPresenceChanged);
      dashboardEvents.off('billingChanged', onBillingChanged);
    });
  });
};
