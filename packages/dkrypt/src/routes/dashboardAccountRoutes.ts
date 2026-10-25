import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { DashboardEmailTestRoute, DashboardPrefsGetRoute, DashboardPrefsUpdateRoute, DashboardPushPublicKeyRoute, DashboardPushSubscribeRoute, DashboardPushTestRoute, DashboardPushUnsubscribeRoute } from '#dashboardAccountContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { getRouteContract } from '#contracts.js';
import { getAuthProfile } from '#identity.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';
import { resolveNotifyEmail, sendMailToUser } from '#mail.js';
import { getVapidPublicKey, sendPushToUser } from '#push.js';
import { fastifyRequireSession, getFastifySession } from '#session.js';
import { addPushSubscription, getUserPrefs, removePushSubscription, updateUserPrefs, type HomeLayoutPreference, type HomeModuleId, type UserPrefs } from '#store/state.js';
import { defaultShortcutBindings, validateShortcutBindings } from '#shortcutBindings.js';
import { validArtifactFilenameTemplate } from '#artifactFilename.js';

const homeModuleIds: HomeModuleId[] = ['artifacts', 'activeJobs', 'jobHistory'];
const navigationIds = ['home', 'billing', 'keys', 'logs', 'insights', 'docs', 'settings'] as const;
const artifactColumnIds = ['app', 'bundleId', 'version', 'source', 'size', 'created'] as const;
const defaultArtifactLibrary = { groupByApp: false, columns: ['app', 'bundleId', 'version', 'source', 'size'] as const, layouts: [] as NonNullable<UserPrefs['artifactLibrary']>['layouts'] };
const defaultHomeLayout: HomeLayoutPreference = {
  id: 'default',
  name: 'Default',
  order: ['artifacts', 'activeJobs', 'jobHistory'],
  hidden: [],
  collapsed: [],
};

function normalizedPrefs(prefs: UserPrefs): UserPrefs {
  const defaults: UserPrefs = {
    shortcutBindings: { ...defaultShortcutBindings },
    density: 'comfortable',
    sidebarWidth: 256,
    sidebarCollapsed: false,
    homeLayouts: [defaultHomeLayout],
    activeHomeLayoutId: defaultHomeLayout.id,
    viewModes: { artifacts: 'list', jobHistory: 'cards', devices: 'cards' },
    settingsMode: 'basic',
    displayTimeZone: 'system',
    appFavorites: [],
    navigationOrder: [...navigationIds],
    pinnedNavigation: [],
    artifactLibrary: { ...defaultArtifactLibrary, columns: [...defaultArtifactLibrary.columns] },
    artifactFilenameTemplate: '{app}-{version}',
    largeTargets: false,
    oneThumbMode: false,
    decryptUsageAlertThresholds: [],
  };
  const homeLayouts = prefs.homeLayouts ?? [defaultHomeLayout];
  const activeHomeLayoutId = homeLayouts.some((layout) => layout.id === prefs.activeHomeLayoutId)
    ? prefs.activeHomeLayoutId
    : homeLayouts[0]?.id ?? defaultHomeLayout.id;
  return {
    ...defaults,
    ...prefs,
    shortcutBindings: prefs.shortcutBindings && validateShortcutBindings(prefs.shortcutBindings) ? prefs.shortcutBindings : { ...defaultShortcutBindings },
    homeLayouts,
    activeHomeLayoutId,
    viewModes: { artifacts: 'list', jobHistory: 'cards', devices: 'cards', ...prefs.viewModes },
    appFavorites: prefs.appFavorites ?? [],
    navigationOrder: prefs.navigationOrder ?? [...navigationIds],
    pinnedNavigation: prefs.pinnedNavigation ?? [],
    artifactLibrary: { ...defaultArtifactLibrary, ...prefs.artifactLibrary, columns: prefs.artifactLibrary?.columns ?? [...defaultArtifactLibrary.columns] },
    decryptUsageAlertThresholds: prefs.decryptUsageAlertThresholds ?? [],
  };
}

function validHomeLayouts(layouts: HomeLayoutPreference[]): boolean {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const layout of layouts) {
    const normalizedName = layout.name.trim().toLowerCase();
    if (ids.has(layout.id) || names.has(normalizedName) || normalizedName.length === 0) return false;
    ids.add(layout.id);
    names.add(normalizedName);
    if (layout.order.length !== homeModuleIds.length || homeModuleIds.some((moduleId) => !layout.order.includes(moduleId))) return false;
    if ([...layout.hidden, ...layout.collapsed].some((moduleId) => !layout.order.includes(moduleId))) return false;
    if (layout.hidden.some((moduleId) => layout.collapsed.includes(moduleId))) return false;
  }
  return true;
}

