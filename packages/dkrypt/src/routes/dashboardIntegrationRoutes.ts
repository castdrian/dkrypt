import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';
import { hasPermission, PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import { getAuthProfile } from '#identity.js';
import { DEFAULT_PROJECT_ID, getUserEffectivePermissions, listAllowedUsers, recordAudit, userCanAccessProject } from '#store/state.js';
import { acceptIntegrationBillingOwnerTransfer, createGithubOidcPolicy, createSignedTriggerPolicy, getSignedTriggerPolicy, listGithubOidcPolicies, listSignedTriggerPolicies, publicSignedTriggerPolicy, requestIntegrationBillingOwnerTransfer, revokeGithubOidcPolicy, revokeSignedTriggerPolicy, rotateSignedTriggerSecret } from '#store/integrationRepository.js';

const bundleIdSchema = Type.String({ minLength: 3, maxLength: 200, pattern: '^[A-Za-z0-9.-]+$' });

export const dashboardIntegrationRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);

  const administrator = fastifyRequirePermission(PermissionFlag.administrator);
  const integrationViewer = fastifyRequirePermission(PermissionFlag.viewAutomation, PermissionFlag.manageAutomation);
  const profileName = (userId: string | undefined): string => userId ? getAuthProfile(userId)?.displayName ?? userId : 'System-owned';
  const serializeIntegration = <T extends { projectId: string; billingOwnerId?: string; billingOwnerTransfer?: { userId: string; requestedBy: string } }>(policy: T) => {
    const { projectId: _projectId, ...safePolicy } = policy;
    return {
    ...safePolicy,
    billingOwnerDisplayName: profileName(policy.billingOwnerId),
    billingOwnerTransferDisplayName: policy.billingOwnerTransfer ? profileName(policy.billingOwnerTransfer.userId) : undefined,
    billingOwnerTransferRequestorDisplayName: policy.billingOwnerTransfer ? profileName(policy.billingOwnerTransfer.requestedBy) : undefined,
    };
  };
  const eligibleOwners = (projectId: string) => listAllowedUsers()
    .filter((user) => userCanAccessProject(user.username, projectId))
    .filter((user) => hasPermission(getUserEffectivePermissions(user.username), PermissionFlag.requestDecrypt))
    .filter((user) => hasPermission(getUserEffectivePermissions(user.username), PermissionFlag.viewAutomation | PermissionFlag.manageAutomation))
    .map((user) => ({ id: user.username, name: profileName(user.username) }));

  server.get('/v1/dashboard/integrations/signed-triggers', { schema: { hide: true }, preHandler: administrator }, () => ({ integrations: listSignedTriggerPolicies().map(serializeIntegration) }));

  server.get('/v1/dashboard/integrations/github-oidc', { schema: { hide: true }, preHandler: administrator }, () => ({ policies: listGithubOidcPolicies().map(serializeIntegration) }));

  server.get('/v1/dashboard/integrations/ownership/pending', { schema: { hide: true }, preHandler: integrationViewer }, (request) => {
    const actor = getFastifySession(request)!.sub.toLowerCase();
    const signed = listSignedTriggerPolicies().filter((policy) => policy.billingOwnerTransfer?.userId === actor).map((policy) => ({ ...serializeIntegration(policy), kind: policy.kind, label: policy.bundleIds.join(', ') }));
    const oidc = listGithubOidcPolicies().filter((policy) => policy.billingOwnerTransfer?.userId === actor).map((policy) => ({ ...serializeIntegration(policy), kind: policy.kind, label: `GitHub Actions · ${policy.bundleIds.join(', ')}` }));
    return { requests: [...signed, ...oidc] };
  });

  server.get('/v1/dashboard/integrations/:id/ownership/eligible', {
    schema: { hide: true, params: Type.Object({ id: Type.String() }) },
    preHandler: administrator,
  }, (request, reply) => {
    const policy = getSignedTriggerPolicy(request.params.id) ?? listGithubOidcPolicies().find((candidate) => candidate.id === request.params.id);
    if (!policy) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'integration not found'));
    return { users: eligibleOwners(policy.projectId) };
  });

  server.post('/v1/dashboard/integrations/:id/ownership/request', {
    schema: { hide: true, params: Type.Object({ id: Type.String() }), body: Type.Object({ userId: Type.String({ minLength: 1, maxLength: 160 }) }, { additionalProperties: false }) },
    preHandler: administrator,
  }, (request, reply) => {
    const actor = getFastifySession(request)!.sub;
    const policy = getSignedTriggerPolicy(request.params.id) ?? listGithubOidcPolicies().find((candidate) => candidate.id === request.params.id);
    if (!policy || !policy.enabled) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'active integration not found'));
    const userId = request.body.userId.trim().toLowerCase();
    if (userId !== 'root' && !eligibleOwners(policy.projectId).some((user) => user.id === userId)) return reply.code(409).send(createHttpErrorEnvelope(request.id, 409, 'recipient needs integration and decrypt access'));
    const result = requestIntegrationBillingOwnerTransfer(request.params.id, userId, actor);
    if (!result) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'active integration not found'));
    recordAudit(actor, 'integration.billing-owner-request', result.id, userId);
    return { policy: result.kind === 'signed_decrypt' ? serializeIntegration(publicSignedTriggerPolicy(result)) : serializeIntegration(result) };
  });

  server.post('/v1/dashboard/integrations/:id/ownership/accept', {
    schema: { hide: true, params: Type.Object({ id: Type.String() }) },
    preHandler: integrationViewer,
  }, (request, reply) => {
    const actor = getFastifySession(request)!.sub;
    const existing = getSignedTriggerPolicy(request.params.id) ?? listGithubOidcPolicies().find((candidate) => candidate.id === request.params.id);
    if (!existing || !existing.enabled || !userCanAccessProject(actor, existing.projectId)) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'integration not found'));
    if (actor !== 'root' && !hasPermission(getUserEffectivePermissions(actor), PermissionFlag.requestDecrypt)) return reply.code(403).send(createHttpErrorEnvelope(request.id, 403, 'decrypt access is required to accept ownership'));
    const policy = acceptIntegrationBillingOwnerTransfer(request.params.id, actor);
    if (!policy) return reply.code(409).send(createHttpErrorEnvelope(request.id, 409, 'no ownership request is awaiting this account'));
    recordAudit(actor, 'integration.billing-owner-accept', policy.id, actor);
    return { policy: policy.kind === 'signed_decrypt' ? serializeIntegration(publicSignedTriggerPolicy(policy)) : serializeIntegration(policy) };
  });

  server.post('/v1/dashboard/integrations/github-oidc', {
    schema: { hide: true, body: Type.Object({ repositoryId: Type.String({ pattern: '^[0-9]+$', maxLength: 32 }), workflowRef: Type.String({ minLength: 1, maxLength: 300 }), ref: Type.Optional(Type.String({ minLength: 1, maxLength: 250 })), environment: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), audience: Type.String({ minLength: 1, maxLength: 250 }), bundleIds: Type.Array(bundleIdSchema, { minItems: 1, maxItems: 25, uniqueItems: true }), allowTestFlight: Type.Boolean() }, { additionalProperties: false }) },
    preHandler: administrator,
  }, (request, reply) => {
    const input = request.body;
    if (Boolean(input.ref) === Boolean(input.environment) || [input.workflowRef, input.ref, input.environment, input.audience].some((value) => value?.includes('*'))) return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'configure one exact ref or environment with no wildcards'));
    const policy = createGithubOidcPolicy({ ...input, projectId: DEFAULT_PROJECT_ID, createdBy: getFastifySession(request)!.sub });
    recordAudit(getFastifySession(request)!.sub, 'integration.create', policy.id, `GitHub repository ${policy.repositoryId}`);
    return reply.code(201).send({ policy });
  });

  server.post('/v1/dashboard/integrations/github-oidc/:id/revoke', { schema: { hide: true, params: Type.Object({ id: Type.String() }) }, preHandler: administrator }, (request, reply) => {
    if (!revokeGithubOidcPolicy(request.params.id)) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'active trust policy not found'));
    recordAudit(getFastifySession(request)!.sub, 'integration.revoke', request.params.id);
    return { ok: true };
  });

  server.post('/v1/dashboard/integrations/signed-triggers', {
    schema: { hide: true, body: Type.Object({ bundleIds: Type.Array(bundleIdSchema, { minItems: 1, maxItems: 25, uniqueItems: true }), sources: Type.Array(Type.Union([Type.Literal('appstore'), Type.Literal('testflight')]), { minItems: 1, maxItems: 2, uniqueItems: true }) }, { additionalProperties: false }) },
    preHandler: administrator,
  }, (request, reply) => {
    const policy = createSignedTriggerPolicy({ ...request.body, projectId: DEFAULT_PROJECT_ID, createdBy: getFastifySession(request)!.sub });
    recordAudit(getFastifySession(request)!.sub, 'integration.create', policy.id, `${policy.bundleIds.length} bundles`);
    return reply.code(201).send({ integration: serializeIntegration(publicSignedTriggerPolicy(policy)), secret: policy.secret });
  });

  server.post('/v1/dashboard/integrations/signed-triggers/:id/rotate', { schema: { hide: true, params: Type.Object({ id: Type.String() }) }, preHandler: administrator }, (request, reply) => {
    const policy = rotateSignedTriggerSecret(request.params.id);
    if (!policy) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'active integration not found'));
    recordAudit(getFastifySession(request)!.sub, 'integration.rotate', policy.id);
    return { integration: serializeIntegration(publicSignedTriggerPolicy(policy)), secret: policy.secret };
  });

  server.post('/v1/dashboard/integrations/signed-triggers/:id/revoke', { schema: { hide: true, params: Type.Object({ id: Type.String() }) }, preHandler: administrator }, (request, reply) => {
    const policy = getSignedTriggerPolicy(request.params.id);
    if (!policy || !revokeSignedTriggerPolicy(policy.id)) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'active integration not found'));
    recordAudit(getFastifySession(request)!.sub, 'integration.revoke', policy.id);
    return { integration: serializeIntegration(publicSignedTriggerPolicy(getSignedTriggerPolicy(policy.id)!)) };
  });
};
