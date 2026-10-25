<script lang="ts">
	import {
		cancelJob,
		fetchJobHistory,
		fetchDashboardQuickSearch,
		fetchMyKeys,
		fetchUsers,
		jobHistoryExportUrl,
		retryJob,
		type JobHistoryEntry,
		type DashboardQuickSearchResult,
	} from "#lib/api";
	import { addDecrypt, pushRecentBundleId } from "#lib/decrypts.svelte";
	import { debounce } from "#lib/format.svelte";
	import { appDisplayName, ensureAppCatalog } from "#lib/appCatalog.svelte";
	import { PermissionFlag } from "#lib/permissions";
	import {
		logout,
		sessionCanSeeSettings,
		sessionHasPermission,
	} from "#lib/session.svelte";
	import {
		closePalette,
		confirmDialog,
		jumpToHistoryBundleId,
		jumpToKeyUsage,
		jumpToUser,
		artifactDetailJumpState,
		deviceDetailJumpState,
		jobDetailJumpState,
		openHelp,
		paletteState,
		requestFocusSearch,
		requestOpenBatch,
		setActiveTab,
		setSettingsSubtab,
		setTheme,
		showToast,
		themePrefState,
	} from "#lib/ui.svelte";
import { interfaceLanguageState, systemLocalesState } from "#lib/ui.svelte";
import { resolveInterfaceLanguage } from "#lib/locale";
	import { translateMessage } from "#lib/messages";
	import Dialog from "#lib/components/ui/Dialog.svelte";
	import Button from "#lib/components/ui/Button.svelte";
	import Input from "#lib/components/ui/Input.svelte";
	import { liveState } from "#lib/live.svelte";
	import { cn } from "#lib/utils";
	import { rankCommands } from "#lib/commandSearch";

	interface Command {
		id: string;
		label: string;
		keywords?: string;
		category?: string;
		subtitle?: string;
		sensitive?: boolean;
		run: () => void;
	}

	let query = $state("");
	let selected = $state(0);
	let inputEl: HTMLInputElement | undefined = $state();
	type RecentJob = Pick<
		JobHistoryEntry,
		| "id"
		| "bundleId"
		| "deviceId"
		| "externalVersionId"
		| "testflight"
		| "versionLabel"
		| "status"
	>;

	let recentJobs = $state<RecentJob[]>([]);
	let queryJobs = $state<RecentJob[]>([]);
	let quickResults = $state<DashboardQuickSearchResult[]>([]);
	let myKeys = $state<{ id: string; name: string }[]>([]);
	let users = $state<{ username: string; accountUsername?: string; displayName?: string }[]>([]);
	let recentIds = $state<string[]>([]);
	let historyQueryToken = 0;
	let quickSearchToken = 0;
	const RECENT_KEY = "commandPaletteRecent";
	const interfaceLanguage = $derived(resolveInterfaceLanguage(interfaceLanguageState.value, systemLocalesState.value));

	function loadRecents(): string[] {
		try {
			const parsed = JSON.parse(
				localStorage.getItem(RECENT_KEY) ?? "[]",
			) as string[];
			return Array.isArray(parsed)
				? parsed.filter((v) => typeof v === "string")
				: [];
		} catch {
			return [];
		}
	}

	function saveRecent(id: string): void {
		recentIds = [id, ...recentIds.filter((x) => x !== id)].slice(0, 20);
		localStorage.setItem(RECENT_KEY, JSON.stringify(recentIds));
	}

	$effect(() => {
		if (!paletteState.open) return;
		recentIds = loadRecents();
		void fetchJobHistory({ cursorOrOffset: 0, limit: 8 }).then((r) => {
			const seen = new Set<string>();
			const jobs: RecentJob[] = [];
			for (const h of r.history) {
				if (seen.has(h.bundleId)) continue;
				seen.add(h.bundleId);
				jobs.push({
					id: h.id,
					bundleId: h.bundleId,
					deviceId: h.deviceId,
					externalVersionId: h.externalVersionId,
					testflight: h.testflight,
					versionLabel: h.versionLabel,
					status: h.status,
				});
			}
			recentJobs = jobs;
		}).catch(() => {});
		void fetchMyKeys().then((r) => {
			myKeys = r.keys.map((k) => ({ id: k.id, name: k.name }));
		});
		if (
			sessionHasPermission(PermissionFlag.viewUsers) ||
			sessionHasPermission(PermissionFlag.manageUsers)
		) {
			void fetchUsers().then((r) => {
				users = r.users.map((u) => ({
					username: u.username,
					displayName: u.displayName,
				}));
			});
		}
	});

	const searchJobHistory = debounce((q: string) => {
		const token = ++historyQueryToken;
		void fetchJobHistory({ cursorOrOffset: 0, limit: 5, q }).then((r) => {
			if (
				!paletteState.open ||
				query.trim() !== q ||
				token !== historyQueryToken
			)
				return;
			const seen = new Set<string>();
			const jobs: RecentJob[] = [];
			for (const h of r.history) {
				if (seen.has(h.bundleId)) continue;
				seen.add(h.bundleId);
				jobs.push({
					id: h.id,
					bundleId: h.bundleId,
					deviceId: h.deviceId,
					externalVersionId: h.externalVersionId,
					testflight: h.testflight,
					versionLabel: h.versionLabel,
					status: h.status,
				});
			}
			queryJobs = jobs;
		}).catch(() => {});
	}, 250);

	$effect(() => {
		const q = query.trim();
		const token = ++quickSearchToken;
		if (!paletteState.open || q.length < 2) {
			quickResults = [];
			queryJobs = [];
			return;
		}
		searchJobHistory(q);
		const timer = setTimeout(() => {
			void fetchDashboardQuickSearch(q).then((response) => {
				if (token === quickSearchToken && paletteState.open && query.trim() === q) quickResults = response.results;
			}).catch(() => {
				if (token === quickSearchToken) quickResults = [];
			});
		}, 180);
		return () => clearTimeout(timer);
	});

	$effect(() => {
		void ensureAppCatalog(
			[...recentJobs, ...queryJobs].map((job) => job.bundleId),
		);
	});

	async function cancelAllJobs(): Promise<void> {
		const jobs = liveState.overview?.activeJobs ?? [];
		if (jobs.length === 0) return;
		if (
			!(await confirmDialog(`Cancel all ${jobs.length} active job(s)?`, {
				confirmLabel: "Cancel all",
			}))
		)
			return;
		await Promise.all(jobs.map((j) => cancelJob(j.id)));
	}

	async function cancelActiveJob(
		id: string,
		bundleId: string,
	): Promise<void> {
		if (
			!(await confirmDialog(`Cancel ${appDisplayName(bundleId)}?`, {
				confirmLabel: "Cancel job",
			}))
		)
			return;
		const { ok } = await cancelJob(id);
		if (ok) showToast(`Cancelled ${appDisplayName(bundleId)}`, "success");
	}

	async function retryRecentJob(job: RecentJob): Promise<void> {
		const { ok, data } = await retryJob(job.id);
		if (!ok) return;
		addDecrypt({
			id: data.id,
			bundleId: job.bundleId,
			trackName: appDisplayName(job.bundleId),
			versionLabel: job.versionLabel,
			externalVersionId: job.externalVersionId,
			testflight: job.testflight,
			status: data.status,
			progress: data.progress,
			queue: data.queue,
			artifactId: data.artifactId,
			artifactUrl: data.artifactUrl,
		});
		pushRecentBundleId(job.bundleId);
		showToast(`Retrying ${appDisplayName(job.bundleId)}`, "success");
	}

	function navigateQuickResult(result: DashboardQuickSearchResult): void {
		if (result.kind === 'app') {
			requestFocusSearch(result.id);
			return;
		}
		if (result.kind === 'job') {
			jobDetailJumpState.id = result.id;
			setActiveTab('home');
			return;
		}
		if (result.kind === 'artifact') {
			artifactDetailJumpState.id = result.id;
			setActiveTab('home');
			return;
		}
		if (result.kind === 'device') {
			deviceDetailJumpState.id = result.id;
			setActiveTab('settings');
			setSettingsSubtab('devices');
			return;
		}
		if (result.kind === 'user') {
			jumpToUser(result.id);
			return;
		}
		setActiveTab('settings');
		setSettingsSubtab(result.id);
	}

	const commands = $derived.by((): Command[] => {
		const base: Command[] = [
			{
				id: "home",
				label: "Go to Home",
				category: "Navigation",
				run: () => setActiveTab("home"),
			},
			{
				id: "billing",
				label: "Go to Plans",
				category: "Navigation",
				run: () => setActiveTab("billing"),
			},
			{
				id: "keys",
				label: "Go to API Keys",
				category: "Navigation",
				run: () => setActiveTab("keys"),
			},
		];
		for (const result of quickResults) {
			const category = translateMessage(`search.${result.kind}` as 'search.app' | 'search.job' | 'search.artifact' | 'search.device' | 'search.user' | 'search.settings', interfaceLanguage);
			base.push({
				id: `quick-${result.kind}-${result.id}`,
				label: result.title,
				keywords: [result.id, result.subtitle].filter(Boolean).join(' '),
				category,
				subtitle: result.subtitle,
				run: () => navigateQuickResult(result),
			});
		}
		if (sessionHasPermission(PermissionFlag.viewLogs)) {
			base.push({
				id: "logs",
				label: "Go to Logs",
				category: "Navigation",
				run: () => setActiveTab("logs"),
			});
		}
		base.push({
			id: "insights",
			label: "Go to Insights",
			category: "Navigation",
			run: () => setActiveTab("insights"),
		});
		base.push({
			id: "docs",
			label: "Go to Docs",
			category: "Navigation",
			run: () => setActiveTab("docs"),
		});
		if (sessionCanSeeSettings()) {
			base.push({
				id: "settings",
				label: "Go to Settings",
				category: "Navigation",
				run: () => setActiveTab("settings"),
			});
		}
		if (sessionHasPermission(PermissionFlag.manageRoles)) {
			base.push({
				id: "settings-roles",
				label: "Go to role management (Discord perks)",
				category: "Navigation",
				keywords: "discord perks roles",
				run: () => {
					setActiveTab("settings");
					setSettingsSubtab("roles");
				},
			});
		}
		const THEME_CYCLE = ["dark", "light", "auto"] as const;
		base.push({
			id: "theme",
			label: "Cycle theme (dark / light / auto)",
			category: "Preferences",
			run: () =>
				setTheme(
					THEME_CYCLE[
						(THEME_CYCLE.indexOf(themePrefState.value) + 1) %
							THEME_CYCLE.length
					],
				),
		});
		base.push({
			id: "shortcuts",
			label: "Show keyboard shortcuts",
			category: "Help",
			run: () => openHelp(),
		});

		if (sessionHasPermission(PermissionFlag.requestDecrypt)) {
			base.push({
				id: "batch-decrypt",
				label: "Open batch decrypt",
				category: "Actions",
				run: () => requestOpenBatch(),
			});
			const activeCount = liveState.overview?.activeJobs.length ?? 0;
			if (activeCount > 0) {
				base.push({
					id: "cancel-all",
					label: `Cancel all ${activeCount} active job(s)`,
					category: "Actions",
					run: () => void cancelAllJobs(),
				});
				for (const job of liveState.overview?.activeJobs ?? []) {
					base.push({
						id: `cancel-${job.id}`,
						label: `Cancel ${appDisplayName(job.bundleId)}`,
						category: "Actions",
						keywords: `${job.bundleId} active job`,
						run: () => void cancelActiveJob(job.id, job.bundleId),
					});
				}
			}
		}
		base.push({
			id: "export-history-csv",
			label: "Export job history as CSV",
			category: "Exports",
			run: () => window.open(jobHistoryExportUrl("csv"), "_blank"),
		});
		base.push({
			id: "export-history-json",
			label: "Export job history as JSON",
			category: "Exports",
			run: () => window.open(jobHistoryExportUrl("json"), "_blank"),
		});

		base.push({
			id: "logout",
			label: "Log out",
			category: "Session",
			run: () => void logout(),
		});

		const devices = liveState.overview?.devices ?? [];
		const showDevice = devices.length > 1;
		const seenJobs = new Set<string>();
		for (const job of [...recentJobs, ...queryJobs]) {
			if (seenJobs.has(job.bundleId)) continue;
			seenJobs.add(job.bundleId);
			const deviceName = showDevice
				? devices.find((d) => d.id === job.deviceId)?.name
				: undefined;
			const appName = appDisplayName(job.bundleId);
			base.push({
				id: `job-${job.bundleId}`,
				label: `Jump to ${appName} in Job History${deviceName ? ` (${deviceName})` : ""}`,
				category: "Navigation",
				keywords: job.bundleId,
				run: () => jumpToHistoryBundleId(job.bundleId),
			});
			if (
				sessionHasPermission(PermissionFlag.requestDecrypt) &&
				job.status === "failed"
			) {
				base.push({
					id: `retry-${job.id}`,
					label: `Retry failed job: ${appName}`,
					category: "Actions",
					keywords: `${job.bundleId} retry failed`,
					run: () => void retryRecentJob(job),
				});
			}
		}
		for (const key of myKeys) {
			base.push({
				id: `key-${key.id}`,
				label: `View usage for API key "${key.name}"`,
				category: "Navigation",
				keywords: key.name,
				run: () => jumpToKeyUsage(key.id),
			});
		}
      for (const u of users) {
			base.push({
				id: `user-${u.username}`,
				label: `Jump to user "${u.displayName || u.username}"`,
				category: "Navigation",
				keywords: `${u.username} ${u.accountUsername ?? ""} ${u.displayName ?? ""}`,
				sensitive: true,
				run: () => jumpToUser(u.username),
			});
		}

		return base;
	});

	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return rankCommands(commands, q, recentIds);
	});

	$effect(() => {
		filtered;
		selected = 0;
	});

	$effect(() => {
		if (paletteState.open) inputEl?.focus();
	});

	function run(cmd: Command): void {
		saveRecent(cmd.id);
		cmd.run();
		close();
	}

	function close(): void {
		query = "";
		closePalette();
	}

	function onKeydown(e: KeyboardEvent): void {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			selected = Math.min(selected + 1, filtered.length - 1);
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			selected = Math.max(selected - 1, 0);
		}
		if (e.key === "Enter") {
			e.preventDefault();
			const cmd = filtered[selected];
			if (cmd) run(cmd);
		}
	}
