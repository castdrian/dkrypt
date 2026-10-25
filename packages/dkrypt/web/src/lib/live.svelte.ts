import type { JobHistoryEntry, LogEntry, OverviewPayload } from '#lib/api';
import { DashboardEventSequenceTracker } from '#lib/liveSequence';
import { serverStateCache } from '#lib/serverStateCache.svelte';
import { announceScreenReader } from '#lib/ui.svelte';

export const liveState = $state<{
  overview: OverviewPayload | null;
  logs: LogEntry[];
  historyAdditions: JobHistoryEntry[];
  onlineUsers: Array<{ userId: string; displayName: string }>;
  connected: boolean;
  overviewLoaded: boolean;
  overviewRefreshFailed: boolean;
  disconnectedAt: number | null;
  reconnectAttempts: number;
  stale: boolean;
  lastEventAt: number | null;
  sequenceGap: boolean;
  billingRevision: number;
}>({
	overview: null,
	logs: [],
	historyAdditions: [],
	onlineUsers: [],
	connected: false,
	overviewLoaded: false,
	overviewRefreshFailed: false,
	disconnectedAt: null,
	reconnectAttempts: 0,
	stale: false,
	lastEventAt: null,
	sequenceGap: false,
	billingRevision: 0,
});

let source: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let visibilityListenerInstalled = false;
const sequenceTracker = new DashboardEventSequenceTracker();
let overviewRefresh: Promise<void> | undefined;
let overviewRefreshGeneration = 0;
let liveConnectionRequested = false;
let billingRefreshAfterReconnect = false;

async function refreshOverview(force = false): Promise<void> {
	if (overviewRefresh && !force) return overviewRefresh;
	const requestGeneration = ++overviewRefreshGeneration;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8_000);
	liveState.overviewRefreshFailed = false;
	const refresh = fetch('/v1/dashboard/overview', { signal: controller.signal })
		.then(async (response) => {
			if (requestGeneration !== overviewRefreshGeneration) return;
			if (!response.ok) {
				liveState.overviewRefreshFailed = true;
				return;
			}
			const overview = (await response.json()) as OverviewPayload;
			if (requestGeneration !== overviewRefreshGeneration) return;
			liveState.overview = overview;
			liveState.overviewLoaded = true;
			liveState.sequenceGap = false;
			liveState.stale = false;
			liveState.overviewRefreshFailed = false;
			if (liveState.connected) liveState.disconnectedAt = null;
		})
		.catch(() => {
			if (requestGeneration === overviewRefreshGeneration) liveState.overviewRefreshFailed = true;
		})
		.finally(() => {
			clearTimeout(timeout);
			if (requestGeneration === overviewRefreshGeneration) overviewRefresh = undefined;
		});
	overviewRefresh = refresh;
	return refresh;
}

function scheduleReconnect(): void {
	if (!liveConnectionRequested || reconnectTimer || document.visibilityState === 'hidden') return;
	const delay = Math.min(30_000, 1_000 * 2 ** Math.min(liveState.reconnectAttempts - 1, 5));
	reconnectTimer = setTimeout(() => {
		reconnectTimer = undefined;
		if (liveConnectionRequested && document.visibilityState === 'visible') connectLive();
	}, delay);
}

function installVisibilityListener(): void {
	if (visibilityListenerInstalled) return;
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') {
			if (reconnectTimer) clearTimeout(reconnectTimer);
			reconnectTimer = undefined;
			source?.close();
			source = null;
			liveState.connected = false;
			if (liveState.disconnectedAt === null) liveState.disconnectedAt = Date.now();
			billingRefreshAfterReconnect = true;
			liveState.stale = true;
			serverStateCache.markAllStale();
			return;
		}
		if (liveConnectionRequested && !source) {
			if (reconnectTimer) clearTimeout(reconnectTimer);
			reconnectTimer = undefined;
			liveState.stale = true;
			connectLive();
		}
	});
	visibilityListenerInstalled = true;
}

function readEvent<T>(event: Event): T {
	const value = JSON.parse((event as MessageEvent).data) as T & { sequence?: number; data?: T };
	if (typeof value.sequence === 'number') {
		if (sequenceTracker.receive(value.sequence)) {
			liveState.sequenceGap = true;
			serverStateCache.invalidateAll();
			liveState.billingRevision += 1;
			void refreshOverview(true);
		}
		liveState.lastEventAt = Date.now();
	}
	if (Array.isArray(value)) return value as T;
	if (value.data !== undefined && Object.keys(value).length === 2) return value.data as T;
	const { sequence: _sequence, ...payload } = value as Record<string, unknown>;
	return payload as T;
}

