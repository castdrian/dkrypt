<script lang="ts">
	import {
		BatteryCharging,
		BatteryMedium,
		Globe,
		RefreshCw,
		Thermometer,
		Wifi,
		WifiOff,
		Zap,
	} from "lucide-svelte";
	import RelativeTime from "#components/RelativeTime.svelte";
	import CopyButton from "#components/CopyButton.svelte";
	import Sparkline from "#components/Sparkline.svelte";
	import {
		fetchDeviceBatteryHistory,
		fetchDeviceHealth,
		fetchDeviceHealthHistory,
		fetchDeviceTemperatureHistory,
		observeJobVolume,
		refreshJobVolume as refreshDashboardJobVolume,
		type DeviceHealth,
		type HourlyBatteryBucket,
		type HourlyHealthBucket,
		type HourlyTemperatureBucket,
	} from "#lib/api";
	import Badge from "#lib/components/ui/Badge.svelte";
	import type { BadgeVariant } from "#lib/components/ui/variants";
	import Button from "#lib/components/ui/Button.svelte";
	import Card from "#lib/components/ui/Card.svelte";
	import Popover from "#lib/components/ui/Popover.svelte";
	import {
		appDisplayName,
		appIconUrl,
		ensureAppCatalog,
	} from "#lib/appCatalog.svelte";
	import { fmtBytesGB, fmtCalendarDate, fmtDateTime, fmtNumber, trendDelta } from "#lib/format.svelte";
	import { liveState } from "#lib/live.svelte";
	import { PermissionFlag } from "#lib/permissions";
