import { describeHttpError } from '#util/httpError.js';
import { throwIfAborted } from '#util/abort.js';
import { getAppleAccountVaultStatus } from '#appleAccountVault.js';

const DEFAULT_ITUNES_COUNTRY = 'US';
const DEFAULT_ITUNES_LANGUAGE = 'en_us';

async function defaultStorefrontCountry(): Promise<string> {
  let status: ReturnType<typeof getAppleAccountVaultStatus>;
  try {
    status = getAppleAccountVaultStatus();
  } catch {
    return DEFAULT_ITUNES_COUNTRY;
  }
  if (status.storefrontCountry) return status.storefrontCountry;
  if (!status.accountConfigured) return DEFAULT_ITUNES_COUNTRY;
  try {
    const { refreshAppleAccountStorefrontCountry } = await import('#offlineAppStore.js');
    await refreshAppleAccountStorefrontCountry();
  } catch {}
  try {
    const refreshedStatus = getAppleAccountVaultStatus();
    if (refreshedStatus.storefrontCountry) return refreshedStatus.storefrontCountry;
    if (refreshedStatus.accountConfigured) throw new Error('configured Apple Account storefront could not be determined');
    return DEFAULT_ITUNES_COUNTRY;
  } catch {
    throw new Error('configured Apple Account storefront could not be determined');
  }
}

async function buildItunesUrl(endpoint: 'lookup' | 'search', params: Record<string, string>): Promise<string> {
  const query = new URLSearchParams({ country: params.country ?? await defaultStorefrontCountry(), lang: DEFAULT_ITUNES_LANGUAGE, ...params });
  return `https://itunes.apple.com/${endpoint}?${query.toString()}`;
}

export interface ItunesLookupResult {
  version: string;
  bundleId: string;
  trackId: number;
  fileSizeBytes?: number;
  minimumOsVersion?: string;
}

export interface ItunesAppMetadata {
  bundleId: string;
  trackId: number;
  trackName: string;
  sellerName: string;
  artworkUrl: string;
  version: string;
  fileSizeBytes?: number;
  category?: string;
  description?: string;
  screenshots?: string[];
  releaseNotes?: string;
  price?: number;
  formattedPrice?: string;
  currency?: string;
}

interface ItunesLookupResponse {
  resultCount: number;
  results: Array<{
    version: string;
    bundleId: string;
    trackId: number;
    fileSizeBytes?: number;
    minimumOsVersion?: string;
    trackName?: string;
    sellerName?: string;
    artworkUrl60?: string;
    artworkUrl100?: string;
    artworkUrl512?: string;
    primaryGenreName?: string;
    description?: string;
    screenshotUrls?: string[];
    releaseNotes?: string;
    price?: number;
    formattedPrice?: string;
    currency?: string;
  }>;
}

function parseFileSizeBytes(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export async function lookupCurrentVersion(bundleId: string, signal?: AbortSignal, storefrontCountry?: string): Promise<ItunesLookupResult> {
  if (storefrontCountry !== undefined && !/^[A-Z]{2}$/.test(storefrontCountry)) throw new Error('country must be a two-letter uppercase storefront code');
  throwIfAborted(signal);
  const url = await buildItunesUrl('lookup', { bundleId, ...(storefrontCountry ? { country: storefrontCountry } : {}) });
  throwIfAborted(signal);
  const res = await fetch(url, { signal });
  throwIfAborted(signal);
  if (!res.ok) throw new Error(describeHttpError('itunes lookup failed', res));

  const body = (await res.json()) as ItunesLookupResponse;
  throwIfAborted(signal);
  const result = body.results[0];
  if (body.resultCount < 1 || !result) throw new Error(`itunes lookup returned no results for ${bundleId}`);

  return {
    version: result.version,
    bundleId: result.bundleId,
    trackId: result.trackId,
    fileSizeBytes: parseFileSizeBytes(result.fileSizeBytes),
    minimumOsVersion: result.minimumOsVersion,
  };
}

async function lookupMetadata(params: Record<string, string>, signal?: AbortSignal): Promise<ItunesAppMetadata> {
  throwIfAborted(signal);
  const url = await buildItunesUrl('lookup', params);
  throwIfAborted(signal);
  const res = await fetch(url, { signal });
  throwIfAborted(signal);
  if (!res.ok) throw new Error(describeHttpError('itunes lookup failed', res));

  const body = (await res.json()) as ItunesLookupResponse;
  throwIfAborted(signal);
  const result = body.results[0];
  if (body.resultCount < 1 || !result || !result.trackName) {
    throw new Error(`itunes lookup returned no metadata for ${params.bundleId ?? params.id}`);
  }

  return {
    bundleId: result.bundleId,
    trackId: result.trackId,
    trackName: result.trackName,
    sellerName: result.sellerName ?? '',
    artworkUrl: result.artworkUrl512 || result.artworkUrl100 || result.artworkUrl60 || '',
    version: result.version,
    fileSizeBytes: parseFileSizeBytes(result.fileSizeBytes),
    category: result.primaryGenreName,
    description: result.description,
    screenshots: result.screenshotUrls?.slice(0, 10),
    releaseNotes: result.releaseNotes,
    price: result.price,
    formattedPrice: result.formattedPrice,
    currency: result.currency,
  };
}

export function lookupAppMetadata(bundleId: string): Promise<ItunesAppMetadata> {
  return lookupMetadata({ bundleId });
}

export function lookupAppMetadataByTrackId(trackId: number, country?: string, signal?: AbortSignal): Promise<ItunesAppMetadata> {
  if (!Number.isSafeInteger(trackId) || trackId < 1) throw new Error('trackId must be a positive integer');
  if (country !== undefined && !/^[A-Z]{2}$/.test(country)) throw new Error('country must be a two-letter uppercase storefront code');
  return lookupMetadata({ id: String(trackId), entity: 'software', ...(country ? { country } : {}) }, signal);
}

export interface ItunesSearchResult {
  bundleId: string;
  trackId: number;
  trackName: string;
  version: string;
  sellerName: string;
  artworkUrl: string;
  price: number;
  category?: string;
  minimumOsVersion?: string;
}

interface ItunesSearchResponse {
  results: Array<{
    bundleId: string;
    trackId: number;
    trackName: string;
    version: string;
    sellerName: string;
    artworkUrl60?: string;
    artworkUrl100?: string;
    price: number;
    primaryGenreName?: string;
    minimumOsVersion?: string;
  }>;
}

export async function searchApps(term: string, limit = 10): Promise<ItunesSearchResult[]> {
  const url = await buildItunesUrl('search', { entity: 'software', limit: String(limit), term });
  const res = await fetch(url);
  if (!res.ok) throw new Error(describeHttpError('itunes search failed', res));

  const body = (await res.json()) as ItunesSearchResponse;
  return body.results.map((r) => ({
    bundleId: r.bundleId,
    trackId: r.trackId,
    trackName: r.trackName,
    version: r.version,
    sellerName: r.sellerName,
    artworkUrl: r.artworkUrl100 || r.artworkUrl60 || '',
    price: r.price,
    category: r.primaryGenreName,
    minimumOsVersion: r.minimumOsVersion,
  }));
}
