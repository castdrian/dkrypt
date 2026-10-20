import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type {
  DashboardRoleCreateRoute,
  DashboardRoleDeleteRoute,
  DashboardRoleListRoute,
  DashboardRoleImpactRoute,
  DashboardRoleReorderRoute,
  DashboardRoleUpdateRoute,
} from '#dashboardRoleContracts.js';
import { canGrantBits } from '#dashboardAdminRules.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { ErrorEnvelope, getRouteContract } from '#contracts.js';
import { getAuthProfile } from '#identity.js';
import { hasPermission, PermissionFlag, parseBits } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import { createRole, DEFAULT_ROLE_ID, deleteRole, listRoles, previewRoleImpact, reorderRoles, updateRole } from '#store/state.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';
import { dashboardRoleImpactBodySchema, dashboardRoleImpactResponseSchema, dashboardRoleParamsSchema } from '#dashboardRoleContracts.js';

const canViewRoles = fastifyRequirePermission(PermissionFlag.viewRoles, PermissionFlag.manageRoles);
const canManageRoles = fastifyRequirePermission(PermissionFlag.manageRoles);

export const dashboardRoleRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get<DashboardRoleListRoute>('/v1/dashboard/roles', {
    schema: getRouteContract('GET', '/v1/dashboard/roles'),
    preHandler: canViewRoles,
  }, () => ({ roles: listRoles() }));

  server.post<DashboardRoleImpactRoute>('/v1/dashboard/roles/:id/impact-preview', {
    schema: { hide: true, params: dashboardRoleParamsSchema, body: dashboardRoleImpactBodySchema, response: { 200: dashboardRoleImpactResponseSchema, 400: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope } },
    attachValidation: true,
    preHandler: canManageRoles,
  }, (request, reply) => {
    if (request.validationError) {
      reply.code(400);
      return createHttpErrorEnvelope(request.id, 400, 'role permission preview is malformed');
    }
    const params = request.params as { id: string };
    const body = request.body as { permissions: string };
    if (!canGrantBits(getFastifySession(request)!.permissions, parseBits(body.permissions))) {
      reply.code(403);
      return createHttpErrorEnvelope(request.id, 403, "you can't grant permissions you don't have yourself");
    }
    const preview = previewRoleImpact(params.id, body.permissions);
    if (!preview) {
      reply.code(404);
      return createHttpErrorEnvelope(request.id, 404, 'role not found');
    }
    const canViewMembers = hasPermission(getFastifySession(request)!.permissions, PermissionFlag.viewUsers | PermissionFlag.manageUsers);
    return canViewMembers
      ? { ...preview, members: preview.members.map((member) => ({ ...member, displayName: getAuthProfile(member.username)?.displayName })) }
      : { ...preview, members: [], memberDetailsHidden: preview.affectedCount > 0 };
  });

  server.post<DashboardRoleCreateRoute>('/v1/dashboard/roles', {
    schema: getRouteContract('POST', '/v1/dashboard/roles'),
    attachValidation: true,
    preHandler: canManageRoles,
  }, (request, reply) => {
    if (request.validationError) {
      reply.code(400);
      return createHttpErrorEnvelope(request.id, 400, 'name (non-empty) and color (#rrggbb) are required');
    }
    const name = request.body.name.trim();
    if (!name) {
      reply.code(400);
      return createHttpErrorEnvelope(request.id, 400, 'name (non-empty) and color (#rrggbb) are required');
    }
    const permissions = request.body.permissions ?? '0';
    if (!canGrantBits(getFastifySession(request)!.permissions, parseBits(permissions))) {
      reply.code(403);
      return createHttpErrorEnvelope(request.id, 403, "you can't grant permissions you don't have yourself");
    }
    reply.code(201);
    return createRole({ name, color: request.body.color, permissions }, getFastifySession(request)!.sub);
  });

  server.patch<DashboardRoleUpdateRoute>('/v1/dashboard/roles/:id', {
    schema: getRouteContract('PATCH', '/v1/dashboard/roles/:id'),
    attachValidation: true,
    preHandler: canManageRoles,
  }, (request, reply) => {
    if (request.validationError && request.body !== undefined) {
      reply.code(400);
      return createHttpErrorEnvelope(request.id, 400, 'role updates are malformed');
    }
    if (request.params.id === DEFAULT_ROLE_ID) {
      reply.code(400);
      return createHttpErrorEnvelope(request.id, 400, "the @everyone role can't be renamed");
    }
    const body = request.body ?? {};
    const patch: { name?: string; color?: string; permissions?: string } = {};
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.color === 'string') patch.color = body.color;
    if (typeof body.permissions === 'string') {
      if (!canGrantBits(getFastifySession(request)!.permissions, parseBits(body.permissions))) {
        reply.code(403);
        return createHttpErrorEnvelope(request.id, 403, "you can't grant permissions you don't have yourself");
      }
      patch.permissions = body.permissions;
    }
    const result = updateRole(request.params.id, patch, getFastifySession(request)!.sub);
    if (!result.ok || !result.role) {
      const statusCode = result.error === 'role not found' ? 404 : 400;
      reply.code(statusCode);
      return createHttpErrorEnvelope(request.id, statusCode, result.error ?? 'role update was rejected');
    }
    return result.role;
  });

  server.delete<DashboardRoleDeleteRoute>('/v1/dashboard/roles/:id', {
    schema: getRouteContract('DELETE', '/v1/dashboard/roles/:id'),
    preHandler: canManageRoles,
  }, (request, reply) => {
    const result = deleteRole(request.params.id, getFastifySession(request)!.sub);
    if (!result.ok) {
      const statusCode = result.error === 'role not found' ? 404 : 400;
      reply.code(statusCode);
      return createHttpErrorEnvelope(request.id, statusCode, result.error ?? 'role removal was rejected');
    }
    return { ok: true };
  });

  server.post<DashboardRoleReorderRoute>('/v1/dashboard/roles/reorder', {
    schema: getRouteContract('POST', '/v1/dashboard/roles/reorder'),
    attachValidation: true,
    preHandler: canManageRoles,
  }, (request, reply) => {
    if (request.validationError) {
      reply.code(400);
      return createHttpErrorEnvelope(request.id, 400, 'roleIds (an array of role ids) is required');
    }
    if (!reorderRoles(request.body.roleIds, getFastifySession(request)!.sub)) {
      reply.code(400);
      return createHttpErrorEnvelope(request.id, 400, 'roleIds must contain every non-default role exactly once');
    }
    return { roles: listRoles() };
  });
};
