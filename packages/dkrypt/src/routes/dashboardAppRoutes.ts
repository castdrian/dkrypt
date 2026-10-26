import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type {
  DashboardAppVersionsRoute,
  DashboardAppStorefrontsRoute,
  DashboardAppCatalogStatsRoute,
  DashboardAppMetadataRefreshRoute,
  DashboardAppMetadataRoute,
  DashboardAppSearchRoute,
} from '#dashboardAppCatalogContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { artifactKeyForAppStoreVersion, getArtifactByKey, type ArtifactRecord } from '#artifacts.js';
import { getRouteContract } from '#contracts.js';
import { scopedLogger } from '#logger.js';
import { PermissionFlag } from '#permissions.js';
import { lookupAppMetadata, lookupAppMetadataByTrackId, searchApps, type ItunesAppMetadata, type ItunesSearchResult } from '#appStoreMetadata.js';
import { fastifyRequirePermission, fastifyRequireSession } from '#session.js';
import {
  getAppCatalogEntries,
  getAppCatalogStats,
  upsertAppCatalogEntries,
  type AppCatalogEntry,
} from '#store/state.js';
import { decorateSearchResults, type TestFlightCatalogApp } from '#testflightSubscriptions.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';
import { listAppVersions } from '#versions.js';

type SearchResult = ItunesSearchResult & {
  testflight?: Pick<TestFlightCatalogApp, 'appId' | 'devices' | 'lastVerifiedAt'>;
};

interface DashboardAppServices {
  searchApps: typeof searchApps;
  decorateSearchResults: (results: ItunesSearchResult[]) => Promise<SearchResult[]>;
  lookupAppMetadata: typeof lookupAppMetadata;
  lookupAppMetadataByTrackId: typeof lookupAppMetadataByTrackId;
  getAppCatalogEntries: typeof getAppCatalogEntries;
  getAppCatalogStats: typeof getAppCatalogStats;
  upsertAppCatalogEntries: typeof upsertAppCatalogEntries;
  listAppVersions: typeof listAppVersions;
  artifactKeyForAppStoreVersion: typeof artifactKeyForAppStoreVersion;
  getArtifactByKey: (key: string) => ArtifactRecord | undefined;
}

const defaultServices: DashboardAppServices = {
  searchApps,
  decorateSearchResults,
  lookupAppMetadata,
  lookupAppMetadataByTrackId,
  getAppCatalogEntries,
  getAppCatalogStats,
  upsertAppCatalogEntries,
  listAppVersions,
  artifactKeyForAppStoreVersion,
  getArtifactByKey,
};

const canViewAutomation = fastifyRequirePermission(PermissionFlag.viewAutomation, PermissionFlag.manageAutomation);
const canManageAppCatalog = fastifyRequirePermission(PermissionFlag.manageAutomation);
const bundleIdPattern = /^[A-Za-z0-9.-]{3,200}$/;
const APP_CATALOG_REVALIDATION_MS = 24 * 60 * 60 * 1000;
const STOREFRONT_LOOKUP_CONCURRENCY = 5;
const log = scopedLogger('app-catalog');

function catalogEntryFromMetadata(metadata: ItunesAppMetadata): Omit<AppCatalogEntry, 'updatedAt'> {
  return {
    bundleId: metadata.bundleId,
    displayName: metadata.trackName,
    displayNameLanguage: 'en',
    iconUrl: metadata.artworkUrl,
    trackId: metadata.trackId,
    sellerName: metadata.sellerName,
    category: metadata.category,
    description: metadata.description,
    screenshots: metadata.screenshots,
    releaseNotes: metadata.releaseNotes,
    price: metadata.price,
    metadataFetchedAt: Date.now(),
  };
}

async function fetchCatalogEntries(services: DashboardAppServices, bundleIds: string[]): Promise<AppCatalogEntry[]> {
  const fetched = await Promise.all(bundleIds.map(async (bundleId) => {
    try {
      return catalogEntryFromMetadata(await services.lookupAppMetadata(bundleId));
    } catch {
      return null;
    }
  }));
  return services.upsertAppCatalogEntries(fetched.filter((entry): entry is Omit<AppCatalogEntry, 'updatedAt'> => entry !== null));
}

