<script lang="ts">
	import { onDestroy } from "svelte";
	import { Download, Eye, Grid2X2, History, List, RotateCcw, X } from "lucide-svelte";
	import BundleStatsDialog from "#components/BundleStatsDialog.svelte";
	import JobAttemptCompareDialog from "#features/jobs/JobAttemptCompareDialog.svelte";
	import BulkJobPreviewDialog from "#components/BulkJobPreviewDialog.svelte";
	import AppIcon from "#components/AppIcon.svelte";
	import JobDetailsDialog from "#components/JobDetailsDialog.svelte";
	import CopyButton from "#components/CopyButton.svelte";
	import EmptyState from "#components/EmptyState.svelte";
	import RelativeTime from "#components/RelativeTime.svelte";
	import VirtualizedList from "#components/VirtualizedList.svelte";
	import {
		fetchJobHistory,
		observeJobHistory,
		jobHistoryExportUrl,
		artifactDownloadUrl,
		previewBulkJobReplay,
		queueDecrypt,
		queueTestFlightDecrypt,
		retryJob,
		type BulkJobPreview,
		type JobHistoryEntry,
	} from "#lib/api";
	import {
		appDisplayName,
		appIconUrl,
		ensureAppCatalog,
	} from "#lib/appCatalog.svelte";
	import Badge from "#lib/components/ui/Badge.svelte";
	import Button from "#lib/components/ui/Button.svelte";
	import Card from "#lib/components/ui/Card.svelte";
	import Checkbox from "#lib/components/ui/Checkbox.svelte";
	import Input from "#lib/components/ui/Input.svelte";
	import {
		buttonVariants,
		statusToBadgeVariant,
	} from "#lib/components/ui/variants";
	import { addDecrypt, pushRecentBundleId } from "#lib/decrypts.svelte";
	import { csvCell, debounce, downloadBlob, fmtCalendarDate, fmtSize } from "#lib/format.svelte";
	import { liveState } from "#lib/live.svelte";
	import { createSavedViews } from "#lib/savedViews.svelte";
	import { sessionState } from "#lib/session.svelte";
	import { isServerQueryCancelled, mergeServerPage, serverQueryStatus } from "#lib/serverStateCache.svelte";
	import { categorizeFailure } from "#lib/failureCategory";
	import {
		historyJumpState,
		requestFocusSearch,
		jobDetailJumpState,
		homeViewModesState,
		interfaceLanguageState,
		systemLocalesState,
		showToast,
		tabState,
	} from "#lib/ui.svelte";
	import { getQueryParam, setQueryParams } from "#lib/urlState";
	import { pushHomeViewMode } from "#lib/session.svelte";
	import { resolveInterfaceLanguage } from "#lib/locale";
	import { translateMessage } from "#lib/messages";

	const PAGE_SIZE = typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches ? 8 : 15;
	const interfaceLanguage = $derived(resolveInterfaceLanguage(interfaceLanguageState.value, systemLocalesState.value));
	const viewMessage = (key: 'viewMode.label' | 'viewMode.list' | 'viewMode.cards') => translateMessage(key, interfaceLanguage);

	type SourceFilter = "all" | "manual";
	type StatusFilter = "all" | "done" | "failed";

	interface FilterPreset {
		name: string;
		query: string;
		source: SourceFilter;
		status: StatusFilter;
		queuedBy: string;
		deviceId: string;
		errorQ: string;
		failureCategory: string;
	}

	interface BulkRetryResult {
		historyJobId: string;
		bundleId: string;
		outcome: "queued" | "failed" | "already-active";
		queuedJobId?: string;
		message?: string;
	}

	type HistoryFeedItem = {
		key: string;
		label: string;
		count: number;
		entry: JobHistoryEntry;
		showDateHeader: boolean;
	};

	function normalizeSourceFilter(value: string | null | undefined): SourceFilter {
		return value === "manual" ? "manual" : "all";
	}

	function requesterInitials(name: string): string {
		return name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase())
			.join("") || "?";
	}

	let entries = $state<JobHistoryEntry[]>([]);
	let total = $state(0);
	let nextCursor = $state<string | undefined>(undefined);
	let loaded = $state(false);
	let loadingMore = $state(false);
	let historyError = $state("");
	let historyCacheStatus = $state("");
	let historyRefreshing = $state(false);
	let activeHistoryQueryKey = "";
	let seenIds = new Set<string>();
	let stopObservingHistory: (() => void) | undefined;
	let historyLoadVersion = 0;
	let requeueing = $state<Set<string>>(new Set());
	let searchText = $state(
		getQueryParam("hq") ??
			localStorage.getItem("jobHistorySearchText") ??
			"",
	);
	let activeQuery = $state("");
	let sourceFilter = $state<SourceFilter>(
		normalizeSourceFilter(
			getQueryParam("hsource") ?? localStorage.getItem("jobHistorySourceFilter"),
		),
	);
	let statusFilter = $state<StatusFilter>(
		(getQueryParam("hstatus") as StatusFilter | undefined) ??
			(localStorage.getItem(
				"jobHistoryStatusFilter",
			) as StatusFilter | null) ??
			"all",
	);
	let queuedByFilter = $state(
		getQueryParam("hqueuedBy") ??
			localStorage.getItem("jobHistoryQueuedByFilter") ??
			"",
	);
	let deviceFilter = $state(
		getQueryParam("hdevice") ??
			localStorage.getItem("jobHistoryDeviceFilter") ??
			"",
	);
	let errorFilter = $state(
		getQueryParam("herror") ??
			localStorage.getItem("jobHistoryErrorFilter") ??
			"",
	);
	let failureCategoryFilter = $state(
		getQueryParam("hcat") ??
			localStorage.getItem("jobHistoryFailureCategoryFilter") ??
			"",
	);
	let selected = $state<Set<string>>(new Set());
	let bulkPreviewIds = $state<string[]>([]);
	let bulkRetryResults = $state<BulkRetryResult[] | null>(null);
	const selectedFailedCount = $derived(entries.filter((entry) => isSelectedForBulkReplay(entry, true)).length);
	let bulkRequeueing = $state(false);
	let bulkPreviewOpen = $state(false);
	let bulkPreviewLoading = $state(false);
	let bulkPreview = $state<BulkJobPreview | null>(null);
	const savedViews = createSavedViews<FilterPreset>(
		"jobHistoryFilterPresets",
	);
	let newPresetName = $state("");
	let jobDetailsOpen = $state(Boolean(getQueryParam("job")));
	let jobDetailsId = $state(getQueryParam("job") ?? "");
	let jobDetailsTitle = $state("");

	function applyPreset(p: FilterPreset): void {
		searchText = p.query;
		sourceFilter = normalizeSourceFilter(p.source);
		statusFilter = p.status;
		queuedByFilter = p.queuedBy;
		deviceFilter = p.deviceId;
		errorFilter = p.errorQ;
		failureCategoryFilter = p.failureCategory ?? "";
	}

	function savePreset(): void {
		const name = newPresetName.trim();
		if (!name) return;
		savedViews.save({
			name,
			query: searchText.trim(),
			source: sourceFilter,
			status: statusFilter,
			queuedBy: queuedByFilter.trim(),
			deviceId: deviceFilter.trim(),
			errorQ: errorFilter.trim(),
			failureCategory: failureCategoryFilter.trim(),
		});
		newPresetName = "";
	}

	function removePreset(name: string): void {
		savedViews.remove(name);
	}

	$effect(() => {
		if (tabState.active !== "home") return;
		setQueryParams({
			hq: searchText.trim() || undefined,
			hsource: sourceFilter === "all" ? undefined : sourceFilter,
			hstatus: statusFilter === "all" ? undefined : statusFilter,
			hqueuedBy: queuedByFilter.trim() || undefined,
			hdevice: deviceFilter.trim() || undefined,
			herror: errorFilter.trim() || undefined,
			hcat: failureCategoryFilter.trim() || undefined,
		});
	});

	function matchesFilters(h: JobHistoryEntry): boolean {
		return (
			(!activeQuery ||
				h.bundleId.toLowerCase().includes(activeQuery.toLowerCase())) &&
			(sourceFilter === "all" || h.source === sourceFilter) &&
			(statusFilter === "all" || h.status === statusFilter) &&
			(!queuedByFilter.trim() ||
				(h.queuedBy ?? "")
					.toLowerCase()
					.includes(queuedByFilter.trim().toLowerCase())) &&
			(!deviceFilter.trim() ||
				(h.deviceId ?? "")
					.toLowerCase()
					.includes(deviceFilter.trim().toLowerCase())) &&
			(!errorFilter.trim() ||
				(h.error ?? "")
					.toLowerCase()
					.includes(errorFilter.trim().toLowerCase())) &&
			(!failureCategoryFilter.trim() ||
				(h.status === "failed" &&
					categorizeFailure(h.error) ===
						failureCategoryFilter.trim()))
		);
	}

	async function loadInitial(query: string): Promise<void> {
		const loadVersion = ++historyLoadVersion;
		stopObservingHistory?.();
		loaded = false;
		historyError = "";
		selected = new Set();
		const filters = {
			queuedBy: queuedByFilter.trim() || undefined,
			deviceId: deviceFilter.trim() || undefined,
			errorQ: errorFilter.trim() || undefined,
			failureCategory: failureCategoryFilter.trim() || undefined,
		};
		const source = sourceFilter === "all" ? undefined : sourceFilter;
		const status = statusFilter === "all" ? undefined : statusFilter;
		const historyQuery = {
			cursorOrOffset: undefined,
			limit: PAGE_SIZE,
			q: query || undefined,
			source,
			status,
			opts: filters,
		};
		const historyQueryKey = JSON.stringify(historyQuery);
		const previousHistoryQueryKey = activeHistoryQueryKey;
		activeHistoryQueryKey = historyQueryKey;
		const applyPage = (data: Awaited<ReturnType<typeof fetchJobHistory>>) => {
			entries = mergeServerPage(data.history, entries, previousHistoryQueryKey, historyQueryKey);
			total = data.total;
			nextCursor = data.nextCursor;
			seenIds = new Set(entries.map((entry) => entry.id));
			historyError = "";
			void ensureAppCatalog(entries.map((entry) => entry.bundleId));
			loaded = true;
		};
		stopObservingHistory = observeJobHistory(
			historyQuery,
			(snapshot) => {
				if (loadVersion !== historyLoadVersion) return;
				if (snapshot.data) {
					applyPage(snapshot.data);
					historyCacheStatus = serverQueryStatus(snapshot);
				} else {
					entries = [];
					total = 0;
					nextCursor = undefined;
					seenIds = new Set();
					loaded = false;
					historyCacheStatus = "";
					historyError = snapshot.error ? "Could not load job history. Check your connection and retry." : "";
					if (snapshot.error && !snapshot.isFetching) loaded = true;
				}
				historyRefreshing = snapshot.isFetching;
			},
		);
		try {
			await fetchJobHistory(historyQuery);
			if (loadVersion === historyLoadVersion) loaded = true;
		} catch (error) {
			if (isServerQueryCancelled(error)) return;
			if (loadVersion === historyLoadVersion) {
				loaded = true;
				if (entries.length === 0) historyError = "Could not load job history. Check your connection and retry.";
			}
		}
	}

	onDestroy(() => {
		historyLoadVersion += 1;
		stopObservingHistory?.();
	});

	async function loadMore(): Promise<void> {
		if (!nextCursor) return;
		loadingMore = true;
		try {
			const data = await fetchJobHistory({
				cursorOrOffset: nextCursor,
				limit: PAGE_SIZE,
				q: activeQuery || undefined,
				source: sourceFilter === "all" ? undefined : sourceFilter,
				status: statusFilter === "all" ? undefined : statusFilter,
				opts: {
					queuedBy: queuedByFilter.trim() || undefined,
					deviceId: deviceFilter.trim() || undefined,
					errorQ: errorFilter.trim() || undefined,
					failureCategory: failureCategoryFilter.trim() || undefined,
				},
			});
			const additions = data.history.filter((e) => !seenIds.has(e.id));
			for (const e of additions) seenIds.add(e.id);
			entries = [...entries, ...additions];
			total = data.total;
			nextCursor = data.nextCursor;
			void ensureAppCatalog(data.history.map((entry) => entry.bundleId));
		} catch (error) {
			if (!isServerQueryCancelled(error)) showToast("Could not load more job history", "error");
		} finally {
			loadingMore = false;
		}
	}

	const debouncedSearch = debounce((query: string) => {
		activeQuery = query;
		void loadInitial(query);
	}, 300);

	$effect(() => {
		const id = jobDetailJumpState.id;
		if (id === "") {
			jobDetailsOpen = false;
			jobDetailsId = "";
			jobDetailsTitle = "";
			jobDetailJumpState.id = null;
			return;
		}
		if (!id) return;
		const entry = entries.find((item) => item.id === id);
		jobDetailsId = id;
		jobDetailsTitle = entry
			? entry.versionLabel ? `${appDisplayName(entry.bundleId)} (${entry.versionLabel})` : appDisplayName(entry.bundleId)
			: 'Job details';
		jobDetailsOpen = true;
		setQueryParams({ job: id });
		jobDetailJumpState.id = null;
	});

	$effect(() => {
		if (historyJumpState.bundleId) {
			searchText = historyJumpState.bundleId;
			sourceFilter = "all";
			statusFilter = "all";
			historyJumpState.bundleId = null;
		}
	});

	$effect(() => {
		if (historyJumpState.failureCategory) {
			failureCategoryFilter = historyJumpState.failureCategory;
			statusFilter = "failed";
			historyJumpState.failureCategory = null;
		}
	});

	let hasSearched = false;

	$effect(() => {
		const query = searchText.trim();
		sourceFilter;
		statusFilter;
		queuedByFilter;
		deviceFilter;
		errorFilter;
		failureCategoryFilter;
		if (!hasSearched) {
			hasSearched = true;
			activeQuery = query;
			void loadInitial(query);
		} else {
			debouncedSearch(query);
		}
	});

	$effect(() => {
		localStorage.setItem("jobHistorySearchText", searchText);
	});
	$effect(() => {
		localStorage.setItem("jobHistorySourceFilter", sourceFilter);
	});
	$effect(() => {
		localStorage.setItem("jobHistoryStatusFilter", statusFilter);
	});
	$effect(() => {
		localStorage.setItem("jobHistoryQueuedByFilter", queuedByFilter);
	});
	$effect(() => {
		localStorage.setItem("jobHistoryDeviceFilter", deviceFilter);
	});
	$effect(() => {
		localStorage.setItem("jobHistoryErrorFilter", errorFilter);
	});
	$effect(() => {
		localStorage.setItem(
			"jobHistoryFailureCategoryFilter",
			failureCategoryFilter,
		);
	});

	function clearSearch(): void {
		searchText = "";
	}

	const hasActiveFilters = $derived(
		!!(
			activeQuery ||
			sourceFilter !== "all" ||
			statusFilter !== "all" ||
			queuedByFilter ||
			deviceFilter ||
			errorFilter ||
			failureCategoryFilter
		),
	);
	const advancedFilterCount = $derived(
		[
			queuedByFilter,
			deviceFilter,
			errorFilter,
			failureCategoryFilter,
		].filter((value) => value.trim()).length,
	);

	function clearAllFilters(): void {
		searchText = "";
		sourceFilter = "all";
		statusFilter = "all";
		queuedByFilter = "";
		deviceFilter = "";
		errorFilter = "";
		failureCategoryFilter = "";
	}

	$effect(() => {
		for (const h of liveState.historyAdditions) {
			if (!seenIds.has(h.id) && matchesFilters(h)) {
				entries = [h, ...entries];
				seenIds.add(h.id);
				total += 1;
			}
		}
		void ensureAppCatalog(
			liveState.historyAdditions.map((entry) => entry.bundleId),
		);
	});

	let statsOpen = $state(false);
	let statsBundleId = $state("");
	let statsPreselectIds = $state<string[] | undefined>(undefined);
	let attemptCompareOpen = $state(false);
	let attemptCompareIds = $state<[string, string]>(['', '']);

	function openStats(bundleId: string): void {
		statsBundleId = bundleId;
		statsPreselectIds = undefined;
		statsOpen = true;
	}

	const compareCandidate = $derived.by(() => {
		if (selected.size !== 2) return null;
		const rows = entries.filter((e) => selected.has(e.id));
		if (
			rows.length !== 2 ||
			rows[0].bundleId !== rows[1].bundleId ||
			rows.some((r) => r.status !== "done")
		)
			return null;
		return { bundleId: rows[0].bundleId, ids: rows.map((r) => r.id) };
	});
	const attemptCompareCandidate = $derived.by(() => {
		if (selected.size !== 2) return null;
		const rows = entries.filter((entry) => selected.has(entry.id));
		if (rows.length !== 2 || rows[0]!.bundleId !== rows[1]!.bundleId) return null;
		const buildKey = (entry: JobHistoryEntry) => entry.testflight
			? entry.testflight.appId && entry.testflight.build.id ? `testflight:${entry.testflight.appId}:${entry.testflight.build.id}` : undefined
			: entry.externalVersionId ? `appstore:${entry.externalVersionId}` : entry.versionLabel ? `version:${entry.versionLabel}` : undefined;
		const firstBuildKey = buildKey(rows[0]!);
		const secondBuildKey = buildKey(rows[1]!);
		if (!firstBuildKey || firstBuildKey !== secondBuildKey) return null;
		return { ids: [rows[0]!.id, rows[1]!.id] as [string, string] };
	});

	function openAttemptCompare(): void {
		if (!attemptCompareCandidate) return;
		attemptCompareIds = attemptCompareCandidate.ids;
		attemptCompareOpen = true;
	}

	function openCompare(): void {
		if (!compareCandidate) return;
		statsBundleId = compareCandidate.bundleId;
		statsPreselectIds = compareCandidate.ids;
		statsOpen = true;
	}

	function curlFor(entry: JobHistoryEntry): string {
		if (!entry.artifactId) return "";
		const base = sessionState.publicBaseUrl ?? location.origin;
		const url = new URL(artifactDownloadUrl(entry.artifactId), base).toString();
		return `curl -H "Authorization: Bearer <YOUR_API_KEY>" "${url}" -o ${entry.bundleId}.ipa`;
	}

	function downloadCsv(filename: string, headers: string[], rows: unknown[][]): void {
		const content = [headers, ...rows]
			.map((row) => row.map(csvCell).join(","))
			.join("\n");
		downloadBlob(content, filename, "text/csv");
	}

	async function decryptAgain(entry: JobHistoryEntry, notifySuccess = true): Promise<BulkRetryResult> {
		const { bundleId, testflight, externalVersionId, versionLabel, minimumOsVersion } = entry;
		requeueing = new Set(requeueing).add(entry.id);
		try {
			const { ok, data } = testflight
				? await queueTestFlightDecrypt(
						bundleId,
						testflight.appId,
						testflight.build,
					)
				: await queueDecrypt(bundleId, externalVersionId, versionLabel, false, minimumOsVersion);
			if (!ok) {
				const responseError = (data as unknown as { error?: unknown }).error;
				return {
					historyJobId: entry.id,
					bundleId,
					outcome: "failed",
					message: typeof responseError === "string" ? responseError : "The retry request was rejected",
				};
			}
			addDecrypt({
				id: data.id,
				bundleId,
				trackName: appDisplayName(bundleId),
				versionLabel,
				status: data.status,
				progress: data.progress,
				queue: data.queue,
				artifactId: data.artifactId,
				artifactUrl: data.artifactUrl,
			});
			pushRecentBundleId(bundleId);
			if (notifySuccess) {
				showToast(
					`Queued ${appDisplayName(bundleId)}${versionLabel ? ` (${versionLabel})` : ""}`,
					"success",
				);
			}
			return { historyJobId: entry.id, bundleId, outcome: "queued", queuedJobId: data.id };
		} catch (error) {
			return {
				historyJobId: entry.id,
				bundleId,
				outcome: "failed",
				message: error instanceof Error ? error.message : String(error),
			};
		} finally {
			const next = new Set(requeueing);
			next.delete(entry.id);
			requeueing = next;
		}
	}

	async function retryJobFromHistory(entry: JobHistoryEntry): Promise<void> {
		requeueing = new Set(requeueing).add(entry.id);
		try {
			const { ok, data } = await retryJob(entry.id);
			if (!ok) return;
			addDecrypt({
				id: data.id,
				bundleId: entry.bundleId,
				trackName: appDisplayName(entry.bundleId),
				versionLabel: entry.versionLabel,
				externalVersionId: entry.externalVersionId,
				testflight: entry.testflight,
				status: data.status,
				progress: data.progress,
				queue: data.queue,
				artifactId: data.artifactId,
				artifactUrl: data.artifactUrl,
			});
			pushRecentBundleId(entry.bundleId);
			showToast(`Retried ${appDisplayName(entry.bundleId)}`, "success");
		} finally {
			const next = new Set(requeueing);
			next.delete(entry.id);
			requeueing = next;
		}
	}

	function openJobDetails(entry: JobHistoryEntry): void {
		jobDetailsId = entry.id;
		jobDetailsTitle = entry.versionLabel
			? `${appDisplayName(entry.bundleId)} (${entry.versionLabel})`
			: appDisplayName(entry.bundleId);
		jobDetailsOpen = true;
		setQueryParams({ job: entry.id });
	}

	$effect(() => {
		if (!jobDetailsId || jobDetailsTitle) return;
		const entry = entries.find((item) => item.id === jobDetailsId);
		if (entry) openJobDetails(entry);
	});

	$effect(() => {
		if (!jobDetailsOpen && getQueryParam("job")) setQueryParams({ job: undefined });
	});

	function toggleSelect(id: string): void {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
	}

	function toggleSelectAll(): void {
		selected =
			selected.size === entries.length
				? new Set()
				: new Set(entries.map((e) => e.id));
	}

	function isSelectedForBulkReplay(entry: JobHistoryEntry, failedOnly: boolean): boolean {
		return selected.has(entry.id) && (!failedOnly || entry.status === "failed");
	}

	async function openBulkPreview(failedOnly = false): Promise<void> {
		const ids = entries
			.filter((entry) => isSelectedForBulkReplay(entry, failedOnly))
			.map((entry) => entry.id);
		if (ids.length === 0) return;
		bulkPreviewLoading = true;
		bulkPreviewIds = ids;
		bulkPreview = null;
		try {
			bulkPreview = await previewBulkJobReplay(ids);
			bulkPreviewOpen = true;
		} catch {
			bulkPreviewIds = [];
			showToast("Could not prepare the bulk preview", "error");
		} finally {
			bulkPreviewLoading = false;
		}
	}

	async function confirmBulkDecryptAgain(): Promise<void> {
		const requestedIds = [...bulkPreviewIds];
		const previewItems = new Map(bulkPreview?.items.map((item) => [item.id, item]) ?? []);
		bulkPreviewOpen = false;
		if (requestedIds.length === 0) return;
		bulkRequeueing = true;
		bulkRetryResults = null;
		try {
			const results: BulkRetryResult[] = [];
			for (const id of requestedIds) {
				const entry = entries.find((candidate) => candidate.id === id);
				const previewItem = previewItems.get(id);
				if (!entry || !previewItem) {
					results.push({ historyJobId: id, bundleId: entry?.bundleId ?? id, outcome: "failed", message: "Job is no longer available for retry" });
					continue;
				}
				if (previewItem.action === "join-existing") {
					results.push({ historyJobId: id, bundleId: entry.bundleId, outcome: "already-active", message: previewItem.reason });
					continue;
				}
				results.push(await decryptAgain(entry, false));
			}
			bulkRetryResults = results;
			selected = new Set();
			bulkPreview = null;
			bulkPreviewIds = [];
		} finally {
			bulkRequeueing = false;
		}
	}

	function exportBulkRetryResultsCsv(): void {
		if (!bulkRetryResults) return;
		const rows = bulkRetryResults.map((result) => [
			result.historyJobId,
			result.bundleId,
			result.outcome,
			result.queuedJobId ?? "",
			result.message ?? "",
		]);
		downloadCsv(
			"dkrypt-bulk-retry-results.csv",
			["historyJobId", "bundleId", "outcome", "queuedJobId", "message"],
			rows,
		);
	}

	function exportBulkRetryResultsJson(): void {
		if (!bulkRetryResults) return;
		downloadBlob(JSON.stringify(bulkRetryResults, null, 2), "dkrypt-bulk-retry-results.json", "application/json");
	}

	const bulkRetryOutcomeCounts = $derived({
		queued: bulkRetryResults?.filter((result) => result.outcome === "queued").length ?? 0,
		failed: bulkRetryResults?.filter((result) => result.outcome === "failed").length ?? 0,
		alreadyActive: bulkRetryResults?.filter((result) => result.outcome === "already-active").length ?? 0,
	});

	function bulkExportCsv(): void {
		const targets = entries.filter((e) => selected.has(e.id));
		const rows = targets.map((j) => [
			j.bundleId,
			j.versionLabel ?? "",
			j.source,
			j.queuedBy ?? "",
			j.status,
			j.sizeBytes ?? "",
			new Date(j.finishedAt).toISOString(),
			j.error ?? "",
		]);
		downloadCsv(
			"dkrypt-job-history-selected.csv",
			[
				"bundleId",
				"version",
				"source",
				"queuedBy",
				"status",
				"size",
				"finishedAt",
				"error",
			],
			rows,
		);
	}

	function bulkExportJson(): void {
		const targets = entries.filter((e) => selected.has(e.id));
		downloadBlob(
			JSON.stringify(targets, null, 2),
			"dkrypt-job-history-selected.json",
			"application/json",
		);
	}

	function dayLabel(ms: number): string {
		const d = new Date(ms);
		const today = new Date();
		const startOfDay = (x: Date) =>
			new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
		const diffDays = Math.round(
			(startOfDay(today) - startOfDay(d)) / 86_400_000,
		);
		if (diffDays === 0) return "Today";
		if (diffDays === 1) return "Yesterday";
		return fmtCalendarDate(ms, {
			month: "short",
			day: "numeric",
			year:
				d.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
		});
	}

	const grouped = $derived.by(
		(): { label: string; items: JobHistoryEntry[] }[] => {
			const groups: { label: string; items: JobHistoryEntry[] }[] = [];
			for (const e of entries) {
				const label = dayLabel(e.finishedAt);
				const last = groups[groups.length - 1];
				if (last && last.label === label) last.items.push(e);
				else groups.push({ label, items: [e] });
			}
			return groups;
		},
	);
	const historyFeedItems = $derived.by((): HistoryFeedItem[] => {
		return grouped.flatMap((group) =>
			group.items.map((entry, index) => ({
				key: entry.id,
				label: group.label,
				count: group.items.length,
				entry,
				showDateHeader: index === 0,
			})),
		);
	});
