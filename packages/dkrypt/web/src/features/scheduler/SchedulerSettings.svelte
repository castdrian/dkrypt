<script lang="ts">
	import { tick } from "svelte";
	import {
		CircleCheck,
		LoaderCircle,
		Plus,
		Search,
		TriangleAlert,
		X,
	} from "lucide-svelte";
	import EmptyState from "#components/EmptyState.svelte";
	import AuditRibbon from "#components/AuditRibbon.svelte";
	import AppIcon from "#components/AppIcon.svelte";
	import RelativeTime from "#components/RelativeTime.svelte";
	import {
		createWatch,
		deleteWatch,
		fetchSettings,
		fetchWatches,
		fetchProjects,
		previewJobHistoryRetention,
		fetchWebhookDeliveries,
		fetchGithubRepos,
		fetchGithubRateLimit,
		fetchGithubWorkflows,
		fetchAppCatalogStats,
		importWatches,
		fetchTestFlightBridgeDiagnostics,
		fetchWatchHealth,
		fetchWatchCalendar,
		fetchWatchDrafts,
		fetchWatchRevisions,
		previewWatchConflicts,
		saveWatchDraft,
		deleteWatchDraft,
		restoreWatchRevision,
		previewWatchDispatchSource,
		previewWatchDispatchDraft,
		validateWatchDispatchDraft,
		saveSettings,
		searchApps,
		testWebhook,
		triggerWatchDispatch,
		updateWatch,
		watchesExportUrl,
		validateCron,
		type AppWatch,
		type AppCatalogStats,
		type AppStoreSearchResult,
		type DispatchTarget,
		type DispatchValidationResult,
		type GithubRepoOption,
		type GithubRateLimit,
		type GithubWorkflowOption,
		type SchedulerSettings,
		type JobHistoryRetentionPreview,
		type TestFlightUpdateCheck,
		type TestFlightBridgeDiagnostics,
		type UpdateCheck,
		type WatchInput,
		type WatchConflict,
		type WatchRevision,
		type WatchHealthSummary,
		type SchedulerCalendarRun,
		type WebhookDeliveryEntry,
		type ProjectRecord,
	} from "#lib/api";
	import Badge from "#lib/components/ui/Badge.svelte";
	import Button from "#lib/components/ui/Button.svelte";
	import Card from "#lib/components/ui/Card.svelte";
	import Dialog from "#lib/components/ui/Dialog.svelte";
	import Input from "#lib/components/ui/Input.svelte";
	import Select from "#lib/components/ui/Select.svelte";
	import SearchSelect from "#lib/components/ui/SearchSelect.svelte";
	import Switch from "#lib/components/ui/Switch.svelte";
	import { buttonVariants } from "#lib/components/ui/variants";
	import { debounce, fmtCalendarDate, fmtNumber, fmtSize } from "#lib/format.svelte";
	import {
		appDisplayName,
		appIconUrl,
		ensureAppCatalog,
		primeAppCatalogFromSearch,
		refreshAppCatalog,
	} from "#lib/appCatalog.svelte";
	import { liveState } from "#lib/live.svelte";
	import { projectSelectionState } from "#lib/projectSelection.svelte";
	import { PermissionFlag } from "#lib/permissions";
