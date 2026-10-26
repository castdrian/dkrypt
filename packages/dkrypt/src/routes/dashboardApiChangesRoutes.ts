import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { publicApiOperations } from '#publicApi.js';
import { publicApiDeprecations, publicApiLifecycle } from '#publicApiLifecycle.js';
import { fastifyRequireSession } from '#session.js';

export const dashboardApiChangesRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.get('/v1/dashboard/api-changes', { schema: { hide: true }, preHandler: fastifyRequireSession }, () => ({
    lifecycle: publicApiLifecycle,
    operations: publicApiOperations,
    deprecations: publicApiDeprecations,
  }));
};
