<script lang="ts">
	import { onMount } from "svelte";
	import { CircleAlert, Clock3, Ellipsis, FlaskConical, History, Link2, RefreshCw, Star, X } from "lucide-svelte";
	import BatchDecryptDialog from "#components/BatchDecryptDialog.svelte";
	import CopyButton from "#components/CopyButton.svelte";
	import EmptyState from "#components/EmptyState.svelte";
	import JobPreflightDialog from "#components/JobPreflightDialog.svelte";
	import {
		fetchDecryptPreflight,
		fetchAppStorefrontContext,
		fetchJobEta,
		lookupAppStoreTrack,
		queueDecrypt,
		queueTestFlightDecrypt,
		searchApps,
		type AppStoreSearchResult,
		type DecryptPreflight,
		type TestFlightCatalogApp,
		type TFBuild,
	} from "#lib/api";
	import Badge from "#lib/components/ui/Badge.svelte";
	import Button from "#lib/components/ui/Button.svelte";
	import Card from "#lib/components/ui/Card.svelte";
	import Input from "#lib/components/ui/Input.svelte";
	import { statusToBadgeVariant } from "#lib/components/ui/variants";
	import {
		appDisplayName,
		appIconUrl,
		ensureAppCatalog,
		primeAppCatalogFromSearch,
	} from "#lib/appCatalog.svelte";
	import {
		addDecrypt,
		isStarredBundleId,
		myDecryptsState,
		pushRecentBundleId,
		recentBundleIdsState,
		removeRecentBundleId,
		starredAppsState,
		toggleStarredApp,
	} from "#lib/decrypts.svelte";
	import { debounce, fmtDateTime, fmtDurationApprox } from "#lib/format.svelte";
	import { liveState } from "#lib/live.svelte";
	import { requestNotificationPermission } from "#lib/notifications";
	import { PermissionFlag } from "#lib/permissions";
import { pushAppFavoritesPref, sessionHasPermission, sessionState } from "#lib/session.svelte";
	import {
		formatSearchResultMeta,
		shouldShowSearchResultStatus,
	} from "#lib/searchResultPresentation";