</script>

<Dialog
	open={paletteState.open}
	onOpenChange={(open) => !open && close()}
	class="top-[18vh] w-[90%] max-w-md translate-y-0 p-2"
>
	<Input
		bind:ref={inputEl}
		bind:value={query}
		onkeydown={onKeydown}
		placeholder={translateMessage('search.placeholder', interfaceLanguage)}
		autofocus
	/>
	<div class="mt-1.5 flex max-h-80 flex-col overflow-y-auto">
		{#each filtered as cmd, i (cmd.id)}
			<Button
				variant="ghost"
				class={cn(
					"h-auto w-full justify-start rounded-md px-3 py-2.5 text-left font-normal text-foreground",
					i === selected && "bg-panel-muted/80 ring-border ring-1",
				)}
				onclick={() => run(cmd)}
			>
				<div class="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1">
					<div class="min-w-0 truncate" data-sensitive={cmd.sensitive ? 'true' : undefined}>{cmd.label}</div>
					{#if cmd.category}<div class="shrink-0 text-[11px] text-muted">{cmd.category}</div>{/if}
				</div>
				{#if cmd.subtitle}<div class="mt-0.5 truncate text-left text-[11px] text-muted">{cmd.subtitle}</div>{/if}
			</Button>
		{/each}
		{#if filtered.length === 0}
			<div class="px-3 py-2.5 text-sm text-muted">
				{translateMessage('search.empty', interfaceLanguage)}
			</div>
		{/if}
	</div>
</Dialog>