function validDisplayTimeZone(value: string): boolean {
  if (value === 'system') return true;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function validNavigationPreferences(order: string[], pinned: string[]): boolean {
  return order.length === navigationIds.length
    && new Set(order).size === navigationIds.length
    && navigationIds.every((id) => order.includes(id))
    && new Set(pinned).size === pinned.length
    && pinned.every((id) => order.includes(id));
}

function validArtifactLibraryPreferences(value: UserPrefs['artifactLibrary']): boolean {
  if (!value || value.columns.length === 0 || value.columns.length > artifactColumnIds.length) return false;
  if (new Set(value.columns).size !== value.columns.length || !value.columns.every((id) => artifactColumnIds.includes(id))) return false;
  const layouts = value.layouts ?? [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const layout of layouts) {
    const name = layout.name.trim().toLowerCase();
    if (!layout.id || ids.has(layout.id) || !name || names.has(name) || layout.columns.length === 0 || layout.columns.length > artifactColumnIds.length || new Set(layout.columns).size !== layout.columns.length || !layout.columns.every((id) => artifactColumnIds.includes(id))) return false;
    ids.add(layout.id);
    names.add(name);
  }
  return value.activeLayoutId === undefined || ids.has(value.activeLayoutId);
}

export const dashboardAccountRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get<DashboardPrefsGetRoute>('/v1/dashboard/me/prefs', { schema: getRouteContract('GET', '/v1/dashboard/me/prefs') }, async (request) => {
    const userId = getFastifySession(request)!.sub;
    return { ...normalizedPrefs(getUserPrefs(userId)), accountEmail: getAuthProfile(userId)?.email };
  });

  server.get<DashboardPushPublicKeyRoute>('/v1/dashboard/push/public-key', { schema: getRouteContract('GET', '/v1/dashboard/push/public-key') }, async () => ({ publicKey: getVapidPublicKey() }));

  server.post<DashboardPushSubscribeRoute>('/v1/dashboard/push/subscribe', { schema: getRouteContract('POST', '/v1/dashboard/push/subscribe') }, async (request) => {
    const userId = getFastifySession(request)!.sub;
    addPushSubscription(userId, request.body);
    return { ok: true };
  });

  server.post<DashboardPushUnsubscribeRoute>('/v1/dashboard/push/unsubscribe', { schema: getRouteContract('POST', '/v1/dashboard/push/unsubscribe') }, async (request) => {
    const userId = getFastifySession(request)!.sub;
    const { endpoint } = request.body;
    removePushSubscription(userId, endpoint);
    return { ok: true };
  });

  server.post<DashboardPushTestRoute>('/v1/dashboard/push/test', { schema: getRouteContract('POST', '/v1/dashboard/push/test') }, async (request) => {
    await sendPushToUser(getFastifySession(request)!.sub, {
      title: 'dkrypt',
      body: 'Push notifications are set up - you\'ll get one of these when your queued decrypts finish.',
    });
    return { ok: true };
  });

  server.post<DashboardEmailTestRoute>('/v1/dashboard/email/test', { schema: getRouteContract('POST', '/v1/dashboard/email/test') }, async (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    if (!resolveNotifyEmail(userId)) return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'set a notification email first'));
    await sendMailToUser(userId, {
      subject: 'dkrypt',
      text: 'Email notifications are set up - you\'ll get one of these when your queued decrypts finish.',
    });
    return { ok: true };
  });

  server.put<DashboardPrefsUpdateRoute>('/v1/dashboard/me/prefs', { schema: getRouteContract('PUT', '/v1/dashboard/me/prefs') }, async (request, reply) => {
    const body = request.body;
    const userId = getFastifySession(request)!.sub;
    const current = normalizedPrefs(getUserPrefs(userId));
    const patch: Partial<UserPrefs> = {};
    if (body.shortcutBindings) {
      const validated = validateShortcutBindings(body.shortcutBindings);
      if (!validated) return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'shortcut bindings conflict or use a browser-reserved key'));
      patch.shortcutBindings = validated;
    }
    if (body.formattingLocale) patch.formattingLocale = body.formattingLocale;
    if (body.interfaceLanguage) patch.interfaceLanguage = body.interfaceLanguage;
    if (body.theme) patch.theme = body.theme;
    if (body.density) patch.density = body.density;
    if (body.sidebarWidth !== undefined) patch.sidebarWidth = body.sidebarWidth;
    if (body.sidebarCollapsed !== undefined) patch.sidebarCollapsed = body.sidebarCollapsed;
    if (body.homeLayouts) patch.homeLayouts = body.homeLayouts.map((layout) => ({ ...layout, name: layout.name.trim() }));
    if (body.activeHomeLayoutId) patch.activeHomeLayoutId = body.activeHomeLayoutId;
    if (body.viewModes) patch.viewModes = { ...normalizedPrefs(getUserPrefs(getFastifySession(request)!.sub)).viewModes, ...body.viewModes };
    if (body.settingsMode) patch.settingsMode = body.settingsMode;
    if (body.displayTimeZone) patch.displayTimeZone = body.displayTimeZone;
    if (body.appFavorites) {
      const seenBundleIds = new Set<string>();
      const favorites = body.appFavorites.filter((favorite) => {
        const bundleId = favorite.bundleId.trim();
        if (!bundleId || seenBundleIds.has(bundleId.toLowerCase())) return false;
        seenBundleIds.add(bundleId.toLowerCase());
        return true;
      }).map((favorite) => ({ bundleId: favorite.bundleId.trim(), trackName: favorite.trackName.trim().slice(0, 120) }));
      patch.appFavorites = favorites;
    }
    if (body.navigationOrder) patch.navigationOrder = body.navigationOrder;
    if (body.pinnedNavigation) patch.pinnedNavigation = body.pinnedNavigation;
    if (body.artifactLibrary) patch.artifactLibrary = {
      ...body.artifactLibrary,
      layouts: body.artifactLibrary.layouts?.map((layout) => ({ ...layout, name: layout.name.trim() })) ?? current.artifactLibrary?.layouts ?? [],
    };
    if (body.artifactFilenameTemplate !== undefined) {
      if (!validArtifactFilenameTemplate(body.artifactFilenameTemplate)) return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'artifact filename template must use app, version, build, or source tokens and cannot contain path characters'));
      patch.artifactFilenameTemplate = body.artifactFilenameTemplate;
    }
    if (body.largeTargets !== undefined) patch.largeTargets = body.largeTargets;
    if (body.oneThumbMode !== undefined) patch.oneThumbMode = body.oneThumbMode;
    if (body.decryptUsageAlertThresholds) {
      const thresholds = [...new Set(body.decryptUsageAlertThresholds)].sort((a, b) => a - b);
      if (thresholds.some((threshold) => ![25, 50, 75, 90, 100].includes(threshold))) {
        return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'decrypt usage alert thresholds must be 25, 50, 75, 90, or 100'));
      }
      patch.decryptUsageAlertThresholds = thresholds;
    }
    if (typeof body.accent === 'string' && /^[a-z-]{1,32}$/.test(body.accent)) patch.accent = body.accent;
    if (typeof body.highContrast === 'boolean') patch.highContrast = body.highContrast;
    if (typeof body.sound === 'boolean') patch.sound = body.sound;
    if (typeof body.pushOnSuccess === 'boolean') patch.pushOnSuccess = body.pushOnSuccess;
    if (typeof body.pushOnFailure === 'boolean') patch.pushOnFailure = body.pushOnFailure;
    if (typeof body.pushOnAlerts === 'boolean') patch.pushOnAlerts = body.pushOnAlerts;
    if (typeof body.pushOnKeyExpiry === 'boolean') patch.pushOnKeyExpiry = body.pushOnKeyExpiry;
    if (typeof body.emailOnSuccess === 'boolean') patch.emailOnSuccess = body.emailOnSuccess;
    if (typeof body.emailOnFailure === 'boolean') patch.emailOnFailure = body.emailOnFailure;
    if (typeof body.emailOnAlerts === 'boolean') patch.emailOnAlerts = body.emailOnAlerts;
    if (typeof body.emailOnKeyExpiry === 'boolean') patch.emailOnKeyExpiry = body.emailOnKeyExpiry;
    if (typeof body.notifyEmail === 'string') {
      const trimmed = body.notifyEmail.trim();
      if (trimmed === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) patch.notifyEmail = trimmed;
    }
    if (typeof body.preferPrimaryDevice === 'boolean') patch.preferPrimaryDevice = body.preferPrimaryDevice;
    const merged = { ...current, ...patch };
    if (merged.displayTimeZone && !validDisplayTimeZone(merged.displayTimeZone)) {
      return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'displayTimeZone must be system or a supported time zone'));
    }
    if (merged.appFavorites && merged.appFavorites.some((favorite) => !favorite.trackName)) {
      return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'app favorites must include a display name'));
    }
    if (merged.navigationOrder && merged.pinnedNavigation && !validNavigationPreferences(merged.navigationOrder, merged.pinnedNavigation)) {
      return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'navigation order must include every tab exactly once and pinned tabs must belong to that order'));
    }
    if (merged.artifactLibrary && !validArtifactLibraryPreferences(merged.artifactLibrary)) {
      return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'artifact columns must be unique supported columns'));
    }
    if (merged.homeLayouts && !validHomeLayouts(merged.homeLayouts)) {
      return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'Home layouts must use each available section exactly once and have unique names and IDs'));
    }
    if (merged.activeHomeLayoutId && !merged.homeLayouts?.some((layout) => layout.id === merged.activeHomeLayoutId)) {
      return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'activeHomeLayoutId must match a saved Home layout'));
    }
    if (body.homeLayouts && !body.activeHomeLayoutId && !body.homeLayouts.some((layout) => layout.id === current.activeHomeLayoutId)) {
      patch.activeHomeLayoutId = body.homeLayouts[0]?.id ?? defaultHomeLayout.id;
    }
    updateUserPrefs(userId, patch);
    return normalizedPrefs(getUserPrefs(userId));
  });
};
