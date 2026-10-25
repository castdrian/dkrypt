<script lang="ts">
	import { BarChart3, CircleCheck, RefreshCw, TriangleAlert, X } from "lucide-svelte";
	import BundleStatsDialog from "#components/BundleStatsDialog.svelte";
	import EmptyState from "#components/EmptyState.svelte";
	import Sparkline from "#components/Sparkline.svelte";
	import {
		fetchInsights,
		fetchFailurePatterns,
		fetchJobSlo,
		fetchStorageForecast,
		type JobSloSummary,
		type InsightsSummary,
		type FailurePattern,
		type StorageForecast,
	} from "#lib/api";
	import Badge from "#lib/components/ui/Badge.svelte";
	import Button from "#lib/components/ui/Button.svelte";
	import Card from "#lib/components/ui/Card.svelte";
	import Input from "#lib/components/ui/Input.svelte";
	import Select from "#lib/components/ui/Select.svelte";
	import {
		csvCell,
		downloadBlob,
		fmtBytesGB,
		fmtCalendarDate,
		fmtDurationApprox,
		fmtNumber,
		trendDelta,
	} from "#lib/format.svelte";
	import { liveState } from "#lib/live.svelte";
	import { PermissionFlag } from "#lib/permissions";
	import { createSavedViews } from "#lib/savedViews.svelte";
	import { sessionHasAnyPermission } from "#lib/session.svelte";
	import {
		jumpToHistoryFailureCategory,
		requestFocusSearch,
		setActiveTab,
	} from "#lib/ui.svelte";
	import { setQueryParams } from "#lib/urlState";
	import RelativeTime from "#components/RelativeTime.svelte";
	import {
		appDisplayName,
		appIconUrl,
		ensureAppCatalog,
	} from "#lib/appCatalog.svelte";
	import ReleaseCoverage from "#features/operations/ReleaseCoverage.svelte";
	import IncidentTimeline from "#features/operations/IncidentTimeline.svelte";

	const TREND_DAYS_OPTIONS = [
		{ value: "7", label: "Last 7 days" },
		{ value: "14", label: "Last 14 days" },
		{ value: "30", label: "Last 30 days" },
		{ value: "60", label: "Last 60 days" },
		{ value: "90", label: "Last 90 days" },
	];

	const TOP_APPS_OPTIONS = [
		{ value: "5", label: "Top 5" },
		{ value: "10", label: "Top 10" },
		{ value: "15", label: "Top 15" },
		{ value: "25", label: "Top 25" },
	];

	interface InsightsPreset {
		name: string;
		trendDays: string;
		topAppsLimit: string;
	}

	let insights = $state<InsightsSummary | null>(null);
	let trendDays = $state("14");
	let topAppsLimit = $state("5");
	const savedViews = createSavedViews<InsightsPreset>(
		"insightsFilterPresets",
	);
	let newPresetName = $state("");

	function applyPreset(p: InsightsPreset): void {
		trendDays = p.trendDays;
		topAppsLimit = p.topAppsLimit;
	}

	function savePreset(): void {
		const name = newPresetName.trim();
		if (!name) return;
		savedViews.save({ name, trendDays, topAppsLimit });
		newPresetName = "";
	}

	const canViewOperationalInsights = $derived(
		sessionHasAnyPermission([
			PermissionFlag.viewAutomation,
			PermissionFlag.manageAutomation,
			PermissionFlag.manageDevices,
		]),
	);
	const canViewQueueSlo = $derived(
		sessionHasAnyPermission([
			PermissionFlag.viewAutomation,
			PermissionFlag.manageAutomation,
		]),
	);
	let queueSlo = $state<JobSloSummary | null>(null);
	let queueSloLoading = $state(false);
	let queueSloError = $state(false);
	let queueSloRequestId = 0;
	const activeJobSloSignature = $derived(
		(liveState.overview?.activeJobs ?? [])
			.map((job) => `${job.id}:${job.status}`)
			.join("|"),
	);
	const historySloSignature = $derived(
		liveState.historyAdditions.map((entry) => entry.id).join("|"),
	);

	async function loadQueueSlo(): Promise<void> {
		const requestId = ++queueSloRequestId;
		queueSloLoading = true;
		queueSloError = false;
		try {
			const result = await fetchJobSlo();
			if (requestId === queueSloRequestId) queueSlo = result;
		} catch {
			if (requestId === queueSloRequestId) queueSloError = true;
		} finally {
			if (requestId === queueSloRequestId) queueSloLoading = false;
		}
	}

	$effect(() => {
		activeJobSloSignature;
		historySloSignature;
		if (!canViewQueueSlo) {
			queueSloRequestId += 1;
			queueSlo = null;
			queueSloError = false;
			queueSloLoading = false;
			return;
		}
		void loadQueueSlo();
	});
	$effect(() => {
		if (!canViewQueueSlo) return;
		const refreshTimer = setInterval(() => void loadQueueSlo(), 30_000);
		return () => clearInterval(refreshTimer);
	});
	let storageForecast = $state<StorageForecast | null>(null);
	let failurePatterns = $state<FailurePattern[]>([]);

	$effect(() => {
		if (!canViewOperationalInsights) return;
		void fetchStorageForecast().then((forecast) => (storageForecast = forecast));
		void fetchFailurePatterns().then(({ patterns }) => (failurePatterns = patterns));
	});

	function load(): void {
		void fetchInsights(Number(trendDays), Number(topAppsLimit)).then(
			(r) => (insights = r),
		);
	}

	$effect(() => {
		void trendDays;
		void topAppsLimit;
		load();
	});

	$effect(() => {
		if (liveState.historyAdditions.length > 0) load();
	});

	$effect(() => {
		void ensureAppCatalog(
			(insights?.topApps ?? []).map((app) => app.bundleId),
		);
	});

	function fmtDayLabel(dateStr: string): string {
		return fmtCalendarDate(dateStr, { month: "short", day: "numeric" });
	}

	const trend = $derived(
		insights?.trend.map((d) => ({
			label: fmtDayLabel(d.date),
			value: d.count,
		})) ?? [],
	);
	const trendDeltaPct = $derived(trendDelta(trend.map((d) => d.value)));
	const maxFailureCount = $derived(
		Math.max(1, ...(insights?.failureBreakdown.map((f) => f.count) ?? [1])),
	);

	let statsOpen = $state(false);
	let statsBundleId = $state("");

	function openStats(bundleId: string): void {
		statsBundleId = bundleId;
		statsOpen = true;
	}

	function inspectAnomaly(jobId: string): void {
		setActiveTab("home");
		setQueryParams({ job: jobId });
	}

	function exportCsv(): void {
		if (!insights) return;
		const rows = [
			"bundleId,totalRuns,doneCount,failedCount,successRate,avgDurationMs,totalSizeBytes",
		];
		for (const app of insights.topApps) {
			rows.push(
				[
					app.bundleId,
					app.totalRuns,
					app.doneCount,
					app.failedCount,
					app.successRate,
					app.avgDurationMs ?? "",
					app.totalSizeBytes,
				]
					.map(csvCell)
					.join(","),
			);
		}
		downloadBlob(rows.join("\n"), "dkrypt-insights.csv", "text/csv");
	}

	function exportJson(): void {
		if (!insights) return;
		downloadBlob(
			JSON.stringify(insights, null, 2),
			"dkrypt-insights.json",
			"application/json",
		);
	}
