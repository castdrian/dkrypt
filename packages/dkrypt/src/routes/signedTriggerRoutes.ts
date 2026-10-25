import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { normalizeVersionSelector, resolveDecryptTarget, VERSION_SELECTOR_RE } from '#decryptTarget.js';
import { AutomationOwnerUnavailableError, enqueueDecryptJob } from '#jobs/store.js';
import { DailyDecryptLimitError } from '#jobs/repository.js';
import { hasPermission, PermissionFlag } from '#permissions.js';
import { getProject, getUserEffectivePermissions } from '#store/state.js';
import { finishIntegrationDelivery, getIntegrationDelivery, getSignedTriggerPolicy, releaseIntegrationDelivery, reserveIntegrationDelivery, verifySignedTrigger } from '#store/integrationRepository.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

const triggerBody = Type.Object({ bundleId: Type.String({ minLength: 3, maxLength: 200, pattern: '^[A-Za-z0-9.-]+$' }), source: Type.Union([Type.Literal('appstore'), Type.Literal('testflight')]), version: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })) }, { additionalProperties: false });

export const signedTriggerRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.removeContentTypeParser('application/json');
  server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  server.post('/v1/integrations/decrypt-trigger/:id', {
    schema: { hide: true, params: Type.Object({ id: Type.String() }), body: Type.Any() },
  }, async (request, reply) => {
    const policy = getSignedTriggerPolicy(request.params.id);
    const timestamp = request.headers['x-dkrypt-timestamp'];
    const eventId = request.headers['x-dkrypt-event-id'];
    const signature = request.headers['x-dkrypt-signature'];
    const body = request.body;
    if (!policy || !Buffer.isBuffer(body) || typeof timestamp !== 'string' || typeof eventId !== 'string' || typeof signature !== 'string' || !verifySignedTrigger(policy, timestamp, eventId, signature, body)) return reply.code(401).send(createHttpErrorEnvelope(request.id, 401, 'invalid integration signature'));
    let input: { bundleId: string; source: 'appstore' | 'testflight'; version?: string };
    try {
      input = JSON.parse(body.toString('utf8'));
    } catch {
      return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'invalid JSON body'));
    }
    if (!Value.Check(triggerBody, input) || (input.version !== undefined && !VERSION_SELECTOR_RE.test(input.version))) return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'invalid decrypt request'));
    if (!policy.bundleIds.includes(input.bundleId) || !policy.sources.includes(input.source)) return reply.code(403).send(createHttpErrorEnvelope(request.id, 403, 'request is outside integration scope'));
    const project = getProject(policy.projectId);
    if (!project || project.archivedAt) return reply.code(409).send(createHttpErrorEnvelope(request.id, 409, 'integration is unavailable'));
    if (policy.billingOwnerId && policy.billingOwnerId !== 'root' && !hasPermission(getUserEffectivePermissions(policy.billingOwnerId), PermissionFlag.requestDecrypt)) return reply.code(403).send({ ...createHttpErrorEnvelope(request.id, 403, 'automation owner no longer has decrypt access'), code: 'automation_owner_unavailable', remediation: { action: 'Restore the owner’s decrypt access or transfer automation ownership.' } });
    if (input.source === 'testflight' && !/^v?\d+(?:\.\d+)*_\d+$/i.test(input.version ?? '')) return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'TestFlight requires an exact version and build number'));
    if (input.source === 'appstore' && input.version?.includes('_')) return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'App Store versions cannot include a TestFlight build number'));
    const delivery = reserveIntegrationDelivery(policy.id, eventId);
    if (!delivery) {
      const existing = getIntegrationDelivery(policy.id, eventId);
      return reply.code(existing?.status === 'accepted' ? 200 : 409).send({ duplicate: true, status: existing?.status ?? 'unknown', jobId: existing?.jobId });
    }
    try {
      const target = await resolveDecryptTarget(input.bundleId, normalizeVersionSelector(input.version));
      if (target.channel !== input.source) throw new Error('resolved release does not match the allowed source');
      const job = enqueueDecryptJob(input.bundleId, 'manual', { externalVersionId: target.externalVersionId, testflight: target.testflight, versionLabel: target.versionLabel, projectId: policy.projectId, queuedBy: `integration:${policy.id}`, billingOwnerId: policy.billingOwnerId, minimumOsVersion: target.minimumOsVersion });
      finishIntegrationDelivery(delivery, 'accepted', job.id);
      return reply.code(202).send({ jobId: job.id, duplicate: false });
    } catch (error) {
      if (error instanceof DailyDecryptLimitError) {
        releaseIntegrationDelivery(delivery);
        reply.header('Retry-After', String(Math.max(1, Math.ceil((error.nextAvailableAt - Date.now()) / 1000))));
        return reply.code(429).send({ ...createHttpErrorEnvelope(request.id, 429, error.message, { nextAvailableAt: error.nextAvailableAt }), code: error.code, retryable: true });
      }
      if (error instanceof AutomationOwnerUnavailableError) {
        releaseIntegrationDelivery(delivery);
        return reply.code(403).send({ ...createHttpErrorEnvelope(request.id, 403, error.message), code: 'automation_owner_unavailable', remediation: { action: 'Restore the owner’s decrypt access or transfer automation ownership.' } });
      }
      finishIntegrationDelivery(delivery, 'failed');
      return reply.code(502).send(createHttpErrorEnvelope(request.id, 502, 'decrypt trigger could not be queued'));
    }
  });
};
