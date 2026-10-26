<script lang="ts">
	import {
		fetchBundleStats,
		fetchJobDiff,
		fetchJobHistory,
		fetchArtifacts,
		type BundleStats,
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
