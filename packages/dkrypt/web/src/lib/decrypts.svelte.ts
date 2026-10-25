import type { AppStoreSearchResult, TFBuild } from '#lib/api';

export interface TrackedDecrypt {
  id: string;
  bundleId: string;
  trackName: string;
  versionLabel?: string;
  externalVersionId?: string;
  testflight?: { appId: number; build: TFBuild };
  status: string;
  progress?: string;
  queue?: { position: number; total: number };
  warnings?: string[];
  error?: string;
  createdAt: number;
  artifactId?: string;
  artifactUrl?: string;
  executionPath?: 'appstore_offline' | 'device' | 'device_fallback';
  attempt?: number;
  finishedAt?: string;
}

const MAX_TRACKED = 30;

function loadDecrypts(): TrackedDecrypt[] {
  try {
    return JSON.parse(localStorage.getItem('myDecrypts') ?? '[]') as TrackedDecrypt[];
  } catch {
    return [];
  }
}

export const myDecryptsState = $state<{ items: TrackedDecrypt[] }>({ items: loadDecrypts() });

function persistDecrypts(): void {
  try {
    localStorage.setItem('myDecrypts', JSON.stringify(myDecryptsState.items));
  } catch {
    // localStorage can throw (quota exceeded, private browsing) - state stays correct in-memory either way.
  }
}

function trimToMax(items: TrackedDecrypt[]): TrackedDecrypt[] {
  if (items.length <= MAX_TRACKED) return items;
  const active = items.filter((d) => d.status !== 'done' && d.status !== 'failed');
  const finished = items.filter((d) => d.status === 'done' || d.status === 'failed');
  const keepFinished = Math.max(0, MAX_TRACKED - active.length);
  const keptFinished = new Set(finished.slice(0, keepFinished).map((d) => d.id));
  return items.filter((d) => d.status !== 'done' && d.status !== 'failed' ? true : keptFinished.has(d.id));
}

export const highlightJobIdState = $state<{ id: string | null }>({ id: null });

export function addDecrypt(entry: Omit<TrackedDecrypt, 'createdAt'> & { createdAt?: number }): void {
  myDecryptsState.items = trimToMax([{ ...entry, createdAt: entry.createdAt ?? Date.now() }, ...myDecryptsState.items]);
  persistDecrypts();
  highlightJobIdState.id = entry.id;
}

export function updateDecrypt(id: string, patch: Partial<TrackedDecrypt>): void {
  myDecryptsState.items = myDecryptsState.items.map((d) => (d.id === id ? { ...d, ...patch } : d));
  persistDecrypts();
}

export function dismissDecrypt(id: string): void {
  myDecryptsState.items = myDecryptsState.items.filter((d) => d.id !== id);
  persistDecrypts();
}

function loadRecentBundleIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem('recentBundleIds') ?? '[]') as string[];
  } catch {
    return [];
  }
}

export const recentBundleIdsState = $state<{ items: string[] }>({ items: loadRecentBundleIds() });

export function pushRecentBundleId(bundleId: string): void {
  const items = [bundleId, ...recentBundleIdsState.items.filter((b) => b !== bundleId)].slice(0, 8);
  recentBundleIdsState.items = items;
  localStorage.setItem('recentBundleIds', JSON.stringify(items));
}

export function removeRecentBundleId(bundleId: string): void {
  const items = recentBundleIdsState.items.filter((b) => b !== bundleId);
  recentBundleIdsState.items = items;
  localStorage.setItem('recentBundleIds', JSON.stringify(items));
}

export interface FavoriteApp {
  bundleId: string;
  trackName: string;
}

function loadStarredApps(): FavoriteApp[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem('starredApps') ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((app): app is AppStoreSearchResult => !!app && typeof app === 'object' && typeof app.bundleId === 'string' && typeof app.trackName === 'string')
      .map(({ bundleId, trackName }) => ({ bundleId, trackName }));
  } catch {
    return [];
  }
}

export const starredAppsState = $state<{ items: FavoriteApp[] }>({ items: loadStarredApps() });

export function isStarredBundleId(bundleId: string): boolean {
  return starredAppsState.items.some((a) => a.bundleId === bundleId);
}

export function toggleStarredApp(app: AppStoreSearchResult): void {
  const items = isStarredBundleId(app.bundleId)
    ? starredAppsState.items.filter((favorite) => favorite.bundleId !== app.bundleId)
    : [{ bundleId: app.bundleId, trackName: app.trackName }, ...starredAppsState.items].slice(0, 50);
  starredAppsState.items = items;
}

export function replaceStarredApps(items: FavoriteApp[]): void {
  starredAppsState.items = items.slice(0, 50).map(({ bundleId, trackName }) => ({ bundleId, trackName }));
}

export function readLegacyStarredApps(): Array<{ bundleId: string; trackName: string }> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem('starredApps') ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((app): app is AppStoreSearchResult => !!app && typeof app === 'object' && typeof app.bundleId === 'string' && typeof app.trackName === 'string')
      .map(({ bundleId, trackName }) => ({ bundleId, trackName }));
  } catch {
    return [];
  }
}

export function clearLegacyStarredApps(): void {
  localStorage.removeItem('starredApps');
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'myDecrypts') myDecryptsState.items = loadDecrypts();
    else if (e.key === 'recentBundleIds') recentBundleIdsState.items = loadRecentBundleIds();
  });
}