</script>

<Card title="Insights">
	{#snippet headerExtra()}
		{#if insights && insights.totalRuns > 0}
			<div class="flex flex-wrap items-center gap-1.5">
				<Button size="sm" variant="secondary" onclick={exportCsv}
					>Export CSV</Button
				>
				<Button size="sm" variant="secondary" onclick={exportJson}
					>Export JSON</Button
				>
			</div>
		{/if}
	{/snippet}
	{#if savedViews.presets.length > 0 || insights}
		<div class="mb-3 flex flex-wrap items-center gap-1.5">
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
						onclick={() => savedViews.remove(p.name)}
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
	{/if}
	{#if !insights}
		<div class="flex flex-col gap-1.5">
			{#each Array(4) as _, i (i)}
				<div class="skeleton bg-panel-muted h-12 rounded-md"></div>
			{/each}
		</div>
	{:else if insights.totalRuns === 0}
		<EmptyState
			icon={BarChart3}
			message="No decrypts yet - insights will show up once some have run."
		>
			{#snippet action()}
				<Button
					size="sm"
					variant="secondary"
					onclick={() => requestFocusSearch()}>Queue a decrypt</Button
				>
			{/snippet}
		</EmptyState>
	{:else}
		<div class="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
			<div class="border-border rounded-lg border p-3">
				<div class="text-xs text-muted">Total runs</div>
				<div class="text-xl font-semibold">{fmtNumber(insights.totalRuns, 0)}</div>
			</div>
			<div class="border-border rounded-lg border p-3">
				<div class="text-xs text-muted">Success rate</div>
				<div class="text-xl font-semibold">
					{fmtNumber(Math.round(insights.successRate * 100), 0)}%
				</div>
			</div>
			<div class="border-border rounded-lg border p-3">
				<div class="text-xs text-muted">Total size decrypted</div>
				<div class="text-xl font-semibold">
					{fmtBytesGB(insights.totalSizeBytes)}
				</div>
			</div>
			<div class="border-border rounded-lg border p-3">
				<div class="text-xs text-muted">Manual / system</div>
				<div class="text-xl font-semibold">
					{fmtNumber(insights.manualCount, 0)} / {fmtNumber(insights.systemCount, 0)}
				</div>
			</div>
		</div>

		<div class="border-border mb-4 border-t pt-3">
			<div class="mb-1.5 flex items-center justify-between gap-2">
				<div class="flex items-center gap-2 text-xs text-muted">
					<span>Decrypts · last {fmtNumber(Number(trendDays), 0)} days</span>
					{#if trendDeltaPct !== null}
						<Badge
							variant={trendDeltaPct > 0
								? "success"
								: trendDeltaPct < 0
									? "destructive"
									: "secondary"}
							title="Second half vs first half of this window"
						>
							{trendDeltaPct > 0 ? "+" : ""}{trendDeltaPct}%
						</Badge>
					{/if}
				</div>
				<Select
					items={TREND_DAYS_OPTIONS}
					bind:value={trendDays}
					class="w-36"
				/>
			</div>
			<div class="overflow-x-auto">
				<Sparkline
					data={trend}
					width={560}
					ariaLabel="Decrypt volume over the last {trendDays} days"
				/>
			</div>
		</div>

		{#if insights.failureBreakdown.length > 0}
			<div class="border-border mb-4 border-t pt-3">
				<div class="mb-2 text-xs text-muted">Failure reasons</div>
				<div class="flex flex-col gap-1.5">
					{#each insights.failureBreakdown as f (f.category)}
						<Button
							variant="ghost"
							class="h-auto w-full justify-start gap-2.5 p-0 text-left font-normal"
							onclick={() =>
								jumpToHistoryFailureCategory(f.category)}
							title="View {f.category} failures in Job History"
						>
							<span
								class="w-32 shrink-0 truncate text-xs hover:text-accent hover:underline"
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
						</Button>
					{/each}
				</div>
			</div>
		{/if}

		{#if insights.anomalies.length > 0}
			<div class="border-border mb-4 border-t pt-3">
				<div class="mb-2 flex items-center justify-between gap-2">
					<div class="text-xs text-muted">Performance anomalies</div>
					<Badge variant="warning">{fmtNumber(insights.anomalies.length, 0)} recent</Badge>
				</div>
				<div class="flex flex-col gap-1.5">
					{#each insights.anomalies.slice(0, 6) as anomaly (anomaly.jobId)}
						<div class="border-border flex items-center gap-2 rounded-lg border p-2.5 text-xs">
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-1.5">
									<span class="font-medium">{appDisplayName(anomaly.bundleId)}</span>
									<Badge variant="destructive">{anomaly.kind === "duration-and-size" ? "slow + large" : anomaly.kind === "duration" ? "slow" : "large"}</Badge>
								</div>
								<div class="mt-1 text-muted">
									{#if anomaly.durationRatio}{fmtNumber(Math.round(anomaly.durationRatio * 100), 0)}% of baseline runtime{/if}
									{#if anomaly.sizeRatio}{anomaly.durationRatio ? " · " : ""}{fmtNumber(Math.round(anomaly.sizeRatio * 100), 0)}% of baseline size{/if}
									 · <RelativeTime ms={anomaly.finishedAt} />
								</div>
							</div>
							<Button size="sm" variant="secondary" onclick={() => inspectAnomaly(anomaly.jobId)}>Inspect</Button>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<div class="border-border border-t pt-3">
			<div class="mb-2 flex items-center justify-between gap-2">
				<div class="text-xs text-muted">Busiest apps</div>
				<Select
					items={TOP_APPS_OPTIONS}
					bind:value={topAppsLimit}
					class="w-32"
				/>
			</div>
			<table class="responsive-table">
				<thead>
					<tr>
						<th>App</th>
						<th>Runs</th>
						<th>Success rate</th>
						<th>Avg duration</th>
						<th>Size</th>
					</tr>
				</thead>
				<tbody>
					{#each insights.topApps as app (app.bundleId)}
						<tr>
							<td data-label="App" class="max-w-56">
								<Button
									variant="link"
									class="h-auto max-w-full justify-start p-0 text-left font-normal"
									title="View stats for {app.bundleId}"
									onclick={() => openStats(app.bundleId)}
								>
									<span class="flex items-center gap-2">
										{#if appIconUrl(app.bundleId)}
											<img
												src={appIconUrl(app.bundleId)}
												alt=""
												class="h-4 w-4 shrink-0 rounded"
											/>
										{/if}
										<span class="truncate"
											>{appDisplayName(
												app.bundleId,
											)}</span
										>
									</span>
								</Button>
							</td>
							<td data-label="Runs">{fmtNumber(app.totalRuns, 0)}</td>
							<td data-label="Success rate">
								<Badge
									variant={app.successRate >= 0.9
										? "success"
										: app.successRate >= 0.5
											? "secondary"
											: "destructive"}
								>
								{fmtNumber(Math.round(app.successRate * 100), 0)}%
								</Badge>
							</td>
							<td data-label="Avg duration" class="text-muted"
								>{app.avgDurationMs
									? fmtDurationApprox(app.avgDurationMs)
									: "-"}</td
							>
							<td data-label="Size" class="text-muted"
								>{fmtBytesGB(app.totalSizeBytes)}</td
							>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#if insights.byDevice.length > 1}
			<div class="border-border mt-4 border-t pt-3">
				<div class="mb-2 text-xs text-muted">By device</div>
				<table class="responsive-table">
					<thead>
						<tr>
							<th>Device</th>
							<th>Runs</th>
							<th>Success rate</th>
							<th>Avg duration</th>
							<th>Size</th>
						</tr>
					</thead>
					<tbody>
						{#each insights.byDevice as d (d.deviceId)}
							<tr>
								<td
									data-label="Device"
									class="max-w-40 truncate"
									title={d.deviceId}
								>
									{d.deviceName}
									{#if d.removed}<span class="text-muted">
											(removed)</span
										>{/if}
								</td>
							<td data-label="Runs">{fmtNumber(d.totalRuns, 0)}</td>
								<td data-label="Success rate">
									<Badge
										variant={d.successRate >= 0.9
											? "success"
											: d.successRate >= 0.5
												? "secondary"
												: "destructive"}
									>
										{Math.round(d.successRate * 100)}%
									</Badge>
								</td>
								<td data-label="Avg duration" class="text-muted"
									>{d.avgDurationMs
										? fmtDurationApprox(d.avgDurationMs)
										: "-"}</td
								>
								<td data-label="Size" class="text-muted"
									>{fmtBytesGB(d.totalSizeBytes)}</td
								>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	{/if}
</Card>

{#if canViewQueueSlo}<ReleaseCoverage />{/if}

{#if canViewQueueSlo}
	<Card title="Queue objective" class="mt-4">
		<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
			<div>
				<div class="text-sm font-medium">Completion target</div>
				<div class="text-xs text-muted">{queueSlo ? fmtDurationApprox(queueSlo.targetMs) : "Configured target"} from submission</div>
			</div>
			<div class="flex items-center gap-2">
				{#if queueSloLoading}<span class="text-xs text-muted">Updating</span>{/if}
				<Button size="icon" variant="ghost" aria-label="Refresh queue objective" title="Refresh" onclick={() => void loadQueueSlo()}>
					<RefreshCw class="h-4 w-4" />
				</Button>
			</div>
		</div>
		{#if queueSloError}
			<div class="text-sm text-muted">Queue objective status is temporarily unavailable.</div>
		{:else if queueSloLoading && !queueSlo}
			<div class="text-sm text-muted">Checking active decrypts…</div>
		{:else if queueSlo}
			{@const breachedJobs = queueSlo.jobs.filter((job) => job.objective === "breached")}
			{#if queueSlo.jobs.length === 0}
				<div class="text-sm text-muted">No active decrypts.</div>
			{:else if breachedJobs.length === 0}
				<div class="flex items-center gap-2 text-sm"><CircleCheck class="h-4 w-4 text-ok" />All {fmtNumber(queueSlo.jobs.length, 0)} active jobs are within the objective.</div>
			{:else}
				<div class="mb-2 flex items-center gap-2 text-sm"><TriangleAlert class="h-4 w-4 text-warn" />{fmtNumber(breachedJobs.length, 0)} active job{breachedJobs.length === 1 ? " is" : "s are"} at risk.</div>
				<div class="flex flex-col gap-1.5">
					{#each breachedJobs.slice(0, 5) as job (job.id)}
						<div class="border-border flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2.5 py-2 text-xs">
							<span class="min-w-0 flex-1 truncate font-medium" title={job.bundleId}>{appDisplayName(job.bundleId)}</span>
							<Badge variant={job.waitedMs > queueSlo.targetMs ? "destructive" : "warning"}>{job.waitedMs > queueSlo.targetMs ? "Objective missed" : "Projected late"}</Badge>
							<span class="w-full text-muted sm:w-auto">Elapsed {fmtDurationApprox(job.waitedMs)}{job.predictedCompletionMs !== null ? ` · best-case total ${fmtDurationApprox(job.waitedMs + job.predictedCompletionMs)} across up to ${job.parallelism} compatible device${job.parallelism === 1 ? "" : "s"}` : ""}</span>
						</div>
					{/each}
				</div>
			{/if}
		{/if}
	</Card>
{/if}

{#if canViewOperationalInsights}
	<Card title="Storage forecast" class="mt-4">
		{#if storageForecast?.sampleCount}
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
				<Badge variant={storageForecast.daysRemaining !== null && storageForecast.daysRemaining < 14 ? "destructive" : "secondary"}>{fmtBytesGB(storageForecast.freeBytes)} free</Badge>
				<span class="text-muted">~{fmtBytesGB(storageForecast.bytesPerDay)} retained per day from {fmtNumber(storageForecast.sampleCount, 0)} completed jobs</span>
				<span class="font-medium">{storageForecast.daysRemaining === null ? "Forecast unavailable" : `${fmtNumber(storageForecast.daysRemaining, 0)} days at current volume`}</span>
			</div>
		{:else}
			<EmptyState message="Storage forecast will appear after completed decrypts with recorded artifact sizes." />
		{/if}
	</Card>

	<Card title="Failure patterns" class="mt-4">
		{#if failurePatterns.length === 0}
			<EmptyState message="No repeated failures recorded." />
		{:else}
			<div class="flex flex-col gap-2">
				{#each failurePatterns as pattern (pattern.message)}
					<div class="border-border rounded-lg border p-2.5 text-xs">
						<div class="flex items-center gap-2"><Badge variant="destructive">{fmtNumber(pattern.count, 0)}×</Badge><span class="min-w-0 flex-1 truncate" title={pattern.message}>{pattern.message}</span></div>
						<div class="mt-1 text-muted">{fmtNumber(pattern.bundleIds.length, 0)} app{pattern.bundleIds.length === 1 ? "" : "s"} · last seen <RelativeTime ms={pattern.lastSeen} /></div>
					</div>
				{/each}
			</div>
		{/if}
	</Card>

{/if}

<details class="mt-4 rounded-xl border border-border/70 bg-panel/40 px-4 py-3">
  <summary class="cursor-pointer text-sm font-semibold focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">Operations · Action Center and incident timeline</summary>
  <div class="mt-4"><IncidentTimeline /></div>
</details>

<BundleStatsDialog
	open={statsOpen}
	bundleId={statsBundleId}
	onOpenChange={(v) => (statsOpen = v)}
/>