export function connectLive(): void {
  liveConnectionRequested = true;
  installVisibilityListener();
  if (source || document.visibilityState === 'hidden') return;

	const eventSource = new EventSource('/v1/dashboard/events');
  source = eventSource;
  const initialSource = eventSource;
	const requiresFreshOverview =
		liveState.stale ||
		liveState.sequenceGap ||
		liveState.disconnectedAt !== null ||
		liveState.overviewRefreshFailed;
	void refreshOverview(requiresFreshOverview).finally(() => {
		if (source === initialSource) liveState.overviewLoaded = true;
	});

	eventSource.onopen = () => {
		const awaitingFreshOverview = liveState.stale || liveState.sequenceGap;
		sequenceTracker.reset();
		if (billingRefreshAfterReconnect) {
			serverStateCache.invalidateAll();
			liveState.billingRevision += 1;
			billingRefreshAfterReconnect = false;
		}
		liveState.connected = true;
		if (!awaitingFreshOverview) liveState.disconnectedAt = null;
		liveState.reconnectAttempts = 0;
		if (!awaitingFreshOverview) {
			liveState.stale = false;
			liveState.sequenceGap = false;
		}
	};

  eventSource.addEventListener('overview', (e) => {
    liveState.overview = readEvent<OverviewPayload>(e);
    serverStateCache.invalidatePrefix('/v1/dashboard/devices');
    liveState.overviewLoaded = true;
    liveState.connected = true;
    liveState.stale = false;
    liveState.overviewRefreshFailed = false;
    liveState.disconnectedAt = null;
    liveState.reconnectAttempts = 0;
  });

  eventSource.addEventListener('log', (e) => {
    const entry = readEvent<LogEntry>(e);
    serverStateCache.invalidatePrefix('/v1/dashboard/logs');
    liveState.logs = [entry, ...liveState.logs].slice(0, 500);
  });

  eventSource.addEventListener('history', (e) => {
    const entry = readEvent<JobHistoryEntry>(e);
    if (entry.status === 'done' || entry.status === 'failed') announceScreenReader(`${entry.bundleId} decrypt ${entry.status}.`, `job:${entry.id}`);
    serverStateCache.invalidatePrefix('/v1/dashboard/jobs');
    serverStateCache.invalidatePrefix('/v1/dashboard/artifacts');
    serverStateCache.invalidatePrefix('/v1/dashboard/overview');
    liveState.historyAdditions = [entry, ...liveState.historyAdditions].slice(0, 200);
  });

  eventSource.addEventListener('presence', (e) => {
    liveState.onlineUsers = readEvent<Array<{ userId: string; displayName: string }>>(e);
  });

  eventSource.addEventListener('billing', (e) => {
    readEvent(e);
    serverStateCache.invalidatePrefix('/v1/billing/subscriptions');
    serverStateCache.invalidatePrefix('/v1/billing/provider-status');
    liveState.billingRevision += 1;
  });

  eventSource.addEventListener('access-revoked', () => {
    eventSource.close();
    if (source !== eventSource) return;
    source = null;
    liveState.overview = null;
    liveState.logs = [];
    liveState.historyAdditions = [];
    serverStateCache.clear();
    liveState.overviewLoaded = false;
    liveState.stale = true;
    sequenceTracker.reset();
    connectLive();
  });

  eventSource.onerror = () => {
    eventSource.close();
    if (source !== eventSource) return;
    source = null;
    liveState.connected = false;
    if (liveState.disconnectedAt === null) liveState.disconnectedAt = Date.now();
    billingRefreshAfterReconnect = true;
    liveState.stale = true;
    serverStateCache.markAllStale();
    liveState.reconnectAttempts += 1;
    scheduleReconnect();
  };
}

export function disconnectLive(): void {
  liveConnectionRequested = false;
  overviewRefreshGeneration += 1;
  overviewRefresh = undefined;
  source?.close();
  source = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  liveState.overview = null;
  liveState.logs = [];
  liveState.historyAdditions = [];
  liveState.onlineUsers = [];
  liveState.connected = false;
  liveState.overviewLoaded = false;
  liveState.overviewRefreshFailed = false;
  liveState.disconnectedAt = null;
  liveState.reconnectAttempts = 0;
  liveState.stale = false;
  liveState.lastEventAt = null;
  liveState.sequenceGap = false;
  serverStateCache.markAllStale();
  billingRefreshAfterReconnect = false;
  sequenceTracker.reset();
}

export function reconnectLive(resetState = false): void {
  source?.close();
  source = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  if (resetState) {
    liveState.overview = null;
    liveState.logs = [];
    liveState.historyAdditions = [];
    liveState.overviewLoaded = false;
    liveState.overviewRefreshFailed = false;
    liveState.stale = true;
    serverStateCache.invalidateAll();
  }
  connectLive();
}
