import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { trackBackgroundWork } from '#backgroundWork.js';
import type {
  DashboardTestFlightCatalogRoute,
  DashboardTestFlightCatalogUnsubscribeRoute,
  DashboardTestFlightSubscriptionActionRoute,
  DashboardTestFlightSubscriptionCreateRoute,
  DashboardTestFlightSubscriptionListRoute,
  TestFlightRouteErrorResponse,
} from '#dashboardTestFlightContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { getRouteContract } from '#contracts.js';
import { getAuthProfile } from '#identity.js';
import { PermissionFlag, hasPermission } from '#permissions.js';
import { canViewOperationalDashboard } from '#dashboardAccess.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import {
  approveTestFlightSubscription,
  createTestFlightSubscription,
  denyTestFlightSubscription,
  findTestFlightSubscriptionByInviteCode,
  getTestFlightSubscription,
} from '#store/state.js';
import { paginateCursor } from '#util/cursor.js';
import { log } from '#logger.js';
import {
  getTestFlightCatalogCacheState,
  getVerifiedTestFlightCatalog,
  isImmutableTestFlightBundle,
  normalizeTestFlightInvite,
  refreshTestFlightCatalogInBackground,
  resolveTestFlightInvite,
  subscriptionsForUser,
  syncTestFlightSubscription,
  TestFlightCatalogUnavailableError,
  unsubscribeDeviceTestFlightApp,
  unsubscribeTestFlightSubscription,
  type ResolvedTestFlightInvite,
  type TestFlightCatalogApp,
  type TestFlightCatalogCacheState,
} from '#testflightSubscriptions.js';
import type { TestFlightSubscription } from '#store/state.js';

interface TestFlightRouteServices {
  resolveInvite: (url: string) => Promise<ResolvedTestFlightInvite>;
  getVerifiedCatalog: (options: { requireAllDevices: boolean }) => Promise<TestFlightCatalogApp[]>;
  syncSubscription: (id: string, actor: string) => Promise<TestFlightSubscription | undefined>;
  unsubscribeSubscription: (id: string, actor: string) => Promise<TestFlightSubscription | undefined>;
  getCatalogCacheState: () => TestFlightCatalogCacheState;
  refreshCatalogInBackground: (force: boolean) => void;
  unsubscribeDeviceApp: (bundleId: string, actor: string) => Promise<{ bundleId: string; removedDeviceIds: string[]; failures: string[] }>;
  isImmutableBundle: (bundleId: string | undefined) => boolean;
}

const defaultServices: TestFlightRouteServices = {
  resolveInvite: resolveTestFlightInvite,
  getVerifiedCatalog: getVerifiedTestFlightCatalog,
  syncSubscription: syncTestFlightSubscription,
  unsubscribeSubscription: unsubscribeTestFlightSubscription,
  getCatalogCacheState: getTestFlightCatalogCacheState,
  refreshCatalogInBackground: refreshTestFlightCatalogInBackground,
  unsubscribeDeviceApp: unsubscribeDeviceTestFlightApp,
  isImmutableBundle: isImmutableTestFlightBundle,
};

const canViewSubscriptions = fastifyRequirePermission(PermissionFlag.requestTestFlightSubscriptions, PermissionFlag.manageTestFlightSubscriptions);
const canManageSubscriptions = fastifyRequirePermission(PermissionFlag.manageTestFlightSubscriptions);
const canViewCatalog = fastifyRequirePermission(PermissionFlag.requestDecrypt, PermissionFlag.requestTestFlightSubscriptions, PermissionFlag.manageTestFlightSubscriptions);

function errorCode(status: number): string {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 422) return 'unprocessable_entity';
  if (status === 503) return 'service_unavailable';
  return 'request_error';
}

function dashboardErrorResponse(
  requestId: string,
  status: number,
  message: string,
  extra: Pick<TestFlightRouteErrorResponse, 'alreadySubscribed' | 'subscription'> = {},
): TestFlightRouteErrorResponse {
  return {
    error: message,
    code: errorCode(status),
    message,
    requestId,
    retryable: status >= 500 || status === 429,
    ...extra,
  };
}