import { sessionHasPermission, sessionState } from "#lib/session.svelte";
import { confirmDialog, showToast } from "#lib/ui.svelte";
import { createWatchPrefillState, interfaceLanguageState, systemLocalesState, watchDetailJumpState } from "#lib/ui.svelte";
import { clearFormDraft, readFormDraft, setFormUnsaved, writeFormDraft } from "#lib/formDrafts.svelte";
	import { resolveInterfaceLanguage } from "#lib/locale";
	import { translateMessage } from "#lib/messages";
	import { exampleWebhookPayload } from "#lib/webhookExamples";
	import Popover from "#lib/components/ui/Popover.svelte";
	import CopyButton from "#components/CopyButton.svelte";
	import AdvancedSection from "#components/AdvancedSection.svelte";

	const FORMAT_OPTIONS = [
		{ value: "embed", label: "Rich embed (Discord)" },
		{ value: "plain", label: "Plain text (Slack / generic)" },
	];

	const SUCCESS_DELIVERY_OPTIONS = [
		{ value: "instant", label: "Immediately" },
		{ value: "daily", label: "Daily digest (09:00)" },
		{ value: "weekly", label: "Weekly digest (Monday 09:00)" },
	];

	const TESTFLIGHT_POLICY_OPTIONS = [
		{ value: "latest", label: "Latest build" },
		{ value: "latestNonExpired", label: "Latest non-expired build" },
		{ value: "train", label: "Specific train" },
	];

	const MISSED_RUN_POLICY_OPTIONS = [
		{ value: "skip", label: "Skip missed checks" },
		{ value: "runOnce", label: "Run one check after restart" },
	];

	const NOTIFY_EVENTS: {
		key: keyof SchedulerSettings;
		label: string;
		description: string;
		group: "Automation" | "Access" | "Device" | "Capacity";
	}[] = [
		{
			key: "notifyOnJobCompleted",
			label: "Any decrypt finishes",
			group: "Automation",
			description:
				"Manual or scheduler jobs, including App Store and TestFlight paths",
		},
		{
			key: "notifyOnQueueSloBreach",
			label: "Queue objective breached",
			group: "Automation",
			description:
				"An active job is projected to exceed the configured queue service objective",
		},
		{
			key: "notifyOnKeyRequest",
			label: "API key requests",
			group: "Access",
			description: "A user without approveApiKeys requests a new key",
		},
		{
			key: "notifyOnAutomationSuccess",
			label: "Automation succeeded",
			group: "Automation",
			description:
				"A watched App Store or TestFlight release completed its GitHub workflow",
		},
		{
			key: "notifyOnAutomationFailure",
			label: "Automation needs attention",
			group: "Automation",
			description:
				"A watched App Store or TestFlight release failed a check, decrypt, dispatch, or workflow",
		},
		{
			key: "notifyOnKeyExpiringSoon",
			label: "API key expiring soon",
			group: "Access",
			description:
				"An approved key has 7 days or less left before it expires",
		},
		{
			key: "notifyOnDeviceOffline",
			label: "iDevice unreachable",
			group: "Device",
			description:
				"A device stays unreachable past the alert threshold below",
		},
		{
			key: "notifyOnDeviceBatteryHot",
			label: "iDevice battery hot",
			group: "Device",
			description:
				"Battery temperature reaches the alert threshold below",
		},
		{
			key: "notifyOnDeviceBatteryLow",
			label: "iDevice battery low",
			group: "Device",
			description:
				"Battery drops to the alert threshold below while not charging",
		},
		{
			key: "notifyOnDiskFull",
			label: "Staging disk full",
			group: "Capacity",
			description:
				"The host staging disk (OUTPUT_DIR) reaches the alert threshold below",
		},
		{
			key: "notifyOnDeviceStorageLow",
			label: "iDevice storage low",
			group: "Capacity",
			description:
				"A device's own storage reaches the alert threshold below",
		},
		{
			key: "notifyOnTestFlightBridgeDown",
			label: "autoinstall bridge unresponsive",
			group: "Device",
			description:
				"The autoinstall SpringBoard bridge stops responding past the alert threshold below",
		},
	];

	const RETRY_OPTIONS = [
		{ value: "0", label: "Off (no retry)" },
		{ value: "1", label: "1 retry" },
		{ value: "2", label: "2 retries" },
		{ value: "3", label: "3 retries" },
		{ value: "5", label: "5 retries" },
	];

	const OFFLINE_ALERT_OPTIONS = [
		{ value: "5", label: "5 minutes" },
		{ value: "15", label: "15 minutes" },
		{ value: "30", label: "30 minutes" },
		{ value: "60", label: "1 hour" },
		{ value: "180", label: "3 hours" },
	];

	const BATTERY_HOT_ALERT_OPTIONS = [
		{ value: "40", label: "40°C" },
		{ value: "42", label: "42°C" },
		{ value: "45", label: "45°C" },
		{ value: "48", label: "48°C" },
		{ value: "50", label: "50°C" },
	];

	const BATTERY_LOW_ALERT_OPTIONS = [
		{ value: "5", label: "5%" },
		{ value: "10", label: "10%" },
		{ value: "15", label: "15%" },
		{ value: "20", label: "20%" },
		{ value: "30", label: "30%" },
	];

	const STORAGE_ALERT_OPTIONS = [
		{ value: "75", label: "75%" },
		{ value: "80", label: "80%" },
		{ value: "90", label: "90%" },
		{ value: "95", label: "95%" },
		{ value: "99", label: "99%" },
	];

	const TESTFLIGHT_BRIDGE_ALERT_OPTIONS = [
		{ value: "5", label: "5 minutes" },
		{ value: "15", label: "15 minutes" },
		{ value: "30", label: "30 minutes" },
		{ value: "60", label: "1 hour" },
		{ value: "180", label: "3 hours" },
	];

	const RETENTION_OPTIONS = [
		{ value: "0", label: "Keep forever (up to 100 entries)" },
		{ value: "30", label: "30 days" },
		{ value: "90", label: "90 days" },
		{ value: "180", label: "180 days" },
		{ value: "365", label: "365 days" },
	];

	const SCHEDULE_TEMPLATES: { label: string; expr: string; maintenanceWindow: { start: string; end: string } | null }[] = [
		{ label: "Every 15 min", expr: "*/15 * * * *", maintenanceWindow: null },
		{ label: "Every 30 min", expr: "*/30 * * * *", maintenanceWindow: null },
		{ label: "Hourly", expr: "0 * * * *", maintenanceWindow: null },
		{ label: "Every 6 hours", expr: "0 */6 * * *", maintenanceWindow: null },
		{ label: "Daily at 3am", expr: "0 3 * * *", maintenanceWindow: null },
		{ label: "Hourly · quiet 22–06", expr: "0 * * * *", maintenanceWindow: { start: "22:00", end: "06:00" } },
	];
	const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	const TIME_ZONE_OPTIONS = [...new Set([LOCAL_TIME_ZONE, "UTC", ...Intl.supportedValuesOf("timeZone")])].map(
		(timezone) => ({ value: timezone, label: timezone }),
	);

	const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
	const WEBHOOK_URL_RE = /^https?:\/\/.+/;
	const DISPATCH_MODE_OPTIONS = [
		{ value: "repository_dispatch", label: "Repository dispatch" },
		{ value: "workflow_dispatch", label: "Workflow dispatch" },
	];

	function workflowFileName(path: string): string {
		const idx = path.lastIndexOf("/");
		return idx >= 0 ? path.slice(idx + 1) : path;
	}

	const canManageWatches = $derived(
		sessionHasPermission(PermissionFlag.manageAutomation),
	);
	const canManageSchedulerSettings = $derived(
		sessionHasPermission(PermissionFlag.manageAutomation),
	);
	const canTriggerDispatch = $derived(
		sessionHasPermission(PermissionFlag.manageAutomation),
	);

	const DEFAULT_WATCH_FORM: WatchInput = {
		projectId: "default",
		bundleId: "",
		repo: "",
		ghWorkflowFile: "remote-ipa-update.yml",
		dispatchTargets: [{ repo: "", ghWorkflowFile: "remote-ipa-update.yml" }],
		pollCron: "0 * * * *",
		timezone: LOCAL_TIME_ZONE,
		maintenanceWindow: null,
		missedRunPolicy: "skip",
		enabled: false,
		webhookUrl: "",
		testFlightPolicy: "latest",
		testFlightTrain: "",
	};

	let watchDialogOpen = $state(false);
	let watchDraftStorageKey = $state("");
	let initialWatchDraft = $state("");
	let maintenanceWindowStart = $state("");
	let maintenanceWindowEnd = $state("");
	let availableProjects = $state<ProjectRecord[]>([]);
	const projectItems = $derived(availableProjects.length > 0 ? availableProjects.map((project) => ({ value: project.id, label: project.name })) : [{ value: "default", label: "Default" }]);
	let editingWatchId = $state<string | null>(null);
	let editingWatchUpdatedAt = $state<number | null>(null);
	let conflictingWatch = $state<AppWatch | null>(null);
	let watchValidationError = $state<{ message: string; fieldId: string } | null>(null);
	let watchForm = $state<WatchInput>({ ...DEFAULT_WATCH_FORM });
	let wizardStep = $state(0);
	let syncedDraftId = $state<string | undefined>(undefined);
	let watchConflicts = $state<WatchConflict[]>([]);
	let acknowledgeWatchConflicts = $state(false);
	let revisionWatch = $state<AppWatch | null>(null);
	let revisions = $state<WatchRevision[]>([]);
	let revisionsOpen = $state(false);
	let dispatchTargets = $state<DispatchTarget[]>([...(DEFAULT_WATCH_FORM.dispatchTargets ?? [])]);
	const watchFormId = "watch-editor";
	let watchCronValid = $state<boolean | null>(null);
	let savingWatch = $state(false);
	let previewByWatch = $state<Record<string, UpdateCheck | null>>({});
	let previewingWatch = $state<Set<string>>(new Set());
	let previewProgressByWatch = $state<Record<string, PreviewProgress[]>>({});
	let triggeringWatch = $state<Set<string>>(new Set());
	let deletingWatch = $state<Set<string>>(new Set());
	let loadingBridgeDiagnostics = $state(false);
	let bridgeDiagnostics = $state<TestFlightBridgeDiagnostics | null>(null);
	let bridgeDiagnosticsOpen = $state(false);
	let watchHealth = $state<WatchHealthSummary[]>([]);
	let watchSearchTerm = $state("");
	let watchSearchResults = $state<AppStoreSearchResult[]>([]);
	let watchSearchLoading = $state(false);
	let watchSearchSearched = $state(false);
	let watchSearchToken = 0;
	let githubRepos = $state<GithubRepoOption[]>([]);
	let githubRateLimit = $state<GithubRateLimit | null>(null);
	let githubReposError = $state("");
	let githubWorkflowsByRepo = $state<Record<string, GithubWorkflowOption[]>>({});
	let githubWorkflowErrors = $state<Record<string, string>>({});
	let loadingWorkflowRepos = $state<Set<string>>(new Set());
	let importingWatches = $state(false);
	let watchImportInput = $state<HTMLInputElement | null>(null);
	let schedulePreviewOpen = $state(false);
	let schedulePreviewLoading = $state(false);
	let schedulePreviewRuns = $state<SchedulerCalendarRun[]>([]);
	let schedulePreviewTruncated = $state(false);
	let schedulePreviewError = $state("");
	let appCatalogStats = $state<AppCatalogStats | null>(null);
	let refreshingCatalog = $state(false);

	const watches = $derived(liveState.overview?.watches ?? []);
	const interfaceLanguage = $derived(resolveInterfaceLanguage(interfaceLanguageState.value, systemLocalesState.value));
	$effect(() => {
		const watchId = watchDetailJumpState.id;
		if (!watchId) return;
		watchDetailJumpState.id = null;
		void tick().then(() => document.getElementById(`watch-${watchId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
	});
	$effect(() => {
		const prefill = createWatchPrefillState.value;
		if (!prefill) return;
		createWatchPrefillState.value = null;
		openAddWatch(true);
		watchForm = { ...watchForm, bundleId: prefill.bundleId };
		watchSearchTerm = prefill.displayName ?? prefill.bundleId;
	});
	$effect(() => {
		void fetchProjects().then(({ projects }) => {
			availableProjects = projects.filter((project) => project.archivedAt === undefined);
		}).catch(() => {
			availableProjects = [];
		});
	});
	$effect(() => {
		if (!watchDialogOpen || !watchDraftStorageKey) return;
		const values = watchDraftValues();
		const serialized = JSON.stringify(values);
		const dirty = serialized !== initialWatchDraft;
		if (dirty) writeFormDraft(watchDraftStorageKey, values);
		setFormUnsaved(watchFormId, dirty);
	});
	$effect(() => {
		if (!watchDialogOpen || editingWatchId) return;
		const serialized = JSON.stringify(watchDraftValues());
		const timer = setTimeout(() => {
			const values = JSON.parse(serialized) as ReturnType<typeof watchDraftValues>;
			const projectId = values.watchForm.projectId ?? 'default';
			void saveWatchDraft(syncedDraftId, projectId, { ...values.watchForm, dispatchTargets: values.dispatchTargets }).then((draft) => {
				if (watchDialogOpen && watchForm.projectId === projectId) syncedDraftId = draft.id;
			}).catch(() => undefined);
		}, 900);
		return () => clearTimeout(timer);
	});

	async function loadWatchConflicts(): Promise<void> {
		if (!watchForm.bundleId || !watchForm.repo) return;
		try {
			watchConflicts = (await previewWatchConflicts({ ...watchForm, dispatchTargets }, editingWatchId ?? undefined)).conflicts;
		} catch (error) {
			showToast(error instanceof Error ? error.message : 'Could not check watch conflicts', 'error');
		}
	}

	async function openWatchRevisions(watch: AppWatch): Promise<void> {
		revisionWatch = watch;
		revisionsOpen = true;
		try {
			revisions = (await fetchWatchRevisions(watch.id)).revisions;
		} catch (error) {
			showToast(error instanceof Error ? error.message : 'Could not load watch revisions', 'error');
		}
	}

	async function restoreRevision(revision: WatchRevision): Promise<void> {
		if (!revisionWatch) return;
		if (!(await confirmDialog(`Restore this watch configuration? The watch will remain ${revisionWatch.enabled ? 'enabled' : 'disabled'}.`, { confirmLabel: 'Restore watch' }))) return;
		try {
			const preview = await previewWatchConflicts({ ...revision.snapshot, enabled: revisionWatch.enabled, webhookUrl: revisionWatch.webhookUrl, projectId: revisionWatch.projectId }, revisionWatch.id);
			if (preview.conflicts.length && !(await confirmDialog(`This schedule overlaps with ${preview.conflicts.length} other watch${preview.conflicts.length === 1 ? '' : 'es'}. Restore anyway?`, { confirmLabel: 'Restore anyway' }))) return;
			const restored = await restoreWatchRevision(revisionWatch.id, revision.id, revisionWatch.updatedAt, revisionWatch.webhookUrl, preview.conflicts.length > 0);
			revisionWatch = restored;
			revisions = (await fetchWatchRevisions(restored.id)).revisions;
			showToast('Watch configuration restored', 'success');
		} catch (error) {
			showToast(error instanceof Error ? error.message : 'Could not restore watch revision', 'error');
		}
	}

	function readableRevisionValue(value: string | undefined): string {
		if (value === undefined) return 'Not set';
		try {
			const parsed = JSON.parse(value) as unknown;
			return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
		} catch {
			return value;
		}
	}

	function watchDraftValues(): {
		editingWatchId: string | null;
		watchForm: Omit<WatchInput, "webhookUrl">;
		maintenanceWindowStart: string;
		maintenanceWindowEnd: string;
		dispatchTargets: DispatchTarget[];
	} {
		return {
			editingWatchId,
			watchForm: {
				projectId: watchForm.projectId,
				bundleId: watchForm.bundleId,
				repo: watchForm.repo,
				ghWorkflowFile: watchForm.ghWorkflowFile,
				dispatchTargets: watchForm.dispatchTargets?.map((target) => ({ ...target })),
				pollCron: watchForm.pollCron,
				timezone: watchForm.timezone,
				maintenanceWindow: watchForm.maintenanceWindow,
				missedRunPolicy: watchForm.missedRunPolicy,
				enabled: watchForm.enabled,
				testFlightPolicy: watchForm.testFlightPolicy,
				testFlightTrain: watchForm.testFlightTrain,
			},
			maintenanceWindowStart,
			maintenanceWindowEnd,
			dispatchTargets: dispatchTargets.map((target) => ({ ...target })),
		};
	}

	function restoreWatchDraft(key: string, expectedWatchId: string | null): boolean {
		const draft = readFormDraft<ReturnType<typeof watchDraftValues>>(key)?.values;
		if (!draft || draft.editingWatchId !== expectedWatchId) return false;
		watchForm = { ...DEFAULT_WATCH_FORM, ...draft.watchForm, webhookUrl: watchForm.webhookUrl };
		maintenanceWindowStart = draft.maintenanceWindowStart;
		maintenanceWindowEnd = draft.maintenanceWindowEnd;
		dispatchTargets = draft.dispatchTargets.map((target) => ({ ...target }));
		return true;
	}

	async function setWatchDialogOpen(open: boolean): Promise<void> {
		if (!open && JSON.stringify(watchDraftValues()) !== initialWatchDraft) {
			const confirmed = await confirmDialog("Close this watch form? Your non-secret changes will be saved as a draft.", { confirmLabel: "Close form" });
			if (!confirmed) return;
		}
		watchDialogOpen = open;
		if (!open) setFormUnsaved(watchFormId, false);
	}
	function projectName(projectId?: string): string {
		const id = projectId ?? "default";
		return availableProjects.find((project) => project.id === id)?.name ?? (id === "default" ? "Default" : "Unavailable project");
	}
	const failedWatchCount = $derived(watchHealth.filter((watch) => watch.lastCheckOk === false || watch.consecutiveFailures > 0).length);
	const healthyWatchCount = $derived(watchHealth.filter((watch) => watch.lastCheckOk && watch.consecutiveFailures === 0).length);

	function healthForWatch(watchId: string): WatchHealthSummary | undefined {
		return watchHealth.find((entry) => entry.watchId === watchId);
	}

	async function loadSchedulePreview(): Promise<void> {
		schedulePreviewOpen = true;
		schedulePreviewLoading = true;
		schedulePreviewError = "";
		try {
			const preview = await fetchWatchCalendar(24, undefined, projectSelectionState.id);
			schedulePreviewRuns = preview.runs;
			schedulePreviewTruncated = preview.truncated;
		} catch (error) {
			schedulePreviewError = error instanceof Error ? error.message : "Schedule preview could not be loaded";
		} finally {
			schedulePreviewLoading = false;
		}
	}

	function scheduleRunTime(run: SchedulerCalendarRun): string {
		const timezone = watches.find((watch) => watch.id === run.watchId)?.timezone ?? LOCAL_TIME_ZONE;
		return fmtCalendarDate(run.at, {
			weekday: "short",
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
			timeZone: timezone,
		});
	}

	$effect(() => {
		void ensureAppCatalog(watches.map((watch) => watch.bundleId));
	});

	$effect(() => {
		if (!canManageWatches) return;
		void fetchGithubRateLimit().then((limit) => (githubRateLimit = limit)).catch(() => undefined);
	});

	$effect(() => {
		void fetchAppCatalogStats().then((stats) => (appCatalogStats = stats)).catch(() => undefined);
	});

	$effect(() => {
		const load = () => void fetchWatchHealth().then(({ watches: next }) => (watchHealth = next)).catch(() => undefined);
		load();
		const interval = setInterval(load, 30_000);
		return () => clearInterval(interval);
	});

	async function openBridgeDiagnostics(): Promise<void> {
		loadingBridgeDiagnostics = true;
		bridgeDiagnosticsOpen = true;
		try {
			bridgeDiagnostics = await fetchTestFlightBridgeDiagnostics();
		} catch (err) {
			bridgeDiagnostics = null;
			showToast(err instanceof Error ? err.message : "Could not load bridge diagnostics", "error");
		} finally {
			loadingBridgeDiagnostics = false;
		}
	}

	const checkWatchCron = debounce(async (expr: string) => {
		if (!expr) {
			watchCronValid = null;
			return;
		}
		const { valid } = await validateCron(expr);
		watchCronValid = valid;
	}, 400);

	$effect(() => {
		checkWatchCron(watchForm.pollCron);
	});

	$effect(() => {
		if (canManageWatches) void loadGithubRepos();
	});

	function repoItemsFor(current: string) {
		const options = githubRepos.map((repo) => ({
			value: repo.fullName,
			label: `${repo.fullName}${repo.isPrivate ? " (private)" : ""}`,
		}));
		const selected = current.trim();
		if (selected && !options.some((option) => option.value === selected)) {
			options.unshift({
				value: selected,
				label: `${selected} (current)`,
			});
		}
		return options;
	}

	function workflowItemsFor(repo: string, current: string) {
		const options = (githubWorkflowsByRepo[repo] ?? []).map((workflow) => ({
			value: workflowFileName(workflow.path),
			label: `${workflow.name} (${workflowFileName(workflow.path)})`,
		}));
		const selected = current.trim();
		if (selected && !options.some((option) => option.value === selected)) {
			options.unshift({
				value: selected,
				label: `${selected} (current)`,
			});
		}
		return options;
	}

	const watchRepoErrors = $derived({
		repo:
			watchForm.repo && !REPO_RE.test(watchForm.repo)
				? "Expected owner/repo"
				: "",
		webhookUrl:
			watchForm.webhookUrl && !WEBHOOK_URL_RE.test(watchForm.webhookUrl)
				? "Expected a full http(s):// URL"
				: "",
	});

	function openAddWatch(skipResume = false): void {
		editingWatchId = null;
		editingWatchUpdatedAt = null;
		conflictingWatch = null;
		watchValidationError = null;
		wizardStep = 0;
		syncedDraftId = undefined;
		watchConflicts = [];
		acknowledgeWatchConflicts = false;
		watchDraftStorageKey = `watch:${sessionState.sub ?? "account"}:new`;
		const selectedProjectId = availableProjects.some((project) => project.id === projectSelectionState.id) ? projectSelectionState.id : "default";
		watchForm = { ...DEFAULT_WATCH_FORM, projectId: selectedProjectId };
		maintenanceWindowStart = "";
		maintenanceWindowEnd = "";
		watchSearchTerm = "";
		watchSearchResults = [];
		watchSearchSearched = false;
		watchSearchLoading = false;
		watchSearchToken += 1;
		dispatchTargets = [{ repo: "", ghWorkflowFile: "remote-ipa-update.yml" }];
		draftPreview = null;
		const localDraftSavedAt = readFormDraft<ReturnType<typeof watchDraftValues>>(watchDraftStorageKey)?.savedAt ?? 0;
		restoreWatchDraft(watchDraftStorageKey, null);
		initialWatchDraft = JSON.stringify(watchDraftValues());
		watchDialogOpen = true;
		if (!skipResume) void fetchWatchDrafts(selectedProjectId).then(({ drafts }) => {
			const draft = drafts[0];
			if (!draft || !watchDialogOpen || editingWatchId) return;
			syncedDraftId = draft.id;
			if (watchForm.bundleId && localDraftSavedAt >= draft.updatedAt) return;
			watchForm = { ...DEFAULT_WATCH_FORM, ...draft.input, webhookUrl: '' } as WatchInput;
			dispatchTargets = draft.input.dispatchTargets?.length ? draft.input.dispatchTargets : dispatchTargets;
		}).catch(() => undefined);
	}

	function openEditWatch(w: AppWatch): void {
		editingWatchId = w.id;
		editingWatchUpdatedAt = w.updatedAt;
		conflictingWatch = null;
		watchValidationError = null;
		watchDraftStorageKey = `watch:${sessionState.sub ?? "account"}:edit:${w.id}`;
		watchForm = {
			projectId: w.projectId ?? "default",
			bundleId: w.bundleId,
			repo: w.repo,
			ghWorkflowFile: w.ghWorkflowFile,
			pollCron: w.pollCron,
			timezone: w.timezone ?? LOCAL_TIME_ZONE,
			maintenanceWindow: w.maintenanceWindow ?? null,
			missedRunPolicy: w.missedRunPolicy ?? "skip",
			enabled: w.enabled,
			webhookUrl: w.webhookUrl ?? "",
			testFlightPolicy: w.testFlightPolicy ?? "latest",
			testFlightTrain: w.testFlightTrain ?? "",
		};
		maintenanceWindowStart = w.maintenanceWindow?.start ?? "";
		maintenanceWindowEnd = w.maintenanceWindow?.end ?? "";
		dispatchTargets = w.dispatchTargets?.length
			? w.dispatchTargets.map((target) => ({ ...target }))
			: [{ repo: w.repo, ghWorkflowFile: w.ghWorkflowFile }];
		watchSearchTerm = appDisplayName(w.bundleId);
		watchSearchResults = [];
		watchSearchSearched = false;
		watchSearchLoading = false;
		watchSearchToken += 1;
		for (const target of dispatchTargets) void loadGithubWorkflows(target.repo);
		draftPreview = null;
		restoreWatchDraft(watchDraftStorageKey, w.id);
		initialWatchDraft = JSON.stringify(watchDraftValues());
		watchDialogOpen = true;
	}

	async function loadGithubRepos(): Promise<void> {
		if (githubRepos.length > 0) return;
		githubReposError = "";
		try {
			const { repos } = await fetchGithubRepos();
			githubRepos = repos;
		} catch (err) {
			githubRepos = [];
			githubReposError =
				err instanceof Error
					? err.message
					: "Failed to load GitHub repositories";
		}
	}

	async function loadGithubWorkflows(repo: string): Promise<void> {
		const trimmed = repo.trim();
		if (!trimmed || !REPO_RE.test(trimmed) || githubWorkflowsByRepo[trimmed] || loadingWorkflowRepos.has(trimmed)) return;
		loadingWorkflowRepos = new Set(loadingWorkflowRepos).add(trimmed);
		githubWorkflowErrors = { ...githubWorkflowErrors, [trimmed]: "" };
		try {
			const { workflows } = await fetchGithubWorkflows(trimmed);
			githubWorkflowsByRepo = { ...githubWorkflowsByRepo, [trimmed]: workflows };
		} catch (err) {
			githubWorkflowErrors = { ...githubWorkflowErrors, [trimmed]: err instanceof Error ? err.message : "Failed to load workflows" };
		} finally {
			const next = new Set(loadingWorkflowRepos);
			next.delete(trimmed);
			loadingWorkflowRepos = next;
		}
	}

	function setDispatchTarget(index: number, patch: Partial<DispatchTarget>): void {
		dispatchTargets = dispatchTargets.map((target, targetIndex) => targetIndex === index ? { ...target, ...patch } : target);
		const primary = dispatchTargets[0] ?? { repo: "", ghWorkflowFile: "remote-ipa-update.yml" };
		watchForm = { ...watchForm, repo: primary.repo, ghWorkflowFile: primary.ghWorkflowFile, dispatchTargets };
	}

	function onWatchRepoChange(index: number, repo: string): void {
		setDispatchTarget(index, { repo });
		void loadGithubWorkflows(repo);
	}

	function onWatchWorkflowChange(index: number, ghWorkflowFile: string): void {
		setDispatchTarget(index, { ghWorkflowFile });
	}

	function setDispatchInput(index: number, previousKey: string, key: string, value: string): void {
		const inputs = { ...(dispatchTargets[index]?.inputs ?? {}) };
		delete inputs[previousKey];
		if (key.trim()) inputs[key.trim()] = value;
		setDispatchTarget(index, { inputs: Object.keys(inputs).length ? inputs : undefined });
	}

	function addDispatchInput(index: number): void {
		const inputs = { ...(dispatchTargets[index]?.inputs ?? {}) };
		let name = "input-name";
		let suffix = 2;
		while (name in inputs) name = `input-name-${suffix++}`;
		inputs[name] = "";
		setDispatchTarget(index, { inputs });
	}

	function addDispatchTarget(): void {
		dispatchTargets = [...dispatchTargets, { repo: "", ghWorkflowFile: "remote-ipa-update.yml" }];
	}

	function removeDispatchTarget(index: number): void {
		if (dispatchTargets.length === 1) return;
		dispatchTargets = dispatchTargets.filter((_, targetIndex) => targetIndex !== index);
		setDispatchTarget(0, {});
	}

	function pickWatchApp(result: AppStoreSearchResult): void {
		watchForm = { ...watchForm, bundleId: result.bundleId };
		watchSearchTerm = result.trackName;
		watchSearchResults = [];
		watchSearchSearched = false;
		primeAppCatalogFromSearch([result]);
	}

	async function runWatchSearch(q: string): Promise<void> {
		const trimmed = q.trim();
		const token = ++watchSearchToken;
		if (!trimmed) {
			watchSearchResults = [];
			watchSearchSearched = false;
			watchSearchLoading = false;
			return;
		}
		watchSearchLoading = true;
		try {
			const data = await searchApps(trimmed);
			if (token !== watchSearchToken) return;
			if ("error" in data) {
				watchSearchResults = [];
				showToast(data.error, "error");
			} else {
				watchSearchResults = data.results;
				primeAppCatalogFromSearch(data.results);
			}
			watchSearchSearched = true;
		} catch {
			if (token !== watchSearchToken) return;
			watchSearchResults = [];
			watchSearchSearched = true;
		} finally {
			if (token === watchSearchToken) watchSearchLoading = false;
		}
	}

	const debouncedWatchSearch = debounce(
		(q: string) => void runWatchSearch(q),
		400,
	);

	function onWatchSearchInput(): void {
		if (!watchSearchTerm.trim()) {
			debouncedWatchSearch.cancel();
			watchSearchToken += 1;
			watchSearchResults = [];
			watchSearchSearched = false;
			watchSearchLoading = false;
			return;
		}
		debouncedWatchSearch(watchSearchTerm);
	}

	function applyScheduleTemplate(template: typeof SCHEDULE_TEMPLATES[number]): void {
		watchForm = { ...watchForm, pollCron: template.expr, maintenanceWindow: template.maintenanceWindow };
		maintenanceWindowStart = template.maintenanceWindow?.start ?? "";
		maintenanceWindowEnd = template.maintenanceWindow?.end ?? "";
	}

	let draftPreview = $state<UpdateCheck | null>(null);
	let previewedWatchTarget = $state('');
	let previewingDraft = $state(false);
	let draftPreviewError = $state("");
	let validatingDraft = $state(false);
	let dispatchValidation = $state<DispatchValidationResult[] | null>(null);

	async function previewDraft(): Promise<void> {
		if (
			!watchForm.bundleId.trim() ||
			!watchForm.repo.trim() ||
			watchRepoErrors.repo
		)
			return;
		previewingDraft = true;
		draftPreviewError = "";
		try {
			draftPreview = await previewWatchDispatchDraft(
				watchForm.bundleId.trim(),
				watchForm.repo.trim(),
			);
			previewedWatchTarget = `${watchForm.bundleId.trim()}:${watchForm.repo.trim()}`;
		} catch (err) {
			draftPreview = null;
			draftPreviewError =
				err instanceof Error ? err.message : String(err);
		} finally {
			previewingDraft = false;
		}
	}

	async function validateDraftDispatch(): Promise<void> {
		if (dispatchTargets.some((target) => !REPO_RE.test(target.repo) || !target.ghWorkflowFile.trim())) return;
		validatingDraft = true;
		dispatchValidation = null;
		try {
			dispatchValidation = (await validateWatchDispatchDraft(dispatchTargets)).results;
		} catch (err) {
			showToast(err instanceof Error ? err.message : String(err), "error");
		} finally {
			validatingDraft = false;
		}
	}

	async function saveWatch(): Promise<void> {
		watchValidationError = null;
		if (watchCronValid === false) {
			await focusWatchError('Poll cron is not a valid cron expression', 'w-pollCron');
			return;
		}
		if (!watchForm.timezone || !TIME_ZONE_OPTIONS.some((option) => option.value === watchForm.timezone)) {
			await focusWatchError('Choose a valid time zone', 'w-timezone');
			return;
		}
		if (Boolean(maintenanceWindowStart) !== Boolean(maintenanceWindowEnd) || (maintenanceWindowStart && maintenanceWindowStart === maintenanceWindowEnd)) {
			await focusWatchError('Choose different start and end times for quiet hours', 'w-maintenance-start');
			return;
		}
		if (watchRepoErrors.repo || watchRepoErrors.webhookUrl || dispatchTargets.some((target) => !REPO_RE.test(target.repo) || !target.ghWorkflowFile.trim())) {
			const fieldId = watchRepoErrors.webhookUrl ? 'w-webhookUrl' : dispatchTargets.some((target) => !REPO_RE.test(target.repo)) ? `w-repo-${Math.max(0, dispatchTargets.findIndex((target) => !REPO_RE.test(target.repo)))}` : `w-workflow-${Math.max(0, dispatchTargets.findIndex((target) => !target.ghWorkflowFile.trim()))}`;
			await focusWatchError('Fix the invalid fields before saving', fieldId);
			return;
		}
		if (!draftPreview || previewedWatchTarget !== `${watchForm.bundleId.trim()}:${watchForm.repo.trim()}`) {
			await previewDraft();
			return;
		}
		await loadWatchConflicts();
		if (watchConflicts.length > 0 && !acknowledgeWatchConflicts) {
			await focusWatchError('Review and acknowledge the overlapping watch schedules', 'watch-conflict-acknowledgement');
			return;
		}
		savingWatch = true;
		try {
			const maintenanceWindow = maintenanceWindowStart && maintenanceWindowEnd
				? { start: maintenanceWindowStart, end: maintenanceWindowEnd }
				: null;
			const { ok, data } = editingWatchId
				? await updateWatch(editingWatchId, { ...watchForm, maintenanceWindow, dispatchTargets, acknowledgeConflicts: acknowledgeWatchConflicts, expectedUpdatedAt: editingWatchUpdatedAt ?? undefined })
				: await createWatch({ ...watchForm, maintenanceWindow, dispatchTargets, acknowledgeConflicts: acknowledgeWatchConflicts });
			if (!ok) {
				const response = data as AppWatch & { code?: string; remediation?: { current?: AppWatch } };
				if (response.code === 'revision_conflict' && response.remediation?.current) conflictingWatch = response.remediation.current;
			}
			if (ok) {
				if (syncedDraftId) void deleteWatchDraft(syncedDraftId);
				clearFormDraft(watchDraftStorageKey);
				initialWatchDraft = JSON.stringify(watchDraftValues());
				setFormUnsaved(watchFormId, false);
				watchDialogOpen = false;
			}
		} finally {
			savingWatch = false;
		}
	}

	async function focusWatchError(message: string, fieldId: string): Promise<void> {
		watchValidationError = { message, fieldId };
		await tick();
		document.getElementById(fieldId)?.focus();
	}

	async function reloadConflictingWatch(): Promise<void> {
		if (!conflictingWatch || !editingWatchId) return;
		const currentId = editingWatchId;
		const { watches: latestWatches } = await fetchWatches();
		const latest = latestWatches.find((watch) => watch.id === currentId);
		if (!latest) return;
		clearFormDraft(watchDraftStorageKey);
		openEditWatch(latest);
	}

	async function applyWatchEditsToLatest(): Promise<void> {
		if (!conflictingWatch) return;
		editingWatchUpdatedAt = conflictingWatch.updatedAt;
		conflictingWatch = null;
		await saveWatch();
	}

	async function removeWatch(w: AppWatch): Promise<void> {
		if (
			!(await confirmDialog(
				`Remove "${appDisplayName(w.bundleId)}"? Its scheduled checks stop immediately.`,
			))
		)
			return;
		const id = w.id;
		deletingWatch = new Set(deletingWatch).add(id);
		try {
			await deleteWatch(id);
		} finally {
			const next = new Set(deletingWatch);
			next.delete(id);
			deletingWatch = next;
		}
	}

  async function toggleWatchEnabled(w: AppWatch): Promise<void> {
    const result = await updateWatch(w.id, { enabled: !w.enabled, expectedUpdatedAt: w.updatedAt }, null);
		if (!result.ok) return;
		const desiredState = !w.enabled;
		showToast(translateMessage(desiredState ? 'undo.watchesEnabled' : 'undo.watchesPaused', interfaceLanguage), 'success', {
			duration: 8000,
			action: {
				label: translateMessage('undo.action', interfaceLanguage),
				onClick: () => void undoWatchEnabled(w, result.data.updatedAt),
			},
		});
	}

	async function undoWatchEnabled(watch: AppWatch, expectedUpdatedAt: number): Promise<void> {
		const result = await updateWatch(watch.id, { enabled: watch.enabled, expectedUpdatedAt }, null);
		if (!result.ok) {
			showToast(translateMessage('undo.conflict', interfaceLanguage), 'error');
			return;
		}
		showToast(watch.enabled ? translateMessage('undo.watchesPaused', interfaceLanguage) : translateMessage('undo.watchesEnabled', interfaceLanguage), 'success');
	}

	async function refreshWatchedCatalog(): Promise<void> {
		refreshingCatalog = true;
		try {
			if (await refreshAppCatalog(watches.map((watch) => watch.bundleId))) {
				appCatalogStats = await fetchAppCatalogStats();
				showToast("App metadata refreshed", "success");
			}
		} finally {
			refreshingCatalog = false;
		}
	}

	async function importWatchFile(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		importingWatches = true;
		try {
			const parsed = JSON.parse(await file.text()) as { watches?: WatchInput[] };
			if (!Array.isArray(parsed.watches)) throw new Error("This file does not contain watches");
			const { ok, data } = await importWatches(parsed.watches);
			if (ok && data.skipped.length) showToast(`${fmtNumber(data.watches.length, 0)} watches imported; ${fmtNumber(data.skipped.length, 0)} skipped`, "success");
		} catch (err) {
			showToast(err instanceof Error ? err.message : "Could not import watches", "error");
		} finally {
			input.value = "";
			importingWatches = false;
		}
	}

	type PreviewProgress = {
		source: "appStore" | "testflight";
		label: string;
		detail: string;
		state: "checking" | "complete" | "failed";
	};

	function updatePreviewProgress(
		id: string,
		source: PreviewProgress["source"],
		detail: string,
		state: PreviewProgress["state"],
	): void {
		const previous = previewProgressByWatch[id] ?? [];
		const label = source === "appStore" ? "App Store" : "TestFlight";
		const next = previous.filter((entry) => entry.source !== source);
		previewProgressByWatch = {
			...previewProgressByWatch,
			[id]: [...next, { source, label, detail, state }],
		};
	}

	function failedPreviewCheck(reason: string): UpdateCheck {
		return { ok: false, wouldDispatch: false, reason };
	}

	async function runPreviewWatch(id: string): Promise<void> {
		previewingWatch = new Set(previewingWatch).add(id);
		previewByWatch = { ...previewByWatch, [id]: null };
		previewProgressByWatch = {
			...previewProgressByWatch,
			[id]: [
				{
					source: "appStore",
					label: "App Store",
					detail: "Looking up the live version and published releases…",
					state: "checking",
				},
				{
					source: "testflight",
					label: "TestFlight",
					detail: "Checking the TestFlight catalog and published builds…",
					state: "checking",
				},
			],
		};
		try {
			const [appStore, testflight] = await Promise.all([
				previewWatchDispatchSource(id, "app-store")
					.then(({ result }) => {
						const check = result as UpdateCheck;
						updatePreviewProgress(
							id,
							"appStore",
							check.reason,
							check.ok ? "complete" : "failed",
						);
						return check;
					})
					.catch((err) => {
						const check = failedPreviewCheck(
							err instanceof Error ? err.message : String(err),
						);
						updatePreviewProgress(
							id,
							"appStore",
							check.reason,
							"failed",
						);
						return check;
					}),
				previewWatchDispatchSource(id, "testflight")
					.then(({ result }) => {
						const check = result as TestFlightUpdateCheck;
						updatePreviewProgress(
							id,
							"testflight",
							check.reason,
							check.ok ? "complete" : "failed",
						);
						return check;
					})
					.catch((err) => {
						const check = failedPreviewCheck(
							err instanceof Error ? err.message : String(err),
						) as TestFlightUpdateCheck;
						updatePreviewProgress(
							id,
							"testflight",
							check.reason,
							"failed",
						);
						return check;
					}),
			]);
			previewByWatch = {
				...previewByWatch,
				[id]: { ...appStore, testflight },
			};
		} finally {
			const next = new Set(previewingWatch);
			next.delete(id);
			previewingWatch = next;
		}
	}

	function dismissPreview(id: string): void {
		const next = { ...previewByWatch };
		delete next[id];
		previewByWatch = next;
		const progress = { ...previewProgressByWatch };
		delete progress[id];
		previewProgressByWatch = progress;
	}

	async function runTriggerWatch(id: string): Promise<void> {
		if (
			!(await confirmDialog(
				"Run a live check now? If there's a new version, it'll decrypt and dispatch for real.",
				{ variant: "default", confirmLabel: "Trigger now" },
			))
		)
			return;
		triggeringWatch = new Set(triggeringWatch).add(id);
		try {
			const { ok, data } = await triggerWatchDispatch(id);
			if (ok)
				showToast(
					"Dispatch check triggered - watch Active Jobs / Logs for progress",
					"success",
				);
			else showToast(data.error ?? "Failed to trigger", "error");
		} finally {
			const next = new Set(triggeringWatch);
			next.delete(id);
			triggeringWatch = next;
		}
	}

	const DEFAULT_FORM: SchedulerSettings = {
		notifyWebhookUrl: "",
		notifyFormat: "embed",
		notifySuccessMode: "instant",
		notifyQuietHoursStart: "",
		notifyQuietHoursEnd: "",
		notifyOnKeyRequest: true,
		notifyOnAutomationSuccess: true,
		notifyOnAutomationFailure: true,
		notifyOnKeyExpiringSoon: true,
		notifyOnDeviceOffline: true,
		notifyOnDeviceBatteryHot: true,
		notifyOnDeviceBatteryLow: true,
		notifyOnDiskFull: true,
		notifyOnDeviceStorageLow: true,
		notifyOnTestFlightBridgeDown: true,
		notifyOnJobCompleted: false,
		notifyOnQueueSloBreach: true,
		schedulerRetryCount: 0,
		deviceOfflineAlertMinutes: 15,
		batteryHotAlertC: 45,
		batteryLowAlertPercent: 10,
		diskFullAlertPercent: 90,
		deviceStorageAlertPercent: 90,
		testFlightBridgeAlertMinutes: 15,
		jobHistoryRetentionDays: 0,
		maintenanceMode: false,
	};

	let form = $state<SchedulerSettings>({ ...DEFAULT_FORM });
	let savedForm = $state<SchedulerSettings>({ ...DEFAULT_FORM });
	let settingsDialogOpen = $state(false);
	let testingWebhook = $state(false);
	let saving = $state(false);
	let deliveries = $state<WebhookDeliveryEntry[] | null>(null);
	let retentionPreview = $state<JobHistoryRetentionPreview | null>(null);
	let retentionPreviewLoading = $state(false);
	let retentionPreviewError = $state("");
	let retentionPreviewRequestId = 0;

	$effect(() => {
		void fetchSettings().then((s) => {
			form = { ...s };
			savedForm = { ...s };
		});
	});

	function loadDeliveries(): void {
		void fetchWebhookDeliveries(10).then(
			(r) => (deliveries = r.deliveries),
		);
	}

	$effect(() => {
		loadDeliveries();
		const interval = setInterval(loadDeliveries, 30_000);
		return () => clearInterval(interval);
	});

	function openSettingsDialog(): void {
		form = { ...savedForm };
		settingsDialogOpen = true;
		void loadRetentionPreview(form.jobHistoryRetentionDays);
	}

	async function loadRetentionPreview(retentionDays: number): Promise<void> {
		if (!canManageSchedulerSettings) return;
		const requestId = ++retentionPreviewRequestId;
		retentionPreviewLoading = true;
		retentionPreviewError = "";
		try {
			const preview = await previewJobHistoryRetention(retentionDays);
			if (requestId === retentionPreviewRequestId) retentionPreview = preview;
		} catch (error) {
			if (requestId === retentionPreviewRequestId) {
				retentionPreviewError = error instanceof Error ? error.message : String(error);
			}
		} finally {
			if (requestId === retentionPreviewRequestId) retentionPreviewLoading = false;
		}
	}

	const repoErrors = $derived({
		notifyWebhookUrl:
			form.notifyWebhookUrl && !WEBHOOK_URL_RE.test(form.notifyWebhookUrl)
				? "Expected a full http(s):// URL"
				: "",
	});

	const enabledAlertCount = $derived(
		NOTIFY_EVENTS.filter((e) => savedForm[e.key]).length,
	);
	const notificationGroups = ["Automation", "Access", "Device", "Capacity"] as const;

	function applyNotificationPreset(preset: "essential" | "all" | "quiet"): void {
		const enabled = new Set<keyof SchedulerSettings>(
			preset === "all"
				? NOTIFY_EVENTS.map((event) => event.key)
				: preset === "essential"
					? ["notifyOnAutomationFailure", "notifyOnKeyRequest", "notifyOnDeviceOffline", "notifyOnTestFlightBridgeDown", "notifyOnDiskFull"]
					: ["notifyOnAutomationFailure", "notifyOnDeviceOffline", "notifyOnTestFlightBridgeDown"],
		);
		form = Object.fromEntries(
			Object.entries(form).map(([key, value]) => [key, NOTIFY_EVENTS.some((event) => event.key === key) ? enabled.has(key as keyof SchedulerSettings) : value]),
		) as SchedulerSettings;
	}

	async function save(): Promise<void> {
		if (repoErrors.notifyWebhookUrl) {
			showToast("Fix the invalid fields before saving", "error");
			return;
		}
		saving = true;
		try {
			const { ok, data } = await saveSettings(form);
			if (ok) {
				form = { ...data };
				savedForm = { ...data };
				settingsDialogOpen = false;
			}
		} finally {
			saving = false;
		}
	}

	async function runTestWebhook(): Promise<void> {
		testingWebhook = true;
		try {
			const { data } = await testWebhook(
				form.notifyWebhookUrl || undefined,
			);
			showToast(
				data.ok
					? "Test notification sent"
					: (data.error ?? "Failed to send"),
				data.ok ? "success" : "error",
			);
		} finally {
			testingWebhook = false;
		}
	}
</script>

<div class="flex flex-col gap-4">
	<AdvancedSection label="settings.automationDiagnostics">
	<Card title="Automation health">
		<div class="flex flex-wrap items-center gap-2 text-sm">
			<Badge variant={failedWatchCount > 0 ? "destructive" : "success"}>{failedWatchCount > 0 ? "attention needed" : "healthy"}</Badge>
			<span class="text-muted">{fmtNumber(healthyWatchCount, 0)} healthy · {fmtNumber(failedWatchCount, 0)} needs attention · {fmtNumber(watches.filter((watch) => watch.schedulable).length, 0)} active</span>
			{#if canManageSchedulerSettings}
				<div class="ml-auto flex flex-wrap items-center gap-1.5">
					<Button size="sm" variant="secondary" loading={loadingBridgeDiagnostics} onclick={openBridgeDiagnostics}>Inspect autoinstall</Button>
				</div>
			{/if}
		</div>
		<div class="mt-2 flex items-center gap-2 text-xs text-muted">
			<span>{appCatalogStats ? `${fmtNumber(appCatalogStats.entries, 0)} catalogued apps · ${fmtNumber(appCatalogStats.icons, 0)} icons cached` : "Loading app catalog…"}</span>
			{#if canManageWatches}
				<Button size="sm" variant="secondary" class="ml-auto" loading={refreshingCatalog} onclick={refreshWatchedCatalog}>Refresh app metadata</Button>
			{/if}
		</div>
		{#if githubRateLimit?.remaining !== undefined}
			<div class="border-border mt-2 flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-2 text-xs">
				<Badge variant={githubRateLimit.remaining < 100 ? "destructive" : "secondary"}>GitHub API</Badge>
				<span class="font-medium">{fmtNumber(githubRateLimit.remaining, 0)}/{githubRateLimit.limit === undefined ? "?" : fmtNumber(githubRateLimit.limit, 0)} remaining</span>
				{#if githubRateLimit.reset}<span class="text-muted">resets {fmtCalendarDate(githubRateLimit.reset * 1000, { hour: "2-digit", minute: "2-digit" })}</span>{/if}
			</div>
		{/if}
	</Card>
	</AdvancedSection>

	<Card title="Watches">
		{#snippet headerExtra()}
			{#if canManageWatches}
				<div class="flex items-center gap-1.5">
					<Button size="sm" variant="secondary" onclick={() => void loadSchedulePreview()} loading={schedulePreviewLoading}>{schedulePreviewOpen ? "Refresh preview" : "Preview next 24 hours"}</Button>
					<input class="hidden" bind:this={watchImportInput} type="file" accept="application/json" onchange={importWatchFile} />
					<Button size="sm" variant="secondary" onclick={() => watchImportInput?.click()} loading={importingWatches}>Import</Button>
					<a class={buttonVariants("secondary", "sm")} href={watchesExportUrl()}>Export</a>
					<Button size="sm" onclick={() => openAddWatch()}>
						<Plus class="h-3.5 w-3.5" />
						Add watch
					</Button>
				</div>
			{/if}
		{/snippet}
		{#if schedulePreviewOpen}
			<div class="border-border mb-3 rounded-lg border p-3" aria-live="polite">
				<div class="mb-2 flex items-center justify-between gap-2">
					<h3 class="text-sm font-medium">Next 24 hours</h3>
					<span class="text-xs text-muted">Times shown in each watch’s time zone</span>
				</div>
				{#if schedulePreviewLoading}
					<p class="py-3 text-center text-sm text-muted">Loading schedule…</p>
				{:else if schedulePreviewError}
					<p class="py-3 text-sm text-err">{schedulePreviewError}</p>
				{:else if schedulePreviewRuns.length === 0}
					<p class="py-3 text-center text-sm text-muted">No scheduled checks in this project during the next 24 hours.</p>
				{:else}
					<div class="max-h-64 divide-border divide-y overflow-y-auto">
						{#each schedulePreviewRuns as run (`${run.watchId}:${run.at}`)}
							{@const watch = watches.find((candidate) => candidate.id === run.watchId)}
							<div class="flex flex-wrap items-center gap-2 py-2 first:pt-0 last:pb-0">
								<AppIcon bundleId={run.bundleId} src={appIconUrl(run.bundleId)} label={appDisplayName(run.bundleId)} class="h-4 w-4" />
								<span class="min-w-28 flex-1 text-sm font-medium">{watch ? appDisplayName(run.bundleId) : run.bundleId}</span>
								<time class="text-xs text-muted" datetime={new Date(run.at).toISOString()}>{scheduleRunTime(run)}{watch?.timezone ? ` · ${watch.timezone}` : ""}</time>
								{#if run.deferred}<Badge variant="secondary">After quiet hours</Badge>{/if}
							</div>
						{/each}
					</div>
					{#if schedulePreviewTruncated}<p class="mt-2 text-xs text-muted">Additional checks are omitted from this preview.</p>{/if}
				{/if}
			</div>
		{/if}
		{#if watches.length === 0}
			<EmptyState
				message="No watches configured yet - add one to have dkrypt track an app for new releases."
			/>
		{:else}
			<div class="flex flex-col gap-2.5">
				{#each watches as w (w.id)}
					<div id={`watch-${w.id}`} class="border-border rounded-lg border p-3">
						<div class="flex flex-wrap items-center gap-2">
							<span
								class="flex items-center gap-1.5 text-[13px] font-medium"
							>
								<AppIcon bundleId={w.bundleId} src={appIconUrl(w.bundleId)} label={appDisplayName(w.bundleId)} class="h-4 w-4" />
								<span>{appDisplayName(w.bundleId)}</span>
							</span>
							<Badge
								variant={w.schedulable
									? "success"
									: "secondary"}
								>{w.schedulable ? "watching" : "off"}</Badge
							>
							{#if w.nextRunAt}
								<span class="text-xs text-muted"
									>next run <RelativeTime
										ms={w.nextRunAt}
									/></span
								>
							{/if}
							<div class="ml-auto flex flex-wrap gap-1.5">
								{#if canManageWatches}
									<Switch
										checked={w.enabled}
										onCheckedChange={() =>
											void toggleWatchEnabled(w)}
										aria-label="Enable {w.bundleId}"
									/>
									<Button
										size="sm"
										variant="secondary"
										onclick={() => openEditWatch(w)}
										>Edit</Button
									>
									<Button size="sm" variant="secondary" onclick={() => void openWatchRevisions(w)}>History</Button>
									<Button
										size="sm"
										variant="destructive"
										loading={deletingWatch.has(w.id)}
										onclick={() => removeWatch(w)}
										>Remove</Button
									>
								{/if}
								{#if canTriggerDispatch}
									<Button
										size="sm"
										variant="secondary"
										loading={previewingWatch.has(w.id)}
										onclick={() => runPreviewWatch(w.id)}
										>Preview</Button
									>
									<Button
										size="sm"
										variant="secondary"
										loading={triggeringWatch.has(w.id)}
										onclick={() => runTriggerWatch(w.id)}
										>Trigger now</Button
									>
								{/if}
							</div>
						</div>
						<div
							class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted"
						>
							<span>{projectName(w.projectId)}</span>
							<span title={w.repo}>{w.dispatchTargets?.length ? `${fmtNumber(w.dispatchTargets.length, 0)} destinations` : w.repo || "-"}</span>
			<span title="poll cron in the selected time zone">{w.pollCron} · {w.timezone ?? LOCAL_TIME_ZONE}</span>
			{#if w.maintenanceWindow}
				<span title="Automatic checks pause during this local-time window">Quiet {w.maintenanceWindow.start}–{w.maintenanceWindow.end}</span>
			{/if}
							{#if healthForWatch(w.id)?.schedulerJobSuccessRate !== undefined}
								<span class="font-sans">{Math.round((healthForWatch(w.id)?.schedulerJobSuccessRate ?? 0) * 100)}% scheduler success</span>
							{/if}
							{#if healthForWatch(w.id)?.medianSchedulerJobDurationMs}
								<span class="font-sans">{Math.round((healthForWatch(w.id)?.medianSchedulerJobDurationMs ?? 0) / 60_000)}m median decrypt</span>
							{/if}
						</div>
						{#if w.configIssues.length > 0}
							<div class="mt-1.5 text-xs text-warn">
								{w.configIssues.join(" ")}
							</div>
						{/if}
						<AuditRibbon target={w.id} />
						{#if previewProgressByWatch[w.id]}
							<div
								class="border-border bg-panel-muted mt-2 rounded-md border p-2.5 text-xs"
								aria-live="polite"
							>
								<div
									class="mb-1.5 flex items-center gap-2 font-medium"
								>
									<span>Preview activity</span>
									{#if previewByWatch[w.id]}
										<Button
											variant="ghost"
											size="icon"
											class="text-muted hover:text-foreground ml-auto h-7 w-7 p-0"
											onclick={() => dismissPreview(w.id)}
											aria-label="Dismiss preview"
											title="Dismiss"
										>
											<X class="h-3.5 w-3.5" />
										</Button>
									{/if}
								</div>
								<div
									class="flex flex-col gap-1.5 font-mono text-[11px]"
								>
									{#each previewProgressByWatch[w.id] as progress (progress.source)}
										<div class="flex items-start gap-1.5">
											{#if progress.state === "checking"}
												<LoaderCircle
													class="text-accent mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin"
												/>
											{:else if progress.state === "complete"}
												<CircleCheck
													class="text-ok mt-0.5 h-3.5 w-3.5 shrink-0"
												/>
											{:else}
												<TriangleAlert
													class="text-err mt-0.5 h-3.5 w-3.5 shrink-0"
												/>
											{/if}
											<span class="text-muted shrink-0"
												>{progress.label}</span
											>
											<span
												class={progress.state ===
												"failed"
													? "text-err"
													: "text-text"}
												>{progress.detail}</span
											>
										</div>
									{/each}
								</div>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</Card>

	<Card title="Notifications & alerts">
		{#snippet headerExtra()}
			<Button size="sm" variant="secondary" onclick={openSettingsDialog}
				>{canManageSchedulerSettings ? "Edit" : "View"}</Button
			>
		{/snippet}
		<dl class="flex flex-col gap-2 text-sm">
			<div class="flex items-center justify-between gap-3">
				<dt class="text-muted">Webhook</dt>
				<dd>
					{#if savedForm.notifyWebhookUrl}
						<Badge variant="success">Configured</Badge>
					{:else}
						<Badge variant="secondary">Not set</Badge>
					{/if}
				</dd>
			</div>
			<div class="flex items-center justify-between gap-3">
				<dt class="text-muted">Alerts enabled</dt>
				<dd>{fmtNumber(enabledAlertCount, 0)} / {fmtNumber(NOTIFY_EVENTS.length, 0)}</dd>
			</div>
			<div class="flex items-center justify-between gap-3">
				<dt class="text-muted">Retry on failure</dt>
				<dd>
					{RETRY_OPTIONS.find(
						(o) =>
							o.value === String(savedForm.schedulerRetryCount),
					)?.label}
				</dd>
			</div>
			<div class="flex items-center justify-between gap-3">
				<dt class="text-muted">Job history retention</dt>
				<dd class="text-right">
					{RETENTION_OPTIONS.find(
						(o) =>
							o.value ===
							String(savedForm.jobHistoryRetentionDays),
					)?.label}
				</dd>
			</div>
		</dl>
	</Card>

	{#if deliveries !== null}
		<Card title="Recent webhook deliveries">
			{#if deliveries.length === 0}
				<EmptyState message="No webhook deliveries yet." />
			{:else}
				<div class="flex flex-col gap-1.5">
					{#each deliveries as d (d.id)}
						<div
							class="border-border flex items-center gap-2.5 rounded-md border px-2.5 py-2 text-xs"
						>
							<span class="w-14 shrink-0 text-muted"
								><RelativeTime ms={d.ts} /></span
							>
							<Badge
								variant={d.ok ? "success" : "destructive"}
								class="shrink-0">{d.ok ? "ok" : "failed"}</Badge
							>
							<span class="shrink-0 font-mono">{d.event}</span>
							<span
								class="min-w-0 flex-1 truncate text-muted"
								title={d.targetHost}>{d.targetHost}</span
							>
							{#if d.error}
								<span
									class="max-w-40 truncate text-err"
									title={d.error}>{d.error}</span
								>
							{:else if d.status}
								<span class="text-muted">{d.status}</span>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</Card>
	{/if}
</div>

<Dialog open={bridgeDiagnosticsOpen} onOpenChange={(value) => (bridgeDiagnosticsOpen = value)} class="max-w-lg">
	<div class="mb-1 text-sm font-medium">autoinstall protocol explorer</div>
	<div class="mb-3 text-xs text-muted">Live bridge version, exposed capabilities, and the most recent protocol activity.</div>
	{#if loadingBridgeDiagnostics}
		<div class="text-sm text-muted">Checking the autoinstall bridge…</div>
	{:else if bridgeDiagnostics}
		<div class="grid grid-cols-2 gap-2 text-xs">
			<div class="border-border rounded-md border p-2">Version <span class="text-muted">{bridgeDiagnostics.bridge.bridgeVersion ?? "unknown"}</span></div>
			<div class="border-border rounded-md border p-2">Catalog <span class={bridgeDiagnostics.bridge.hasCatalogManager ? "text-ok" : "text-err"}>{bridgeDiagnostics.bridge.hasCatalogManager ? "ready" : "missing"}</span></div>
			<div class="border-border rounded-md border p-2">Installer <span class={bridgeDiagnostics.bridge.hasInstaller ? "text-ok" : "text-err"}>{bridgeDiagnostics.bridge.hasInstaller ? "ready" : "missing"}</span></div>
			<div class="border-border rounded-md border p-2">Install <span class="text-muted">{String(bridgeDiagnostics.install?.state ?? "idle")}</span></div>
		</div>
		<div class="mt-3 flex flex-wrap gap-1.5">
			{#each bridgeDiagnostics.bridge.capabilities ?? [] as capability (capability)}
				<Badge variant="secondary">{capability}</Badge>
			{:else}
				<span class="text-xs text-muted">No capabilities reported.</span>
			{/each}
		</div>
		{#if bridgeDiagnostics.recentLog?.length}
			<pre class="bg-panel-muted mt-3 max-h-64 overflow-auto rounded-md p-2 text-[10px] whitespace-pre-wrap">{bridgeDiagnostics.recentLog.join("\n")}</pre>
		{/if}
	{:else}
		<div class="text-sm text-muted">No diagnostics available.</div>
	{/if}
</Dialog>

{#if canManageWatches}
	<Dialog
		open={watchDialogOpen}
		onOpenChange={(v) => void setWatchDialogOpen(v)}
		class="max-w-md"
	>
		<div class="mb-3 text-sm font-medium">
			{editingWatchId ? "Edit watch" : "Add watch"}
		</div>
		{#if !editingWatchId}
			<div class="mb-3 flex gap-1" aria-label="Watch setup progress">
				{#each ['App', 'Destination', 'Schedule', 'Review'] as label, index}
					<span class={`flex-1 rounded px-1 py-1 text-center text-[11px] ${wizardStep === index ? 'bg-primary text-primary-foreground' : 'bg-muted/40 text-foreground'}`}>{label}</span>
				{/each}
			</div>
		{/if}
		<div class="max-h-[60vh] overflow-y-auto pr-0.5">
			{#if watchValidationError}
				<div class="mb-3 rounded-md border border-err/40 bg-err/10 p-2 text-xs text-err" role="alert">
					{watchValidationError.message}
					<button type="button" class="ml-1 underline" onclick={() => document.getElementById(watchValidationError?.fieldId ?? '')?.focus()}>Go to field</button>
				</div>
			{/if}
			{#if conflictingWatch}
				<section class="mb-3 rounded-lg border border-warn/50 bg-warn/5 p-3 text-xs" aria-label="Watch edit conflict">
					<p class="font-medium">This watch changed while you were editing. Review the saved version before applying your edits.</p>
					<div class="mt-2 grid grid-cols-3 gap-2"><span>Field</span><span>Your edit</span><span>Saved version</span>
						<span>Schedule</span><span>{watchForm.pollCron}</span><span>{conflictingWatch.pollCron}</span>
						<span>Repository</span><span>{watchForm.repo}</span><span>{conflictingWatch.repo}</span>
						<span>Time zone</span><span>{watchForm.timezone}</span><span>{conflictingWatch.timezone}</span>
						<span>TestFlight policy</span><span>{watchForm.testFlightPolicy}</span><span>{conflictingWatch.testFlightPolicy}</span>
					</div>
					<div class="mt-3 flex flex-wrap gap-2">
						<Button size="sm" variant="secondary" onclick={() => void reloadConflictingWatch()}>Reload saved version</Button>
						<Button size="sm" variant="secondary" onclick={() => (conflictingWatch = null)}>Keep editing</Button>
						<Button size="sm" onclick={() => void applyWatchEditsToLatest()}>Apply my edits to latest</Button>
					</div>
				</section>
			{/if}
			{#if editingWatchId || wizardStep === 0}
			<label for="w-search" class="mb-1 block text-xs text-muted"
				>App search</label
			>
			<div class="relative">
				<Input
					id="w-search"
					placeholder="Search App Store app name or bundle ID"
					bind:value={watchSearchTerm}
					oninput={onWatchSearchInput}
					class="pr-8"
				/>
				<div
					class="text-muted pointer-events-none absolute top-1/2 right-2 -translate-y-1/2"
				>
					{#if watchSearchLoading}
						<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
					{:else}
						<Search class="h-3.5 w-3.5" />
					{/if}
				</div>
			</div>
			{#if watchSearchResults.length > 0}
				<div
					class="border-border mt-1.5 max-h-52 overflow-y-auto rounded-md border"
				>
					{#each watchSearchResults as result (result.bundleId)}
						<Button
							variant="ghost"
							class="border-border hover:bg-panel-muted/80 hover:ring-accent/60 h-auto w-full justify-start rounded-lg border-b px-2.5 py-2 text-left font-normal last:border-0 hover:ring-1"
							onclick={() => pickWatchApp(result)}
						>
							{#if result.artworkUrl}
								<img
									src={result.artworkUrl}
									alt=""
									class="h-5 w-5 shrink-0 rounded"
								/>
							{/if}
							<div class="min-w-0 flex-1">
								<div class="truncate text-[13px] font-medium">
									{result.trackName}
								</div>
								<div class="truncate text-[11px] text-muted" title={result.bundleId}>
									v{result.version} · {result.sellerName}{result.category ? ` · ${result.category}` : ""}
								</div>
							</div>
						</Button>
					{/each}
				</div>
			{:else if watchSearchSearched && watchSearchTerm.trim()}
				<div class="mt-1 text-xs text-muted">No apps found.</div>
			{/if}

			<div class="mt-3 text-xs text-muted">Selected app</div>
			<div class="mt-1 truncate text-sm" title={watchForm.bundleId}>
				{watchForm.bundleId
					? appDisplayName(watchForm.bundleId)
					: "Choose an app from search"}
			</div>

			<label for="w-project" class="mt-3 mb-1 block text-xs text-muted">Project</label>
			<Select
				id="w-project"
				items={projectItems}
				value={watchForm.projectId ?? "default"}
				onValueChange={(projectId) => { if (projectId !== watchForm.projectId) syncedDraftId = undefined; watchForm = { ...watchForm, projectId }; }}
				class="w-full"
			/>

			<label for="w-testFlightPolicy" class="mt-3 mb-1 block text-xs text-muted"
				>TestFlight build policy</label
			>
			<Select
				id="w-testFlightPolicy"
				items={TESTFLIGHT_POLICY_OPTIONS}
				value={watchForm.testFlightPolicy ?? "latest"}
				onValueChange={(value) =>
					(watchForm = {
						...watchForm,
						testFlightPolicy: value as WatchInput["testFlightPolicy"],
					})}
				class="w-full"
			/>
			{#if watchForm.testFlightPolicy === "train"}
				<label for="w-testFlightTrain" class="mt-2 mb-1 block text-xs text-muted"
					>Train version</label
				>
				<Input id="w-testFlightTrain" placeholder="341.0" bind:value={watchForm.testFlightTrain} />
			{/if}
			{/if}

			{#if editingWatchId || wizardStep === 1}
			<div class="mt-3 flex items-center justify-between gap-3">
				<div class="text-xs text-muted">Dispatch destinations</div>
				<Button size="sm" variant="secondary" onclick={addDispatchTarget}>Add destination</Button>
			</div>
			<div class="mt-1.5 flex flex-col gap-2">
				{#each dispatchTargets as target, index (`${index}-${target.repo}-${target.ghWorkflowFile}`)}
					<div class="border-border rounded-lg border p-2.5">
						<div class="mb-1.5 flex items-center justify-between gap-2 text-xs text-muted">
							<span>Destination {index + 1}</span>
							{#if dispatchTargets.length > 1}
								<Button variant="link" size="sm" class="h-auto p-0 text-xs text-muted hover:text-destructive" onclick={() => removeDispatchTarget(index)}>Remove</Button>
							{/if}
						</div>
						<label for={`w-repo-${index}`} class="mb-1 block text-[11px] text-muted">Repository</label>
						<SearchSelect
							id={`w-repo-${index}`}
							items={repoItemsFor(target.repo)}
							value={target.repo}
							placeholder="Search repositories…"
							onValueChange={(repo) => onWatchRepoChange(index, repo)}
							class="w-full"
						/>
						<label for={`w-workflow-${index}`} class="mt-2 mb-1 block text-[11px] text-muted">Workflow</label>
						<SearchSelect
							id={`w-workflow-${index}`}
							items={workflowItemsFor(target.repo, target.ghWorkflowFile)}
							value={target.ghWorkflowFile}
							placeholder="Search workflows…"
							onValueChange={(workflow) => onWatchWorkflowChange(index, workflow)}
							class="w-full"
						/>
						<label for={`w-mode-${index}`} class="mt-2 mb-1 block text-[11px] text-muted">Trigger</label>
						<Select
							id={`w-mode-${index}`}
							items={DISPATCH_MODE_OPTIONS}
							value={target.mode ?? "repository_dispatch"}
							onValueChange={(mode) => setDispatchTarget(index, { mode: mode as DispatchTarget["mode"] })}
							class="w-full"
						/>
						{#if target.mode === "workflow_dispatch"}
							<label for={`w-ref-${index}`} class="mt-2 mb-1 block text-[11px] text-muted">Branch or tag</label>
							<Input id={`w-ref-${index}`} placeholder="Default branch" value={target.ref ?? ""} onchange={(event) => setDispatchTarget(index, { ref: event.currentTarget.value })} />
						{/if}
						{#if githubWorkflowErrors[target.repo]}
							<div class="mt-1 text-xs text-err">{githubWorkflowErrors[target.repo]}</div>
						{/if}
						<div class="mt-2.5 flex items-center justify-between gap-2">
							<span class="text-[11px] text-muted">Workflow payload inputs</span>
							<Button size="sm" variant="secondary" onclick={() => addDispatchInput(index)}>Add input</Button>
						</div>
						{#each Object.entries(target.inputs ?? {}) as [key, value] (key)}
							<div class="mt-1.5 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-1.5">
								<Input value={key} aria-label="Input name" onchange={(event) => setDispatchInput(index, key, event.currentTarget.value, value)} />
								<Input value={value} aria-label="Input value" onchange={(event) => setDispatchInput(index, key, key, event.currentTarget.value)} />
							</div>
						{/each}
					</div>
				{/each}
			</div>
			{#if githubReposError}
				<div class="mt-1 text-xs text-err">{githubReposError}</div>
			{/if}
			{#if watchRepoErrors.repo}
				<div class="mt-1 text-xs text-err">{watchRepoErrors.repo}</div>
			{/if}
			{/if}

			{#if editingWatchId || wizardStep === 2}
			<label for="w-timezone" class="mt-3 mb-1 block text-xs text-muted"
				>Schedule time zone</label
			>
			<SearchSelect
				id="w-timezone"
				items={TIME_ZONE_OPTIONS}
				value={watchForm.timezone ?? LOCAL_TIME_ZONE}
				placeholder="Search time zones…"
				label="Schedule time zone"
				onValueChange={(timezone) => (watchForm = { ...watchForm, timezone })}
				class="w-full"
			/>
			<div class="mt-1 text-[11px] text-muted">Scheduled checks use this local time and adjust for daylight saving.</div>
			<div class="mt-3 grid grid-cols-2 gap-3">
				<div>
					<label for="w-maintenance-start" class="mb-1 block text-xs text-muted">Quiet hours start</label>
					<Input id="w-maintenance-start" type="time" bind:value={maintenanceWindowStart} />
				</div>
				<div>
					<label for="w-maintenance-end" class="mb-1 block text-xs text-muted">Quiet hours end</label>
					<Input id="w-maintenance-end" type="time" bind:value={maintenanceWindowEnd} />
				</div>
			</div>
			<div class="mt-1 text-[11px] text-muted">Scheduled checks in this daily local-time window are coalesced and run once when it ends. Manual triggers run immediately.</div>
			<label for="w-missed-run-policy" class="mt-3 mb-1 block text-xs text-muted">Missed checks</label>
			<Select
				id="w-missed-run-policy"
				items={MISSED_RUN_POLICY_OPTIONS}
				value={watchForm.missedRunPolicy ?? "skip"}
				onValueChange={(missedRunPolicy) => (watchForm = { ...watchForm, missedRunPolicy: missedRunPolicy as "skip" | "runOnce" })}
				class="w-full"
			/>
			<div class="mt-1 text-[11px] text-muted">Skipped schedules are normally left alone; choose one coalesced check on restart to catch up after downtime.</div>
			<label for="w-pollCron" class="mt-3 mb-1 block text-xs text-muted"
				>Poll cron</label
			>
			<Input id="w-pollCron" bind:value={watchForm.pollCron} />
			{#if watchCronValid === false}
				<div class="mt-1 text-xs text-err">
					Not a valid cron expression
				</div>
			{/if}
			<div class="mt-1.5 mb-1 text-xs text-muted">Schedule templates</div>
			<div class="flex flex-wrap gap-1.5">
				{#each SCHEDULE_TEMPLATES as p (p.label)}
					<Button
						variant="outline"
						size="sm"
						class="border-border rounded-full px-2.5 py-1 text-[12px] text-muted hover:border-primary hover:text-foreground"
						title={p.maintenanceWindow ? "Sets hourly checks and quiet hours from 22:00 to 06:00" : `Sets ${p.expr}`}
						onclick={() => applyScheduleTemplate(p)}
					>
						{p.label}
					</Button>
				{/each}
			</div>
			{/if}

			{#if editingWatchId || wizardStep === 3}
			{#if !editingWatchId}
				<div class="rounded-lg border border-border p-3 text-xs">
					<div class="font-medium">Review this watch</div>
					<div class="mt-2">{watchForm.bundleId} · {projectName(watchForm.projectId)}</div>
					<div class="mt-1">{dispatchTargets.map((target) => `${target.repo}/${target.ghWorkflowFile}`).join(', ')}</div>
					<div class="mt-1">{watchForm.pollCron} · {watchForm.timezone}</div>
					<label class="mt-3 flex items-center gap-2"><input type="checkbox" bind:checked={watchForm.enabled} /> Enable scheduled checks after saving</label>
				</div>
			{/if}
			{#if watchConflicts.length > 0}
				<div class="mt-3 rounded-lg border border-warn/40 bg-warn/5 p-3 text-xs" role="alert">
					<div class="font-medium">Possible duplicate dispatches</div>
					{#each watchConflicts as conflict (conflict.watchId)}
						<div class="mt-1">{conflict.bundleId} uses {conflict.target} at {new Date(conflict.nextOverlapAt).toLocaleString()}</div>
					{/each}
					<label class="mt-2 flex items-center gap-2"><input id="watch-conflict-acknowledgement" type="checkbox" bind:checked={acknowledgeWatchConflicts} /> I understand and want to save this watch</label>
				</div>
			{/if}
			<label for="w-webhookUrl" class="mt-3 mb-1 block text-xs text-muted"
				>Webhook override (optional)</label
			>
			<Input
				id="w-webhookUrl"
				placeholder="blank = use the default webhook"
				bind:value={watchForm.webhookUrl}
			/>
			{#if watchRepoErrors.webhookUrl}
				<div class="mt-1 text-xs text-err">
					{watchRepoErrors.webhookUrl}
				</div>
			{/if}
			<div class="mt-1 text-[11px] text-muted">
				Send this watch's dispatch notifications to a different
				Discord/Slack channel.
			</div>

			<Button
				variant="secondary"
				class="mt-3.5 w-full"
				loading={previewingDraft}
				disabled={!watchForm.bundleId.trim() ||
					!watchForm.repo.trim() ||
					!!watchRepoErrors.repo}
				onclick={previewDraft}
			>
				Preview what this would do
			</Button>
			{#if !draftPreview || previewedWatchTarget !== `${watchForm.bundleId.trim()}:${watchForm.repo.trim()}`}<p class="mt-1 text-xs text-muted">Review the dispatch preview before saving this watch.</p>{/if}
			<Button
				variant="secondary"
				class="mt-2 w-full"
				loading={validatingDraft}
				disabled={dispatchTargets.some((target) => !REPO_RE.test(target.repo) || !target.ghWorkflowFile.trim())}
				onclick={validateDraftDispatch}
			>
				Validate GitHub destinations
			</Button>
			{#if dispatchValidation}
				<div class="border-border bg-panel-muted mt-2 rounded-md border p-2.5 text-xs">
					{#each dispatchValidation as result (`${result.repo}-${result.workflow}`)}
						<div class={result.ok ? "text-ok" : "text-err"}>{result.repo} · {result.workflow}</div>
						{#each result.checks as check (check.label)}
							<div class="mt-1 text-muted"><span class={check.ok ? "text-ok" : "text-err"}>{check.ok ? "✓" : "×"}</span> {check.label}: {check.detail}</div>
						{/each}
					{/each}
				</div>
			{/if}
			{#if draftPreview}
				<div
					class="border-border bg-panel-muted mt-2 rounded-md border p-2.5 text-xs"
				>
					<div
						class={draftPreview.wouldDispatch
							? "text-ok"
							: "text-muted"}
					>
						{draftPreview.reason}
					</div>
					{#if draftPreview.testflight}
						<div class="border-border mt-1.5 border-t pt-1.5">
							<div
								class={draftPreview.testflight.wouldDispatch
									? "text-ok"
									: "text-muted"}
							>
								{draftPreview.testflight.reason}
							</div>
						</div>
					{/if}
				</div>
			{:else if draftPreviewError}
				<div class="mt-2 text-xs text-err">{draftPreviewError}</div>
			{/if}
			{/if}
		</div>
		{#if !editingWatchId && wizardStep < 3}
			<div class="mt-3.5 flex gap-2">
				{#if wizardStep > 0}<Button variant="secondary" onclick={() => (wizardStep -= 1)}>Back</Button>{/if}
				<Button class="flex-1" disabled={wizardStep === 0 ? !watchForm.bundleId.trim() : wizardStep === 1 ? dispatchTargets.some((target) => !REPO_RE.test(target.repo) || !target.ghWorkflowFile.trim()) : watchCronValid === false} onclick={() => { wizardStep += 1; if (wizardStep === 3) void loadWatchConflicts(); }}>Continue</Button>
			</div>
		{:else}
			<div class="mt-3.5 flex gap-2">
				{#if !editingWatchId}<Button variant="secondary" onclick={() => (wizardStep = 2)}>Back</Button>{/if}
				<Button class="flex-1" loading={savingWatch} onclick={saveWatch}>{editingWatchId ? "Save" : "Create watch"}</Button>
			</div>
		{/if}
	</Dialog>
{/if}

<Dialog open={revisionsOpen} onOpenChange={(open) => (revisionsOpen = open)} class="max-w-lg">
	<h2 class="text-sm font-semibold">Watch revisions</h2>
	<p class="mt-1 text-xs text-muted">Restoring a configuration preserves the current enabled state.</p>
	<div class="mt-3 max-h-[60vh] space-y-2 overflow-y-auto">
		{#each revisions as revision (revision.id)}
			<div class="rounded-lg border border-border p-3 text-xs">
				<div class="flex items-center justify-between gap-2"><span class="font-medium">{revision.action} · {new Date(revision.at).toLocaleString()}</span><Button size="sm" variant="secondary" onclick={() => void restoreRevision(revision)}>Restore</Button></div>
				<div class="mt-1 text-muted">By {revision.actorDisplayName ?? revision.actor}</div>
				{#if revision.changes?.length}
					<dl class="mt-2 space-y-1">
						{#each revision.changes as change (change.field)}
							<div class="break-words"><dt class="font-medium">{change.field}</dt><dd class="text-muted">{readableRevisionValue(change.before)} → {readableRevisionValue(change.after)}</dd></div>
						{/each}
					</dl>
				{:else}<div class="mt-1">{revision.changedFields.join(', ') || 'No configuration fields changed'}</div>{/if}
			</div>
		{/each}
	</div>
</Dialog>

<Dialog
	open={settingsDialogOpen}
	onOpenChange={(v) => (settingsDialogOpen = v)}
	class="max-w-md"
>
	<div class="mb-3 text-sm font-medium">Notifications & alerts</div>
	<div class="max-h-[70vh] overflow-y-auto pr-0.5">
		{#if !canManageSchedulerSettings}
			<div
				class="border-border bg-panel-muted mb-3.5 rounded-md border p-2.5 text-xs text-muted"
			>
				You can operate the scheduler but not change its configuration -
				fields below are read-only.
			</div>
		{/if}

		<label for="s-notifyWebhookUrl" class="mb-1 block text-xs text-muted"
			>Webhook URL (Discord/Slack-compatible, optional)</label
		>
		<div class="flex gap-2">
			<Input
				id="s-notifyWebhookUrl"
				bind:value={form.notifyWebhookUrl}
				disabled={!canManageSchedulerSettings}
			/>
			{#if canTriggerDispatch}
				<Button
					variant="secondary"
					loading={testingWebhook}
					onclick={runTestWebhook}>Test</Button
				>
			{/if}
		</div>
		<div class="mt-1 text-xs text-muted">
			One webhook for everything below - test sends to whatever's
			currently typed above, saved or not.
		</div>
		{#if repoErrors.notifyWebhookUrl}
			<div class="mt-1 text-xs text-err">
				{repoErrors.notifyWebhookUrl}
			</div>
		{/if}

		<label for="s-notifyFormat" class="mt-3 mb-1 block text-xs text-muted"
			>Webhook format</label
		>
		<Select
			id="s-notifyFormat"
			items={FORMAT_OPTIONS}
			value={form.notifyFormat}
			onValueChange={(v) =>
				(form = {
					...form,
					notifyFormat: v as SchedulerSettings["notifyFormat"],
				})}
			disabled={!canManageSchedulerSettings}
			class="w-full"
		/>

		<label for="s-successDelivery" class="mt-3 mb-1 block text-xs text-muted"
			>Successful automation delivery</label
		>
		<Select
			id="s-successDelivery"
			items={SUCCESS_DELIVERY_OPTIONS}
			value={form.notifySuccessMode}
			onValueChange={(value) =>
				(form = {
					...form,
					notifySuccessMode: value as SchedulerSettings["notifySuccessMode"],
				})}
			disabled={!canManageSchedulerSettings}
			class="w-full"
		/>
		<div class="mt-1 text-xs text-muted">
			Failures remain immediate. Digests include successful decrypts and completed automation runs.
		</div>

		<div class="mt-3 grid grid-cols-2 gap-2">
			<div>
				<label for="s-quietStart" class="mb-1 block text-xs text-muted">Quiet hours start</label>
				<Input id="s-quietStart" type="time" bind:value={form.notifyQuietHoursStart} disabled={!canManageSchedulerSettings} />
			</div>
			<div>
				<label for="s-quietEnd" class="mb-1 block text-xs text-muted">Quiet hours end</label>
				<Input id="s-quietEnd" type="time" bind:value={form.notifyQuietHoursEnd} disabled={!canManageSchedulerSettings} />
			</div>
		</div>

		<div class="mt-3 flex items-center justify-between gap-2">
			<div class="text-xs text-muted">Notification events</div>
			<div class="flex gap-1">
				<Button variant="outline" size="sm" class="h-7 rounded-full px-2 py-1 text-[11px] text-muted" onclick={() => applyNotificationPreset("essential")}>Essential</Button>
				<Button variant="outline" size="sm" class="h-7 rounded-full px-2 py-1 text-[11px] text-muted" onclick={() => applyNotificationPreset("all")}>All</Button>
				<Button variant="outline" size="sm" class="h-7 rounded-full px-2 py-1 text-[11px] text-muted" onclick={() => applyNotificationPreset("quiet")}>Quiet</Button>
			</div>
		</div>
		<div class="mt-1.5 flex flex-col gap-2">
			{#each notificationGroups as group (group)}
				<div class="border-border divide-border overflow-hidden rounded-lg border divide-y">
					<div class="bg-panel-muted/50 px-3 py-1.5 text-[11px] font-medium text-muted">{group}</div>
					{#each NOTIFY_EVENTS.filter((event) => event.group === group) as event (event.key)}
						<div class="flex items-center gap-3 px-3 py-2">
					<div class="min-w-0 flex-1">
						<div class="text-[13px] text-text">{event.label}</div>
						<div class="text-[11px] text-muted">
							{event.description}
						</div>
					</div>
					<Popover>
						{#snippet trigger()}
							<span
								class="text-muted hover:text-text cursor-pointer text-[11px] underline-offset-2 hover:underline"
								>payload</span
							>
						{/snippet}
						<div class="max-w-xs">
							<div class="mb-1.5 text-[11px] text-muted">
								Example payload for this event ({form.notifyFormat})
							</div>
							<pre
								class="bg-panel-muted max-h-64 max-w-72 overflow-auto rounded-md p-2 text-[10.5px] leading-snug whitespace-pre-wrap">{exampleWebhookPayload(
									event.key,
									form.notifyFormat,
								)}</pre>
							<div class="mt-1.5">
								<CopyButton
									text={exampleWebhookPayload(
										event.key,
										form.notifyFormat,
									)}
									label="Copy"
								/>
							</div>
						</div>
					</Popover>
					<Switch
						checked={form[event.key] as boolean}
						disabled={!canManageSchedulerSettings}
						onCheckedChange={(checked) =>
							(form = { ...form, [event.key]: checked })}
						aria-label={event.label}
					/>
						</div>
					{/each}
				</div>
			{/each}
		</div>

		<label for="s-retryCount" class="mt-3 mb-1 block text-xs text-muted"
			>Retry a failed check before recording/notifying failure</label
		>
		<Select
			id="s-retryCount"
			items={RETRY_OPTIONS}
			value={String(form.schedulerRetryCount)}
			onValueChange={(v) =>
				(form = { ...form, schedulerRetryCount: Number(v) })}
			disabled={!canManageSchedulerSettings}
			class="w-full"
		/>
		<div class="mt-1 text-xs text-muted">
			Retries back off: 30s, 60s, 120s… Applies to every watch.
		</div>

		<label for="s-retention" class="mt-3 mb-1 block text-xs text-muted"
			>Job history retention</label
		>
		<Select
			id="s-retention"
			items={RETENTION_OPTIONS}
			value={String(form.jobHistoryRetentionDays)}
			onValueChange={(v) => {
				const retentionDays = Number(v);
				form = { ...form, jobHistoryRetentionDays: retentionDays };
				void loadRetentionPreview(retentionDays);
			}}
			disabled={!canManageSchedulerSettings}
			class="w-full"
		/>
		<div class="mt-2 rounded-md border border-border bg-muted/20 p-3 text-xs" aria-live="polite">
			<div class="font-medium text-foreground">Retention preview</div>
			{#if retentionPreviewLoading}
				<div class="mt-1 text-muted">Calculating the impact…</div>
			{:else if retentionPreviewError}
				<div class="mt-1 text-err">Preview unavailable: {retentionPreviewError}</div>
			{:else if retentionPreview}
				<div class="mt-1 text-muted">
					{#if retentionPreview.removed > 0}
						{retentionPreview.removed} current entries would be removed on the next recorded job ({retentionPreview.agePruned} by age, {retentionPreview.capacityPruned} by the {retentionPreview.maxEntries}-entry cap).
					{:else}
						No current entries would be pruned on the next recorded job.
					{/if}
				</div>
				<div class="mt-1 text-muted">
					{retentionPreview.retained} existing entries plus the next job would leave {retentionPreview.afterNextWrite} of {retentionPreview.maxEntries} history rows.
				</div>
				<div class="mt-1 text-muted">
					IPA files remain available: {retentionPreview.artifacts.retained} files · {fmtSize(retentionPreview.artifacts.retainedBytes)} of {fmtSize(retentionPreview.artifacts.maxBytes)} used. Job-history retention does not delete library files.
				</div>
			{:else}
				<div class="mt-1 text-muted">Choose a retention window to preview its impact.</div>
			{/if}
		</div>

		<label for="s-offlineMinutes" class="mt-3 mb-1 block text-xs text-muted"
			>iDevice offline alert threshold</label
		>
		<Select
			id="s-offlineMinutes"
			items={OFFLINE_ALERT_OPTIONS}
			value={String(form.deviceOfflineAlertMinutes)}
			onValueChange={(v) =>
				(form = { ...form, deviceOfflineAlertMinutes: Number(v) })}
			disabled={!canManageSchedulerSettings}
			class="w-full"
		/>

		<label for="s-batteryHot" class="mt-3 mb-1 block text-xs text-muted"
			>Battery hot alert threshold</label
		>
		<Select
			id="s-batteryHot"
			items={BATTERY_HOT_ALERT_OPTIONS}
			value={String(form.batteryHotAlertC)}
			onValueChange={(v) =>
				(form = { ...form, batteryHotAlertC: Number(v) })}
			disabled={!canManageSchedulerSettings}
			class="w-full"
		/>

		<label for="s-batteryLow" class="mt-3 mb-1 block text-xs text-muted"
			>Battery low alert threshold (while not charging)</label
		>
		<Select
			id="s-batteryLow"
			items={BATTERY_LOW_ALERT_OPTIONS}
			value={String(form.batteryLowAlertPercent)}
			onValueChange={(v) =>
				(form = { ...form, batteryLowAlertPercent: Number(v) })}
			disabled={!canManageSchedulerSettings}
			class="w-full"
		/>

		<label for="s-diskFull" class="mt-3 mb-1 block text-xs text-muted"
			>Staging disk full alert threshold</label
		>
		<Select
			id="s-diskFull"
			items={STORAGE_ALERT_OPTIONS}
			value={String(form.diskFullAlertPercent)}
			onValueChange={(v) =>
				(form = { ...form, diskFullAlertPercent: Number(v) })}
			disabled={!canManageSchedulerSettings}
			class="w-full"
		/>

		<label for="s-deviceStorage" class="mt-3 mb-1 block text-xs text-muted"
			>iDevice storage alert threshold</label
		>
		<Select
			id="s-deviceStorage"
			items={STORAGE_ALERT_OPTIONS}
			value={String(form.deviceStorageAlertPercent)}
			onValueChange={(v) =>
				(form = { ...form, deviceStorageAlertPercent: Number(v) })}
			disabled={!canManageSchedulerSettings}
			class="w-full"
		/>

		<label for="s-bridgeDown" class="mt-3 mb-1 block text-xs text-muted"
			>autoinstall bridge unresponsive alert threshold</label
		>
		<Select
			id="s-bridgeDown"
			items={TESTFLIGHT_BRIDGE_ALERT_OPTIONS}
			value={String(form.testFlightBridgeAlertMinutes)}
			onValueChange={(v) =>
				(form = { ...form, testFlightBridgeAlertMinutes: Number(v) })}
			disabled={!canManageSchedulerSettings}
			class="w-full"
		/>
	</div>

	{#if canManageSchedulerSettings}
		<Button class="mt-3.5 w-full" loading={saving} onclick={save}
			>Save</Button
		>
	{/if}
</Dialog>
