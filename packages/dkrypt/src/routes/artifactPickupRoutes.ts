import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { artifactFileAvailable, getArtifactById, getArtifactForJob, touchArtifact } from '#artifacts.js';
import { getBillingEntitlements } from '#billing.js';
import { PermissionFlag } from '#permissions.js';
import { streamFilePath, jobFileAvailable } from '#jobs/http.js';
import { getJob } from '#jobs/store.js';
import { Response } from '#http.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import { DEFAULT_PROJECT_ID, getUserPrefs } from '#store/state.js';
import { canViewJobForUser } from '#dashboardAccess.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';
import { formatArtifactFilename } from '#artifactFilename.js';
import { createPickupUrl, isValidPickupToken, PICKUP_LINK_TTL_MS, type PickupKind } from '#pickupLinks.js';
const pickupKindSchema = Type.Union([Type.Literal('artifact'), Type.Literal('job')]);
const pickupLinkBodySchema = Type.Object({ artifactId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), jobId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) });
const pickupParamsSchema = Type.Object({ kind: pickupKindSchema, id: Type.String({ minLength: 1, maxLength: 128 }) });


export const artifactPickupRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.post<{ Body: { artifactId?: string; jobId?: string } }>('/v1/dashboard/pickup-link', {
    schema: { hide: true, body: pickupLinkBodySchema },
    preHandler: [fastifyRequireSession, fastifyRequirePermission(PermissionFlag.requestDecrypt)],
  }, (request, reply) => {
    const session = getFastifySession(request)!;
    const { artifactId, jobId } = request.body;
    if (Boolean(artifactId) === Boolean(jobId)) return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'choose one artifact or job result'));

    const now = Date.now();
    if (artifactId) {
      if (getBillingEntitlements(session.sub).freeTier) return reply.code(403).send(createHttpErrorEnvelope(request.id, 403, 'shared library downloads require a paid plan'));
      const artifact = getArtifactById(artifactId);
      if (!artifact || !artifact.projectIds.includes(DEFAULT_PROJECT_ID) || !artifactFileAvailable(artifact)) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'artifact not found'));
      const expiresAt = now + PICKUP_LINK_TTL_MS;
      const fileName = formatArtifactFilename(getUserPrefs(session.sub).artifactFilenameTemplate, artifact);
      return { url: createPickupUrl(session.sub, 'artifact', artifact.id, fileName, expiresAt), expiresAt, fileName };
    }

    const job = getJob(jobId!);
    if (!job || !canViewJobForUser(job, session.sub, session.permissions) || !jobFileAvailable(job)) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'download not found'));
    if (job.freeTierResult && job.billingOwnerId?.toLowerCase() !== session.sub.toLowerCase()) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'download not found'));
    const expiresAt = Math.min(now + PICKUP_LINK_TTL_MS, job.temporaryResultExpiresAt ?? Number.MAX_SAFE_INTEGER);
    const artifact = getArtifactForJob(job);
    const fileName = artifact ? formatArtifactFilename(getUserPrefs(session.sub).artifactFilenameTemplate, artifact) : `${job.bundleId}.ipa`;
    return { url: createPickupUrl(session.sub, 'job', job.id, fileName, expiresAt), expiresAt, fileName, ...(job.temporaryResultExpiresAt ? { resultExpiresAt: job.temporaryResultExpiresAt } : {}) };
  });

  server.get<{ Params: { kind: PickupKind; id: string }; Querystring: { subject: string; name: string; expires: string; signature: string } }>('/pickup/:kind/:id', {
    schema: { hide: true, params: pickupParamsSchema, querystring: Type.Object({ subject: Type.String({ minLength: 1, maxLength: 128 }), name: Type.String({ minLength: 1, maxLength: 160 }), expires: Type.String({ minLength: 1, maxLength: 16 }), signature: Type.String({ minLength: 1, maxLength: 128 }) }) },
  }, async (request, reply) => {
    const { kind, id } = request.params;
    const { subject, name, expires, signature } = request.query;
    if (!isValidPickupToken(kind, id, subject, name, expires, signature)) return reply.code(403).type('text/plain').send('This pickup link has expired. Create a new QR code from dkrypt.');
    reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer');
    if (kind === 'artifact') {
      const artifact = getArtifactById(id);
      if (!artifact || !artifact.projectIds.includes(DEFAULT_PROJECT_ID) || !artifactFileAvailable(artifact)) return reply.code(404).type('text/plain').send('This artifact is no longer available.');
      await touchArtifact(artifact);
      await streamFilePath(artifact.filePath, request.raw, new Response(reply), name, artifact.fileSizeBytes, artifact.id, artifact.sha256);
      return;
    }
    const job = getJob(id);
    if (!job || !jobFileAvailable(job)) return reply.code(404).type('text/plain').send('This result is no longer available.');
    if (job.freeTierResult && job.temporaryResultExpiresAt !== undefined && job.temporaryResultExpiresAt <= Date.now()) return reply.code(410).type('text/plain').send('The 30-minute download window has expired.');
    const artifact = getArtifactForJob(job);
    const filePath = artifact?.filePath ?? job.filePath;
    if (!filePath) return reply.code(404).type('text/plain').send('This result is no longer available.');
    await streamFilePath(filePath, request.raw, new Response(reply), name, artifact?.fileSizeBytes ?? job.fileSizeBytes, job.id, artifact?.sha256 ?? job.sha256);
  });
};
