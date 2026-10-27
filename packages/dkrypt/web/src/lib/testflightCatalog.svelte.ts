import { fetchTestFlightCatalog, type TestFlightCatalogApp } from '#lib/api';
import { sessionState } from '#lib/session.svelte';
import { persistTestFlightCatalog, readPersistedTestFlightCatalog } from '#lib/testFlightCatalogPersistence';
import { resetTestFlightCatalogState, testFlightCatalogState } from '#lib/testFlightCatalogState.svelte';

export { testFlightCatalogState } from '#lib/testFlightCatalogState.svelte';

const REFRESHING_POLL_DELAY_MS = 2_000;
const NORMAL_REFRESH_DELAY_MS = 5 * 60_000;
const FAILED_REFRESH_DELAY_MS = 2 * 60_000;

let catalogGeneration = 0;
let loadedGeneration = -1;
let loadPromise: { generation: number; promise: Promise<void> } | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

function currentUserId(): string | undefined {
  const sub = sessionState.sub?.trim().toLowerCase();
  return sessionState.loggedIn && sub ? sub : undefined;
}

function isCurrentCatalogGeneration(userId: string, generation: number): boolean {
  return catalogGeneration === generation
    && testFlightCatalogState.ownerId === userId
    && currentUserId() === userId;
}

function catalogForCurrentViewer(apps: TestFlightCatalogApp[]): TestFlightCatalogApp[] {
  return apps;
}

function ensureCatalogOwner(userId: string): number {
  if (testFlightCatalogState.ownerId === userId) return catalogGeneration;

  catalogGeneration += 1;
  loadedGeneration = -1;
  loadPromise = undefined;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = undefined;
  resetTestFlightCatalogState();
  testFlightCatalogState.ownerId = userId;

  const cached = readPersistedTestFlightCatalog(userId);
  if (cached) {
    testFlightCatalogState.apps = catalogForCurrentViewer(cached.apps);
    testFlightCatalogState.fetchedAt = cached.fetchedAt;
    testFlightCatalogState.refreshing = true;
  }

  return catalogGeneration;
}

function scheduleRefresh(userId: string, generation: number, delay: number): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    if (isCurrentCatalogGeneration(userId, generation)) void loadCatalog(false, true, userId);
  }, delay);
}

async function loadCatalog(force: boolean, ignoreLoaded: boolean, requestedUserId?: string): Promise<void> {
  const userId = requestedUserId ?? currentUserId();
  if (!userId || currentUserId() !== userId) return;
  const generation = ensureCatalogOwner(userId);

  if (loadPromise?.generation === generation) {
    await loadPromise.promise;
    if (!isCurrentCatalogGeneration(userId, generation) || !force) return;
  }
  if (!force && !ignoreLoaded && loadedGeneration === generation) return;

  testFlightCatalogState.loading = testFlightCatalogState.apps.length === 0;
  if (testFlightCatalogState.apps.length > 0) testFlightCatalogState.refreshing = true;

  let pending: Promise<void>;
  pending = fetchTestFlightCatalog(force)
    .then((data) => {
      if (!isCurrentCatalogGeneration(userId, generation)) return;
      const preserveCachedApps = data.refreshing === true
        && data.apps.length === 0
        && testFlightCatalogState.apps.length > 0;
      if (!preserveCachedApps) {
        testFlightCatalogState.apps = catalogForCurrentViewer(data.apps);
        testFlightCatalogState.fetchedAt = data.fetchedAt;
      }
      testFlightCatalogState.refreshing = data.refreshing === true;
      testFlightCatalogState.error = undefined;
      loadedGeneration = generation;
      if (!preserveCachedApps && data.fetchedAt !== undefined) persistTestFlightCatalog(userId, testFlightCatalogState.apps, data.fetchedAt);
      if (testFlightCatalogState.refreshing) scheduleRefresh(userId, generation, REFRESHING_POLL_DELAY_MS);
      else scheduleRefresh(userId, generation, NORMAL_REFRESH_DELAY_MS);
    })
    .catch((error) => {
      if (!isCurrentCatalogGeneration(userId, generation)) return;
      testFlightCatalogState.error = error instanceof Error ? error.message : String(error);
      testFlightCatalogState.refreshing = false;
      loadedGeneration = generation;
      scheduleRefresh(userId, generation, FAILED_REFRESH_DELAY_MS);
    })
    .finally(() => {
      if (!isCurrentCatalogGeneration(userId, generation)) return;
      testFlightCatalogState.loading = false;
      if (loadPromise?.generation === generation && loadPromise.promise === pending) loadPromise = undefined;
    });

  loadPromise = { generation, promise: pending };
  return pending;
}

export function loadTestFlightCatalog(force = false): Promise<void> {
  const userId = currentUserId();
  if (!userId) return Promise.resolve();
  ensureCatalogOwner(userId);
  return loadCatalog(force, false, userId);
}
