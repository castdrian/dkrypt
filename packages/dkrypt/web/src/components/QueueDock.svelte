<script lang="ts">
	import { CircleCheck, ChevronDown, ChevronUp, Download, LoaderCircle, ListTodo } from "lucide-svelte";
	import AppIcon from "#components/AppIcon.svelte";
	import Button from "#lib/components/ui/Button.svelte";
	import { appDisplayName, appIconUrl, ensureAppCatalog } from "#lib/appCatalog.svelte";
	import { myDecryptsState, highlightJobIdState } from "#lib/decrypts.svelte";
	import { liveState } from "#lib/live.svelte";
	import { setActiveTab, focusViewState, artifactDetailJumpState } from "#lib/ui.svelte";
	import { sessionState } from "#lib/session.svelte";

	let expanded = $state(false);
	const activeJobs = $derived(liveState.overview?.activeJobs ?? []);
	const runningCount = $derived(activeJobs.filter((job) => job.status === "running").length);
	const latestArtifact = $derived.by(() => {
		const now = Date.now();
		return myDecryptsState.items.find((entry) => {
			if (entry.status !== "done" || !entry.artifactUrl || !entry.artifactId) return false;
			const finishedAt = entry.finishedAt ? Date.parse(entry.finishedAt) : entry.createdAt;
			return Number.isFinite(finishedAt) && now - finishedAt < 24 * 60 * 60_000;
		});
	});

	$effect(() => {
		void ensureAppCatalog(activeJobs.slice(0, 5).map((job) => job.bundleId));
		if (activeJobs.length === 0 && !latestArtifact) expanded = false;
	});

	function openJob(jobId: string): void {
		expanded = false;
		setActiveTab("home");
		highlightJobIdState.id = jobId;
	}

	function openArtifact(artifactId: string): void {
		expanded = false;
		setActiveTab("home");
		artifactDetailJumpState.id = artifactId;
	}

	function openLatestArtifact(): void {
		const artifactId = latestArtifact?.artifactId;
		if (artifactId) openArtifact(artifactId);
	}
</script>

{#if sessionState.loggedIn && !focusViewState.enabled && (activeJobs.length > 0 || latestArtifact)}
	<div class="fixed bottom-[calc(5.25rem+env(safe-area-inset-bottom))] left-1/2 z-30 w-[min(34rem,calc(100vw-1.5rem))] -translate-x-1/2 lg:bottom-5">
		{#if expanded}
			<section class="mb-2 overflow-hidden rounded-2xl border border-border bg-card/95 shadow-2xl backdrop-blur-xl" aria-label="Decrypt queue">
					<div class="flex items-center justify-between border-b border-border/70 px-3 py-2.5">
					<div class="flex items-center gap-2 text-sm font-semibold"><ListTodo class="size-4 text-accent" /> Decrypt queue <span class="text-xs font-normal text-muted">{activeJobs.length} active</span></div>
					<Button size="icon" variant="ghost" class="size-7" aria-label="Collapse decrypt queue" onclick={() => (expanded = false)}><ChevronDown class="size-4" /></Button>
				</div>
				{#if activeJobs.length > 0}
					<div class="max-h-[min(50vh,22rem)] divide-y divide-border/70 overflow-y-auto">
						{#each activeJobs.slice(0, 8) as job (job.id)}
							<button type="button" class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50" onclick={() => openJob(job.id)}>
								<AppIcon bundleId={job.bundleId} src={appIconUrl(job.bundleId)} label={appDisplayName(job.bundleId, job.bundleId)} class="size-9" />
								<span class="min-w-0 flex-1">
									<span class="flex min-w-0 items-center gap-2"><span class="truncate text-sm font-medium">{appDisplayName(job.bundleId, job.bundleId)}</span><span class="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{job.testflight ? "TestFlight" : "App Store"}</span></span>
									<span class="mt-0.5 block truncate text-xs text-muted">{job.pausedAt !== undefined ? "Paused in queue" : job.progress || (job.status === "running" ? "Working" : "Waiting in queue")}</span>
								</span>
								{#if job.status === "running"}<LoaderCircle class="size-4 shrink-0 animate-spin text-accent" />{:else}<span class="shrink-0 text-[11px] text-muted">Queued</span>{/if}
							</button>
						{/each}
						{#if activeJobs.length > 8}<div class="px-3 py-2 text-center text-xs text-muted">And {activeJobs.length - 8} more</div>{/if}
					</div>
				{/if}
				{#if latestArtifact}
					<div class="flex items-center gap-3 border-t border-border/70 bg-muted/20 px-3 py-2.5">
						<AppIcon bundleId={latestArtifact.bundleId} src={appIconUrl(latestArtifact.bundleId)} label={latestArtifact.trackName} class="size-9" />
						<span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">{latestArtifact.trackName} is ready</span><span class="block truncate text-xs text-muted">{latestArtifact.versionLabel ?? "IPA available"}</span></span>
						{#if latestArtifact.artifactUrl}<a href={latestArtifact.artifactUrl} class="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-accent-foreground hover:brightness-110" aria-label={`Download ${latestArtifact.trackName}`}><Download class="size-3.5" /> Download</a>{/if}
						{#if latestArtifact.artifactId}<Button size="icon" variant="ghost" class="size-8 shrink-0" aria-label={`Open ${latestArtifact.trackName} in library`} onclick={openLatestArtifact}><CircleCheck class="size-4 text-emerald-500" /></Button>{/if}
					</div>
				{/if}
			</section>
		{/if}
		<Button variant="secondary" class="mx-auto flex h-10 max-w-full items-center gap-2 rounded-full border border-border bg-card/95 px-4 shadow-xl backdrop-blur-xl" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
			{#if activeJobs.length > 0}<span class="relative inline-flex size-4 items-center justify-center">{#if runningCount > 0}<LoaderCircle class="size-4 animate-spin text-accent" />{:else}<ListTodo class="size-4 text-accent" />{/if}</span><span class="text-xs font-semibold">{activeJobs.length} {activeJobs.length === 1 ? "job" : "jobs"}</span><span class="text-xs text-muted">{runningCount > 0 ? `${runningCount} running` : "in queue"}</span>{:else if latestArtifact}<CircleCheck class="size-4 text-emerald-500" /><span class="truncate text-xs font-semibold">Your IPA is ready</span>{/if}
			{#if expanded}<ChevronDown class="size-3.5" />{:else}<ChevronUp class="size-3.5" />{/if}
		</Button>
	</div>
{/if}
