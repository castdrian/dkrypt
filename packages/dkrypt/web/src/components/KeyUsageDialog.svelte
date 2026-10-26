<script lang="ts">
	import {
		fetchKeyBundleUsage,
		fetchKeyOutcomeUsage,
		fetchKeyRequestHistory,
		fetchKeyUsage,
		type ApiKeyBundleUsage,
		type ApiKeyOutcomeUsage,
		type ApiKeyRequestHistoryEntry,
		type ApiKeyUsageBucket,
	} from "#lib/api";
	import {
		appDisplayName,
		appIconUrl,
		ensureAppCatalog,
	} from "#lib/appCatalog.svelte";
	import Dialog from "#lib/components/ui/Dialog.svelte";
	import Sparkline from "#components/Sparkline.svelte";
	import { fmtCalendarDate, fmtDateTime, fmtNumber } from "#lib/format.svelte";

	let {
		open = $bindable(),
		keyId,
		keyName,
		dailyLimit,
		lastUsedIp,
		onOpenChange,
	}: {
		open: boolean;
		keyId: string;
		keyName: string;
		dailyLimit?: number;
		lastUsedIp?: string;
		onOpenChange: (open: boolean) => void;
	} = $props();

	let usage = $state<ApiKeyUsageBucket[] | null>(null);
	let bundleUsage = $state<ApiKeyBundleUsage[] | null>(null);
	let outcomeUsage = $state<ApiKeyOutcomeUsage[] | null>(null);
	let requests = $state<ApiKeyRequestHistoryEntry[] | null>(null);
	let requestsError = $state('');

	async function loadRecentRequests(): Promise<void> {
		requests = null;
		requestsError = '';
		try {
			requests = (await fetchKeyRequestHistory(keyId)).requests;
		} catch (error) {
			requests = [];
			requestsError = error instanceof Error ? error.message : 'Could not load recent requests.';
		}
	}

	$effect(() => {
		if (open && keyId) {
			usage = null;
			bundleUsage = null;
			outcomeUsage = null;
			requests = null;
			requestsError = '';
			void fetchKeyUsage(keyId, 14).then((r) => (usage = r.usage));
			void fetchKeyBundleUsage(keyId).then(
				(r) => (bundleUsage = r.bundles),
			);
			void fetchKeyOutcomeUsage(keyId).then((r) => (outcomeUsage = r.outcomes));
			void loadRecentRequests();
		}
	});

	$effect(() => {
		if (!open || !bundleUsage) return;
		void ensureAppCatalog(bundleUsage.map((entry) => entry.bundleId));
	});

	const maxBundleCount = $derived(
		Math.max(1, ...(bundleUsage?.map((b) => b.count) ?? [1])),
	);

	function fmtDayLabel(dateStr: string): string {
		return fmtCalendarDate(dateStr, { month: "short", day: "numeric" });
	}

	const total = $derived(usage?.reduce((a, d) => a + d.count, 0) ?? 0);
	const todayCount = $derived(usage?.[usage.length - 1]?.count ?? 0);
	const todayPercent = $derived(
		dailyLimit ? Math.min(100, (todayCount / dailyLimit) * 100) : 0,
	);
</script>