import { sessionHasAnyPermission } from "#lib/session.svelte";

	const overview = $derived(liveState.overview);
	let now = $state(Date.now());
	const canViewDevices = $derived(sessionHasAnyPermission([PermissionFlag.viewDevices, PermissionFlag.manageDevices]));
	const canViewOperations = $derived(sessionHasAnyPermission([PermissionFlag.viewDevices, PermissionFlag.manageDevices, PermissionFlag.viewAutomation, PermissionFlag.manageAutomation, PermissionFlag.viewScheduler]));
	const canViewStatusDetails = $derived(canViewOperations);
	const canManageDevices = $derived(sessionHasAnyPermission([PermissionFlag.manageDevices]));
	const statusDevices = $derived(overview?.statusDevices ?? overview?.devices.map((device) => ({
		id: device.id,
		name: device.name,
		enabled: device.enabled,
		draining: device.draining,
		isPrimary: device.isPrimary,
		reachable: undefined as boolean | undefined,
	})) ?? []);
	const primaryStatusDeviceId = $derived(statusDevices.find((device) => device.enabled && !device.draining && device.isPrimary)?.id ?? statusDevices.find((device) => device.enabled && !device.draining)?.id);
	const primaryDeviceId = $derived(canViewDevices ? primaryStatusDeviceId : undefined);

	const diskColor = $derived.by(() => {
		const pct = overview?.disk?.usedPercent ?? 0;
		if (pct >= 0.9) return "bg-err";
		if (pct >= 0.75) return "bg-warn";
		return "bg-accent";
	});

	$effect(() => {
		void ensureAppCatalog((overview?.activeJobs ?? []).map((job) => job.bundleId));
	});

	function thermalBadgeVariant(
		tempC: number,
	): "destructive" | "warning" | "secondary" {
		if (tempC >= 42) return "destructive";
		if (tempC >= 37) return "warning";
		return "secondary";
	}

	function fmtDayLabel(date: string): string {
		return fmtCalendarDate(date, { month: "short", day: "numeric" });
	}

	function sourceStateLabel(state: NonNullable<DeviceHealth['subsystems']>['appStore']): string {
		if (state === 'ready') return 'Available';
		if (state === 'idle') return 'Idle';
		if (state === 'degraded') return 'Needs attention';
		if (state === 'offline') return 'Unavailable';
		if (state === 'unsupported') return 'Not supported';
		return 'Not checked';
	}

	function sourceStateExplanation(source: 'appStore' | 'testFlight', state: NonNullable<DeviceHealth['subsystems']>['appStore']): string {
		if (state === 'idle') return source === 'appStore'
			? 'No App Store install is running. Idle does not mean the App Store is disconnected.'
			: 'No TestFlight operation is running. Idle does not mean TestFlight access is unavailable.';
		if (state === 'ready') return 'The latest device check verified this source.';
		if (state === 'degraded') return 'The latest device check found a partial issue.';
		if (state === 'offline') return 'The latest device check could not reach this source.';
		if (state === 'unsupported') return 'This device or installed bridge does not support this check.';
		return 'No successful check has established availability yet.';
	}

	let volume = $state<{ label: string; value: number }[] | null>(null);
	let volumeUnavailable = $state(false);
	let health = $state<DeviceHealth | null>(null);
	let refreshingHealth = $state(false);
	let healthError = $state("");

	async function refreshHealth(): Promise<void> {
		if (!primaryDeviceId) return;
		refreshingHealth = true;
		try {
			health = await fetchDeviceHealth(primaryDeviceId, true);
			healthError = "";
		} catch (error) {
			healthError = error instanceof Error ? error.message : "Device health check failed";
		} finally {
			refreshingHealth = false;
		}
	}

	$effect(() => {
		const interval = setInterval(() => (now = Date.now()), 15_000);
		return () => clearInterval(interval);
	});

	$effect(() => {
		if (!canViewOperations) return;
		return observeJobVolume((snapshot) => {
			const days = snapshot.data?.days;
			if (Array.isArray(days)) {
				volume = days
					.filter(
						(day) =>
							typeof day?.date === "string" &&
							typeof day.count === "number" &&
							Number.isFinite(day.count),
					)
					.map((day) => ({
						label: fmtDayLabel(day.date),
						value: day.count,
					}));
				volumeUnavailable = Boolean(snapshot.error);
				return;
			}
			if (snapshot.error || snapshot.data !== undefined) volumeUnavailable = true;
		});
	});

	$effect(() => {
		const deviceId = primaryDeviceId;
		if (!deviceId) return;
		const load = () =>
			void fetchDeviceHealth(deviceId).then((h) => {
				health = h;
				healthError = "";
			}).catch((error) => {
				healthError = error instanceof Error ? error.message : "Device health check failed";
			});
		load();
		const interval = setInterval(load, 60_000);
		return () => clearInterval(interval);
	});

	let poolHealth = $state<Record<string, DeviceHealth | undefined>>({});
	function deviceReachability(device: { id: string; reachable?: boolean }): boolean | undefined {
		return canViewDevices ? poolHealth[device.id]?.reachable : device.reachable;
	}

	$effect(() => {
		const devices = statusDevices;
		if (!canViewDevices) return;
		if (devices.length <= 1) return;
		const load = () => {
			for (const d of devices)
				void fetchDeviceHealth(d.id).then(
					(h) => (poolHealth = { ...poolHealth, [d.id]: h }),
				).catch(() => undefined);
		};
		load();
		const interval = setInterval(load, 30_000);
		return () => clearInterval(interval);
	});

	const poolSummary = $derived.by(() => {
		const devices = statusDevices;
		if (devices.length <= 1) return null;
		const enabled = devices.filter((d) => d.enabled);
		const healthy = enabled.filter(
			(d) => deviceReachability(d),
		).length;
		return { healthy, total: enabled.length };
	});

	let healthHistory = $state<HourlyHealthBucket[] | null>(null);
	let uptimePercent = $state<number | null>(null);

	$effect(() => {
		const deviceId = primaryDeviceId;
		if (!deviceId) return;
		const load = () =>
			void fetchDeviceHealthHistory(deviceId, 24).then((r) => {
				healthHistory = r.buckets;
				uptimePercent = r.uptimePercent;
			});
		load();
		const interval = setInterval(load, 60_000);
		return () => clearInterval(interval);
	});

	function bucketColor(pct: number | null): string {
		if (pct === null) return "bg-panel-muted";
		if (pct >= 0.95) return "bg-ok";
		if (pct > 0) return "bg-warn";
		return "bg-err";
	}

	function bucketTitle(bucket: HourlyHealthBucket): string {
		const time = fmtDateTime(bucket.hourStart, { year: undefined, minute: undefined });
		if (bucket.reachablePercent === null) return `${time}: no data`;
		return `${time}: ${Math.round(bucket.reachablePercent * 100)}% reachable · ${bucket.transitions} state changes`;
	}

	let batteryHistory = $state<HourlyBatteryBucket[] | null>(null);

	$effect(() => {
		const deviceId = primaryDeviceId;
		if (!deviceId) return;
		const load = () =>
			void fetchDeviceBatteryHistory(deviceId, 24).then(
				(r) => (batteryHistory = r.buckets),
			);
		load();
		const interval = setInterval(load, 60_000);
		return () => clearInterval(interval);
	});

	function batteryBucketColor(pct: number | null): string {
		if (pct === null) return "bg-panel-muted";
		if (pct <= 20) return "bg-err";
		if (pct <= 40) return "bg-warn";
		return "bg-ok";
	}

	function batteryBucketTitle(bucket: HourlyBatteryBucket): string {
		const time = fmtDateTime(bucket.hourStart, { year: undefined, minute: undefined });
		if (bucket.batteryPercent === null) return `${time}: no data`;
		return `${time}: ${bucket.batteryPercent}%`;
	}

	const hasBatteryHistory = $derived(
		batteryHistory?.some((b) => b.batteryPercent !== null) ?? false,
	);

	let temperatureHistory = $state<HourlyTemperatureBucket[] | null>(null);

	$effect(() => {
		const deviceId = primaryDeviceId;
		if (!deviceId) return;
		const load = () =>
			void fetchDeviceTemperatureHistory(deviceId, 24).then(
				(r) => (temperatureHistory = r.buckets),
			);
		load();
		const interval = setInterval(load, 60_000);
		return () => clearInterval(interval);
	});

	function temperatureBucketColor(tempC: number | null): string {
		if (tempC === null) return "bg-panel-muted";
		if (tempC >= 42) return "bg-err";
		if (tempC >= 37) return "bg-warn";
		return "bg-ok";
	}

	function temperatureBucketTitle(bucket: HourlyTemperatureBucket): string {
		const time = fmtDateTime(bucket.hourStart, { year: undefined, minute: undefined });
		if (bucket.batteryTemperatureC === null) return `${time}: no data`;
		return `${time}: ${fmtNumber(bucket.batteryTemperatureC, 1, 1)}°C`;
	}

	const hasTemperatureHistory = $derived(
		temperatureHistory?.some((b) => b.batteryTemperatureC !== null) ??
			false,
	);

	const deviceStorageColor = $derived.by(() => {
		const pct = health?.storageUsedPercent ?? 0;
		if (pct >= 0.9) return "bg-err";
		if (pct >= 0.75) return "bg-warn";
		return "bg-accent";
	});

	const total = $derived(volume?.reduce((a, d) => a + d.value, 0) ?? 0);
	const volumeDeltaPct = $derived(
		volume ? trendDelta(volume.map((d) => d.value)) : null,
	);

	type HealthLevel = "ok" | "warn" | "err" | "unknown";

	const overallHealth = $derived.by(
		(): { level: HealthLevel; reasons: string[] } => {
			if (!health) return { level: "unknown", reasons: [] };
			const reasons: string[] = [];
			let level: HealthLevel = "ok";
			const worsen = (next: HealthLevel, reason: string) => {
				reasons.push(reason);
				if (next === "err" || level === "ok") level = next;
			};

			if (!health.reachable) worsen("err", "Device unreachable");
			if (health.reachable && health.subsystems?.agent === "offline")
				worsen("warn", "USB connected · device agent unavailable");
			if (health.reachable && health.networkConnected === false)
				worsen("err", "Device is not on a network");
			else if (
				health.reachable &&
				health.networkConnected &&
				health.internetAccess === false
			)
				worsen("warn", "iDevice has no internet access");
			if (overview?.disk && overview.disk.usedPercent >= 0.9)
				worsen("err", "Staging disk nearly full");
			else if (overview?.disk && overview.disk.usedPercent >= 0.75)
				worsen("warn", "Staging disk filling up");
			if (
				health.storageUsedPercent !== undefined &&
				health.storageUsedPercent >= 0.9
			)
				worsen("err", "iDevice storage nearly full");
			else if (
				health.storageUsedPercent !== undefined &&
				health.storageUsedPercent >= 0.75
			)
				worsen("warn", "iDevice storage filling up");
			if (
				health.batteryTemperatureC !== undefined &&
				health.batteryTemperatureC >= 42
			)
				worsen("err", "Battery hot");
			else if (
				health.batteryTemperatureC !== undefined &&
				health.batteryTemperatureC >= 37
			)
				worsen("warn", "Battery warm");
			if (
				health.batteryPercent !== undefined &&
				health.batteryPercent <= 20 &&
				!health.batteryCharging
			)
				worsen("err", "Battery critically low");
			else if (
				health.batteryPercent !== undefined &&
				health.batteryPercent <= 40 &&
				!health.batteryCharging
			)
				worsen("warn", "Battery low");

			return { level, reasons };
		},
	);

	const HEALTH_DOT_CLASS: Record<HealthLevel, string> = {
		ok: "bg-ok",
		warn: "bg-warn",
		err: "bg-err",
		unknown: "bg-panel-muted",
	};

	const HEALTH_LABEL: Record<HealthLevel, string> = {
		ok: "All good",
		warn: "Needs attention",
		err: "Needs attention now",
		unknown: "Checking",
	};

	const deviceChip = $derived.by((): { label: string; detail: string; variant: BadgeVariant } => {
		if (!overview) {
			return {
				label: "Loading devices",
				detail: "Loading the configured device pool.",
				variant: "secondary",
			};
		}
		const summary = overview.deviceStatus;
		if (summary) {
			if (summary.configured === 0) return { label: "No device connected", detail: "No decrypt device is configured.", variant: "secondary" };
			if (summary.enabled === 0) return { label: "No enabled device", detail: "All decrypt devices are disabled.", variant: "secondary" };
			if (summary.freshUntil !== undefined && now >= summary.freshUntil) {
				return { label: "Device status outdated", detail: "The last device check is too old to confirm availability.", variant: "warning" };
			}
			if (summary.ready > 0) {
				return {
					label: summary.ready === summary.enabled ? `${summary.ready} device${summary.ready === 1 ? "" : "s"} ready` : `${summary.ready}/${summary.enabled} devices ready`,
					detail: summary.ready === summary.enabled ? "Decrypt automation is available." : `${summary.attention} need attention · ${summary.unavailable} unavailable · ${summary.checking} checking`,
					variant: summary.ready === summary.enabled ? "success" : "warning",
				};
			}
			if (summary.attention > 0) return { label: summary.attention === 1 ? "Device needs attention" : `${summary.attention} devices need attention`, detail: "Connected, but decrypt automation is not ready.", variant: "warning" };
			if (summary.unavailable > 0) return { label: `${summary.unavailable} device${summary.unavailable === 1 ? "" : "s"} unavailable`, detail: `${summary.checking} checking`, variant: "destructive" };
			return { label: "Checking device", detail: "Waiting for a recent device health check.", variant: "secondary" };
		}
		if (statusDevices.length === 0) {
			return {
				label: "No device connected",
				detail: "Connect a device from Settings → Devices to run decrypts.",
				variant: "secondary",
			};
		}
		if (!statusDevices.some((device) => device.enabled)) {
			return {
				label: "No enabled device",
				detail: "Enable a device from Settings → Devices to run decrypts.",
				variant: "secondary",
			};
		}
		return {
			label: "Checking device",
			detail: "Checking the enabled device connection and autoinstall bridge.",
			variant: "secondary",
		};
	});
	const activeJobs = $derived(overview?.activeJobs.length ?? 0);
	function debugBundleText(): string {
		return JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				health,
				overview: overview
					? {
							devices: overview.devices,
							disk: overview.disk,
							maintenance: overview.maintenance,
							activeJobs: overview.activeJobs,
						}
					: undefined,
				poolHealth,
				uptimePercent,
			},
			null,
			2,
		);
	}
