<script lang="ts">
	import {
		fetchBundleStats,
		fetchJobDiff,
		fetchJobHistory,
		fetchArtifacts,
		fetchAppStorefronts,
		type BundleStats,
		type AppStorefrontListing,
		type ArtifactRecord,
		type JobDiffResult,
		type JobHistoryEntry,
	} from "#lib/api";
	import Badge from "#lib/components/ui/Badge.svelte";
	import Button from "#lib/components/ui/Button.svelte";
	import Checkbox from "#lib/components/ui/Checkbox.svelte";
	import Dialog from "#lib/components/ui/Dialog.svelte";
	import {
		appCatalogEntry,
		appDisplayName,
		appIconUrl,
		ensureAppCatalog,
	} from "#lib/appCatalog.svelte";
	import { fmtBytesGB, fmtDurationApprox, fmtNumber } from "#lib/format.svelte";
	import RelativeTime from "#components/RelativeTime.svelte";
	import RateLimitHint from "#components/RateLimitHint.svelte";
	import { isServerQueryCancelled } from "#lib/serverStateCache.svelte";
	import { artifactDetailJumpState, setActiveTab } from "#lib/ui.svelte";

	let {
		open = $bindable(),
		bundleId,
		preselectIds,
		onOpenChange,
	}: {
		open: boolean;
		bundleId: string;
		preselectIds?: string[];
		onOpenChange: (open: boolean) => void;
	} = $props();

	const VERSIONS_PAGE_SIZE = 20;
	const STOREFRONT_OPTIONS = [
		{ code: 'CA', name: 'Canada', column: 2, row: 1 },
		{ code: 'US', name: 'United States', column: 2, row: 2 },
		{ code: 'MX', name: 'Mexico', column: 2, row: 3 },
		{ code: 'BR', name: 'Brazil', column: 4, row: 4 },
		{ code: 'GB', name: 'United Kingdom', column: 6, row: 2 },
		{ code: 'FR', name: 'France', column: 6, row: 3 },
		{ code: 'ES', name: 'Spain', column: 6, row: 4 },
		{ code: 'NL', name: 'Netherlands', column: 7, row: 1 },
		{ code: 'DE', name: 'Germany', column: 7, row: 2 },
		{ code: 'IT', name: 'Italy', column: 7, row: 3 },
		{ code: 'AT', name: 'Austria', column: 8, row: 2 },
		{ code: 'CH', name: 'Switzerland', column: 8, row: 3 },
		{ code: 'SE', name: 'Sweden', column: 8, row: 1 },
		{ code: 'PL', name: 'Poland', column: 9, row: 2 },
		{ code: 'IN', name: 'India', column: 9, row: 4 },
		{ code: 'TR', name: 'Türkiye', column: 9, row: 3 },
		{ code: 'AE', name: 'United Arab Emirates', column: 10, row: 3 },
		{ code: 'CN', name: 'China', column: 10, row: 2 },
		{ code: 'SG', name: 'Singapore', column: 10, row: 4 },
		{ code: 'HK', name: 'Hong Kong', column: 11, row: 3 },
		{ code: 'KR', name: 'South Korea', column: 11, row: 2 },
		{ code: 'JP', name: 'Japan', column: 12, row: 2 },
		{ code: 'AU', name: 'Australia', column: 12, row: 4 },
		{ code: 'NZ', name: 'New Zealand', column: 12, row: 5 },
	];

	let stats = $state<BundleStats | null>(null);
	let versions = $state<JobHistoryEntry[] | null>(null);
	let versionsOffset = $state(0);
	let versionsHasMore = $state(false);
	let loadingMoreVersions = $state(false);
	let selected = $state<Set<string>>(new Set());
	let diff = $state<JobDiffResult | null>(null);
	let diffing = $state(false);
	let relatedArtifacts = $state<ArtifactRecord[]>([]);
	let artifactsLoading = $state(false);
	let artifactsFailed = $state(false);
	let storefronts = $state<AppStorefrontListing[]>([]);
	let storefrontCountries = $state(['US', 'GB', 'DE', 'CA', 'AU']);
	let storefrontLoading = $state(false);
	let storefrontError = $state('');
	let storefrontCheckedAt = $state<number | undefined>();
	let storefrontsExpanded = $state(false);
	let customStorefrontCode = $state('');
	let storefrontCountryError = $state('');
	let storefrontRequestId = 0;
	let detailRequestId = 0;
	let currentAppMetadata = $derived(appCatalogEntry(bundleId));

	async function loadRelatedArtifacts(currentRequest: number): Promise<void> {
		artifactsLoading = true;
		artifactsFailed = false;
		try {
			const result = await fetchArtifacts({ q: bundleId, limit: 50 });
			if (currentRequest === detailRequestId) {
				relatedArtifacts = result.artifacts.filter((artifact) => artifact.bundleId === bundleId).slice(0, 8);
			}
		} catch {
			if (currentRequest === detailRequestId) artifactsFailed = true;
		} finally {
			if (currentRequest === detailRequestId) artifactsLoading = false;
		}
	}

	function inspectArtifact(id: string): void {
		artifactDetailJumpState.id = id;
		setActiveTab("home");
		onOpenChange(false);
	}

	async function loadVersionsPage(offset: number): Promise<void> {
		try {
			const r = await fetchJobHistory({
				cursorOrOffset: offset,
				limit: VERSIONS_PAGE_SIZE,
				q: bundleId,
				status: "done",
			});
			const matched = r.history.filter((h) => h.bundleId === bundleId);
			versions = offset === 0 ? matched : [...(versions ?? []), ...matched];
			versionsOffset = offset + r.history.length;
			versionsHasMore = r.history.length === VERSIONS_PAGE_SIZE;
		} catch (error) {
			if (!isServerQueryCancelled(error)) throw error;
		}
	}

	async function loadMoreVersions(): Promise<void> {
		loadingMoreVersions = true;
		try {
			await loadVersionsPage(versionsOffset);
		} finally {
			loadingMoreVersions = false;
		}
	}

	$effect(() => {
		if (open && bundleId) {
			detailRequestId += 1;
			const requestId = detailRequestId;
			stats = null;
			relatedArtifacts = [];
			versions = null;
			versionsOffset = 0;
			versionsHasMore = false;
			diff = null;
			void fetchBundleStats(bundleId).then((s) => (stats = s));
			void loadRelatedArtifacts(requestId);
			void loadVersionsPage(0);

			if (preselectIds && preselectIds.length === 2) {
				selected = new Set(preselectIds);
				void compare();
			} else {
				selected = new Set();
			}
		}
	});

	$effect(() => {
		if (!open || !bundleId) return;
		void ensureAppCatalog([bundleId]);
	});

	const maxFailureCount = $derived(
		Math.max(1, ...(stats?.failureBreakdown.map((f) => f.count) ?? [1])),
	);

	function toggleSelect(id: string): void {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else if (next.size < 2) next.add(id);
		selected = next;
		diff = null;
	}

	async function compare(): Promise<void> {
		const [a, b] = [...selected];
		if (!a || !b) return;
		diffing = true;
		try {
			diff = await fetchJobDiff(bundleId, a, b);
		} finally {
			diffing = false;
		}
	}

	function toggleStorefront(countryCode: string, checked: boolean): void {
		resetStorefrontResults();
		storefrontCountries = checked
			? [...new Set([...storefrontCountries, countryCode])]
			: storefrontCountries.filter((country) => country !== countryCode);
	}

	function addStorefrontCountry(): void {
		const countryCode = customStorefrontCode.trim().toUpperCase();
		if (!/^[A-Z]{2}$/.test(countryCode)) {
			storefrontCountryError = 'Enter a two-letter country code.';
			return;
		}
		if (storefrontCountries.includes(countryCode)) {
			storefrontCountryError = `${countryCode} is already selected.`;
			return;
		}
		if (storefrontCountries.length >= 25) {
			storefrontCountryError = 'Select up to 25 storefronts.';
			return;
		}
		resetStorefrontResults();
		storefrontCountries = [...storefrontCountries, countryCode];
		customStorefrontCode = '';
		storefrontCountryError = '';
	}

	function resetStorefrontResults(): void {
		storefrontRequestId += 1;
		storefronts = [];
		storefrontCheckedAt = undefined;
		storefrontError = '';
		storefrontLoading = false;
	}

	function storefrontTileClass(countryCode: string): string {
		const result = storefronts.find((storefront) => storefront.countryCode === countryCode);
		if (result?.status === 'available') return 'border-ok/40 bg-ok/15 text-ok';
		if (result?.status === 'unavailable') return 'border-err/40 bg-err/10 text-err';
		if (result) return 'border-warn/40 bg-warn/10 text-warn';
		if (storefrontCountries.includes(countryCode)) return 'border-accent/50 bg-accent/10 text-text';
		return 'border-border/70 bg-background/70 text-muted hover:border-accent/40 hover:text-text';
	}

	function storefrontTileLabel(countryCode: string, countryName: string): string {
		const result = storefronts.find((storefront) => storefront.countryCode === countryCode);
		const state = result?.status === 'available'
			? `available${result.formattedPrice ? ` at ${result.formattedPrice}` : ''}`
			: result?.status === 'unavailable' ? 'not listed' : result ? 'could not verify' : storefrontCountries.includes(countryCode) ? 'selected, not checked' : 'not selected';
		return `${countryName}: ${state}`;
	}

	async function checkStorefronts(): Promise<void> {
		const trackId = currentAppMetadata?.trackId;
		if (!trackId || storefrontCountries.length === 0) return;
		const requestId = ++storefrontRequestId;
		storefrontLoading = true;
		storefrontError = '';
		try {
			const result = await fetchAppStorefronts(trackId, storefrontCountries);
			if (requestId === storefrontRequestId) {
				storefronts = result.storefronts;
				storefrontCheckedAt = result.checkedAt;
			}
		} catch (error) {
			if (requestId === storefrontRequestId) storefrontError = error instanceof Error ? error.message : 'Could not check App Store availability.';
		} finally {
			if (requestId === storefrontRequestId) storefrontLoading = false;
		}
	}
