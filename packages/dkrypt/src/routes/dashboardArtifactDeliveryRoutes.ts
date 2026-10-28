import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { deleteCloudDestination, getCloudDestination, listCloudDeliveries, retryCloudDelivery, saveCloudDestination, testCloudDestination } from '#artifactDelivery.js';
import { fastifyRequireSession, getFastifySession } from '#session.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

const webdavDestination = Type.Object({
  provider: Type.Literal('webdav'),
  endpoint: Type.String({ minLength: 9, maxLength: 2048 }),
  prefix: Type.Optional(Type.String({ maxLength: 512 })),
  username: Type.String({ minLength: 1, maxLength: 256 }),
  password: Type.Optional(Type.String({ maxLength: 2048 })),
  enabled: Type.Boolean(),
}, { additionalProperties: false });

const s3Destination = Type.Object({
  provider: Type.Literal('s3'),
  endpoint: Type.String({ minLength: 9, maxLength: 2048 }),
  prefix: Type.Optional(Type.String({ maxLength: 512 })),
  accessKey: Type.Optional(Type.String({ maxLength: 256 })),
  secretKey: Type.Optional(Type.String({ maxLength: 2048 })),
  region: Type.String({ minLength: 1, maxLength: 64 }),
  bucket: Type.String({ minLength: 3, maxLength: 63 }),
  enabled: Type.Boolean(),
}, { additionalProperties: false });

export const dashboardArtifactDeliveryRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get('/v1/dashboard/download-destination', { schema: { hide: true } }, (request) => {
    const ownerId = getFastifySession(request)!.sub;
    return { destination: getCloudDestination(ownerId), deliveries: listCloudDeliveries(ownerId, 10) };
  });

  server.put('/v1/dashboard/download-destination', {
    schema: { hide: true, body: Type.Union([webdavDestination, s3Destination]) },
    attachValidation: true,
  }, async (request, reply) => {
    if (request.validationError) return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'Download destination settings are malformed'));
    try {
      const destination = await saveCloudDestination(getFastifySession(request)!.sub, request.body);
      return { destination };
    } catch (error) {
      return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, error instanceof Error ? error.message : 'Could not save the download destination'));
    }
  });

  server.delete('/v1/dashboard/download-destination', { schema: { hide: true } }, (request) => {
    return { deleted: deleteCloudDestination(getFastifySession(request)!.sub) };
  });

  server.post('/v1/dashboard/download-destination/test', { schema: { hide: true } }, async (request, reply) => {
    try {
      return await testCloudDestination(getFastifySession(request)!.sub);
    } catch (error) {
      return reply.code(502).send(createHttpErrorEnvelope(request.id, 502, error instanceof Error ? error.message : 'Could not test the download destination'));
    }
  });

  server.post('/v1/dashboard/download-destination/deliveries/:id/retry', {
    schema: { hide: true, params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }) }) },
  }, async (request, reply) => {
    const record = await retryCloudDelivery(getFastifySession(request)!.sub, request.params.id);
    return record ? { delivery: record } : reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'Failed delivery not found'));
  });
};
