import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from '@sinclair/typebox';
import { getAllJobHistory } from '#store/state.js';
import { getActiveJobs } from '#jobs/store.js';
import { listArtifacts } from '#artifacts.js';
import { listAuthProfiles } from '#identity.js';
import { PermissionFlag, hasPermission } from '#permissions.js';
import { fastifyRequireSession, getFastifySession } from '#session.js';
import { getEffectiveDevices, listAllowedUsers, searchAppCatalogEntries, type AppCatalogEntry, type DeviceRecord, type JobHistoryEntry } from '#store/state.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';

const quickSearchQuerySchema = Type.Object({
  q: Type.String({ maxLength: 120 }),
}, { additionalProperties: false });

const quickSearchResultSchema = Type.Object({
  kind: Type.Union([
    Type.Literal('app'),
    Type.Literal('job'),
    Type.Literal('artifact'),
    Type.Literal('device'),
    Type.Literal('user'),
    Type.Literal('settings'),
  ]),
  id: Type.String({ minLength: 1, maxLength: 200 }),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  subtitle: Type.Optional(Type.String({ maxLength: 300 })),
}, { additionalProperties: false });

const quickSearchResponseSchema = Type.Object({
  results: Type.Array(quickSearchResultSchema, { maxItems: 24 }),
}, { additionalProperties: false });

type QuickSearchQuery = Static<typeof quickSearchQuerySchema>;
type QuickSearchResult = Static<typeof quickSearchResultSchema>;
type QuickSearchPermissions = bigint;

interface QuickSearchServices {
  searchAppCatalogEntries: (query: string, limit: number) => AppCatalogEntry[];
  getAllJobHistory: typeof getAllJobHistory;
  getActiveJobs: typeof getActiveJobs;
  listArtifacts: typeof listArtifacts;
  getEffectiveDevices: typeof getEffectiveDevices;
  listAuthProfiles: typeof listAuthProfiles;
  listAllowedUsers: typeof listAllowedUsers;
}

const defaultServices: QuickSearchServices = {
  searchAppCatalogEntries,
  getAllJobHistory,
  getActiveJobs,
  listArtifacts,
  getEffectiveDevices,
  listAuthProfiles,
  listAllowedUsers,
};

const MAX_QUICK_SEARCH_RESULTS = 24;
const MAX_RESULTS_PER_KIND = 8;

function matches(query: string, values: Array<string | undefined>): boolean {
  const normalizedQuery = query.toLowerCase();
  return values.some((value) => value?.toLowerCase().includes(normalizedQuery));
}

function visibleSettings(permissions: QuickSearchPermissions): Array<{ id: string; title: string; keywords: string; any: bigint[]; all?: bigint[] }> {
  return [
    { id: 'personalization', title: 'Personalization', keywords: 'timezone time zone touch targets navigation favorites artifact columns appearance density', any: [] },
    { id: 'notifications', title: 'Notifications', keywords: 'webhook alerts events quiet hours digest', any: [PermissionFlag.viewAutomation, PermissionFlag.manageAutomation] },
    { id: 'storage', title: 'Storage', keywords: 'artifact retention quota cleanup prune', any: [PermissionFlag.manageAutomation], all: [PermissionFlag.requestDecrypt] },
    { id: 'devices', title: 'Devices', keywords: 'usb wifi pairing health setup', any: [PermissionFlag.viewDevices, PermissionFlag.manageDevices] },
    { id: 'doctor', title: 'System', keywords: 'diagnostics health configuration', any: [PermissionFlag.manageDevices] },
    { id: 'users', title: 'Users', keywords: 'members accounts access', any: [PermissionFlag.viewUsers, PermissionFlag.manageUsers] },
    { id: 'roles', title: 'Roles', keywords: 'permissions access', any: [PermissionFlag.viewRoles, PermissionFlag.manageRoles] },
    { id: 'backup', title: 'Backup', keywords: 'restore export', any: [PermissionFlag.viewBackup, PermissionFlag.manageBackup] },
    { id: 'testflight', title: 'TestFlight', keywords: 'subscriptions invites', any: [PermissionFlag.manageTestFlightSubscriptions] },
    { id: 'billing', title: 'Billing', keywords: 'subscription payment stripe crypto', any: [PermissionFlag.viewBilling, PermissionFlag.manageBilling] },
    { id: 'reports', title: 'Support reports', keywords: 'support diagnostics reports issue', any: [PermissionFlag.viewDiagnosticReports] },
  ].filter((section) => (section.any.length === 0 || section.any.some((permission) => hasPermission(permissions, permission))) && (section.all ?? []).every((permission) => hasPermission(permissions, permission)));
}

function jobResult(entry: JobHistoryEntry, catalog: Map<string, AppCatalogEntry>): QuickSearchResult {
  const app = catalog.get(entry.bundleId);
  return {
    kind: 'job',
    id: entry.id,
    title: app?.displayName ?? entry.bundleId,
    subtitle: [entry.versionLabel, entry.status].filter(Boolean).join(' · '),
  };
}