<Dialog {open} {onOpenChange} class="max-h-[85dvh] max-w-2xl overflow-y-auto">
	<div class="mb-1 truncate text-sm font-medium" title={keyName}>
		{keyName} - usage
	</div>
	{#if lastUsedIp}
		<div class="mb-3 text-xs text-muted">
			Last seen from <span class="font-mono">{lastUsedIp}</span>
		</div>
	{/if}
	{#if !usage}
		<div class="text-sm text-muted">Loading…</div>
	{:else}
		{#if dailyLimit}
			<div class="mb-3">
				<div
					class="mb-1.5 flex items-center justify-between text-xs text-muted"
				>
					<span>Today</span>
					<span>{fmtNumber(todayCount, 0)} / {fmtNumber(dailyLimit, 0)}</span>
				</div>
				<div
					class="bg-panel-muted h-1.5 w-full overflow-hidden rounded-full"
				>
					<div
						class="h-full rounded-full {todayPercent >= 100
							? 'bg-err'
							: todayPercent >= 80
								? 'bg-warn'
								: 'bg-accent'}"
						style="width: {todayPercent}%"
					></div>
				</div>
			</div>
		{/if}
		{#if total === 0}
			<div class="text-sm text-muted">
				No requests with this key in the last 14 days.
			</div>
		{:else}
			<div class="mb-1.5 text-xs text-muted">
				{total} request{total === 1 ? "" : "s"} · last 14 days
			</div>
			<Sparkline
				data={usage.map((d) => ({
					label: fmtDayLabel(d.date),
					value: d.count,
				}))}
				width={300}
				ariaLabel="{total} requests over the last 14 days"
			/>
		{/if}

		{#if bundleUsage === null}
			<div class="border-border mt-3 border-t pt-3 text-xs text-muted">
				Loading used-for breakdown…
			</div>
		{:else if bundleUsage.length > 0}
			<div class="border-border mt-3 border-t pt-3">
				<div class="mb-2 text-xs text-muted">Used to decrypt</div>
				<div class="flex flex-col gap-1.5">
					{#each bundleUsage as b (b.bundleId)}
						<div class="flex items-center gap-2.5">
							<span
								class="flex w-44 min-w-0 items-center gap-1.5 truncate"
								title={b.bundleId}
							>
								{#if appIconUrl(b.bundleId)}
									<img
										src={appIconUrl(b.bundleId)}
										alt=""
										class="h-3.5 w-3.5 shrink-0 rounded"
									/>
								{/if}
								<span class="truncate text-[11px]"
									>{appDisplayName(b.bundleId)}</span
								>
							</span>
							<div
								class="bg-panel-muted h-2 flex-1 overflow-hidden rounded-full"
							>
								<div
									class="bg-accent h-full rounded-full"
									style="width: {(b.count / maxBundleCount) *
										100}%"
								></div>
							</div>
							<span
								class="w-6 shrink-0 text-right text-xs text-muted"
				>{fmtNumber(b.count, 0)}</span
							>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		{#if outcomeUsage === null}
			<div class="border-border mt-3 border-t pt-3 text-xs text-muted">Loading response outcomes…</div>
		{:else if outcomeUsage.length > 0}
			<div class="border-border mt-3 border-t pt-3">
				<div class="mb-2 text-xs text-muted">Response outcomes</div>
				<div class="flex flex-col gap-1.5 text-xs">
					{#each outcomeUsage as outcome (outcome.route)}
						<div class="flex items-center justify-between gap-2">
							<span class="truncate font-mono text-muted" title={outcome.route}>{outcome.route}</span>
							<span class="shrink-0 text-right"><span class="text-ok">{fmtNumber(outcome.success, 0)} ok</span> · <span class={outcome.clientError || outcome.serverError ? 'text-err' : 'text-muted'}>{fmtNumber(outcome.clientError + outcome.serverError, 0)} failed</span>{#if outcome.latencyCount}<span class="ml-1 text-muted">· {fmtNumber(outcome.averageLatencyMs ?? 0, 0)} ms avg</span>{/if}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}
		{#if requests === null}
			<div class="border-border mt-3 border-t pt-3 text-xs text-muted">Loading recent requests…</div>
		{:else}
			<div class="border-border mt-3 border-t pt-3">
				<div class="mb-2 text-xs font-medium">Recent requests <span class="font-normal text-muted">· routes only, no request data</span></div>
				{#if requestsError}
					<div class="flex flex-wrap items-center gap-2 text-xs text-warn" role="alert"><span>{requestsError}</span><button type="button" class="rounded-md border border-border px-2 py-1 text-muted hover:bg-panel-muted" onclick={() => void loadRecentRequests()}>Try again</button></div>
				{:else if requests.length === 0}
					<div class="text-xs text-muted">No requests have been recorded for this key.</div>
				{:else}
					<div class="max-h-60 overflow-auto rounded-lg border border-border/70">
						<table class="w-full min-w-[34rem] text-left text-[11px]">
							<thead class="sticky top-0 bg-panel-muted text-muted"><tr><th class="px-2.5 py-2 font-medium">Time</th><th class="px-2.5 py-2 font-medium">Request</th><th class="px-2.5 py-2 font-medium">Result</th><th class="px-2.5 py-2 text-right font-medium">Duration</th></tr></thead>
							<tbody>
								{#each requests as request (`${request.at}-${request.method}-${request.route}-${request.status}`)}
									<tr class="border-t border-border/60"><td class="whitespace-nowrap px-2.5 py-2 text-muted">{fmtDateTime(request.at)}</td><td class="px-2.5 py-2 font-mono">{request.method} {request.route}</td><td class="px-2.5 py-2"><span class={request.status >= 500 ? 'text-err' : request.status >= 400 ? 'text-warn' : 'text-ok'}>{request.status}</span></td><td class="px-2.5 py-2 text-right tabular-nums text-muted">{request.durationMs === undefined ? '—' : `${request.durationMs} ms`}</td></tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>
		{/if}
	{/if}
</Dialog>