export function createDashboardAppRoutes(overrides: Partial<DashboardAppServices> = {}): FastifyPluginAsyncTypebox {
  const services = { ...defaultServices, ...overrides };

  return async (server) => {
    server.addHook('preHandler', fastifyRequireSession);
    server.addHook('preHandler', recordFastifyDashboardActivity);

    server.get<DashboardAppSearchRoute>('/v1/dashboard/search', {
      schema: getRouteContract('GET', '/v1/dashboard/search'),
    }, async (request, reply) => {
      const term = request.query.q.trim();
      if (!term) {
        reply.code(400);
        return createHttpErrorEnvelope(request.id, 400, 'query param q is required');
      }

      try {
        const results = await services.decorateSearchResults(await services.searchApps(term));
        services.upsertAppCatalogEntries(results.map((result) => ({
          bundleId: result.bundleId,
          displayName: result.trackName,
          displayNameLanguage: 'en',
          iconUrl: result.artworkUrl,
          trackId: result.trackId,
          sellerName: result.sellerName,
          category: result.category,
        })));
        return { results };
      } catch (error) {
        log.warn('dashboard app search failed', {
          requestId: request.id,
          error: error instanceof Error ? error.message : String(error),
        });
        reply.code(502);
        return {
          error: 'App Store search is temporarily unavailable',
          code: 'app_store_search_failed',
          message: 'App Store search is temporarily unavailable',
          requestId: request.id,
          retryable: true,
        };
      }
    });

    server.get<{ Querystring: { trackId: string } }>('/v1/dashboard/apps/lookup-track', {
      schema: getRouteContract('GET', '/v1/dashboard/apps/lookup-track'),
    }, async (request, reply) => {
      const trackId = Number(request.query.trackId);
      if (!/^\d+$/.test(request.query.trackId) || !Number.isSafeInteger(trackId) || trackId < 1) {
        return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'Invalid App Store app ID'));
      }
      try {
        const metadata = await services.lookupAppMetadataByTrackId(trackId);
        if (metadata.trackId !== trackId) throw new Error('App Store returned a different app');
        services.upsertAppCatalogEntries([catalogEntryFromMetadata(metadata)]);
        return { bundleId: metadata.bundleId, trackName: metadata.trackName, trackId: metadata.trackId };
      } catch (error) {
        log.warn('dashboard App Store link lookup failed', { requestId: request.id, trackId, error: error instanceof Error ? error.message : String(error) });
        return reply.code(502).send(createHttpErrorEnvelope(request.id, 502, 'App Store link could not be resolved'));
      }
    });

    server.get<DashboardAppStorefrontsRoute>('/v1/dashboard/apps/storefronts', {
      schema: getRouteContract('GET', '/v1/dashboard/apps/storefronts'),
    }, async (request, reply) => {
      const trackId = Number(request.query.trackId);
      const countries = [...new Set(request.query.countries.split(',').map((value) => value.trim().toUpperCase()))];
      if (!/^\d+$/.test(request.query.trackId) || !Number.isSafeInteger(trackId) || trackId < 1) {
        return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'Invalid App Store app ID'));
      }
      if (countries.length < 1 || countries.length > 25 || countries.some((country) => !/^[A-Z]{2}$/.test(country))) {
        return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'Choose 1 to 25 two-letter storefront country codes'));
      }

      const storefronts: Array<{ countryCode: string; countryName: string; status: 'available' | 'unavailable' | 'unknown'; price?: number; formattedPrice?: string; currency?: string }> = [];
      for (let offset = 0; offset < countries.length; offset += STOREFRONT_LOOKUP_CONCURRENCY) {
        const batch = countries.slice(offset, offset + STOREFRONT_LOOKUP_CONCURRENCY);
        storefronts.push(...await Promise.all(batch.map(async (countryCode) => {
          const countryName = new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode) ?? countryCode;
          try {
            const metadata = await services.lookupAppMetadataByTrackId(trackId, countryCode, AbortSignal.timeout(10_000));
            if (metadata.trackId !== trackId) throw new Error('App Store returned a different app');
            return {
              countryCode,
              countryName,
              status: 'available' as const,
              price: metadata.price,
              formattedPrice: metadata.formattedPrice,
              currency: metadata.currency,
            };
          } catch (error) {
            const unavailable = error instanceof Error && error.message.startsWith('itunes lookup returned no metadata');
            return { countryCode, countryName, status: unavailable ? 'unavailable' as const : 'unknown' as const };
          }
        })));
      }
      return { trackId, checkedAt: Date.now(), storefronts };
    });

    server.get<DashboardAppVersionsRoute>('/v1/dashboard/versions/:bundleId', {
      schema: getRouteContract('GET', '/v1/dashboard/versions/:bundleId'),
    }, async (request, reply) => {
      const bundleId = request.params.bundleId;
      try {
        const versions = await services.listAppVersions(bundleId, request.query.force === 'true');
        return {
          versions: versions.map((version) => ({
            ...version,
            artifactId: services.getArtifactByKey(services.artifactKeyForAppStoreVersion(
              bundleId,
              version.displayVersion ?? version.externalVersionId ?? 'latest',
              version.externalVersionId,
            ))?.id,
          })),
        };
      } catch (error) {
        log.warn('dashboard App Store versions lookup failed', {
          requestId: request.id,
          bundleId,
          error: error instanceof Error ? error.message : String(error),
        });
        reply.code(502);
        return createHttpErrorEnvelope(request.id, 502, 'App Store version history is temporarily unavailable');
      }
    });

    server.get<DashboardAppMetadataRoute>('/v1/dashboard/apps/metadata', {
      schema: getRouteContract('GET', '/v1/dashboard/apps/metadata'),
    }, async (request) => {
      const rawBundleIds = request.query.bundleIds ?? '';
      const bundleIds = [...new Set(rawBundleIds
        .split(',')
        .map((value) => value.trim())
        .filter((bundleId) => bundleIdPattern.test(bundleId)))].slice(0, 200);
      if (bundleIds.length === 0) return { entries: [] };

      const now = Date.now();
      const existing = new Map(services.getAppCatalogEntries(bundleIds).map((entry) => [entry.bundleId, entry]));
      const staleOrMissing = bundleIds.filter((bundleId) => {
        const entry = existing.get(bundleId);
        return entry?.displayNameLanguage !== 'en' || !entry.metadataFetchedAt || now - entry.metadataFetchedAt >= APP_CATALOG_REVALIDATION_MS;
      }).slice(0, 40);
      if (staleOrMissing.length > 0) await fetchCatalogEntries(services, staleOrMissing);

      return { entries: services.getAppCatalogEntries(bundleIds) };
    });

    server.get<DashboardAppCatalogStatsRoute>('/v1/dashboard/apps/cache', {
      schema: getRouteContract('GET', '/v1/dashboard/apps/cache'),
      preHandler: canViewAutomation,
    }, () => services.getAppCatalogStats());

    server.post<DashboardAppMetadataRefreshRoute>('/v1/dashboard/apps/metadata/refresh', {
      schema: getRouteContract('POST', '/v1/dashboard/apps/metadata/refresh'),
      preHandler: canManageAppCatalog,
    }, async (request, reply) => {
      const bundleIds = [...new Set(request.body.bundleIds.filter(
        (bundleId): bundleId is string => typeof bundleId === 'string' && bundleIdPattern.test(bundleId),
      ))].slice(0, 40);
      if (bundleIds.length === 0) {
        reply.code(400);
        return createHttpErrorEnvelope(request.id, 400, 'at least one valid bundle ID is required');
      }
      return { entries: await fetchCatalogEntries(services, bundleIds) };
    });
  };
}

export const dashboardAppRoutes = createDashboardAppRoutes();
