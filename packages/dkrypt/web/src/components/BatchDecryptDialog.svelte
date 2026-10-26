<script lang="ts">
	import { untrack } from "svelte";
	import { Download, LoaderCircle, TriangleAlert } from "lucide-svelte";
	import {
		fetchTestFlightBuilds,
		fetchTestFlightTrains,
		lookupAppStoreTrack,
		queueDecrypt,
		queueTestFlightDecrypt,
		submitTestFlightSubscription,
		type JobSummary,
		type TFBuild,
	} from "#lib/api";
	import {
		BATCH_QUEUE_TEMPLATES,
		MAX_BATCH_QUEUE_ENTRIES,
		TESTFLIGHT_ACCESS_MAX_AGE_MS,
		batchQueueEntryKey,
		getRecentlyVerifiedTestFlightDevices,
		isValidBatchQueueSelector,
		parseBatchQueueEntries,
		type BatchQueueEntry,
		type BatchQueueSource,
	} from "#lib/batchQueue";
	import { parsePastedDecryptInput, parsePastedDecryptInputs } from "#lib/pastedDecryptInputs";
	import {
		appDisplayName,
		appIconUrl,
		ensureAppCatalog,
	} from "#lib/appCatalog.svelte";
	import Button from "#lib/components/ui/Button.svelte";
	import Dialog from "#lib/components/ui/Dialog.svelte";
	import Select from "#lib/components/ui/Select.svelte";
	import Textarea from "#lib/components/ui/Textarea.svelte";
	import {
		addDecrypt,
		myDecryptsState,
		pushRecentBundleId,
	} from "#lib/decrypts.svelte";
	import { liveState } from "#lib/live.svelte";
	import { requestNotificationPermission } from "#lib/notifications";
	import { PermissionFlag } from "#lib/permissions";
	import { sessionHasPermission } from "#lib/session.svelte";
	import { loadTestFlightCatalog, testFlightCatalogState } from "#lib/testflightCatalog.svelte";
	import { showToast } from "#lib/ui.svelte";
	import { cn } from "#lib/utils";

	let {
		open = $bindable(),
		onOpenChange,
	}: { open: boolean; onOpenChange: (open: boolean) => void } = $props();

	const BUNDLE_ID_RE = /^[A-Za-z0-9.-]{3,200}$/;
	type BatchResult = BatchQueueEntry & {
		state: "pending" | "ok" | "error" | "quota";
		jobId?: string;
		error?: string;
	};

	let text = $state("");
	let source = $state<BatchQueueSource>("appstore");
	let inputMode = $state<BatchQueueSource | "links">("appstore");
	let pastedRows = $state<string[]>([]);
	let inviteRequests = $state<Record<string, "pending" | "done" | "error">>({});
	let resolving = $state(false);
	let submittedSource = $state<BatchQueueSource>("appstore");
	let selectedDeviceByBundleId = $state<Record<string, string>>({});
	let now = $state(Date.now());
	let submitting = $state(false);
	let results = $state<BatchResult[]>([]);

	const parsedResult = $derived(parseBatchQueueEntries(text, source));
	const pastedInputs = $derived(pastedRows.map(parsePastedDecryptInput));
	const pastedInvalid = $derived(pastedInputs.some((row) => row.kind === "invalid"));
	const pastedQueueable = $derived(pastedInputs.filter((row) => row.kind === "bundle" || row.kind === "appstore"));
	const canRequestTestFlight = $derived(sessionHasPermission(PermissionFlag.requestTestFlightSubscriptions));
	const parsed = $derived(parsedResult.entries);
	const activeTemplate = $derived(BATCH_QUEUE_TEMPLATES.find((template) => template.source === source)!);
	const missingTestFlightSelectors = $derived(source === "testflight" ? parsed.filter((entry) => !entry.selector) : []);
	const testFlightCatalogBusy = $derived(testFlightCatalogState.loading || testFlightCatalogState.refreshing);
	const testFlightAppSelections = $derived.by(() => {
		if (source !== "testflight") return [];
		const bundleIds = [...new Set(parsed.map((entry) => entry.bundleId))];
		return bundleIds.map((bundleId) => {
			const app = testFlightCatalogState.apps.find((candidate) => candidate.bundleId === bundleId);
			return {
				bundleId,
				app,
				devices: app && !testFlightCatalogState.error
					? getRecentlyVerifiedTestFlightDevices(app, now)
					: [],
			};
		});
	});
	const unavailableTestFlightApps = $derived(testFlightAppSelections.filter((selection) => selection.devices.length === 0));
	const availableTestFlightApps = $derived(testFlightAppSelections.filter((selection) => selection.devices.length > 0));
	const queueableTestFlightEntries = $derived(parsed.filter((entry) =>
		entry.selector
		&& isValidBatchQueueSelector(entry.selector, "testflight")
		&& availableTestFlightApps.some((selection) => selection.bundleId === entry.bundleId),
	));

	$effect(() => {
		if (!open || source !== "testflight") return;
		untrack(() => {
			const fetchedAt = testFlightCatalogState.fetchedAt;
			const stale = !fetchedAt || now - fetchedAt > TESTFLIGHT_ACCESS_MAX_AGE_MS || testFlightCatalogState.error;
			void loadTestFlightCatalog(Boolean(stale));
		});
	});

	$effect(() => {
		if (!open || source !== "testflight") return;
		const timer = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(timer);
	});

	$effect(() => {
		if (source !== "testflight") return;
		let next = selectedDeviceByBundleId;
		let changed = false;
		for (const selection of availableTestFlightApps) {
			if (selection.devices.some((device) => device.id === next[selection.bundleId])) continue;
			if (!changed) next = { ...next };
			next[selection.bundleId] = selection.devices[0]!.id;
			changed = true;
		}
		if (changed) selectedDeviceByBundleId = next;
	});

	function setSelectedTestFlightDevice(bundleId: string, deviceId: string): void {
		selectedDeviceByBundleId = { ...selectedDeviceByBundleId, [bundleId]: deviceId };
	}

	const activeBundleIds = $derived.by(() => {
		const set = new Set<string>();
		for (const d of myDecryptsState.items)
			if (d.status === "queued" || d.status === "running")
				set.add(d.bundleId);
		for (const j of liveState.overview?.activeJobs ?? [])
			set.add(j.bundleId);
		return set;
	});

	const alreadyActiveInBatch = $derived(
		parsed
			.filter((e) => activeBundleIds.has(e.bundleId))
			.map((e) => e.bundleId),
	);

	$effect(() => {
		void ensureAppCatalog([
			...parsed.map((entry) => entry.bundleId),
			...results.map((result) => result.bundleId),
		]);
	});

	function updateResult(entry: BatchQueueEntry, changes: Partial<BatchResult>): void {
		const entryKey = batchQueueEntryKey(entry);
		results = results.map((result) => batchQueueEntryKey(result) === entryKey
			? { ...result, ...changes }
			: result);
	}

	function csvField(value: string | undefined): string {
		const normalized = value ?? "";
		const safe = /^[\t\r\n ]*[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
		return `"${safe.replaceAll('"', '""')}"`;
	}

	function exportResults(): void {
		if (submitting || results.length === 0) return;
		const rows = [
			["bundle_id", "selector", "status", "job_id", "error"],
			...results.map((result) => [
				result.bundleId,
				result.selector,
				result.state === "ok" ? "queued" : result.state === "quota" ? "quota-blocked" : result.state === "error" ? "failed" : "pending",
				result.jobId,
				result.error,
			]),
		];
		const content = `${rows.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
		const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
		const link = document.createElement("a");
		link.href = url;
		link.download = "dkrypt-batch-results.csv";
		document.body.append(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	function close(): void {
		if (submitting || resolving) return;
		text = "";
		pastedRows = [];
		inviteRequests = {};
		results = [];
		onOpenChange(false);
	}

	function addPastedRows(): void {
		const parsed = parsePastedDecryptInputs(text);
		const current = new Set(pastedRows.map((value) => {
			const row = parsePastedDecryptInput(value);
			return row.kind === "bundle" ? `bundle:${row.bundleId}` : row.kind === "appstore" ? `appstore:${row.trackId}` : row.kind === "testflight" ? row.url : row.value;
		}));
		for (const row of parsed.rows) {
			const key = row.kind === "bundle" ? `bundle:${row.bundleId}` : row.kind === "appstore" ? `appstore:${row.trackId}` : row.kind === "testflight" ? row.url : row.value;
			if (current.has(key)) continue;
			if (pastedRows.length >= MAX_BATCH_QUEUE_ENTRIES) break;
			pastedRows = [...pastedRows, row.value];
			current.add(key);
		}
		text = "";
		if (parsed.duplicates.length || parsed.overflow) showToast(parsed.overflow ? `Only the first ${MAX_BATCH_QUEUE_ENTRIES} entries were added` : "Repeated entries were skipped", "error");
	}

	async function requestInvite(url: string): Promise<void> {
		inviteRequests = { ...inviteRequests, [url]: "pending" };
		try {
			const result = await submitTestFlightSubscription(url);
			inviteRequests = { ...inviteRequests, [url]: result.ok ? "done" : "error" };
			if (result.ok) showToast("TestFlight request submitted", "success");
		} catch {
			inviteRequests = { ...inviteRequests, [url]: "error" };
		}
	}

	async function submitPasted(): Promise<void> {
		if (pastedInvalid || pastedQueueable.length === 0) return;
		resolving = true;
		const entries: BatchQueueEntry[] = [];
		try {
			for (const row of pastedQueueable) {
				if (row.kind === "bundle") entries.push({ bundleId: row.bundleId });
				if (row.kind === "appstore") {
					const metadata = await lookupAppStoreTrack(row.trackId);
					entries.push({ bundleId: metadata.bundleId });
				}
			}
			const unique = [...new Map(entries.map((entry) => [entry.bundleId, entry])).values()];
			submittedSource = "appstore";
			results = unique.map((entry) => ({ ...entry, state: "pending" }));
			await submitEntries(unique, "appstore");
		} catch (error) {
			showToast(error instanceof Error ? error.message : "Could not resolve App Store link", "error");
		} finally {
			resolving = false;
		}
	}

	async function submitEntries(entries: BatchQueueEntry[], queueSource: BatchQueueSource): Promise<void> {
		requestNotificationPermission();
		submitting = true;

		let ok = 0;
		for (const entry of entries) {
			const { bundleId, selector } = entry;
			if (!BUNDLE_ID_RE.test(bundleId)) {
				updateResult(entry, { state: "error", error: "doesn't look like a bundle ID" });
				continue;
			}
			if (selector && !isValidBatchQueueSelector(selector, queueSource)) {
				updateResult(entry, {
					state: "error",
					error: queueSource === "testflight" ? "use version_build" : "invalid App Store version ID",
				});
				continue;
			}
			if (queueSource === "testflight" && !selector) {
				updateResult(entry, { state: "error", error: "add a version_build selector" });
				continue;
			}
			try {
				let response;
				let trackName = appDisplayName(bundleId);
				let versionLabel = selector;
				let testflight: { appId: number; build: TFBuild } | undefined;
				if (queueSource === "testflight") {
					const app = testFlightCatalogState.apps.find((candidate) => candidate.bundleId === bundleId);
					if (!app || testFlightCatalogState.error) throw new Error("not available via TestFlight on an enabled device");
					const deviceOptions = getRecentlyVerifiedTestFlightDevices(app, Date.now());
					const selectedDeviceId = selectedDeviceByBundleId[bundleId];
					if (!selectedDeviceId || !deviceOptions.some((device) => device.id === selectedDeviceId)) {
						throw new Error("no recently verified device has access");
					}
					if (!selector) throw new Error("add a version_build selector");
					const [trainVersion, buildNumber] = selector.split("_");
					const trainsResult = await fetchTestFlightTrains(app.appId, selectedDeviceId);
					if ("error" in trainsResult) throw new Error(trainsResult.error);
					const train = trainsResult.trains.find((candidate) => candidate.trainVersion === trainVersion);
					if (!train) throw new Error("TestFlight train not found");
					const buildsResult = await fetchTestFlightBuilds(app.appId, train.trainVersion, selectedDeviceId);
					if ("error" in buildsResult) throw new Error(buildsResult.error);
					const build = buildsResult.builds.find((candidate) => candidate.bundleId === bundleId && candidate.cfBundleVersion === buildNumber);
					if (!build) throw new Error("TestFlight build not found");
					trackName = appDisplayName(app.bundleId, app.bundleId);
					versionLabel = `TestFlight ${selector}`;
					testflight = { appId: app.appId, build };
					response = await queueTestFlightDecrypt(bundleId, app.appId, build, false, selectedDeviceId, true);
				} else {
					response = await queueDecrypt(bundleId, selector, undefined, false, undefined, true);
				}
				const { ok: queuedOk, data } = response;
				if (!queuedOk) {
					const problem = data as JobSummary & { code?: string; error?: string; remediation?: { nextAvailableAt?: number } };
					updateResult(entry, { state: problem.code === 'daily_decrypt_limit' ? 'quota' : 'error', error: problem.code === 'daily_decrypt_limit' && problem.remediation?.nextAvailableAt ? `Daily allowance used; next slot ${new Date(problem.remediation.nextAvailableAt).toLocaleString()}` : problem.error ?? 'rejected' });
					continue;
				}
				addDecrypt({
					id: data.id,
					bundleId,
					trackName,
					versionLabel,
					externalVersionId: queueSource === "appstore" ? selector : undefined,
					testflight,
					status: data.status,
					progress: data.progress,
					queue: data.queue,
					artifactId: data.artifactId,
					artifactUrl: data.artifactUrl,
				});
				pushRecentBundleId(bundleId);
				updateResult(entry, { state: "ok", jobId: data.id });
				ok += 1;
			} catch (error) {
				updateResult(entry, { state: "error", error: error instanceof Error ? error.message : "request failed" });
			}
		}

		submitting = false;
		const quotaBlocked = results.filter((result) => result.state === 'quota').length;
		showToast(
			`Queued ${ok} of ${entries.length}${quotaBlocked ? ` · ${quotaBlocked} blocked by daily allowance` : ''}${ok + quotaBlocked < entries.length ? ` · ${entries.length - ok - quotaBlocked} failed` : ""}`,
			ok === entries.length ? "success" : "error",
		);
	}

	async function submit(): Promise<void> {
		const entries = parsed;
		if (entries.length === 0) return;
		submittedSource = source;
		results = entries.map((entry) => ({ ...entry, state: "pending" }));
		await submitEntries(entries, source);
	}

	const failedCount = $derived(
		results.filter((r) => r.state === "error" || r.state === "quota").length,
	);

	async function retryFailed(): Promise<void> {
		const failed = results
			.filter((r) => r.state === "error" || r.state === "quota")
			.map(({ bundleId, selector }) => ({ bundleId, selector }));
		if (failed.length === 0) return;
		results = results.map((r) =>
			r.state === "error"
				? { ...r, state: "pending", error: undefined }
				: r,
		);
		await submitEntries(failed, submittedSource);
	}
</script>

<Dialog {open} onOpenChange={(v) => !v && close()} class="max-w-md">
	<div class="mb-1 text-sm font-medium">Batch decrypt</div>
	<div class="mb-3 text-xs text-muted">Choose a workflow. Enter up to {MAX_BATCH_QUEUE_ENTRIES} apps.</div>

	{#if results.length === 0}
		<div class="mb-2 flex flex-wrap gap-2" role="group" aria-label="Batch queue template">
			{#each BATCH_QUEUE_TEMPLATES as template (template.source)}
				<Button
					variant={inputMode === template.source ? "default" : "secondary"}
					size="sm"
					aria-pressed={inputMode === template.source}
					onclick={() => { source = template.source; inputMode = template.source; text = ""; }}>{template.label}</Button
				>
			{/each}
			<Button variant={inputMode === "links" ? "default" : "secondary"} size="sm" aria-pressed={inputMode === "links"} onclick={() => { inputMode = "links"; text = ""; }}>Paste links</Button>
		</div>
		{#if inputMode === "links"}
			<div class="mb-2 text-xs text-muted">Paste bundle IDs, App Store links, or public TestFlight invites. Invites are never subscribed automatically.</div>
			<Textarea bind:value={text} disabled={submitting || resolving} placeholder={'com.example.app\nhttps://apps.apple.com/us/app/example/id123456789\nhttps://testflight.apple.com/join/ABC123'} rows={4} class="border-border bg-panel-muted focus:border-accent w-full rounded-md border px-3 py-2 font-mono text-xs text-text focus:outline-none"></Textarea>
			<Button class="mt-2" size="sm" variant="secondary" disabled={!text.trim() || pastedRows.length >= MAX_BATCH_QUEUE_ENTRIES} onclick={addPastedRows}>Add rows</Button>
			{#if pastedRows.length > 0}
				<div class="mt-3 flex max-h-64 flex-col gap-2 overflow-y-auto">
					{#each pastedRows as rowValue, index (index)}
						{@const row = pastedInputs[index]}
						<div class="border-border rounded-md border px-2 py-2">
							<div class="flex items-center gap-2">
								<input aria-label={`Pasted app ${index + 1}`} class="bg-transparent min-w-0 flex-1 font-mono text-xs outline-none" value={rowValue} oninput={(event) => { pastedRows[index] = event.currentTarget.value; pastedRows = [...pastedRows]; }} />
								<Button size="sm" variant="ghost" aria-label={`Remove pasted app ${index + 1}`} onclick={() => (pastedRows = pastedRows.filter((_, item) => item !== index))}>Remove</Button>
							</div>
							{#if row?.kind === "invalid"}<div class="mt-1 text-xs text-warn" role="status">{row.error}</div>{/if}
							{#if row?.kind === "testflight"}
								<div class="mt-1 flex items-center justify-between gap-2 text-xs text-muted">
									<span>TestFlight invite · requires a separate request</span>
									{#if canRequestTestFlight}
										<Button size="sm" variant="secondary" disabled={inviteRequests[row.url] === "pending" || inviteRequests[row.url] === "done"} onclick={() => void requestInvite(row.url)}>{inviteRequests[row.url] === "done" ? "Requested" : inviteRequests[row.url] === "pending" ? "Requesting…" : "Request access"}</Button>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
				<Button class="mt-3 w-full" disabled={pastedInvalid || pastedQueueable.length === 0 || resolving || submitting} loading={resolving || submitting} onclick={submitPasted}>Queue {pastedQueueable.length} App Store app{pastedQueueable.length === 1 ? "" : "s"}</Button>
			{/if}
		{:else}
		<div class="mb-2 text-xs text-muted">{activeTemplate.description}</div>
		{#if source === "testflight"}
			{#if parsed.length === 0}
				<div class="mb-2 text-xs text-muted">Enter apps available via TestFlight to check eligible devices.</div>
			{:else if testFlightCatalogBusy}
				<div class="mb-2 text-xs text-muted" role="status">Checking recent TestFlight access…</div>
			{:else if testFlightCatalogState.error}
				<div class="mb-2 flex items-center justify-between gap-2 text-xs text-warn" role="status">
					<span>TestFlight access could not be refreshed.</span>
					<Button size="sm" variant="ghost" onclick={() => void loadTestFlightCatalog(true)}>Retry</Button>
				</div>
			{:else}
				<div class="mb-2 flex flex-col gap-2">
					{#each testFlightAppSelections as selection (selection.bundleId)}
						<div class="border-border bg-panel-muted flex min-w-0 items-center justify-between gap-3 rounded-md border px-3 py-2">
							<div class="min-w-0">
								<div class="truncate text-xs font-medium">{appDisplayName(selection.bundleId)}</div>
								<div class="truncate font-mono text-[10px] text-muted">{selection.bundleId}</div>
							</div>
							{#if selection.devices.length === 0}
								<span class="shrink-0 text-xs text-warn">Unavailable</span>
							{:else if selection.devices.length === 1}
								<span class="shrink-0 text-xs text-muted">{selection.devices[0]!.name}</span>
							{:else}
								<label class="sr-only" for={`batch-testflight-device-${selection.bundleId}`}>Eligible device for {appDisplayName(selection.bundleId)}</label>
								<Select
									id={`batch-testflight-device-${selection.bundleId}`}
									ariaLabel={`Eligible device for ${appDisplayName(selection.bundleId)}`}
									items={selection.devices.map((device) => ({ value: device.id, label: device.name }))}
									value={selectedDeviceByBundleId[selection.bundleId] ?? ""}
									onValueChange={(deviceId) => setSelectedTestFlightDevice(selection.bundleId, deviceId)}
									class="w-44 shrink-0"
								/>
							{/if}
						</div>
					{/each}
				</div>
				{#if unavailableTestFlightApps.length > 0}
					<div class="mb-2 text-xs text-warn" role="status">Unavailable apps will be marked failed; available apps can still be queued.</div>
				{/if}
				{#if missingTestFlightSelectors.length > 0}
					<div class="mb-2 text-xs text-warn" role="status">Add a version_build selector to queue each TestFlight app.</div>
				{/if}
			{/if}
		{/if}
		<Textarea
			bind:value={text}
			disabled={submitting}
			placeholder={activeTemplate.placeholder}
			rows={6}
			class="border-border bg-panel-muted focus:border-accent w-full rounded-md border px-3 py-2 font-mono text-xs text-text focus:outline-none disabled:opacity-60"
		></Textarea>
		<div class="mt-1.5 text-xs text-muted">
			{parsed.length} bundle ID{parsed.length === 1 ? "" : "s"} recognized
		</div>
		{#if parsedResult.invalidSelectors.length > 0}
			<div class="text-warn mt-1 flex items-start gap-1.5 text-xs" role="status">
				<TriangleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" />
				<span>Check version selector format: {parsedResult.invalidSelectors.join(", ")}</span>
			</div>
		{/if}
		{#if parsedResult.duplicateBundleIds.length > 0}
			<div class="text-warn mt-1 flex items-start gap-1.5 text-xs">
				<TriangleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" />
				<span
					>Repeated in this batch: {parsedResult.duplicateBundleIds.join(
						", ",
					)}</span
				>
			</div>
		{/if}
		{#if alreadyActiveInBatch.length > 0}
			<div class="text-warn mt-1 flex items-start gap-1.5 text-xs">
				<TriangleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" />
				<span
					>Already queued or running: {alreadyActiveInBatch.join(
						", ",
					)}</span
				>
			</div>
		{/if}
		<Button
			class="mt-3 w-full"
			disabled={parsed.length === 0 || (source === "testflight" && (testFlightCatalogBusy || queueableTestFlightEntries.length === 0))}
			loading={submitting}
			onclick={submit}>Queue all</Button
		>
		{/if}
	{:else}
		<div class="flex max-h-72 flex-col gap-1 overflow-y-auto">
			{#each results as r (batchQueueEntryKey(r))}
				<div class="flex items-center gap-2 text-xs">
					{#if r.state === "pending"}
						<LoaderCircle
							class="h-3.5 w-3.5 shrink-0 animate-spin text-muted"
						/>
					{:else if r.state === "ok"}
						<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-ok"
						></span>
					{:else if r.state === "quota"}
						<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"></span>
					{:else}
						<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-err"
						></span>
					{/if}
					<span
						class={cn(
							"flex min-w-0 items-center gap-1.5 truncate",
							r.state === "error" && "text-err",
						)}
					>
						{#if appIconUrl(r.bundleId)}
							<img
								src={appIconUrl(r.bundleId)}
								alt=""
								class="h-3.5 w-3.5 shrink-0 rounded"
							/>
						{/if}
						<span class="truncate"
							>{appDisplayName(r.bundleId)}</span
						>
					</span>
					<span
						class="truncate font-mono text-muted"
						title={batchQueueEntryKey(r)}
						>{r.bundleId}{r.selector
							? `@${r.selector}`
							: ""}</span
					>
					{#if r.error}<span class="text-muted">- {r.error}</span
						>{/if}
				</div>
			{/each}
		</div>
		<div class="mt-3 flex flex-col gap-2">
			<Button variant="secondary" class="w-full" disabled={submitting} onclick={exportResults}>
				<Download class="mr-2 h-4 w-4" />
				Export results
			</Button>
			<div class="flex gap-2">
				{#if failedCount > 0}
					<Button
						class="flex-1"
						loading={submitting}
						onclick={retryFailed}>Retry {failedCount} failed</Button
					>
				{/if}
				<Button
					variant="secondary"
					class="flex-1"
					disabled={submitting}
					onclick={close}>Close</Button
				>
			</div>
		</div>
	{/if}
</Dialog>