import { decryptSearchJumpState, SHARE_TARGET_PARAMS, signupDecryptContinuationState, showToast } from "#lib/ui.svelte";
	import { loadTestFlightCatalog, testFlightCatalogState } from "#lib/testflightCatalog.svelte";
	import { cn } from "#lib/utils";
	import TestFlightPickerDialog from "#features/testflight/TestFlightPickerDialog.svelte";
	import TestFlightInviteDialog from "#features/testflight/TestFlightInviteDialog.svelte";
	import VersionPickerDialog from "#features/jobs/VersionPickerDialog.svelte";

	let term = $state("");
	let results = $state<AppStoreSearchResult[]>([]);
	let loading = $state(false);
	let searched = $state(false);
	let highlighted = $state(-1);
	let storefrontCountry = $state("");
	let accountStorefrontCountry = $state<string | undefined>();
	let storefrontCountries = $state<Array<{ code: string; name: string }>>([]);
	let inputEl: HTMLInputElement | undefined = $state();
	let searchToken = 0;
	let queueing = $state<Set<string>>(new Set());
	let resultDetailsOpen = $state<Set<string>>(new Set());
	let preflightOpen = $state(false);
	let preflight = $state<DecryptPreflight | null>(null);
	let pendingQueue = $state<{
		bundleId: string;
		trackName: string;
		externalVersionId?: string;
		versionLabel?: string;
		minimumOsVersion?: string;
		testflight?: { appId: number; build: TFBuild };
		deviceId?: string;
	} | null>(null);

	const statusByBundle = $derived.by(() => {
		const map = new Map<string, string>();
		for (const d of myDecryptsState.items)
			if (!map.has(d.bundleId)) map.set(d.bundleId, d.status);
		for (const j of liveState.overview?.activeJobs ?? [])
			if (!map.has(j.bundleId)) map.set(j.bundleId, j.status);
		return map;
	});

	async function runSearch(q: string): Promise<void> {
		const trimmed = q.trim();
		const sharedUrl = trimmed.match(/https?:\/\/[^\s<>]+/i)?.[0]?.replace(/[),.;!?]+$/, "");
		if (sharedUrl) {
			try {
				const url = new URL(sharedUrl);
				const hostname = url.hostname.replace(/^www\./, "");
				if (hostname === "testflight.apple.com" && /^\/join\/[A-Za-z0-9]+\/?$/.test(url.pathname)) {
					if (!canRequestTestFlight) {
						showToast("You don’t have permission to request TestFlight apps", "error");
						return;
					}
					inviteInitialUrl = url.toString();
					inviteDialogOpen = true;
					return;
				}
				if (["apps.apple.com", "itunes.apple.com"].includes(hostname)) {
					const trackId = url.pathname.match(/(?:^|\/)id(\d+)(?:\/|$)/)?.[1];
					if (trackId) {
						const linkedCountry = url.pathname.match(/^\/([a-z]{2})\/app\//i)?.[1]?.toUpperCase();
						const country = storefrontCountry || linkedCountry;
						if (!storefrontCountry && linkedCountry) storefrontCountry = linkedCountry;
						const lookup = await lookupAppStoreTrack(Number(trackId), country);
						term = lookup.bundleId;
						void runSearch(lookup.bundleId);
						return;
					}
				}
			} catch {
				showToast("That Apple app link couldn’t be opened", "error");
				return;
			}
		}
		const token = ++searchToken;
		if (!trimmed) {
			results = [];
			searched = false;
			return;
		}
		loading = true;
		try {
			const data = await searchApps(trimmed, storefrontCountry || undefined);
			if (token !== searchToken) return;
			if ("error" in data) {
				showToast(data.error, "error");
				results = [];
			} else {
				results = data.results;
				primeAppCatalogFromSearch(data.results);
			}
			searched = true;
			highlighted = -1;
		} catch (err) {
			if (token !== searchToken) return;

			const alreadyHandled =
				err instanceof Error &&
				(err.message === "network error" ||
					err.message === "unauthorized");
			if (!alreadyHandled)
				showToast("App Store search failed - try again", "error");
			results = [];
			searched = true;
		} finally {
			if (token === searchToken) loading = false;
		}
	}

	function submitSharedValue(value: string): void {
		const trimmed = value.trim();
		if (!trimmed) return;
		term = trimmed;
		void runSearch(trimmed);
	}

	onMount(() => {
		void fetchAppStorefrontContext().then((context) => {
			storefrontCountries = context.countries;
			accountStorefrontCountry = context.accountCountry;
		}).catch(() => {});
		const params = new URLSearchParams(location.search);
		const sharedValue = SHARE_TARGET_PARAMS.map((key) => params.get(key)).find(Boolean);
		if (sharedValue) {
			for (const key of SHARE_TARGET_PARAMS) params.delete(key);
			const query = params.toString();
			history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
			submitSharedValue(sharedValue);
		}
	});

	function onStorefrontChange(): void {
		if (term.trim()) void runSearch(term);
	}

	const debouncedSearch = debounce((q: string) => void runSearch(q), 400);

	function onInput(): void {
		if (!term.trim()) {
			debouncedSearch.cancel();
			searchToken++;
			results = [];
			searched = false;
			loading = false;
			return;
		}
		debouncedSearch(term);
	}

	function clearSearch(): void {
		term = "";
		onInput();
		inputEl?.focus();
	}

	const canDecrypt = $derived(
		sessionHasPermission(PermissionFlag.requestDecrypt),
	);
	const canRequestTestFlight = $derived(
		sessionHasPermission(PermissionFlag.requestTestFlightSubscriptions),
	);
	const testFlightAvailabilityStale = $derived.by(() => {
		const refreshing = testFlightCatalogState.refreshing;
		return testFlightCatalogState.error !== undefined || (!refreshing && testFlightCatalogState.apps.some((app) => Date.now() - app.lastVerifiedAt > 30 * 60_000));
	});

	function testFlightAvailabilityTitle(app: TestFlightCatalogApp): string {
		return `${appDisplayName(app.bundleId, app.bundleId)} · ${app.bundleId} · Access last checked ${fmtDateTime(app.lastVerifiedAt)}`;
	}

	let versionsOpen = $state(false);
	let versionsBundleId = $state("");
	let versionsTrackName = $state("");

	function openVersions(bundleId: string, trackName: string): void {
		versionsBundleId = bundleId;
		versionsTrackName = trackName;
		versionsOpen = true;
	}

	async function queueNow(request: NonNullable<typeof pendingQueue>): Promise<void> {
		requestNotificationPermission();
		queueing = new Set(queueing).add(request.bundleId);
		try {
		const { ok, data } = request.testflight
				? await queueTestFlightDecrypt(request.bundleId, request.testflight.appId, request.testflight.build, false, request.deviceId)
				: await queueDecrypt(request.bundleId, request.externalVersionId, request.versionLabel, false, request.minimumOsVersion);
			if (!ok) return;
			addDecrypt({
				id: data.id,
				bundleId: request.bundleId,
				trackName: request.trackName,
				versionLabel: request.versionLabel,
				externalVersionId: request.externalVersionId,
				testflight: request.testflight,
				status: data.status,
				progress: data.progress,
				queue: data.queue,
				artifactId: data.artifactId,
				artifactUrl: data.artifactUrl,
				freeTierResult: data.freeTierResult,
				temporaryResultExpiresAt: data.temporaryResultExpiresAt,
			});
			pushRecentBundleId(request.bundleId);
			showToast(`Queued ${request.trackName}${request.versionLabel ? ` (${request.versionLabel})` : ""}`, "success");
		} finally {
			const next = new Set(queueing);
			next.delete(request.bundleId);
			queueing = next;
		}
	}

	async function confirmPreflight(): Promise<void> {
		const request = pendingQueue;
		preflightOpen = false;
		pendingQueue = null;
		preflight = null;
		if (request) await queueNow(request);
	}

	async function queue(
		bundleId: string,
		trackName: string,
		externalVersionId?: string,
		versionLabel?: string,
		minimumOsVersion?: string,
	): Promise<void> {
		if (!canDecrypt) return;
		try {
			pendingQueue = { bundleId, trackName, externalVersionId, versionLabel, minimumOsVersion };
			preflight = await fetchDecryptPreflight({ bundleId, versionLabel });
			preflightOpen = true;
		} catch {
			pendingQueue = null;
			preflight = null;
			showToast("Could not check device readiness", "error");
		}
	}

	function decryptVersion(
		bundleId: string,
		externalVersionId: string,
		label: string,
		minimumOsVersion?: string,
	): void {
		versionsOpen = false;
		void queue(bundleId, versionsTrackName, externalVersionId, label, minimumOsVersion);
	}

	let testflightOpen = $state(false);
	let testflightBundleId = $state("");
	let testflightAppId = $state(0);
	let testflightTrackName = $state("");
	let testflightDevices = $state<Array<{ id: string; name: string }>>([]);
	let inviteDialogOpen = $state(false);
	let inviteInitialUrl = $state('');

	function openTestFlight(
		bundleId: string,
		appId: number,
		trackName: string,
		devices: Array<{ id: string; name: string }> = [],
	): void {
		testflightBundleId = bundleId;
		testflightAppId = appId;
		testflightTrackName = trackName;
		testflightDevices = devices;
		testflightOpen = true;
	}

	async function decryptTestFlightBuild(
		bundleId: string,
		appId: number,
		build: TFBuild,
		label: string,
		deviceId?: string,
	): Promise<void> {
		if (!canDecrypt) return;
		testflightOpen = false;
		try {
			pendingQueue = {
				bundleId,
				trackName: testflightTrackName,
				versionLabel: `TestFlight ${label}`,
				testflight: { appId, build },
				deviceId,
			};
			preflight = await fetchDecryptPreflight({ bundleId, versionLabel: `TestFlight ${label}`, testflight: true, installSizeBytes: build.fileSize, deviceId });
			preflightOpen = true;
		} catch {
			pendingQueue = null;
			preflight = null;
			showToast("Could not check device readiness", "error");
		}
	}

	function onKeydown(e: KeyboardEvent): void {
		if (e.key === "Enter") {
			e.preventDefault();
			const target = highlighted >= 0 ? results[highlighted] : undefined;
			if (target && target.price === 0)
				void queue(target.bundleId, target.trackName);
			else void runSearch(term);
		} else if (e.key === "ArrowDown" && results.length > 0) {
			e.preventDefault();
			highlighted = Math.min(highlighted + 1, results.length - 1);
		} else if (e.key === "ArrowUp" && results.length > 0) {
			e.preventDefault();
			highlighted = Math.max(highlighted - 1, -1);
		}
	}

	function pickRecent(bundleId: string): void {
		term = bundleId;
		void runSearch(bundleId);
	}

	function removeRecent(bundleId: string): void {
		removeRecentBundleId(bundleId);
		showToast("Removed from recents", "success", {
			action: {
				label: "Undo",
				onClick: () => pushRecentBundleId(bundleId),
			},
		});
	}

	function showStarredApp(app: AppStoreSearchResult): void {
		searchToken++;
		debouncedSearch.cancel();
		loading = false;
		results = [app];
		searched = true;
		highlighted = -1;
	}

	function updateStarredApp(app: AppStoreSearchResult): void {
		toggleStarredApp(app);
		void pushAppFavoritesPref(starredAppsState.items);
	}

	function removeStarredApp(bundleId: string): void {
		starredAppsState.items = starredAppsState.items.filter((favorite) => favorite.bundleId !== bundleId);
		void pushAppFavoritesPref(starredAppsState.items);
	}

	function testFlightShortcut(app: TestFlightCatalogApp): AppStoreSearchResult {
		return {
			bundleId: app.bundleId,
			trackId: app.appId,
			trackName: appDisplayName(app.bundleId, app.bundleId),
			version: "",
			sellerName: app.sellerName ?? "",
			artworkUrl: app.iconUrl ?? "",
			price: 0,
			category: app.category,
			testflight: { appId: app.appId, devices: app.devices, lastVerifiedAt: app.lastVerifiedAt },
		};
	}

	function showTestFlightShortcut(app: TestFlightCatalogApp): void {
		showStarredApp(testFlightShortcut(app));
	}

	let etaByBundle = $state<Record<string, number | null>>({});
	let etaRangeByBundle = $state<Record<string, { p50Ms: number | null; p95Ms: number | null }>>({});
	let etaConfidenceByBundle = $state<Record<string, string>>({});
	let etaSamplesByBundle = $state<Record<string, number>>({});
	const fetchedEtaBundles = new Set<string>();

	$effect(() => {
		const bundleId = decryptSearchJumpState.bundleId;
		if (!bundleId) return;
		decryptSearchJumpState.bundleId = null;
		term = bundleId;
		void runSearch(bundleId);
	});

	$effect(() => {
		const request = signupDecryptContinuationState.request;
		if (!request) return;
		signupDecryptContinuationState.request = null;
		term = request.bundleId;
		void runSearch(request.bundleId);
		if (request.channel === 'testflight' && request.inviteUrl) {
			inviteInitialUrl = request.inviteUrl;
			inviteDialogOpen = true;
		}
	});

	$effect(() => {
		for (const r of results) {
			if (fetchedEtaBundles.has(r.bundleId)) continue;
			fetchedEtaBundles.add(r.bundleId);
			fetchJobEta(r.bundleId)
				.then((res) => {
					etaByBundle[r.bundleId] = res.avgMs;
					etaRangeByBundle[r.bundleId] = { p50Ms: res.p50Ms, p95Ms: res.p95Ms };
					etaConfidenceByBundle[r.bundleId] = res.confidence;
					etaSamplesByBundle[r.bundleId] = res.sampleCount;
				})
				.catch(() => fetchedEtaBundles.delete(r.bundleId));
		}
	});

	$effect(() => {
		void ensureAppCatalog([
			...recentBundleIdsState.items,
			...starredAppsState.items.map((app) => app.bundleId),
			...results.map((result) => result.bundleId),
			...testFlightCatalogState.apps.map((app) => app.bundleId),
		]);
	});

	$effect(() => {
		if (!sessionState.loggedIn || !sessionState.sub || sessionState.permissions === undefined || (!canDecrypt && !canRequestTestFlight)) return;
		void loadTestFlightCatalog();
	});

	function decryptButtonTitle(bundleId: string): string | undefined {
		const avg = etaByBundle[bundleId];
		const range = etaRangeByBundle[bundleId];
		const estimate = range?.p50Ms !== null && range?.p50Ms !== undefined && range.p95Ms !== null
			? `Likely ${fmtDurationApprox(range.p50Ms)}–${fmtDurationApprox(range.p95Ms)}`
			: avg ? `Usually ${fmtDurationApprox(avg)}` : undefined;
		return estimate ? `${estimate} · ${etaConfidenceByBundle[bundleId]} confidence from ${etaSamplesByBundle[bundleId]} jobs` : undefined;
	}

	function curlFor(bundleId: string): string {
		const base = sessionState.publicBaseUrl ?? location.origin;
		return `curl -H "Authorization: Bearer <YOUR_API_KEY>" "${base}/v1/decrypt?bundleId=${bundleId}" -o ${bundleId}.ipa`;
	}

	function toggleResultDetails(bundleId: string): void {
		const next = new Set(resultDetailsOpen);
		if (next.has(bundleId)) next.delete(bundleId);
		else next.add(bundleId);
		resultDetailsOpen = next;
	}

	export function focusSearch(bundleId?: string | null): void {
		if (bundleId) {
			term = bundleId;
			void runSearch(bundleId);
		}
		inputEl?.focus();
	}

	let batchOpen = $state(false);

	export function openBatch(): void {
		if (canDecrypt) batchOpen = true;
	}