export function createDashboardQuickSearchRoutes(overrides: Partial<QuickSearchServices> = {}): FastifyPluginAsyncTypebox {
  const services = { ...defaultServices, ...overrides };
  return async (server) => {
    server.addHook('preHandler', fastifyRequireSession);
    server.addHook('preHandler', recordFastifyDashboardActivity);

    server.get<{ Querystring: QuickSearchQuery; Reply: { 200: Static<typeof quickSearchResponseSchema> } }>('/v1/dashboard/quick-search', {
      schema: { hide: true, querystring: quickSearchQuerySchema, response: { 200: quickSearchResponseSchema } },
    }, (request) => {
      const session = getFastifySession(request)!;
      const query = request.query.q.trim();
      if (query.length < 2) return { results: [] };

      const catalogEntries = services.searchAppCatalogEntries(query, MAX_RESULTS_PER_KIND);
      const catalog = new Map(catalogEntries.map((entry) => [entry.bundleId, entry]));
      const results: QuickSearchResult[] = [];
      const append = (items: QuickSearchResult[]) => {
        results.push(...items.slice(0, MAX_RESULTS_PER_KIND - results.filter((result) => result.kind === items[0]?.kind).length));
      };
      append(catalogEntries.map((entry) => ({ kind: 'app' as const, id: entry.bundleId, title: entry.displayName, subtitle: entry.bundleId })));

      const canSearchJobs = hasPermission(session.permissions, PermissionFlag.requestDecrypt) || hasPermission(session.permissions, PermissionFlag.viewLogs);
      if (canSearchJobs) {
        const historicalJobs = services.getAllJobHistory()
          .filter((entry) => matches(query, [entry.id, entry.bundleId, entry.versionLabel, catalog.get(entry.bundleId)?.displayName]))
          .slice(0, MAX_RESULTS_PER_KIND)
          .map((entry) => jobResult(entry, catalog));
        const activeJobs = services.getActiveJobs()
          .filter((entry) => matches(query, [entry.id, entry.bundleId, entry.versionLabel, catalog.get(entry.bundleId)?.displayName]))
          .slice(0, MAX_RESULTS_PER_KIND)
          .map((entry) => ({
            kind: 'job' as const,
            id: entry.id,
            title: catalog.get(entry.bundleId)?.displayName ?? entry.bundleId,
            subtitle: [entry.versionLabel, entry.status].filter(Boolean).join(' · '),
          }));
        append([...activeJobs, ...historicalJobs]);
      }

      if (hasPermission(session.permissions, PermissionFlag.requestDecrypt)) {
        const directArtifacts = services.listArtifacts({ query, archived: false, limit: 100 }).artifacts;
        const appArtifacts = catalogEntries.length > 0
          ? services.listArtifacts({ bundleIds: catalogEntries.map((entry) => entry.bundleId), archived: false, limit: 100 }).artifacts
          : [];
        const seenArtifactIds = new Set<string>();
        append([...directArtifacts, ...appArtifacts]
          .filter((artifact) => {
            if (seenArtifactIds.has(artifact.id)) return false;
            seenArtifactIds.add(artifact.id);
            return true;
          })
          .slice(0, MAX_RESULTS_PER_KIND)
          .map((artifact) => ({
            kind: 'artifact' as const,
            id: artifact.id,
            title: catalog.get(artifact.bundleId)?.displayName ?? artifact.bundleId,
            subtitle: [artifact.versionLabel, artifact.channel === 'testflight' ? 'TestFlight' : 'App Store'].filter(Boolean).join(' · '),
          })));
      }

      const canSearchDevices = hasPermission(session.permissions, PermissionFlag.viewDevices) || hasPermission(session.permissions, PermissionFlag.manageDevices);
      if (canSearchDevices) {
        append(services.getEffectiveDevices()
          .filter((device) => matches(query, [device.name, device.udid, device.productType, device.host]))
          .slice(0, MAX_RESULTS_PER_KIND)
          .map((device: DeviceRecord) => ({ kind: 'device' as const, id: device.id, title: device.name, subtitle: [device.productType, device.transport === 'usb' ? 'USB' : 'Wi-Fi'].filter(Boolean).join(' · ') })));
      }

      const canSearchUsers = hasPermission(session.permissions, PermissionFlag.viewUsers) || hasPermission(session.permissions, PermissionFlag.manageUsers);
      if (canSearchUsers) {
        const allowedUsers = new Set(services.listAllowedUsers().map((user) => user.username.toLowerCase()));
        append(services.listAuthProfiles()
          .filter((profile) => allowedUsers.has(profile.userId.toLowerCase()))
          .filter((profile) => matches(query, [profile.userId, profile.username, profile.displayName]))
          .slice(0, MAX_RESULTS_PER_KIND)
          .map((profile) => ({ kind: 'user' as const, id: profile.userId, title: profile.displayName || profile.username, subtitle: `@${profile.username}` })));
      }

      const settings = visibleSettings(session.permissions)
        .filter((section) => matches(query, [section.title, section.id, section.keywords]))
        .map((section) => ({ kind: 'settings' as const, id: section.id, title: section.title, subtitle: 'Settings' }));
      append(settings);
      const kinds: QuickSearchResult['kind'][] = ['app', 'job', 'artifact', 'device', 'user', 'settings'];
      const grouped = new Map<QuickSearchResult['kind'], QuickSearchResult[]>();
      const seen = new Set<string>();
      for (const result of results) {
        const key = `${result.kind}:${result.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        grouped.set(result.kind, [...(grouped.get(result.kind) ?? []), result]);
      }
      const balanced: QuickSearchResult[] = [];
      for (let position = 0; position < MAX_RESULTS_PER_KIND && balanced.length < MAX_QUICK_SEARCH_RESULTS; position += 1) {
        for (const kind of kinds) {
          const result = grouped.get(kind)?.[position];
          if (result) balanced.push(result);
          if (balanced.length === MAX_QUICK_SEARCH_RESULTS) break;
        }
      }
      return { results: balanced };
    });
  };
}

export const dashboardQuickSearchRoutes = createDashboardQuickSearchRoutes();
