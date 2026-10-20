import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import type {
  DashboardUserCreateRoute,
  DashboardUserDeleteRoute,
  DashboardUserListRoute,
  DashboardUserUpdateRoute,
} from '#dashboardUserContracts.js';
import { getBillingEntitlements } from '#billing.js';
import { canGrantBits } from '#dashboardAdminRules.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { listAuthProfiles } from '#identity.js';
import { getRouteContract } from '#contracts.js';
import { hasPermission, PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import {
  addAllowedUser,
  effectiveBitsForRoleIds,
  getUserActivityStats,
  listAllowedUsers,
  listRoles,
  removeAllowedUser,
  setUserPriority,
  updateAllowedUserRoles,
  wouldOrphanPermission,
} from '#store/state.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

const canViewUsers = fastifyRequirePermission(PermissionFlag.viewUsers, PermissionFlag.manageUsers);
const canManageUsers = fastifyRequirePermission(PermissionFlag.manageUsers);

function hasRoleIdArray(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const roleIds = (body as Record<string, unknown>).roleIds;
  return Array.isArray(roleIds) && roleIds.every((roleId) => typeof roleId === 'string');
}

export const dashboardUserRoutes: FastifyPluginAsyncTypebox = async (server) => {
  const invalidRoleIdRequests = new WeakSet<FastifyRequest>();
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);
  server.addHook('preValidation', async (request) => {
    const routePath = request.url.split('?', 1)[0];
    const isUserMutation = (request.method === 'POST' && routePath === '/v1/dashboard/users') ||
      (request.method === 'PATCH' && routePath.startsWith('/v1/dashboard/users/'));
    if (isUserMutation && !hasRoleIdArray(request.body)) invalidRoleIdRequests.add(request);
  });

  server.get<DashboardUserListRoute>('/v1/dashboard/users', {
    schema: getRouteContract('GET', '/v1/dashboard/users'),
    preHandler: canViewUsers,
  }, (request) => {
    const session = getFastifySession(request)!;
    const canViewBilling = hasPermission(session.permissions, PermissionFlag.viewBilling) || hasPermission(session.permissions, PermissionFlag.manageBilling);
    const billingEntitlementsFor = (username: string) => {
      if (!canViewBilling) return undefined;
      const entitlements = getBillingEntitlements(username);
      if (entitlements.planId === 'viewer') return undefined;
      return {
        planId: entitlements.planId,
        decrypt: entitlements.decrypt,
        api: entitlements.api,
        priority: entitlements.priority,
      };
    };
    const assignments = new Map(listAllowedUsers().map((user) => [user.username, user]));
    const activity = getUserActivityStats();
    const users = listAuthProfiles().map((profile) => {
      const assignment = assignments.get(profile.userId);
      return {
        username: profile.userId,
        accountUsername: profile.username,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        roleIds: assignment?.roleIds ?? [],
        billingEntitlements: billingEntitlementsFor(profile.userId),
        addedAt: assignment?.addedAt ?? Date.parse(profile.updatedAt),
        lastActiveAt: assignment?.lastActiveAt,
        priority: assignment?.priority,
        activity: activity.get(profile.userId.toLowerCase()),
      };
    });
    for (const assignment of assignments.values()) {
      if (!users.some((user) => user.username === assignment.username)) {
        users.push({
          username: assignment.username,
          accountUsername: assignment.username,
          displayName: assignment.username,
          avatarUrl: '',
          roleIds: assignment.roleIds,
          billingEntitlements: billingEntitlementsFor(assignment.username),
          addedAt: assignment.addedAt,
          lastActiveAt: assignment.lastActiveAt,
          priority: assignment.priority,
          activity: activity.get(assignment.username.toLowerCase()),
        });
      }
    }
    return { users };
  });

  server.post<DashboardUserCreateRoute>('/v1/dashboard/users', {
    schema: getRouteContract('POST', '/v1/dashboard/users'),
    attachValidation: true,
    preHandler: canManageUsers,
  }, (request, reply) => {
    if (request.validationError || invalidRoleIdRequests.has(request)) {
      reply.code(400);
      return createHttpErrorEnvelope(request.id, 400, 'username and roleIds (an array of role ids) are required');
    }
    const username = request.body.username.trim();
    if (!username) {
      reply.code(400);
      return createHttpErrorEnvelope(request.id, 400, 'username and roleIds (an array of role ids) are required');
    }
    const targetBits = effectiveBitsForRoleIds(request.body.roleIds, listRoles());
    if (!canGrantBits(getFastifySession(request)!.permissions, targetBits)) {
      reply.code(403);
      return createHttpErrorEnvelope(request.id, 403, "you can't grant permissions you don't have yourself");
    }
    reply.code(201);
    const account = listAuthProfiles().find((profile) => profile.username.toLowerCase() === username.toLowerCase());
    return addAllowedUser(account?.userId ?? username, request.body.roleIds, getFastifySession(request)!.sub);
  });

  server.patch<DashboardUserUpdateRoute>('/v1/dashboard/users/:username', {
    schema: getRouteContract('PATCH', '/v1/dashboard/users/:username'),
    attachValidation: true,
    preHandler: canManageUsers,
  }, (request, reply) => {
    if (request.validationError || invalidRoleIdRequests.has(request)) {
      reply.code(400);
      return createHttpErrorEnvelope(request.id, 400, 'roleIds (an array of role ids) is required');
    }
    const session = getFastifySession(request)!;
    const targetBits = effectiveBitsForRoleIds(request.body.roleIds, listRoles());
    if (!canGrantBits(session.permissions, targetBits)) {
      reply.code(403);
      return createHttpErrorEnvelope(request.id, 403, "you can't grant permissions you don't have yourself");
    }
    if (request.params.username.toLowerCase() === session.sub.toLowerCase() && !hasPermission(targetBits, PermissionFlag.manageUsers)) {
      reply.code(400);
      return createHttpErrorEnvelope(request.id, 400, "you can't remove your own ability to manage users");
    }
    if (wouldOrphanPermission(request.params.username, PermissionFlag.manageUsers, request.body.roleIds)) {
      reply.code(400);
      return createHttpErrorEnvelope(request.id, 400, 'this would leave nobody on the allowlist able to manage users - grant it to someone else first');
    }
    const updated = updateAllowedUserRoles(request.params.username, request.body.roleIds, session.sub);
    if (!updated) {
      reply.code(404);
      return createHttpErrorEnvelope(request.id, 404, 'not on the allowlist');
    }
    if (typeof request.body.priority === 'number' && Number.isFinite(request.body.priority)) {
      setUserPriority(request.params.username, request.body.priority, session.sub);
    }
    return updated;
  });

  server.delete<DashboardUserDeleteRoute>('/v1/dashboard/users/:username', {
    schema: getRouteContract('DELETE', '/v1/dashboard/users/:username'),
    preHandler: canManageUsers,
  }, (request, reply) => {
    if (wouldOrphanPermission(request.params.username, PermissionFlag.manageUsers, null)) {
      reply.code(400);
      return createHttpErrorEnvelope(request.id, 400, 'this would leave nobody on the allowlist able to manage users - grant it to someone else first');
    }
    if (!removeAllowedUser(request.params.username, getFastifySession(request)!.sub)) {
      reply.code(404);
      return createHttpErrorEnvelope(request.id, 404, 'not on the allowlist');
    }
    return { ok: true };
  });
};
