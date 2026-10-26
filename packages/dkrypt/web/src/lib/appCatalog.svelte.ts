import { fetchAppCatalog, refreshAppCatalog as requestAppCatalogRefresh, type AppCatalogEntry, type AppStoreSearchResult } from '#lib/api';

const catalogState = $state<{ byBundleId: Record<string, AppCatalogEntry> }>({ byBundleId: {} });
const inFlight = new Set<string>();
const APP_CATALOG_REVALIDATION_MS = 24 * 60 * 60 * 1000;

function normalizeBundleIds(bundleIds: string[]): string[] {
  return [...new Set(bundleIds.map((bundleId) => bundleId.trim()).filter(Boolean))];
}

function mergeEntries(entries: AppCatalogEntry[]): void {
  if (entries.length === 0) return;
  const next = { ...catalogState.byBundleId };
  for (const entry of entries) {
    if (!entry.bundleId || !entry.displayName) continue;
    const previous = next[entry.bundleId];
    next[entry.bundleId] = {
      ...previous,
      ...entry,
      iconUrl: entry.iconUrl ?? previous?.iconUrl,
      trackId: entry.trackId ?? previous?.trackId,
      sellerName: entry.sellerName ?? previous?.sellerName,
      category: entry.category ?? previous?.category,
      description: entry.description ?? previous?.description,
      screenshots: entry.screenshots ?? previous?.screenshots,
      releaseNotes: entry.releaseNotes ?? previous?.releaseNotes,
      price: entry.price ?? previous?.price,
      metadataFetchedAt: entry.metadataFetchedAt ?? previous?.metadataFetchedAt,
      updatedAt: entry.metadataFetchedAt ? entry.updatedAt : previous?.updatedAt ?? entry.updatedAt,
    };
  }
  catalogState.byBundleId = next;
}

export function primeAppCatalogFromSearch(results: AppStoreSearchResult[]): void {
  mergeEntries(
    results.map((result) => ({
      bundleId: result.bundleId,
      displayName: result.trackName,
      displayNameLanguage: 'en',
      iconUrl: result.artworkUrl,
      trackId: result.trackId,
      sellerName: result.sellerName,
      category: result.category,
      price: result.price,
      updatedAt: Date.now(),
    })),
  );
}

export async function ensureAppCatalog(bundleIds: string[]): Promise<void> {
  const unique = normalizeBundleIds(bundleIds);
  const staleOrMissing = unique.filter((bundleId) => {
    const entry = catalogState.byBundleId[bundleId];
    return (entry?.displayNameLanguage !== 'en' || !entry.metadataFetchedAt || Date.now() - entry.metadataFetchedAt >= APP_CATALOG_REVALIDATION_MS) && !inFlight.has(bundleId);
  }).slice(0, 40);
  if (staleOrMissing.length === 0) return;

  for (const bundleId of staleOrMissing) inFlight.add(bundleId);
  try {
    const { entries } = await fetchAppCatalog(staleOrMissing);
    mergeEntries(entries);
  } catch {
  } finally {
    for (const bundleId of staleOrMissing) inFlight.delete(bundleId);
  }
}

export async function refreshAppCatalog(bundleIds: string[]): Promise<boolean> {
  const unique = normalizeBundleIds(bundleIds).slice(0, 40);
  if (unique.length === 0) return true;
  const { ok, data } = await requestAppCatalogRefresh(unique);
  if (ok) mergeEntries(data.entries);
  return ok;
}

export function appDisplayName(bundleId: string, fallback?: string): string {
  const entry = catalogState.byBundleId[bundleId];
  if (entry && entry.displayNameLanguage !== 'en') return bundleId;
  return entry?.displayName ?? fallback ?? bundleId;
}

export function appIconUrl(bundleId: string): string | undefined {
  return catalogState.byBundleId[bundleId]?.iconUrl;
}

export function appCatalogEntry(bundleId: string): AppCatalogEntry | undefined {
  return catalogState.byBundleId[bundleId];
}
