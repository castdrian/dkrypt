import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { DashboardOverviewRoute } from '#dashboardOverviewContracts.js';
import { buildDashboardOverview } from '#dashboardOverview.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { getRouteContract } from '#contracts.js';
import { fastifyRequireSession, getFastifySession } from '#session.js';

export const dashboardOverviewRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get<DashboardOverviewRoute>('/v1/dashboard/overview', {
    schema: getRouteContract('GET', '/v1/dashboard/overview'),
  }, (request) => {
    const session = getFastifySession(request)!;
    return buildDashboardOverview(session.permissions, session.sub);
  });
};