</script>

<Card title="Decrypt an app">
	{#snippet headerExtra()}
		{#if canDecrypt}
			<Button
				size="sm"
				variant="secondary"
				class="hidden sm:inline-flex"
				onclick={() => (batchOpen = true)}>Batch decrypt</Button
			>
		{/if}
	{/snippet}
	<div class="relative">
		<Input
			bind:ref={inputEl}
			bind:value={term}
			oninput={onInput}
			onkeydown={onKeydown}
			placeholder="Search or paste an App Store or TestFlight link…"
			class={term ? "pr-8" : ""}
		/>
		{#if term}
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
	{#if storefrontCountries.length > 0}
		<div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
			<label for="decrypt-storefront" class="text-muted">Search storefront</label>
			<select id="decrypt-storefront" bind:value={storefrontCountry} onchange={onStorefrontChange} class="h-8 max-w-full rounded-md border border-border bg-panel px-2 text-xs text-text">
				<option value="">Apple Account{accountStorefrontCountry ? ` · ${accountStorefrontCountry}` : " · default"}</option>
				{#each storefrontCountries as country (country.code)}
					<option value={country.code}>{country.name} ({country.code})</option>
				{/each}
			</select>
			{#if storefrontCountry && storefrontCountry !== accountStorefrontCountry}
				<span class="text-muted">Results use this storefront; downloads still use your Apple Account storefront.</span>
			{/if}
		</div>
	{/if}

	{#if canDecrypt}
		<div class="mt-2.5 flex flex-wrap items-center gap-2 sm:hidden">
			<Button
				size="sm"
				variant="secondary"
				onclick={() => (batchOpen = true)}>Batch decrypt</Button
			>
		</div>
	{:else}
		<div class="mt-2.5 text-xs text-muted sm:hidden">
			View-only access. Ask an admin for decrypt permission.
		</div>
	{/if}

	{#if !term.trim() && starredAppsState.items.length > 0}
		<div class="mt-2.5 flex flex-wrap gap-1.5">
			{#each starredAppsState.items as app (app.bundleId)}
				<span
					class="border-border text-muted hover:text-text hover:border-accent inline-flex items-center gap-1 rounded-full border pr-1 pl-1.5 py-1 text-[12px]"
				>
					{#if appIconUrl(app.bundleId)}
						<img
							src={appIconUrl(app.bundleId)}
							alt=""
							class="h-4 w-4 shrink-0 rounded"
						/>
					{/if}
					<Button
						variant="link"
						size="sm"
						class="h-auto max-w-42 justify-start truncate p-0 text-xs text-muted"
						onclick={() => pickRecent(app.bundleId)}
						title={app.bundleId}
						>{appDisplayName(app.bundleId)}</Button
					>
					<Button
						variant="ghost"
						size="icon"
						class="text-warn hover:text-destructive h-6 w-6 rounded-full p-0"
						onclick={() => removeStarredApp(app.bundleId)}
						aria-label="Unstar {appDisplayName(app.bundleId)}"
						title="Unstar"
					>
						<Star class="h-3 w-3" fill="currentColor" />
					</Button>
				</span>
			{/each}
		</div>
	{/if}

	{#if !term.trim() && recentBundleIdsState.items.length > 0}
		<div class="mt-2.5 flex flex-wrap gap-1.5">
			{#each recentBundleIdsState.items as bundleId (bundleId)}
				<span
					class="border-border text-muted hover:text-text hover:border-accent inline-flex items-center gap-1 rounded-full border pr-1 pl-1.5 py-1 text-[11.5px]"
				>
					{#if appIconUrl(bundleId)}
						<img
							src={appIconUrl(bundleId)}
							alt=""
							class="h-4 w-4 shrink-0 rounded"
						/>
					{/if}
					<Button
						variant="link"
						size="sm"
						class="h-auto max-w-42 justify-start truncate p-0 text-left text-xs text-muted"
						onclick={() => pickRecent(bundleId)}
						title={bundleId}>{appDisplayName(bundleId)}</Button
					>
					<Button
						variant="ghost"
						size="icon"
						class="text-muted hover:text-destructive h-6 w-6 rounded-full p-0"
						onclick={() => removeRecent(bundleId)}
						aria-label="Remove {bundleId} from recents"
						title="Remove from recents"
					>
						<X class="h-3 w-3" />
					</Button>
				</span>
			{/each}
		</div>
	{/if}

	{#if !term.trim() && testFlightCatalogState.apps.length > 0}
		<div class="mt-3">
			<div class="mb-1.5 flex items-center justify-between gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted">
				<div class="flex min-w-0 items-center gap-1.5">
					<span>Available via TestFlight</span>
					{#if testFlightCatalogState.refreshing}
						<span role="status" aria-label="Refreshing TestFlight availability" title="Checking current device access"><RefreshCw aria-hidden="true" class="h-3 w-3 animate-spin" /></span>
					{:else if testFlightCatalogState.error}
						<span role="status" aria-label="Showing saved TestFlight results after a refresh failure" title="Showing saved results; the latest access check failed"><CircleAlert aria-hidden="true" class="h-3 w-3 text-warn" /></span>
					{:else if testFlightAvailabilityStale}
						<span role="status" aria-label="TestFlight availability may be out of date" title="Device access was last verified more than 30 minutes ago"><Clock3 aria-hidden="true" class="h-3 w-3" /></span>
					{/if}
				</div>
				{#if canRequestTestFlight}
					<Button size="sm" variant="ghost" class="h-7 px-2 text-[11px] normal-case tracking-normal" onclick={() => (inviteDialogOpen = true)}><Link2 class="h-3.5 w-3.5" /> Request an app</Button>
				{/if}
			</div>
			<div class="flex snap-x gap-2 overflow-x-auto pb-1">
				{#each testFlightCatalogState.apps as app (app.appId)}
					<Button
						variant="outline"
						size="sm"
						class="h-auto min-w-[10rem] shrink-0 snap-start justify-start gap-2 rounded-xl px-2.5 py-2 text-left"
						onclick={() => showTestFlightShortcut(app)}
						title={testFlightAvailabilityTitle(app)}
					>
						{#if app.iconUrl}<img src={app.iconUrl} alt="" class="h-7 w-7 shrink-0 rounded-lg" />{/if}
						<span class="min-w-0">
			<span class="block truncate text-xs font-medium">{appDisplayName(app.bundleId, app.bundleId)}</span>
							<span class="block truncate text-[10px] text-muted">{app.bundleId}</span>
						</span>
					</Button>
				{/each}
			</div>
		</div>
	{/if}

	{#if !term.trim() && testFlightCatalogState.apps.length === 0 && testFlightCatalogState.loading}
		<div class="mt-3 rounded-xl border border-border px-3 py-2.5 text-xs text-muted">
			Checking TestFlight availability…
		</div>
	{:else if !term.trim() && testFlightCatalogState.apps.length === 0 && testFlightCatalogState.error}
		<div class="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border px-3 py-2.5 text-xs text-muted">
			<span role="status" class="inline-flex items-center gap-1.5"><CircleAlert aria-hidden="true" class="h-3.5 w-3.5 text-warn" />Couldn’t check TestFlight availability.</span>
			<div class="flex items-center gap-1.5">
				<Button size="sm" variant="ghost" aria-label="Retry TestFlight availability" onclick={() => void loadTestFlightCatalog(true)}>Retry</Button>
				{#if canRequestTestFlight}<Button size="sm" variant="secondary" onclick={() => (inviteDialogOpen = true)}><Link2 class="h-3.5 w-3.5" /> Request an app</Button>{/if}
			</div>
		</div>
	{:else if !term.trim() && testFlightCatalogState.apps.length === 0 && canRequestTestFlight}
		<div class="mt-3 flex items-center justify-between gap-3 rounded-xl border border-dashed border-border px-3 py-2.5 text-xs text-muted">
			<span>No TestFlight apps yet.</span>
			<Button size="sm" variant="secondary" onclick={() => (inviteDialogOpen = true)}><Link2 class="h-3.5 w-3.5" /> Request an app</Button>
		</div>
	{/if}

	<div class="mt-3.5">
		{#if loading}
			<div
				class="border-border bg-panel-muted/35 animate-pulse rounded-xl border p-3"
			>
				<div class="text-sm text-muted">Searching the App Store…</div>
				<div class="mt-2.5 space-y-2">
					{#each Array(3) as _, i (i)}
						<div class="bg-panel-muted h-10 rounded-lg"></div>
					{/each}
				</div>
			</div>
		{:else if searched && results.length === 0}
			<EmptyState message="No results." />
		{:else}
			{#each results as r, i (r.bundleId)}
				<div
					class={cn(
						"border-border flex animate-[glass-surface-in_220ms_cubic-bezier(0.22,1,0.36,1)] items-center gap-3 border-t py-2.5 first:border-t-0 transition-all duration-200",
						i === highlighted && "bg-panel-muted/80 rounded-xl",
					)}
				>
					{#if r.artworkUrl}
						<img
							src={r.artworkUrl}
							alt=""
							class="h-10 w-10 shrink-0 rounded-lg"
						/>
					{/if}
					<div class="min-w-0 flex-1">
						<div class="text-[13px]">
							{appDisplayName(r.bundleId, r.trackName)}
						</div>
						<div
							class="break-words text-xs leading-4 text-muted"
							title={r.bundleId}
						>
							{formatSearchResultMeta(r)}
						</div>
					</div>
					{#if r.price > 0}
						<Badge
							variant="destructive"
							title="ipadecrypt only supports free apps"
							>Paid</Badge
						>
					{:else}
						<div class="flex shrink-0 items-center gap-1.5">
							<div class="hidden items-center gap-1.5 sm:flex">
								<Button
									variant="ghost"
									size="icon"
									class={cn(
										"h-8 w-8 rounded-md p-0",
										isStarredBundleId(r.bundleId)
											? "text-warn"
											: "text-muted hover:text-text",
									)}
									onclick={() => updateStarredApp(r)}
									aria-label={isStarredBundleId(r.bundleId)
										? `Unstar ${r.bundleId}`
										: `Star ${r.bundleId}`}
									title={isStarredBundleId(r.bundleId)
										? "Unstar"
										: "Star"}
								>
									<Star
										class="h-3.5 w-3.5"
										fill={isStarredBundleId(r.bundleId)
											? "currentColor"
											: "none"}
									/>
								</Button>
								<CopyButton
									text={curlFor(r.bundleId)}
									label="curl"
								/>
								{#if canDecrypt}
									<Button
										size="sm"
										variant="secondary"
										onclick={() =>
											openVersions(
												r.bundleId,
												appDisplayName(
													r.bundleId,
													r.trackName,
												),
											)}
										title="Browse version history"
										aria-label="Browse version history"
									>
										<History class="h-3.5 w-3.5" />
									</Button>
									{#if r.testflight}
										<Button
											size="sm"
											variant="secondary"
											onclick={() =>
												openTestFlight(
													r.bundleId,
													r.testflight?.appId ?? r.trackId,
													appDisplayName(
														r.bundleId,
														r.trackName,
													),
													r.testflight?.devices,
													)}
											title="Browse TestFlight builds"
											aria-label="Browse TestFlight builds"
										>
											<FlaskConical class="h-3.5 w-3.5" />
										</Button>
									{/if}
								{/if}
							</div>
							{#if shouldShowSearchResultStatus(r, statusByBundle)}
								{@const status =
									statusByBundle.get(r.bundleId) ?? ""}
								<Badge variant={statusToBadgeVariant(status)}
									>{status}</Badge
								>
							{:else if canDecrypt}
								<Button
									size="sm"
									loading={queueing.has(r.bundleId)}
									onclick={() =>
										queue(r.bundleId, r.trackName, undefined, undefined, r.minimumOsVersion)}
									title={decryptButtonTitle(r.bundleId)}
								>
									Decrypt
								</Button>
							{:else}
								<Badge
									variant="secondary"
									title="Viewers can't queue decrypts"
									>view only</Badge
								>
							{/if}
							<Button
								size="sm"
								variant="secondary"
								class="sm:hidden"
								onclick={() => toggleResultDetails(r.bundleId)}
								aria-expanded={resultDetailsOpen.has(
									r.bundleId,
								)}
								aria-label="More actions for {r.trackName}"
								title="More actions"
							>
								<Ellipsis class="h-3.5 w-3.5" />
							</Button>
						</div>
					{/if}
				</div>
				{#if r.price === 0 && resultDetailsOpen.has(r.bundleId)}
					<div
						class="border-border flex flex-wrap items-center gap-1.5 border-t py-2 sm:hidden"
					>
						<Button
							variant="ghost"
							size="icon"
							class={cn(
								"h-8 w-8 rounded-md p-0",
								isStarredBundleId(r.bundleId)
									? "text-warn"
									: "text-muted hover:text-text",
							)}
			onclick={() => updateStarredApp(r)}
							aria-label={isStarredBundleId(r.bundleId)
								? `Unstar ${r.bundleId}`
								: `Star ${r.bundleId}`}
							title={isStarredBundleId(r.bundleId)
								? "Unstar"
								: "Star"}
						>
							<Star
								class="h-3.5 w-3.5"
								fill={isStarredBundleId(r.bundleId)
									? "currentColor"
									: "none"}
							/>
						</Button>
						<CopyButton text={curlFor(r.bundleId)} label="curl" />
						{#if canDecrypt}
							<Button
								size="sm"
								variant="secondary"
								onclick={() =>
									openVersions(
										r.bundleId,
										appDisplayName(r.bundleId, r.trackName),
									)}
							>
								<History class="h-3.5 w-3.5" />
								Versions
							</Button>
							{#if r.testflight}
								<Button
									size="sm"
									variant="secondary"
									onclick={() =>
										openTestFlight(
											r.bundleId,
											r.testflight?.appId ?? r.trackId,
											appDisplayName(r.bundleId, r.trackName),
											r.testflight?.devices,
										)}
								>
									<FlaskConical class="h-3.5 w-3.5" />
									TestFlight
								</Button>
							{/if}
						{/if}
					</div>
				{/if}
			{/each}
		{/if}
	</div>
</Card>

<VersionPickerDialog
	open={versionsOpen}
	bundleId={versionsBundleId}
	trackName={versionsTrackName}
	onOpenChange={(v) => (versionsOpen = v)}
	onDecrypt={decryptVersion}
/>

<TestFlightPickerDialog
	open={testflightOpen}
	bundleId={testflightBundleId}
	appId={testflightAppId}
	trackName={testflightTrackName}
	devices={testflightDevices}
	onOpenChange={(v) => (testflightOpen = v)}
	onDecrypt={decryptTestFlightBuild}
/>

<TestFlightInviteDialog open={inviteDialogOpen} initialInviteUrl={inviteInitialUrl} onOpenChange={(value) => (inviteDialogOpen = value)} />

<BatchDecryptDialog open={batchOpen} onOpenChange={(v) => (batchOpen = v)} />

<JobPreflightDialog
	open={preflightOpen}
	preflight={preflight}
	onOpenChange={(v) => {
		preflightOpen = v;
		if (!v) {
			pendingQueue = null;
			preflight = null;
		}
	}}
	onConfirm={() => void confirmPreflight()}
/>