function getMutableSubscription(
  id: string,
  services: TestFlightRouteServices,
): { subscription: TestFlightSubscription } | { status: 404 | 409; message: string } {
  const subscription = getTestFlightSubscription(id);
  if (!subscription) return { status: 404, message: 'subscription not found' };
  if (services.isImmutableBundle(subscription.bundleId)) {
    return { status: 409, message: 'Discord TestFlight access is protected and cannot be changed' };
  }
  return { subscription };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canViewTestFlightDeviceDetails(permissions: bigint): boolean {
  return canViewOperationalDashboard(permissions);
}

function visibleSubscription(subscription: TestFlightSubscription, showDeviceDetails: boolean): TestFlightSubscription {
  return showDeviceDetails ? subscription : { ...subscription, devices: [] };
}

function scheduleSync(services: TestFlightRouteServices, id: string, actor: string): void {
  void trackBackgroundWork('testflight-subscription-sync', () => services.syncSubscription(id, actor)).catch((error: unknown) => {
    log.warn('TestFlight subscription synchronization failed', { subscriptionId: id, error: errorMessage(error) });
  });
}

function scheduleUnsubscribe(services: TestFlightRouteServices, id: string, actor: string): void {
  void trackBackgroundWork('testflight-subscription-removal', () => services.unsubscribeSubscription(id, actor)).catch((error: unknown) => {
    log.warn('TestFlight subscription removal failed', { subscriptionId: id, error: errorMessage(error) });
  });
}

export function createDashboardTestFlightRoutes(overrides: Partial<TestFlightRouteServices> = {}): FastifyPluginAsyncTypebox {
  const services = { ...defaultServices, ...overrides };

  return async (server) => {
    server.addHook('preHandler', fastifyRequireSession);
    server.addHook('preHandler', recordFastifyDashboardActivity);

    server.get<DashboardTestFlightSubscriptionListRoute>('/v1/dashboard/testflight/subscriptions', {
      schema: getRouteContract('GET', '/v1/dashboard/testflight/subscriptions'),
      preHandler: canViewSubscriptions,
    }, (request) => {
      const session = getFastifySession(request)!;
      const manager = hasPermission(session.permissions, PermissionFlag.manageTestFlightSubscriptions);
      const showDeviceDetails = canViewTestFlightDeviceDetails(session.permissions);
      const allSubscriptions = subscriptionsForUser(session.sub, manager);
      const { cursor, limit, offset } = request.query;
      const page = paginateCursor(allSubscriptions, {
        cursor,
        offset: cursor ? 0 : offset ?? 0,
        limit: Math.min(limit ?? 50, 100),
        keyOf: (subscription) => [subscription.createdAt, subscription.id],
        order: 'desc',
      });
      return {
        subscriptions: page.items.map((subscription) => ({
          ...visibleSubscription(subscription, showDeviceDetails),
          requestedByDisplayName: getAuthProfile(subscription.requestedBy)?.displayName,
        })),
        total: allSubscriptions.length,
        nextCursor: page.nextCursor,
      };
    });

    server.post<DashboardTestFlightSubscriptionCreateRoute>('/v1/dashboard/testflight/subscriptions', {
      schema: getRouteContract('POST', '/v1/dashboard/testflight/subscriptions'),
      preHandler: canViewSubscriptions,
    }, async (request, reply) => {
      let normalized: ReturnType<typeof normalizeTestFlightInvite>;
      try {
        normalized = normalizeTestFlightInvite(request.body.url);
      } catch (error) {
        reply.code(400);
        return dashboardErrorResponse(request.id, 400, errorMessage(error));
      }
      const session = getFastifySession(request)!;
      const manager = hasPermission(session.permissions, PermissionFlag.manageTestFlightSubscriptions);
      const showDeviceDetails = canViewTestFlightDeviceDetails(session.permissions);
      const existing = findTestFlightSubscriptionByInviteCode(normalized.inviteCode);
      if (existing) {
        if (existing.status === 'approved') {
          if (!manager && existing.requestedBy !== session.sub.toLowerCase()) {
            reply.code(409);
            return dashboardErrorResponse(request.id, 409, 'a subscription already exists for this invite link');
          }
          const message = `${existing.displayName ?? existing.url} is already subscribed`;
          reply.code(409);
          return dashboardErrorResponse(request.id, 409, message, { alreadySubscribed: true, subscription: visibleSubscription(existing, showDeviceDetails) });
        }
        if (!manager && existing.requestedBy !== session.sub.toLowerCase()) {
          reply.code(409);
          return dashboardErrorResponse(request.id, 409, 'a subscription already exists for this invite link');
        }
        if (manager && existing.status === 'pending') {
          const approved = approveTestFlightSubscription(existing.id, session.sub);
          if (approved) scheduleSync(services, approved.id, session.sub);
          reply.code(202);
          return { subscription: visibleSubscription(approved ?? existing, showDeviceDetails) };
        }
        return { subscription: visibleSubscription(existing, showDeviceDetails) };
      }

      try {
        const metadata = await services.resolveInvite(normalized.url);
        if (services.isImmutableBundle(metadata.bundleId)) {
          reply.code(409);
          return dashboardErrorResponse(request.id, 409, 'Discord TestFlight access is protected and cannot be changed');
        }
        const deviceCatalog = await services.getVerifiedCatalog({ requireAllDevices: true });
        const existingDeviceAccess = deviceCatalog.find((entry) => entry.appId === metadata.appId && entry.bundleId === metadata.bundleId);
        if (existingDeviceAccess) {
          const message = `${metadata.displayName} is already subscribed on an enabled device`;
          reply.code(409);
          return dashboardErrorResponse(request.id, 409, message, { alreadySubscribed: true });
        }
        const subscription = createTestFlightSubscription({
          ...normalized,
          ...metadata,
          requestedBy: session.sub,
          status: manager ? 'approved' : 'pending',
        }, session.sub);
        if (!manager && subscription.requestedBy !== session.sub.toLowerCase()) {
          reply.code(409);
          return dashboardErrorResponse(request.id, 409, 'a subscription already exists for this invite link');
        }
        if (manager) scheduleSync(services, subscription.id, session.sub);
        reply.code(manager ? 202 : 201);
        return { subscription: visibleSubscription(subscription, showDeviceDetails) };
      } catch (error) {
        const status = error instanceof TestFlightCatalogUnavailableError ? 503 : 422;
        reply.code(status);
        return dashboardErrorResponse(request.id, status, errorMessage(error));
      }
    });

    server.post<DashboardTestFlightSubscriptionActionRoute>('/v1/dashboard/testflight/subscriptions/:id/approve', {
      schema: getRouteContract('POST', '/v1/dashboard/testflight/subscriptions/:id/approve'),
      preHandler: canManageSubscriptions,
    }, (request, reply) => {
      const lookup = getMutableSubscription(request.params.id, services);
      if ('status' in lookup) {
        reply.code(lookup.status);
        return dashboardErrorResponse(request.id, lookup.status, lookup.message);
      }
      const current = lookup.subscription;
      if (current.status !== 'pending') {
        reply.code(409);
        return dashboardErrorResponse(request.id, 409, `cannot approve a ${current.status} subscription`);
      }
      const subscription = approveTestFlightSubscription(request.params.id, getFastifySession(request)!.sub);
      if (!subscription) {
        reply.code(404);
        return dashboardErrorResponse(request.id, 404, 'subscription not found');
      }
      scheduleSync(services, subscription.id, getFastifySession(request)!.sub);
      reply.code(202);
      return { subscription: visibleSubscription(subscription, canViewTestFlightDeviceDetails(getFastifySession(request)!.permissions)) };
    });

    server.post<DashboardTestFlightSubscriptionActionRoute>('/v1/dashboard/testflight/subscriptions/:id/deny', {
      schema: getRouteContract('POST', '/v1/dashboard/testflight/subscriptions/:id/deny'),
      preHandler: canManageSubscriptions,
    }, (request, reply) => {
      const lookup = getMutableSubscription(request.params.id, services);
      if ('status' in lookup) {
        reply.code(lookup.status);
        return dashboardErrorResponse(request.id, lookup.status, lookup.message);
      }
      const current = lookup.subscription;
      if (current.status !== 'pending') {
        reply.code(409);
        return dashboardErrorResponse(request.id, 409, `cannot deny a ${current.status} subscription`);
      }
      const subscription = denyTestFlightSubscription(request.params.id, getFastifySession(request)!.sub);
      if (!subscription) {
        reply.code(404);
        return dashboardErrorResponse(request.id, 404, 'subscription not found');
      }
      return { subscription: visibleSubscription(subscription, canViewTestFlightDeviceDetails(getFastifySession(request)!.permissions)) };
    });

    server.post<DashboardTestFlightSubscriptionActionRoute>('/v1/dashboard/testflight/subscriptions/:id/sync', {
      schema: getRouteContract('POST', '/v1/dashboard/testflight/subscriptions/:id/sync'),
      preHandler: canManageSubscriptions,
    }, (request, reply) => {
      const lookup = getMutableSubscription(request.params.id, services);
      if ('status' in lookup) {
        reply.code(lookup.status);
        return dashboardErrorResponse(request.id, lookup.status, lookup.message);
      }
      const subscription = lookup.subscription;
      if (subscription.status !== 'approved') {
        reply.code(409);
        return dashboardErrorResponse(request.id, 409, `cannot synchronize a ${subscription.status} subscription`);
      }
      scheduleSync(services, subscription.id, getFastifySession(request)!.sub);
      reply.code(202);
      return { subscription: visibleSubscription(subscription, canViewTestFlightDeviceDetails(getFastifySession(request)!.permissions)) };
    });

    server.post<DashboardTestFlightSubscriptionActionRoute>('/v1/dashboard/testflight/subscriptions/:id/unsubscribe', {
      schema: getRouteContract('POST', '/v1/dashboard/testflight/subscriptions/:id/unsubscribe'),
      preHandler: canViewSubscriptions,
    }, (request, reply) => {
      const subscription = getTestFlightSubscription(request.params.id);
      if (!subscription) {
        reply.code(404);
        return dashboardErrorResponse(request.id, 404, 'subscription not found');
      }
      const session = getFastifySession(request)!;
      const manager = hasPermission(session.permissions, PermissionFlag.manageTestFlightSubscriptions);
      if (!manager && subscription.requestedBy !== session.sub.toLowerCase()) {
        reply.code(403);
        return dashboardErrorResponse(request.id, 403, 'you can only unsubscribe your own TestFlight subscriptions');
      }
      if (services.isImmutableBundle(subscription.bundleId)) {
        reply.code(409);
        return dashboardErrorResponse(request.id, 409, 'Discord TestFlight access cannot be unsubscribed');
      }
      scheduleUnsubscribe(services, subscription.id, session.sub);
      reply.code(202);
      return { subscription: visibleSubscription(subscription, canViewTestFlightDeviceDetails(session.permissions)) };
    });

    server.get<DashboardTestFlightCatalogRoute>('/v1/dashboard/testflight/catalog', {
      schema: getRouteContract('GET', '/v1/dashboard/testflight/catalog'),
      preHandler: canViewCatalog,
    }, (request) => {
      const cache = services.getCatalogCacheState();
      const forceRefresh = request.query.refresh === 'true';
      if (forceRefresh || cache.stale) services.refreshCatalogInBackground(forceRefresh);
      const current = services.getCatalogCacheState();
      const showDeviceDetails = canViewTestFlightDeviceDetails(getFastifySession(request)!.permissions);
      const apps = showDeviceDetails ? cache.apps : cache.apps.map((app) => ({ ...app, devices: [], available: true }));
      return { apps, fetchedAt: cache.fetchedAt, refreshing: forceRefresh || current.refreshing };
    });

    server.post<DashboardTestFlightCatalogUnsubscribeRoute>('/v1/dashboard/testflight/catalog/:bundleId/unsubscribe', {
      schema: getRouteContract('POST', '/v1/dashboard/testflight/catalog/:bundleId/unsubscribe'),
      preHandler: canManageSubscriptions,
    }, async (request, reply) => {
      const bundleId = request.params.bundleId;
      try {
        return await services.unsubscribeDeviceApp(bundleId, getFastifySession(request)!.sub);
      } catch (error) {
        const status = error instanceof TestFlightCatalogUnavailableError ? 503 : services.isImmutableBundle(bundleId) ? 409 : 422;
        reply.code(status);
        return dashboardErrorResponse(request.id, status, errorMessage(error));
      }
    });
  };
}

export const dashboardTestFlightRoutes = createDashboardTestFlightRoutes();
