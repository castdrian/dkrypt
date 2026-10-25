import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import { getWorkerFleetStatus, setWorkerDrainState } from '#jobs/store.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

const canManageWorkers = fastifyRequirePermission(PermissionFlag.manageDevices);

export const dashboardWorkerRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get('/v1/dashboard/workers', {
    schema: { hide: true },
    preHandler: canManageWorkers,
  }, () => getWorkerFleetStatus());

  server.post('/v1/dashboard/workers/:workerId/drain', {
    schema: {
      hide: true,
      params: Type.Object({ workerId: Type.String({ minLength: 1, maxLength: 80 }) }),
      body: Type.Object({ draining: Type.Boolean() }, { additionalProperties: false }),
    },
    preHandler: canManageWorkers,
  }, (request, reply) => {
    const session = getFastifySession(request)!;
    if (!setWorkerDrainState(request.params.workerId, request.body.draining)) {
      reply.code(409);
      return createHttpErrorEnvelope(request.id, 409, 'worker is offline or no longer available');
    }
    return { ok: true, workers: getWorkerFleetStatus().workers, changedBy: session.sub };
  });
};