</script>

<Card title="Job history" id="job-history">
	{#snippet headerExtra()}
		<div class="one-thumb-job-actions flex flex-wrap items-center gap-1.5" data-selected={selected.size > 0 ? 'true' : 'false'}>
			<div class="inline-flex rounded-md border border-border/70 p-0.5" role="group" aria-label={viewMessage('viewMode.label')}>
				<Button variant={homeViewModesState.value.jobHistory === 'list' ? 'secondary' : 'ghost'} size="icon" class="h-7 w-7" aria-label={viewMessage('viewMode.list')} aria-pressed={homeViewModesState.value.jobHistory === 'list'} onclick={() => void pushHomeViewMode('jobHistory', 'list')}><List class="h-3.5 w-3.5" /></Button>
				<Button variant={homeViewModesState.value.jobHistory === 'cards' ? 'secondary' : 'ghost'} size="icon" class="h-7 w-7" aria-label={viewMessage('viewMode.cards')} aria-pressed={homeViewModesState.value.jobHistory === 'cards'} onclick={() => void pushHomeViewMode('jobHistory', 'cards')}><Grid2X2 class="h-3.5 w-3.5" /></Button>
			</div>
			{#if selected.size > 0}
				{#if compareCandidate}
					<Button size="sm" variant="secondary" onclick={openCompare}
						>Compare selected</Button
					>
				{/if}
				{#if attemptCompareCandidate}
					<Button size="sm" variant="secondary" onclick={openAttemptCompare}>Compare attempts</Button>
				{/if}
				<Button
					size="sm"
					loading={bulkRequeueing || bulkPreviewLoading}
					onclick={() => void openBulkPreview()}
					>Decrypt {selected.size} again</Button
				>
				{#if selectedFailedCount > 0}
					<Button
						size="sm"
						variant="secondary"
						loading={bulkRequeueing || bulkPreviewLoading}
						onclick={() => void openBulkPreview(true)}
						>Retry failed only ({selectedFailedCount})</Button
					>
				{/if}
				<Button size="sm" variant="secondary" onclick={bulkExportCsv}
					>Export {selected.size} CSV</Button
				>
				<Button size="sm" variant="secondary" onclick={bulkExportJson}
					>Export {selected.size} JSON</Button
				>
			{/if}
			<a
				href={jobHistoryExportUrl("csv")}
				download
				class={buttonVariants("secondary", "sm")}>Export CSV</a
			>
			<a
				href={jobHistoryExportUrl("json")}
				download
				class={buttonVariants("secondary", "sm")}>Export JSON</a
			>
		</div>
	{/snippet}
	{#if entries.length > 0}
		<div class="mb-3 inline-flex items-center gap-2 text-xs text-muted">
			<Checkbox
				checked={selected.size === entries.length}
				onCheckedChange={toggleSelectAll}
				aria-label="Select or unselect all loaded jobs"
			/>
			Select all loaded
		</div>
	{/if}
	<div class="mb-3 flex flex-wrap items-center gap-2.5">
		<div class="relative max-w-xs flex-1">
			<Input
				placeholder="Search apps or bundle IDs…"
				bind:value={searchText}
				class="pr-8"
			/>
			{#if searchText}
				<Button
					variant="ghost"
					size="icon"
					class="text-muted hover:text-foreground absolute top-1/2 right-1.5 h-7 w-7 -translate-y-1/2"
					onclick={clearSearch}
					aria-label="Clear search"
					title="Clear search"
				>
					<X class="h-3.5 w-3.5" />
				</Button>
			{/if}
		</div>
		<div class="flex flex-wrap gap-1">
			<Button
				variant={statusFilter === "all" ? "default" : "secondary"}
				onclick={() => (statusFilter = "all")}>All</Button
			>
			<Button
				variant={statusFilter === "done" ? "default" : "secondary"}
				onclick={() => (statusFilter = "done")}>Done</Button
			>
			<Button
				variant={statusFilter === "failed" ? "default" : "secondary"}
				onclick={() => (statusFilter = "failed")}>Failed</Button
			>
		</div>
		<div class="flex flex-wrap gap-1">
			<Button
				variant={sourceFilter === "all" ? "default" : "secondary"}
				onclick={() => (sourceFilter = "all")}>Any source</Button
			>
			<Button
				variant={sourceFilter === "manual" ? "default" : "secondary"}
				onclick={() => (sourceFilter = "manual")}>Manual</Button
			>
		</div>
	</div>

	<details class="border-border mb-3 rounded-lg border">
		<summary
			class="text-muted cursor-pointer px-3 py-2 text-xs font-medium"
		>
			More filters and saved views{advancedFilterCount
				? ` · ${advancedFilterCount} active`
				: ""}
		</summary>
		<div
			class="border-border grid grid-cols-1 gap-2 border-t p-3 sm:grid-cols-3"
		>
			<Input
				placeholder="Queued by username…"
				bind:value={queuedByFilter}
			/>
			<Input placeholder="Device id…" bind:value={deviceFilter} />
			<Input placeholder="Error contains…" bind:value={errorFilter} />
		</div>
		<div
			class="border-border flex flex-wrap items-center gap-1.5 border-t p-3"
		>
			{#if failureCategoryFilter}
				<span
					class="border-accent text-accent inline-flex items-center gap-1.5 rounded-full border pr-1 pl-2.5 py-1 text-[12px]"
				>
					Failure category: {failureCategoryFilter}
					<Button
						variant="ghost"
						size="icon"
						class="hover:text-destructive h-6 w-6 rounded-full p-0"
						onclick={() => (failureCategoryFilter = "")}
						aria-label="Clear failure category filter"
						title="Clear failure category filter"
					>
						<X class="h-3 w-3" />
					</Button>
				</span>
			{/if}
			{#each savedViews.presets as p (p.name)}
				<span
					class="border-border text-muted hover:text-text hover:border-accent inline-flex items-center gap-1 rounded-full border pr-1 pl-2.5 py-1 text-[12px]"
				>
					<Button
						variant="link"
						size="sm"
						class="h-auto p-0 text-xs text-muted"
						onclick={() => applyPreset(p)}>{p.name}</Button
					>
					<Button
						variant="ghost"
						size="icon"
						class="text-muted hover:text-destructive h-6 w-6 rounded-full p-0"
						onclick={() => removePreset(p.name)}
						aria-label="Delete preset {p.name}"
						title="Delete preset"
					>
						<X class="h-3 w-3" />
					</Button>
				</span>
			{/each}
			<div class="flex items-center gap-1.5">
				<Input
					placeholder="Preset name…"
					bind:value={newPresetName}
					class="h-7 w-32 text-xs"
				/>
				<Button
					size="sm"
					variant="secondary"
					disabled={!newPresetName.trim()}
					onclick={savePreset}>Save view</Button
				>
			</div>
		</div>
	</details>
	{#if bulkRetryResults}
		<section class="border-border bg-panel mb-3 space-y-3 rounded-xl border p-3" aria-label="Bulk retry results">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<div>
					<h3 class="text-sm font-semibold">Bulk retry results</h3>
					<p class="text-muted text-xs" role="status" aria-live="polite">
						{bulkRetryOutcomeCounts.queued} queued · {bulkRetryOutcomeCounts.failed} failed · {bulkRetryOutcomeCounts.alreadyActive} already active
					</p>
				</div>
				<div class="flex flex-wrap gap-1.5">
					<Button size="sm" variant="secondary" onclick={exportBulkRetryResultsCsv}>Export retry results CSV</Button>
					<Button size="sm" variant="secondary" onclick={exportBulkRetryResultsJson}>Export retry results JSON</Button>
				</div>
			</div>
			<div class="divide-border divide-y rounded-lg border border-border/70" role="list">
				{#each bulkRetryResults as result (result.historyJobId)}
					<div class="flex flex-wrap items-start justify-between gap-2 px-3 py-2.5" role="listitem">
						<div class="min-w-0">
							<div class="truncate text-xs font-medium">{appDisplayName(result.bundleId)}</div>
							<div class="text-muted break-all font-mono text-[10px]">{result.bundleId}</div>
							{#if result.message}<div class="text-muted mt-1 text-xs">{result.message}</div>{/if}
						</div>
						<span class="text-xs font-medium {result.outcome === 'queued' ? 'text-ok' : result.outcome === 'failed' ? 'text-destructive' : 'text-muted'}">
							{result.outcome === 'already-active' ? 'Already active' : result.outcome === 'queued' ? 'Queued' : 'Failed'}
						</span>
					</div>
				{/each}
			</div>
		</section>
	{/if}
	{#if historyError}
		<div class="border-destructive/40 bg-destructive/5 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs" role="alert">
			<span>{historyError}</span>
			<Button size="sm" variant="secondary" onclick={() => void loadInitial(activeQuery)}>Retry</Button>
		</div>
	{/if}
	{#if historyCacheStatus}
		<div class="border-border/70 text-muted mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs" role="status" aria-live="polite">
			<span>{historyCacheStatus}</span>
			<Button size="sm" variant="secondary" disabled={historyRefreshing} onclick={() => void loadInitial(activeQuery)}>
				{historyRefreshing ? "Refreshing" : "Refresh"}
			</Button>
		</div>
	{/if}

	{#if loaded && entries.length === 0 && !historyError}
		<EmptyState
			icon={History}
			message={hasActiveFilters
				? "No decrypts match these filters."
				: "No decrypts yet."}
		>
			{#snippet action()}
				{#if hasActiveFilters}
					<Button
						size="sm"
						variant="secondary"
						onclick={clearAllFilters}>Clear filters</Button
					>
				{:else}
					<Button
						size="sm"
						variant="secondary"
						onclick={() => requestFocusSearch()}>Queue a decrypt</Button
					>
				{/if}
			{/snippet}
		</EmptyState>
	{:else}
		<div class="history-feed">
			{#if !loaded}
				<div role="status" aria-label="Loading job history">
					{#each Array(5) as _, i (i)}
						<div class="skeleton border-border h-20 border-b" aria-hidden="true"></div>
					{/each}
				</div>
			{:else}
				<VirtualizedList
					items={historyFeedItems}
					itemKey={(item) => item.key}
					estimateSize={(item) => 140 + (item.showDateHeader ? 40 : 0)}
					overscan={4}
					label="Job history entries"
					class="history-feed-{homeViewModesState.value.jobHistory} h-[min(74dvh,860px)] overflow-y-auto"
				>
					{#snippet children(g: HistoryFeedItem)}
					{@const j = g.entry}
					{@const requester = j.requester ?? {
						displayName: j.source === "scheduler" ? "System" : (j.queuedBy ?? "Unknown"),
						username: j.queuedBy,
					}}
					<section>
						{#if g.showDateHeader}
						<div class="border-border mb-1 flex items-center gap-2 border-b pb-2">
							<span
								class="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase"
								>{g.label}</span
							>
							<span class="text-[11px] text-muted"
								>{g.count} job{g.count === 1
									? ""
									: "s"}</span
							>
						</div>
						{/if}
								<article
									class="history-feed-row"
								>
									<div class="history-feed-main min-w-0">
										<div class="history-feed-summary flex min-w-0 items-start gap-3">
											<Checkbox
												class="mt-1"
												checked={selected.has(j.id)}
												onCheckedChange={() => toggleSelect(j.id)}
												aria-label="Select {j.bundleId}"
											/>
											<AppIcon bundleId={j.bundleId} src={appIconUrl(j.bundleId)} label={appDisplayName(j.bundleId)} class="mt-0.5 h-5 w-5 shrink-0" />
											<Button
												variant="link"
												size="sm"
												class="h-auto min-w-0 flex-1 justify-start p-0 text-left text-[12.5px] font-medium whitespace-normal"
												title="View stats for {appDisplayName(j.bundleId)}"
												onclick={() => openStats(j.bundleId)}
											>
												<span class="block min-w-0 break-words">{appDisplayName(j.bundleId)}</span>
											</Button>
										</div>
										<div class="history-feed-meta mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
											<span class="break-words text-muted" title={j.bundleId}>{j.versionLabel ?? "Current App Store release"}</span>
											<span class="shrink-0 text-muted">{fmtSize(j.sizeBytes)}</span>
											<div class="history-feed-status flex min-w-0 flex-wrap items-center gap-2">
												<Badge variant={statusToBadgeVariant(j.status)}>{j.status}</Badge>
												{#if j.warnings?.length}<Badge variant="warning" title={j.warnings.join(" ")}>warning</Badge>{/if}
												<span class="text-muted"><RelativeTime ms={j.finishedAt} /></span>
											</div>
											{#if j.testflight}<Badge variant="secondary">TestFlight</Badge>{/if}
											<span
												class="border-border bg-panel-muted inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border py-0.5 pr-2 pl-1 text-[11px] text-muted"
												title={requester.username ?? requester.displayName}
											>
												{#if requester.avatarUrl}
													<img src={requester.avatarUrl} alt="" class="h-4 w-4 shrink-0 rounded-full object-cover" />
												{:else}
													<span class="bg-panel flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[8px] font-semibold">
														{requesterInitials(requester.displayName)}
													</span>
												{/if}
												<span class="truncate">{requester.displayName}</span>
											</span>
										</div>
									</div>
									<div
										class="history-feed-actions flex min-w-0 flex-nowrap items-center justify-end gap-1 self-start"
									>
										{#if j.status === "failed"}
											<Button data-list-primary-action size="icon" variant="ghost" class="h-8 w-8" onclick={() => openJobDetails(j)} aria-label="Inspect job" title="Inspect job"><Eye class="h-4 w-4" /></Button>
											<Button size="icon" variant="ghost" class="h-8 w-8" loading={requeueing.has(j.id)} onclick={() => retryJobFromHistory(j)} aria-label="Retry failed job" title="Retry failed job"><RotateCcw class="h-4 w-4" /></Button>
										{:else}
											{#if j.downloadUrl}
												<a class={buttonVariants("ghost", "sm")} href={j.downloadUrl} aria-label="Download IPA" title="Download IPA"><Download class="h-4 w-4" /></a>
											{/if}
											<Button data-list-primary-action size="icon" variant="ghost" class="h-8 w-8" onclick={() => openJobDetails(j)} aria-label="Inspect job" title="Inspect job"><Eye class="h-4 w-4" /></Button>
											<Button
												size="icon"
												variant="ghost"
												class="h-8 w-8"
												loading={requeueing.has(j.id)}
												onclick={() => decryptAgain(j)}
												aria-label="Decrypt again"
												title="Decrypt again"
												><RotateCcw class="h-4 w-4" /></Button
											>
										{/if}
										{#if j.artifactId && j.fileAvailable}
											<CopyButton
												text={curlFor(j)}
												title="Copy curl command"
											/>
										{/if}
									</div>
								</article>
					</section>
					{/snippet}
				</VirtualizedList>
			{/if}
		</div>
	{/if}
	{#if loaded && nextCursor}
		<div class="mt-3 flex justify-center">
			<Button
				size="sm"
				variant="secondary"
				loading={loadingMore}
				onclick={loadMore}
			>
				Load more ({total - entries.length} older)
			</Button>
		</div>
	{/if}
</Card>

<BundleStatsDialog
	open={statsOpen}
	bundleId={statsBundleId}
	preselectIds={statsPreselectIds}
	onOpenChange={(v) => (statsOpen = v)}
/>
<JobAttemptCompareDialog bind:open={attemptCompareOpen} ids={attemptCompareIds} />
<JobDetailsDialog bind:open={jobDetailsOpen} jobId={jobDetailsId} title={jobDetailsTitle || "Job details"} />
<BulkJobPreviewDialog
	open={bulkPreviewOpen}
	preview={bulkPreview}
	onOpenChange={(v) => {
		bulkPreviewOpen = v;
		if (!v) {
			bulkPreview = null;
			bulkPreviewIds = [];
		}
	}}
	onConfirm={() => void confirmBulkDecryptAgain()}
/>