</script>

<Dialog {open} {onOpenChange} class="max-h-[85vh] max-w-xl overflow-y-auto">
	<div class="mb-3 flex items-center gap-2">
		{#if appIconUrl(bundleId)}
			<img
				src={appIconUrl(bundleId)}
				alt=""
				class="h-5 w-5 shrink-0 rounded"
			/>
		{/if}
		<div class="min-w-0">
			<div class="truncate text-[13px] font-medium">
				{appDisplayName(bundleId)}
			</div>
		</div>
	</div>
	{#if currentAppMetadata}
		<section class="border-border mb-3 rounded-lg border p-3" aria-label="App information">
			<div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
				{#if currentAppMetadata.sellerName}<span class="font-medium">{currentAppMetadata.sellerName}</span>{/if}
				{#if currentAppMetadata.category}<Badge variant="secondary">{currentAppMetadata.category}</Badge>{/if}
				{#if currentAppMetadata.price !== undefined}<span class="text-muted">Price {fmtNumber(currentAppMetadata.price, 2)}</span>{/if}
			</div>
			{#if currentAppMetadata.description}<p class="text-muted mt-2 line-clamp-3 whitespace-pre-wrap text-xs">{currentAppMetadata.description}</p>{/if}
			{#if currentAppMetadata.releaseNotes}<details class="mt-2 text-xs"><summary class="cursor-pointer font-medium">Latest release notes</summary><p class="text-muted mt-1 whitespace-pre-wrap">{currentAppMetadata.releaseNotes}</p></details>{/if}
		</section>
	{/if}
	<section class="border-border mb-3 rounded-lg border p-3" aria-label="App Store storefront availability">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div><h3 class="text-xs font-semibold">Storefront availability</h3><p class="mt-1 text-[11px] text-muted">Check listed price and availability in selected countries.</p></div>
			<Button size="sm" variant="secondary" disabled={!currentAppMetadata?.trackId || storefrontCountries.length === 0} loading={storefrontLoading} onclick={() => void checkStorefronts()}>Check storefronts</Button>
		</div>
		{#if !currentAppMetadata?.trackId}
			<p class="mt-2 text-xs text-muted">App Store metadata is not available for this app yet.</p>
		{:else}
			<div class="mt-3" role="group" aria-label="World storefront availability map">
				<div class="grid grid-cols-12 grid-rows-5 gap-1 rounded-lg border border-border/60 bg-panel-muted/20 p-2">
					{#each STOREFRONT_OPTIONS as country (country.code)}
						{@const checked = storefrontCountries.includes(country.code)}
						<button type="button" class={`flex min-h-8 items-center justify-center rounded-md border text-[9px] font-semibold transition-colors sm:min-h-9 sm:text-[10px] ${storefrontTileClass(country.code)}`} style={`grid-column:${country.column};grid-row:${country.row}`} aria-label={storefrontTileLabel(country.code, country.name)} aria-pressed={checked} title={storefrontTileLabel(country.code, country.name)} onclick={() => toggleStorefront(country.code, !checked)}>{country.code}</button>
					{/each}
				</div>
				<div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted" aria-label="Map legend">
					<span class="flex items-center gap-1"><span class="h-2 w-2 rounded-sm bg-ok"></span>Available</span>
					<span class="flex items-center gap-1"><span class="h-2 w-2 rounded-sm bg-err"></span>Not listed</span>
					<span class="flex items-center gap-1"><span class="h-2 w-2 rounded-sm bg-warn"></span>Could not verify</span>
					<span class="flex items-center gap-1"><span class="h-2 w-2 rounded-sm border border-accent bg-accent/20"></span>Selected, unchecked</span>
				</div>
				{#if storefrontCountries.some((code) => !STOREFRONT_OPTIONS.some((country) => country.code === code))}
					<div class="mt-3">
						<p class="mb-1 text-[10px] font-medium text-muted">Other selected storefronts</p>
						<div class="flex flex-wrap gap-1.5">
							{#each storefrontCountries.filter((code) => !STOREFRONT_OPTIONS.some((country) => country.code === code)) as code (code)}
								{@const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code}
								<button type="button" class={`rounded-md border px-2 py-1 text-[10px] ${storefrontTileClass(code)}`} aria-label={`${storefrontTileLabel(code, name)}. Remove from selection`} aria-pressed="true" title={storefrontTileLabel(code, name)} onclick={() => toggleStorefront(code, false)}>{name} · {code}</button>
							{/each}
						</div>
					</div>
				{/if}
			</div>
			<button type="button" class="mt-2 text-[11px] text-accent hover:underline" aria-expanded={storefrontsExpanded} onclick={() => (storefrontsExpanded = !storefrontsExpanded)}>{storefrontsExpanded ? 'Hide country list' : `${storefrontCountries.length} countries selected · Edit list`}</button>
			{#if storefrontsExpanded}
				<div class="mt-2 grid grid-cols-2 gap-1 sm:grid-cols-4">
					{#each STOREFRONT_OPTIONS as country (country.code)}
						<label class="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] hover:bg-muted/30"><input type="checkbox" checked={storefrontCountries.includes(country.code)} onchange={(event) => toggleStorefront(country.code, event.currentTarget.checked)} />{country.code}</label>
					{/each}
				</div>
				<div class="mt-2 flex flex-wrap items-center gap-2"><input class="h-8 w-20 rounded-md border border-border bg-background px-2 text-xs uppercase" bind:value={customStorefrontCode} maxlength="2" placeholder="Code" aria-label="Add storefront country code" /><Button size="sm" variant="ghost" disabled={storefrontCountries.length >= 25} onclick={addStorefrontCountry}>Add country</Button></div>
			{/if}
		{/if}
		{#if storefrontCountryError}<p class="mt-1 text-[11px] text-err" role="alert">{storefrontCountryError}</p>{/if}
		{#if storefrontError}<p class="mt-2 text-xs text-err" role="alert">{storefrontError}</p>{/if}
		{#if storefronts.length > 0}
			<ul class="mt-2 divide-y divide-border/60">
				{#each storefronts as storefront (storefront.countryCode)}
					<li class="flex items-center justify-between gap-3 py-1.5 text-xs"><span>{storefront.countryName}</span><span class="text-right text-muted">{#if storefront.status === 'available'}{storefront.formattedPrice ?? (storefront.price === undefined ? 'Available' : `${storefront.price} ${storefront.currency ?? ''}`)}{:else if storefront.status === 'unavailable'}Not listed{:else}Could not verify{/if}</span></li>
				{/each}
			</ul>
			{#if storefrontCheckedAt}<p class="mt-1 text-[10px] text-muted">Checked {new Date(storefrontCheckedAt).toLocaleString()}</p>{/if}
		{/if}
	</section>
	<section class="border-border mb-3 rounded-lg border p-3" aria-label="App IPA library items">
		<div class="mb-2 flex items-center justify-between gap-2">
			<h3 class="text-xs font-semibold">IPA Library</h3>
			{#if currentAppMetadata}<span class="text-[11px] text-muted">App metadata updated <RelativeTime ms={currentAppMetadata.metadataFetchedAt ?? currentAppMetadata.updatedAt} /></span>{/if}
		</div>
		{#if artifactsLoading}
			<div class="text-xs text-muted" role="status">Loading saved IPAs…</div>
		{:else if artifactsFailed}
			<div class="text-xs text-muted">Saved IPA details are temporarily unavailable.</div>
		{:else if relatedArtifacts.length > 0}
			<div class="flex flex-col gap-1">
				{#each relatedArtifacts as artifact (artifact.id)}
					<Button variant="ghost" size="sm" class="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left" onclick={() => inspectArtifact(artifact.id)}>
						<span class="min-w-0 flex-1 truncate">{artifact.versionLabel ?? "Saved IPA"}{#if artifact.buildNumber}<span class="text-muted"> · build {artifact.buildNumber}</span>{/if}</span>
						<Badge variant={artifact.channel === "testflight" ? "secondary" : "outline"}>{artifact.channel === "testflight" ? "TestFlight" : "App Store"}</Badge>
						<span class="shrink-0 text-[11px] text-muted">{fmtBytesGB(artifact.fileSizeBytes)}</span>
					</Button>
				{/each}
			</div>
		{:else}
			<div class="text-xs text-muted">No saved IPA for this app yet.</div>
		{/if}
	</section>
	{#if !stats}
		<div class="text-sm text-muted">Loading…</div>
	{:else if stats.totalRuns === 0}
		<div class="text-sm text-muted">
			No decrypt history for this bundle ID yet.
		</div>
	{:else}
		<dl class="flex flex-col gap-2 text-sm">
			<div class="flex items-center justify-between">
				<dt class="text-muted">Total runs</dt>
				<dd>{fmtNumber(stats.totalRuns, 0)}</dd>
			</div>
			<div class="flex items-center justify-between">
				<dt class="text-muted">Success rate</dt>
				<dd>
					{fmtNumber(Math.round(stats.successRate * 100), 0)}% ({fmtNumber(stats.doneCount, 0)} done,
					{fmtNumber(stats.failedCount, 0)} failed)
				</dd>
			</div>
			<div class="flex items-center justify-between">
				<dt class="text-muted">Avg duration</dt>
				<dd>
					{stats.avgDurationMs
						? fmtDurationApprox(stats.avgDurationMs)
						: "-"}
				</dd>
			</div>
			<div class="flex items-center justify-between">
				<dt class="text-muted">Last run</dt>
				<dd>
					{#if stats.lastRunAt}<RelativeTime
							ms={stats.lastRunAt}
						/>{:else}-{/if}
				</dd>
			</div>
		</dl>
		{#if stats.failureBreakdown.length > 0}
			<div class="border-border mt-3 border-t pt-3">
				<div class="mb-2 text-xs text-muted">Failure reasons</div>
				<div class="flex flex-col gap-1.5">
					{#each stats.failureBreakdown as f (f.category)}
						<div class="flex items-center gap-2.5">
							<span
								class="w-24 shrink-0 truncate text-xs"
								title={f.category}>{f.category}</span
							>
							<div
								class="bg-panel-muted h-2 flex-1 overflow-hidden rounded-full"
							>
								<div
									class="bg-err h-full rounded-full"
									style="width: {(f.count / maxFailureCount) *
										100}%"
								></div>
							</div>
							<span
								class="w-6 shrink-0 text-right text-xs text-muted"
				>{fmtNumber(f.count, 0)}</span
							>
						</div>
					{/each}
				</div>
			</div>
		{/if}
		{#if versions && versions.length > 0}
			<div class="border-border mt-3 border-t pt-3">
				<div class="mb-2 flex items-center justify-between gap-2">
					<span class="text-xs text-muted"
						>Versions - pick 2 to compare</span
					>
					{#if selected.size === 2}
						<Button size="sm" loading={diffing} onclick={compare}
							>Compare</Button
						>
					{/if}
				</div>
				<RateLimitHint bucket="jobDiff" />
				<div class="flex max-h-40 flex-col gap-1 overflow-y-auto">
					{#each versions as v (v.id)}
						{@const buildNumber = v.testflight?.build.cfBundleVersion ?? v.ipaMetadata?.bundleVersion}
						<div
							class="hover:bg-panel-muted/80 hover:ring-accent/60 flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-xs hover:ring-1"
						>
							<Checkbox
								checked={selected.has(v.id)}
								disabled={!selected.has(v.id) &&
									selected.size >= 2}
								onCheckedChange={() => toggleSelect(v.id)}
								aria-label="Select {v.versionLabel ?? 'version'}{buildNumber ? `, build ${buildNumber}` : ''}"
							/>
							<span
								class="min-w-0 flex-1 truncate"
								title={v.versionLabel ?? ""}
							>
								{v.versionLabel ?? "(no version label)"}
								{#if buildNumber}<span class="text-muted"> · build {buildNumber}</span>{/if}
							</span>
							<span class="text-muted"
								><RelativeTime ms={v.finishedAt} /></span
							>
						</div>
					{/each}
				</div>
				{#if versionsHasMore}
					<Button
						size="sm"
						variant="secondary"
						class="mt-1.5 w-full"
						loading={loadingMoreVersions}
						onclick={loadMoreVersions}
					>
						Load more versions
					</Button>
				{/if}
			</div>
		{/if}
		{#if diff}
			<div class="border-border mt-3 border-t pt-3">
				<div class="grid grid-cols-2 gap-2 text-xs">
					{#each [diff.a, diff.b] as side (side.id)}
						<div class="bg-panel-muted/60 min-w-0 rounded-md p-2">
							<div class="truncate font-medium">
								{side.versionLabel ?? "Unknown version"}
								{#if side.buildNumber}<span class="text-muted"> · build {side.buildNumber}</span>{/if}
							</div>
							<div class="text-muted mt-1">
								{side.channel === "testflight" ? "TestFlight" : "App Store"}
								{#if side.cacheHit === true}<span> · reused existing IPA</span>{/if}
							</div>
							{#if side.releaseNotes}<p class="text-muted mt-2 line-clamp-3 whitespace-pre-wrap">{side.releaseNotes}</p>{/if}
						</div>
					{/each}
				</div>
				<div class="mb-2 flex items-center justify-between text-xs">
					<span class="text-muted">Size delta</span>
					<Badge
						variant={diff.sizeDeltaBytes > 0
							? "warning"
							: diff.sizeDeltaBytes < 0
								? "success"
								: "secondary"}
					>
						{diff.sizeDeltaBytes >= 0 ? "+" : ""}{fmtBytesGB(
							diff.sizeDeltaBytes,
						)}
					</Badge>
				</div>
				{#if diff.plistDiff.length === 0}
					<div class="text-xs text-muted">
						No Info.plist differences captured between these two
						versions.
					</div>
				{:else}
					<div class="flex flex-col gap-1.5">
						{#each diff.plistDiff as row (row.key)}
							<div
								class="border-border rounded-md border p-2 text-xs"
							>
								<div class="font-mono text-[11px] text-muted">
									{row.key}
								</div>
								<div class="mt-0.5 flex items-center gap-1.5">
									<span class="text-err line-through"
										>{row.before === undefined
											? "(unset)"
											: String(row.before)}</span
									>
									<span class="text-muted">→</span>
									<span class="text-ok"
										>{row.after === undefined
											? "(unset)"
											: String(row.after)}</span
									>
								</div>
							</div>
						{/each}
					</div>
				{/if}
				{#if currentAppMetadata}
					<div class="border-border mt-3 border-t pt-3">
						<div class="flex items-center justify-between gap-2 text-xs">
							<span class="font-medium">App Store metadata</span>
							<span class="text-muted">Updated <RelativeTime ms={currentAppMetadata.metadataFetchedAt ?? currentAppMetadata.updatedAt} /></span>
						</div>
						{#if currentAppMetadata.releaseNotes}
							<div class="mt-2 text-xs font-medium">Latest release notes</div>
							<p class="text-muted mt-1 whitespace-pre-wrap text-xs">{currentAppMetadata.releaseNotes}</p>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
	{/if}
</Dialog>