</script>

<Card title="Status" class="status-surface">
	{#snippet headerExtra()}
		{#if canViewDevices && health}
			<div
				class="flex min-w-0 flex-wrap items-center justify-end gap-1.5 text-xs text-muted"
			>
				<span
					class="inline-flex items-center gap-1.5"
					title={overallHealth.reasons.length > 0
						? overallHealth.reasons.join(", ")
						: HEALTH_LABEL[overallHealth.level]}
				>
					<span
						class="h-2 w-2 shrink-0 rounded-full {HEALTH_DOT_CLASS[
							overallHealth.level
						]}"
					></span>
					{HEALTH_LABEL[overallHealth.level]}
				</span>
				<span>{health.refreshing ? "Updating ·" : "Checked"} <RelativeTime ms={health.checkedAt} /></span>
				{#if canManageDevices}
				<Button
					variant="ghost"
					size="icon"
					class="h-7 w-7 p-0 text-muted"
					disabled={refreshingHealth}
					onclick={refreshHealth}
					aria-label="Refresh device status"
					title="Refresh device status"
				>
					<RefreshCw
						class="h-3.5 w-3.5 {refreshingHealth
							? 'animate-spin'
							: ''}"
					/>
				</Button>
				<CopyButton
					text={debugBundleText()}
					title="Copy debug info (device health, queue, disk)"
				/>
				{/if}
			</div>
		{/if}
	{/snippet}
	{#if !canViewStatusDetails}
		<div class="flex flex-wrap items-center justify-between gap-3 py-2" role="status">
			<Badge variant={overview?.serviceStatus === "maintenance" ? "warning" : "success"}>
				{overview?.serviceStatus === "maintenance" ? "Maintenance in progress" : "All systems operational"}
			</Badge>
			<span class="text-sm text-muted">
				{activeJobs === 0 ? "No active decrypts" : `${fmtNumber(activeJobs, 0)} active decrypt${activeJobs === 1 ? "" : "s"}`}
			</span>
		</div>
	{:else}
	{#if healthError}
		<p role="status" class="mb-2 text-xs text-warning">{healthError}</p>
	{/if}
	<div class="mb-1.5 flex flex-wrap items-center gap-1.5">
		<Popover>
			{#snippet trigger()}
				<Badge variant={activeJobs > 0 ? "default" : "secondary"}
					>{fmtNumber(activeJobs, 0)} active job{activeJobs === 1 ? "" : "s"}</Badge
				>
			{/snippet}
			<div class="flex max-w-xs flex-col gap-1">
				{#if activeJobs === 0}
					<div class="text-muted whitespace-nowrap">
						Nothing running or queued.
					</div>
				{:else}
					{#each overview?.activeJobs ?? [] as j (j.id)}
						<div class="flex items-center gap-1.5 truncate">
							{#if appIconUrl(j.bundleId)}
								<img
									src={appIconUrl(j.bundleId)}
									alt=""
									class="h-3.5 w-3.5 shrink-0 rounded"
								/>
							{/if}
							<span class="text-muted">{j.status}</span>
							<span class="truncate" title={j.bundleId}
								>{appDisplayName(j.bundleId)}</span
							>
						</div>
					{/each}
				{/if}
			</div>
		</Popover>
	</div>
	<div class="mb-1.5 flex flex-wrap items-center gap-1.5">
		{#if health}
			{@const h = health}
			<Popover>
				{#snippet trigger()}
					<Badge variant={!h.reachable ? "destructive" : h.subsystems?.agent === "offline" ? "warning" : "success"}
						>{!h.reachable ? "Device unreachable" : h.subsystems?.agent === "offline" ? "USB connected · agent unavailable" : "Device online"}</Badge
					>
				{/snippet}
				<div class="flex flex-col gap-1 whitespace-nowrap">
					{#if !h.reachable}
						<div class="text-err max-w-xs whitespace-normal">
							{h.error ?? "unreachable"}
						</div>
					{/if}
					{#if h.reachable && h.subsystems?.agent === "offline"}
						<div class="text-warn max-w-xs whitespace-normal">USB and mux are connected. The on-device agent needs recovery before automation can run.</div>
					{/if}
					{#if statusDevices.length}
						<div class="text-muted">Devices</div>
						{#each statusDevices as d (d.id)}
							<div>
								{d.name}{d.id === primaryStatusDeviceId
									? " (primary)"
									: ""} · {d.enabled ? "enabled" : "disabled"}
							</div>
						{/each}
					{/if}
				</div>
			</Popover>
			{#if poolSummary}
				<Popover>
					{#snippet trigger()}
						<Badge
							variant={poolSummary.healthy < poolSummary.total
								? "destructive"
								: "success"}
						>
							{poolSummary.healthy}/{poolSummary.total} devices healthy
						</Badge>
					{/snippet}
					<div class="flex flex-col gap-1 whitespace-nowrap">
						{#each statusDevices.filter((d) => d.enabled) as d (d.id)}
							{@const reachable = deviceReachability(d)}
							<div>
								<span
									class={reachable
										? "text-ok"
										: reachable !== undefined
											? "text-err"
											: "text-muted"}
									>{reachable !== undefined
										? reachable
											? "online"
											: "unreachable"
										: "checking"}</span
								>
								· {d.name}{d.id === primaryStatusDeviceId
									? " (primary)"
									: ""}
							</div>
						{/each}
					</div>
				</Popover>
			{/if}
			{#if h.reachable}
				<Popover>
					{#snippet trigger()}
						<Badge
							variant={h.testFlightRunning
								? "default"
								: "secondary"}
							>autoinstall {h.testFlightRunning
								? "running"
								: "idle"}</Badge
						>
					{/snippet}
					<div class="flex flex-col gap-1 whitespace-nowrap">
						{#each ['appStore', 'testFlight'] as source}
							{@const detail = h.subsystemDetails?.[source as 'appStore' | 'testFlight']}
							{@const state = detail?.state ?? h.subsystems?.[source as 'appStore' | 'testFlight'] ?? 'unknown'}
							<div class="font-medium">{source === 'appStore' ? 'App Store' : 'TestFlight'} · {sourceStateLabel(state)}</div>
							<div class="max-w-xs whitespace-normal text-muted">{sourceStateExplanation(source as 'appStore' | 'testFlight', state)}</div>
							{#if detail?.reason}<div class="max-w-xs whitespace-normal">{detail.reason}</div>{/if}
							{#if detail?.lastChangedAt}<div class="text-muted">State changed <RelativeTime ms={detail.lastChangedAt} /></div>{/if}
						{/each}
						<div class="text-muted">Last health check <RelativeTime ms={h.checkedAt} /></div>
						{#if h.testFlightBridgeReachable !== undefined}
							<div>
								<span class="text-muted">Bridge</span> · {h.testFlightBridgeReachable
									? "reachable"
									: "unreachable"}
							</div>
						{/if}
						<div class="text-muted">
							Drives App Store & TestFlight installs.
						</div>
					</div>
				</Popover>
			{/if}
		{:else}
			<Popover>
				{#snippet trigger()}
					<Badge variant={deviceChip.variant}>{deviceChip.label}</Badge>
				{/snippet}
				<div class="max-w-xs whitespace-normal">{deviceChip.detail}</div>
			</Popover>
		{/if}
	</div>
	{#if health}
		{@const h = health}
		{#if h.reachable && (h.batteryPercent !== undefined || h.batteryTemperatureC !== undefined || h.networkConnected !== undefined)}
			<div class="mb-3.5 flex flex-wrap items-center gap-1.5">
				{#if h.batteryPercent !== undefined}
					<Popover>
						{#snippet trigger()}
							<Badge
								variant={h.batteryPercent !== undefined &&
								h.batteryPercent <= 20 &&
								!h.batteryCharging
									? "destructive"
									: "secondary"}
							>
								{#if h.batteryCharging}
									<BatteryCharging
										class="mr-1 inline h-3 w-3"
									/>
								{:else}
									<BatteryMedium
										class="mr-1 inline h-3 w-3"
									/>
								{/if}
								{fmtNumber(h.batteryPercent ?? 0, 0)}%
							</Badge>
						{/snippet}
						<div class="flex flex-col gap-1 whitespace-nowrap">
							{#if h.batteryHealthPercent !== undefined}
								<div>
									<span class="text-muted"
										>Battery health</span
									>
									· {fmtNumber(h.batteryHealthPercent, 0)}%
								</div>
							{/if}
							{#if h.batteryCycleCount !== undefined}
								<div>
									<span class="text-muted">Cycle count</span>
									· {fmtNumber(h.batteryCycleCount, 0)}
								</div>
							{/if}
							{#if h.batteryMaxCapacityMah !== undefined && h.batteryDesignCapacityMah !== undefined}
								<div>
									<span class="text-muted">Capacity</span> · {fmtNumber(h.batteryMaxCapacityMah, 0)}
									/ {fmtNumber(h.batteryDesignCapacityMah, 0)} mAh
								</div>
							{/if}
						</div>
					</Popover>
				{/if}
				{#if h.batteryTemperatureC !== undefined}
					{@const temp = h.batteryTemperatureC}
					<Popover>
						{#snippet trigger()}
							<Badge variant={thermalBadgeVariant(temp)}>
								<Thermometer class="mr-1 inline h-3 w-3" />
								{fmtNumber(temp, 1, 1)}°C
								{#if h.batteryCharging}
									<Zap class="ml-1 inline h-3 w-3" />
								{/if}
							</Badge>
						{/snippet}
						<div class="flex flex-col gap-1 whitespace-nowrap">
							<div>
								<span class="text-muted">State</span> · {temp >=
								42
									? "hot"
									: temp >= 37
										? "warm"
										: "normal"}
							</div>
							<div class="text-muted">
								Warm ≥ 37°C · Hot ≥ 42°C
							</div>
						</div>
					</Popover>
				{/if}
				{#if h.networkConnected !== undefined}
					{#if !h.networkConnected}
						<Badge variant="destructive">
							<WifiOff class="mr-1 inline h-3 w-3" />
							No network
						</Badge>
					{:else}
						<Popover>
							{#snippet trigger()}
								<Badge
									variant={h.internetAccess
										? "success"
										: "warning"}
								>
									{#if h.internetAccess}
										<Globe class="mr-1 inline h-3 w-3" />
										Internet
									{:else}
										<Wifi class="mr-1 inline h-3 w-3" />
										No internet
									{/if}
								</Badge>
							{/snippet}
							<div class="flex flex-col gap-1 whitespace-nowrap">
								{#if !h.internetAccess}
									<div>
										On a network but can't reach the
										internet.
									</div>
								{/if}
								{#if h.networkInterface}
									<div>
										<span class="text-muted">Interface</span
										>
										· {h.networkInterface}
									</div>
								{/if}
								{#if h.networkIpAddress}
									<div>
										<span class="text-muted"
											>IP address</span
										>
										· {h.networkIpAddress}
									</div>
								{/if}
							</div>
						</Popover>
					{/if}
				{/if}
			</div>
		{/if}
	{/if}
	{#if healthHistory}
		<div class="mb-3.5">
			<div
				class="mb-1.5 flex items-center justify-between text-xs text-muted"
			>
				<span>Device reachability · last 24h</span>
				{#if uptimePercent !== null}
					<span>{Math.round(uptimePercent * 100)}% uptime</span>
				{/if}
			</div>
			<div class="flex gap-0.5">
				{#each healthHistory as bucket (bucket.hourStart)}
					<div
					class="h-4 flex-1 rounded-sm {bucketColor(
						bucket.reachablePercent,
					)} {bucket.transitions >= 2 ? 'ring-2 ring-warn' : ''}"
						title={bucketTitle(bucket)}
					></div>
				{/each}
			</div>
		</div>
	{/if}
	{#if hasBatteryHistory}
		<div class="mb-3.5">
			<div class="mb-1.5 text-xs text-muted">Battery · last 24h</div>
			<div class="flex gap-0.5">
				{#each batteryHistory ?? [] as bucket (bucket.hourStart)}
					<div
						class="h-4 flex-1 rounded-sm {batteryBucketColor(
							bucket.batteryPercent,
						)}"
						title={batteryBucketTitle(bucket)}
					></div>
				{/each}
			</div>
		</div>
	{/if}
	{#if hasTemperatureHistory}
		<div class="mb-3.5">
			<div class="mb-1.5 text-xs text-muted">Temperature · last 24h</div>
			<div class="flex gap-0.5">
				{#each temperatureHistory ?? [] as bucket (bucket.hourStart)}
					<div
						class="h-4 flex-1 rounded-sm {temperatureBucketColor(
							bucket.batteryTemperatureC,
						)}"
						title={temperatureBucketTitle(bucket)}
					></div>
				{/each}
			</div>
		</div>
	{/if}
	{#if overview?.disk}
		<div class="border-border mt-1 border-t pt-3">
			<div
				class="mb-1.5 flex items-center justify-between text-xs text-muted"
			>
				<span>Staging disk</span>
				<span
					>{fmtBytesGB(overview.disk.usedBytes)} / {fmtBytesGB(
						overview.disk.totalBytes,
					)}</span
				>
			</div>
			<div
				class="bg-panel-muted h-1.5 w-full overflow-hidden rounded-full"
			>
				<div
					class="h-full rounded-full {diskColor}"
					style="width: {Math.min(
						100,
						overview.disk.usedPercent * 100,
					)}%"
				></div>
			</div>
		</div>
	{/if}
	{#if health?.storageUsedPercent !== undefined}
		<div class="border-border mt-3 border-t pt-3">
			<div
				class="mb-1.5 flex items-center justify-between text-xs text-muted"
			>
				<span>iDevice storage</span>
				<span>
					{#if health.storageFreeBytes !== undefined && health.storageTotalBytes !== undefined}
						{fmtBytesGB(health.storageUsedBytes ?? health.storageTotalBytes - health.storageFreeBytes)} / {fmtBytesGB(
							health.storageTotalBytes,
						)}
					{:else}
						{Math.round(health.storageUsedPercent * 100)}%
					{/if}
				</span>
			</div>
			<div
				class="bg-panel-muted h-1.5 w-full overflow-hidden rounded-full"
			>
				<div
					class="h-full rounded-full {deviceStorageColor}"
					style="width: {Math.min(
						100,
						health.storageUsedPercent * 100,
					)}%"
				></div>
			</div>
		</div>
	{/if}
	{#if volume}
		<div class="border-border mt-1 border-t pt-3">
			<div class="mb-1.5 flex items-center gap-2 text-xs text-muted">
				<span
					>{total} decrypt{total === 1 ? "" : "s"} · last 14 days</span
				>
				{#if volumeUnavailable}
					<span role="status">Refresh unavailable</span>
					<Button
						variant="ghost"
						size="icon"
						class="h-5 w-5 p-0 text-muted"
						onclick={() => refreshDashboardJobVolume()}
						aria-label="Retry decrypt history"
						title="Retry decrypt history"
					>
						<RefreshCw class="h-3 w-3" />
					</Button>
				{/if}
				{#if volumeDeltaPct !== null}
					<Badge
						variant={volumeDeltaPct > 0
							? "success"
							: volumeDeltaPct < 0
								? "destructive"
								: "secondary"}
						title="Second half vs first half of this window"
					>
						{volumeDeltaPct > 0 ? "+" : ""}{volumeDeltaPct}%
					</Badge>
				{/if}
			</div>
			<Sparkline
				data={volume}
				width={280}
				ariaLabel="{total} decrypts over the last 14 days"
			/>
		</div>
	{:else if volumeUnavailable}
		<div role="status" class="border-border mt-1 flex items-center justify-between border-t pt-3 text-xs text-muted">
			<span>Decrypt activity unavailable</span>
			<Button
				variant="ghost"
				size="sm"
				class="h-7 px-2 text-[11px]"
				onclick={() => refreshDashboardJobVolume()}
				aria-label="Retry decrypt history"
			>
				Retry
			</Button>
		</div>
	{/if}
	{/if}
</Card>
