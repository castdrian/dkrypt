<script lang="ts">
  import { tick } from 'svelte';
  import { AlertTriangle, CheckCircle2, CircleX, Grid2X2, List, Pencil, RefreshCw, Search, Smartphone, Star, Trash2, Usb, Wifi } from 'lucide-svelte';
  import AdvancedSection from '#components/AdvancedSection.svelte';
  import AuditRibbon from '#components/AuditRibbon.svelte';
  import DeviceArtwork from '#components/DeviceArtwork.svelte';
  import DeviceComparison from '#features/devices/DeviceComparison.svelte';
  import EmptyState from '#components/EmptyState.svelte';
  import RelativeTime from '#components/RelativeTime.svelte';
  import VirtualizedList from '#components/VirtualizedList.svelte';
  import {
    discoverDevices,
    drainDevice,
    fetchDeviceDisableImpact,
    fetchDeviceActivity,
    fetchDeviceHealth,
    fetchDeviceInventory,
    fetchDevicePreflight,
    fetchDeviceRecoveryOperation,
    fetchDeviceRecoveryOperations,
    fetchDeviceSetupOperation,
    fetchDeviceSetupOperations,
    fetchDevices,
    fetchSettings,
    recoverDevice,
    saveSettings,
    setDeviceDarkMode,
    startDeviceSetupOperation,
    resumeDeviceSetupOperation,
    updateDevice,
    deleteDevice,
    type DeviceDiscoveryCandidate,
    type DeviceDiscoveryResult,
    type DeviceHealth,
    type DeviceActivityEntry,
    type DeviceRecord,
    type DeviceSetupResult,
    type DeviceSetupOperation,
    type DeviceRecoveryOperation,
    type DashboardSettings,
  } from '#lib/api';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import Switch from '#lib/components/ui/Switch.svelte';
  import { liveState } from '#lib/live.svelte';
  import { PermissionFlag } from '#lib/permissions';
  import { getAppleDeviceModelName } from '#lib/deviceModel';
  import { sessionHasAnyPermission, sessionHasPermission, sessionState } from '#lib/session.svelte';
  import { announceScreenReader, confirmDialog, deviceDetailJumpState, homeViewModesState, interfaceLanguageState, showToast, systemLocalesState } from '#lib/ui.svelte';
  import { pushHomeViewMode } from '#lib/session.svelte';
  import { clearFormDraft, clearSyncedFormDraft, readFormDraft, readSyncedFormDraft, setFormUnsaved, writeFormDraft, writeSyncedFormDraft } from '#lib/formDrafts.svelte';
  import { backgroundTasksState, startBackgroundTask, updateBackgroundTask } from '#lib/backgroundTasks.svelte';
  import { resolveInterfaceLanguage } from '#lib/locale';
  import { translateMessage, type MessageKey } from '#lib/messages';

  type DeviceSubsystemId = keyof NonNullable<DeviceHealth['subsystems']>;
  type DeviceSubsystemState = NonNullable<NonNullable<DeviceHealth['subsystems']>[DeviceSubsystemId]>;
  const interfaceLanguage = $derived(resolveInterfaceLanguage(interfaceLanguageState.value, systemLocalesState.value));
  const msg = (key: MessageKey) => translateMessage(key, interfaceLanguage);
  const subsystemNames: Record<DeviceSubsystemId, MessageKey> = {
    usb: 'device.subsystem.usb', mux: 'device.subsystem.mux', agent: 'device.subsystem.agent', jailbreak: 'device.subsystem.jailbreak',
    appStore: 'device.subsystem.appStore', testFlight: 'device.subsystem.testFlight', sshTunnel: 'device.subsystem.sshTunnel', storage: 'device.subsystem.storage', battery: 'device.subsystem.battery', thermal: 'device.subsystem.thermal',
  };
  const subsystemStates: Record<DeviceSubsystemState, MessageKey> = {
    ready: 'device.state.ready', idle: 'device.state.idle', degraded: 'device.state.degraded', offline: 'device.state.offline', unsupported: 'device.state.unsupported', unknown: 'device.state.unknown',
  };

  function statusLabel(status: DeviceSubsystemState, process: boolean): string {
    if (process && status === 'ready') return msg('device.state.running');
    if (process && status === 'idle') return msg('device.state.notOpen');
    return msg(subsystemStates[status]);
  }

  const canManageDevices = $derived(sessionHasPermission(PermissionFlag.manageDevices));
  const canViewMaintenance = $derived(sessionHasAnyPermission([PermissionFlag.viewAutomation, PermissionFlag.manageAutomation]));
  const canManageMaintenance = $derived(sessionHasPermission(PermissionFlag.manageAutomation));
  const devices = $derived(liveState.overview?.devices ?? []);
  const maintenanceStatus = $derived(liveState.overview?.maintenance);

  function subsystemVariant(status: DeviceSubsystemState): 'success' | 'warning' | 'destructive' | 'secondary' {
    if (status === 'ready') return 'success';
    if (status === 'degraded') return 'warning';
    if (status === 'offline') return 'destructive';
    return 'secondary';
  }

  function connectionChain(device: DeviceRecord, value: DeviceHealth | undefined): Array<{ label: string; status: DeviceSubsystemState; reason?: string }> {
    const stages: Array<{ label: string; subsystem: DeviceSubsystemId }> = [
      { label: 'Mux', subsystem: 'mux' },
      { label: 'Agent', subsystem: 'agent' },
      { label: 'SSH/SFTP', subsystem: 'sshTunnel' },
      { label: 'App Store', subsystem: 'appStore' },
      { label: 'TestFlight', subsystem: 'testFlight' },
    ];
    const connectionStatus = device.transport === 'usb'
      ? value?.subsystems?.usb ?? 'unknown'
      : value ? value.reachable ? 'ready' : 'offline' : 'unknown';
    return [
      { label: device.transport === 'usb' ? 'USB' : 'Wi-Fi', status: connectionStatus, reason: device.transport === 'usb' ? value?.subsystemDetails?.usb?.reason : value?.error },
      ...stages.map(({ label, subsystem }) => ({ label, status: value?.subsystems?.[subsystem] ?? 'unknown', reason: value?.subsystemDetails?.[subsystem]?.reason })),
    ];
  }

  let maintenanceSettings = $state<DashboardSettings | null>(null);
  let comparingDevices = $state(false);
  let togglingMaintenance = $state(false);

  $effect(() => {
    if (!canViewMaintenance) return;
    void fetchSettings().then((settings) => (maintenanceSettings = settings));
  });

  $effect(() => {
    const deviceId = deviceDetailJumpState.id;
    if (!deviceId) return;
    deviceDetailJumpState.id = null;
    void tick().then(() => {
      const card = document.getElementById(`device-${encodeURIComponent(deviceId)}`);
      card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card?.focus({ preventScroll: true });
    });
  });

  async function toggleMaintenance(): Promise<void> {
    if (!maintenanceSettings) return;
    const enabling = !maintenanceSettings.maintenanceMode;
    const confirmed = await confirmDialog(
      enabling
        ? 'Pause every decrypt request and API call right now? Anyone using the API will get blocked until this is turned off again.'
        : "Resume decrypts and the API? If maintenance mode was auto-engaged, make sure the underlying device issue is actually resolved first - it'll just re-engage on its own if not.",
      { variant: enabling ? 'destructive' : 'default', confirmLabel: enabling ? 'Pause everything' : 'Resume' },
    );
    if (!confirmed) return;
    togglingMaintenance = true;
    try {
      const { ok, data } = await saveSettings({ ...maintenanceSettings, maintenanceMode: enabling });
      if (ok) maintenanceSettings = data;
    } finally {
      togglingMaintenance = false;
    }
  }

  let health = $state<Record<string, DeviceHealth | undefined>>({});
  let recoveryReceipts = $state<Record<string, DeviceRecoveryOperation[]>>({});
  const activeRecoveryPolls = new Set<string>();
  const recoverySyncDeviceIds = new Set<string>();
  const knownSubsystemStates = new Map<string, DeviceSubsystemState>();

  $effect(() => {
    for (const [deviceId, deviceHealth] of Object.entries(health)) {
      if (!deviceHealth?.subsystems) continue;
      const device = devices.find((entry) => entry.id === deviceId);
      for (const [name, state] of Object.entries(deviceHealth.subsystems)) {
        const subsystem = name as DeviceSubsystemId;
        const subsystemState = state as DeviceSubsystemState;
        const key = `${deviceId}:${subsystem}`;
        const previousState = knownSubsystemStates.get(key);
        if (previousState !== undefined && previousState !== subsystemState) {
          announceScreenReader(`${device?.name ?? 'Device'} ${msg(subsystemNames[subsystem])}: ${msg(subsystemStates[subsystemState])}`, `device-state:${key}:${subsystemState}`);
        }
        knownSubsystemStates.set(key, subsystemState);
      }
    }
  });
  let activity = $state<Record<string, DeviceActivityEntry[]>>({});
  let activityNextCursor = $state<Record<string, string | undefined>>({});
  let activityTotals = $state<Record<string, number>>({});
  let loadingActivity = $state<Set<string>>(new Set());

  function loadHealth(): void {
    for (const device of devices) {
      void fetchDeviceHealth(device.id).then((value) => (health = { ...health, [device.id]: value })).catch(() => {});
      void fetchDeviceActivity(device.id, 50).then((result) => {
        const existing = activity[device.id] ?? [];
        const pageIds = new Set(result.activity.map((entry) => entry.id));
        const olderEntries = existing.filter((entry) => !pageIds.has(entry.id));
        activity = { ...activity, [device.id]: [...result.activity, ...olderEntries] };
        activityNextCursor = { ...activityNextCursor, [device.id]: olderEntries.length > 0 ? activityNextCursor[device.id] : result.nextCursor };
        activityTotals = { ...activityTotals, [device.id]: result.total };
      }).catch(() => {});
    }
  }

  async function loadMoreActivity(deviceId: string): Promise<void> {
    const cursor = activityNextCursor[deviceId];
    if (!cursor || loadingActivity.has(deviceId)) return;
    loadingActivity = new Set(loadingActivity).add(deviceId);
    try {
      const result = await fetchDeviceActivity(deviceId, cursor, 50);
      const existing = activity[deviceId] ?? [];
      const seenIds = new Set(existing.map((entry) => entry.id));
      activity = { ...activity, [deviceId]: [...existing, ...result.activity.filter((entry) => !seenIds.has(entry.id))] };
      activityNextCursor = { ...activityNextCursor, [deviceId]: result.nextCursor };
      activityTotals = { ...activityTotals, [deviceId]: result.total };
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not load device activity', 'error');
    } finally {
      const nextLoading = new Set(loadingActivity);
      nextLoading.delete(deviceId);
      loadingActivity = nextLoading;
    }
  }

  async function reloadDevices(): Promise<void> {
    try {
      const result = await fetchDevices();
      if (liveState.overview) liveState.overview = { ...liveState.overview, devices: result.devices };
    } catch {}
  }

  function rememberRecoveryOperation(operation: DeviceRecoveryOperation): void {
    const current = recoveryReceipts[operation.deviceId] ?? [];
    recoveryReceipts = {
      ...recoveryReceipts,
      [operation.deviceId]: [operation, ...current.filter((entry) => entry.id !== operation.id)].slice(0, 10),
    };
  }

  async function followRecovery(device: DeviceRecord, initial: DeviceRecoveryOperation): Promise<void> {
    if (activeRecoveryPolls.has(initial.id)) return;
    activeRecoveryPolls.add(initial.id);
    const taskId = startBackgroundTask('device_recovery', `Recover ${device.name}`, initial.stage, '/?tab=settings&stab=devices', initial.id);
    recoveringId = new Set(recoveringId).add(device.id);
    let operation = initial;
    try {
      while (!['complete', 'failed', 'interrupted'].includes(operation.status)) {
        rememberRecoveryOperation(operation);
        updateBackgroundTask(taskId, 'running', operation.stage);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        try {
          operation = (await fetchDeviceRecoveryOperation(device.id, initial.id)).operation;
        } catch (error) {
          updateBackgroundTask(taskId, 'running', 'Waiting for the recovery receipt', error instanceof Error ? error.message : undefined);
        }
      }
      rememberRecoveryOperation(operation);
      if (operation.status === 'complete') {
        updateBackgroundTask(taskId, 'complete', 'Device and Autoinstall reconnected', `Command exit ${operation.commandExitCode ?? 'unknown'} · agent ${operation.agentReady ? 'ready' : 'not ready'} · SpringBoard ${operation.springboardReady ? 'ready' : 'not ready'}`);
        const value = await fetchDeviceHealth(device.id, true).catch(() => undefined);
        if (value) health = { ...health, [device.id]: value };
        showToast(`${device.name} recovery was verified`, 'success');
      } else if (operation.status === 'failed' || operation.status === 'interrupted') {
        updateBackgroundTask(taskId, 'failed', operation.stage, operation.error);
        showToast(operation.error ?? `${device.name} recovery could not be verified`, 'error');
      } else {
        updateBackgroundTask(taskId, 'running', 'Recovery is still running', 'dkrypt is still checking the device recovery receipt.');
      }
    } finally {
      activeRecoveryPolls.delete(initial.id);
      const next = new Set(recoveringId);
      next.delete(device.id);
      recoveringId = next;
    }
  }

  $effect(() => {
    if (!canManageDevices) return;
    for (const device of devices) {
      if (recoverySyncDeviceIds.has(device.id)) continue;
      recoverySyncDeviceIds.add(device.id);
      void fetchDeviceRecoveryOperations(device.id).then(({ operations }) => {
        recoveryReceipts = { ...recoveryReceipts, [device.id]: operations };
        for (const operation of operations) {
          const localTask = backgroundTasksState.items.find((task) => task.id === operation.id);
          const active = ['queued', 'running', 'verifying'].includes(operation.status);
          if (active) void followRecovery(device, operation);
          else if (localTask?.status === 'running') updateBackgroundTask(operation.id, operation.status === 'complete' ? 'complete' : 'failed', operation.stage, operation.error);
        }
      }).catch(() => {});
    }
  });

  $effect(() => {
    devices;
    const fragment = window.location.hash.slice(1);
    if (fragment.startsWith('device-')) {
      void tick().then(() => document.getElementById(fragment)?.scrollIntoView({ block: 'start' }));
    }
    loadHealth();
    const interval = setInterval(loadHealth, 30_000);
    return () => clearInterval(interval);
  });

  let testingId = $state<Set<string>>(new Set());
  let inspectingId = $state<Set<string>>(new Set());
  let recoveringId = $state<Set<string>>(new Set());
  let updatingDarkModeId = $state<Set<string>>(new Set());
  let deletingId = $state<Set<string>>(new Set());
  let preflightOpen = $state(false);
  let preflight = $state<Awaited<ReturnType<typeof fetchDevicePreflight>> | null>(null);
  let inventoryOpen = $state(false);
  let inventory = $state<{ deviceId: string; bundles: string[] } | null>(null);

  async function testConnection(device: DeviceRecord): Promise<void> {
    const taskId = startBackgroundTask('device_check', 'Device connection check', 'Contacting device transport', '/?tab=settings&stab=devices');
    testingId = new Set(testingId).add(device.id);
    try {
      const value = await fetchDeviceHealth(device.id, true);
      health = { ...health, [device.id]: value };
      updateBackgroundTask(taskId, value.reachable ? 'complete' : 'failed', value.reachable ? 'Connection verified' : 'Device unreachable', value.error);
      showToast(value.reachable ? `${device.name} is reachable` : `${device.name} is unreachable${value.error ? `: ${value.error}` : ''}`, value.reachable ? 'success' : 'error');
    } catch (error) {
      updateBackgroundTask(taskId, 'failed', 'Connection check failed', error instanceof Error ? error.message : undefined);
      showToast(error instanceof Error ? error.message : 'Connection test failed', 'error');
    } finally {
      const next = new Set(testingId);
      next.delete(device.id);
      testingId = next;
    }
  }

  async function inspectDevice(device: DeviceRecord): Promise<void> {
    const taskId = startBackgroundTask('device_check', 'Device preflight', 'Checking prerequisites', '/?tab=settings&stab=devices');
    inspectingId = new Set(inspectingId).add(device.id);
    try {
      preflight = await fetchDevicePreflight(device.id);
      preflightOpen = true;
      updateBackgroundTask(taskId, preflight.ready ? 'complete' : 'failed', preflight.ready ? 'Prerequisites verified' : 'Prerequisites need attention');
    } catch (error) {
      updateBackgroundTask(taskId, 'failed', 'Preflight failed', error instanceof Error ? error.message : undefined);
      showToast(error instanceof Error ? error.message : 'Preflight failed', 'error');
    } finally {
      const next = new Set(inspectingId);
      next.delete(device.id);
      inspectingId = next;
    }
  }

  async function inspectInventory(device: DeviceRecord): Promise<void> {
    const taskId = startBackgroundTask('device_check', 'Device inventory', 'Reading installed apps', '/?tab=settings&stab=devices');
    inspectingId = new Set(inspectingId).add(device.id);
    try {
      inventory = await fetchDeviceInventory(device.id);
      inventoryOpen = true;
      updateBackgroundTask(taskId, 'complete', 'Inventory available');
    } catch (error) {
      updateBackgroundTask(taskId, 'failed', 'Inventory lookup failed', error instanceof Error ? error.message : undefined);
      showToast(error instanceof Error ? error.message : 'Inventory lookup failed', 'error');
    } finally {
      const next = new Set(inspectingId);
      next.delete(device.id);
      inspectingId = next;
    }
  }

  async function recover(device: DeviceRecord): Promise<void> {
    recoveringId = new Set(recoveringId).add(device.id);
    let recoveryStarted = false;
    try {
      const result = await recoverDevice(device.id);
      if (result.ok && result.data?.operation) {
        rememberRecoveryOperation(result.data.operation);
        recoveryStarted = true;
        void followRecovery(device, result.data.operation);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Device recovery failed', 'error');
    } finally {
      if (!recoveryStarted) {
        const next = new Set(recoveringId);
        next.delete(device.id);
        recoveringId = next;
      }
    }
  }

  async function toggleDarkMode(device: DeviceRecord, enabled: boolean): Promise<void> {
    updatingDarkModeId = new Set(updatingDarkModeId).add(device.id);
    try {
      const result = await setDeviceDarkMode(device.id, enabled);
      if (result.ok) health = { ...health, [device.id]: result.data };
    } finally {
      const next = new Set(updatingDarkModeId);
      next.delete(device.id);
      updatingDarkModeId = next;
    }
  }

  let discoveryOpen = $state(false);
  let discoveryLoading = $state(false);
  let discovery = $state<DeviceDiscoveryResult | null>(null);
  let discoveryError = $state('');
  let setupExistingId = $state<string | undefined>();
  let setupCandidate = $state<DeviceDiscoveryCandidate | null>(null);
  let setupName = $state('');

  let setupOpen = $state(false);
  let setupRunning = $state(false);
  let setupError = $state('');
  let setupResult = $state<DeviceSetupResult | null>(null);
  let setupOperation = $state<DeviceSetupOperation | null>(null);
  let setupOperationsLoaded = false;

  $effect(() => {
    if (!canManageDevices || setupOperationsLoaded) return;
    setupOperationsLoaded = true;
    void fetchDeviceSetupOperations().then(({ operations }) => {
      const latest = operations.find((operation) => operation.status === 'running' || operation.status === 'queued' || operation.status === 'interrupted' || operation.status === 'failed');
      if (latest) {
        setupOperation = latest;
        setupRunning = latest.status === 'running' || latest.status === 'queued';
        setupError = latest.error ?? '';
      }
    }).catch(() => undefined);
  });

  $effect(() => {
    const operation = setupOperation;
    if (!operation || !['queued', 'running'].includes(operation.status)) return;
    const timer = setInterval(() => void refreshSetupOperation(operation.id), 1000);
    return () => clearInterval(timer);
  });

  async function refreshSetupOperation(id: string): Promise<void> {
    try {
      const { operation } = await fetchDeviceSetupOperation(id);
      if (setupOperation?.id !== id) return;
      const wasComplete = setupOperation.status === 'complete';
      setupOperation = operation;
      setupRunning = operation.status === 'queued' || operation.status === 'running';
      setupResult = operation.setup ?? null;
      setupError = operation.error ?? '';
      if (operation.status === 'complete' && !wasComplete) await reloadDevices();
    } catch (error) {
      setupError = error instanceof Error ? error.message : 'Could not load setup progress';
    }
  }

  async function openDiscovery(existingId?: string): Promise<void> {
    setupExistingId = existingId;
    discoveryOpen = true;
    discoveryLoading = true;
    discoveryError = '';
    try {
      discovery = await discoverDevices();
    } catch (error) {
      discoveryError = error instanceof Error ? error.message : 'Device discovery failed';
    } finally {
      discoveryLoading = false;
    }
  }

  function prepareSetup(candidate: DeviceDiscoveryCandidate): void {
    discoveryOpen = false;
    setupCandidate = candidate;
    setupName = candidate.name;
    setupError = '';
    setupResult = null;
    setupOperation = null;
    setupOpen = true;
    void runSetup(candidate);
  }

  async function runSetup(candidate: DeviceDiscoveryCandidate): Promise<void> {
    setupRunning = true;
    try {
      const result = await startDeviceSetupOperation(candidate, { name: setupName.trim() || candidate.name, existingId: setupExistingId });
      if (result.ok) {
        setupOperation = result.data.operation;
      } else {
        const message = result.data.error;
        setupError = typeof message === 'string' ? message : 'Device setup could not be completed. Try again.';
      }
    } catch (error) {
      setupError = error instanceof Error ? error.message : 'Device setup failed';
    } finally {
      if (!setupOperation || !['queued', 'running'].includes(setupOperation.status)) setupRunning = false;
    }
  }

  async function retrySetup(): Promise<void> {
    setupError = '';
    setupResult = null;
    if (setupOperation && ['interrupted', 'failed'].includes(setupOperation.status)) {
      const result = await resumeDeviceSetupOperation(setupOperation.id);
      if (result.ok) {
        setupOperation = result.data.operation;
        setupRunning = true;
      } else setupError = result.data.error ?? 'Reconnect the device before resuming setup';
      return;
    }
    if (setupCandidate) await runSetup(setupCandidate);
  }

  let editOpen = $state(false);
  let editingId = $state<string | null>(null);
  let editingUpdatedAt = $state(0);
  let conflictDevice = $state<DeviceRecord | null>(null);
  let formError = $state('');
  let formName = $state('');
  let formIosVersion = $state('');
  let formToolchain = $state('');
  let formNotes = $state('');
  let saving = $state(false);
  let deviceDraftKey = $state('');
  let deviceDraftOwnerAccountId = $state('');
  let initialDeviceDraft = $state('');
  let loadingDeviceDraft = $state(false);
  const deviceFormId = 'device-editor';

  function deviceDraftValues(): { name: string; iosVersion: string; toolchain: string; notes: string } {
    return { name: formName, iosVersion: formIosVersion, toolchain: formToolchain, notes: formNotes };
  }

  $effect(() => {
    if (editOpen && deviceDraftOwnerAccountId && sessionState.sub !== deviceDraftOwnerAccountId) {
      editOpen = false;
      editingId = null;
      conflictDevice = null;
      setFormUnsaved(deviceFormId, false);
    }
  });

  $effect(() => {
    if (!editOpen || !deviceDraftKey || loadingDeviceDraft) return;
    const values = deviceDraftValues();
    const serialized = JSON.stringify(values);
    const dirty = serialized !== initialDeviceDraft;
    if (dirty) {
      writeFormDraft(deviceDraftKey, values);
      if (editingId) writeSyncedFormDraft(`device:${editingId}`, 'device', values, deviceDraftOwnerAccountId);
    }
    setFormUnsaved(deviceFormId, dirty);
  });

  async function setEditOpen(open: boolean): Promise<void> {
    if (!open && JSON.stringify(deviceDraftValues()) !== initialDeviceDraft) {
      const confirmed = await confirmDialog('Close this device form? Your changes will be saved as a draft.', { confirmLabel: 'Close form' });
      if (!confirmed) return;
    }
    editOpen = open;
    if (!open) setFormUnsaved(deviceFormId, false);
  }

  function openEdit(device: DeviceRecord): void {
    editingId = device.id;
    deviceDraftOwnerAccountId = sessionState.sub ?? '';
    editingUpdatedAt = device.updatedAt;
    conflictDevice = null;
    formError = '';
    deviceDraftKey = `device:${sessionState.sub ?? 'account'}:${device.id}`;
    loadingDeviceDraft = true;
    formName = device.name;
    formIosVersion = device.iosVersion ?? '';
    formToolchain = device.toolchain ?? '';
    formNotes = device.notes ?? '';
    const draft = readFormDraft<ReturnType<typeof deviceDraftValues>>(deviceDraftKey)?.values;
    if (draft) {
      formName = draft.name;
      formIosVersion = draft.iosVersion;
      formToolchain = draft.toolchain;
      formNotes = draft.notes;
    }
    initialDeviceDraft = JSON.stringify(deviceDraftValues());
    editOpen = true;
    const openedValues = JSON.stringify(deviceDraftValues());
    void readSyncedFormDraft<ReturnType<typeof deviceDraftValues>>(`device:${device.id}`, 'device', deviceDraftKey).then((draft) => {
      if (draft && sessionState.sub === deviceDraftOwnerAccountId && editOpen && editingId === device.id && JSON.stringify(deviceDraftValues()) === openedValues) {
        formName = draft.values.name;
        formIosVersion = draft.values.iosVersion;
        formToolchain = draft.values.toolchain;
        formNotes = draft.values.notes;
        initialDeviceDraft = JSON.stringify(deviceDraftValues());
      }
    }).finally(() => {
      if (editingId === device.id) loadingDeviceDraft = false;
    });
  }

  async function save(): Promise<void> {
    if (!editingId || !formName.trim()) {
      formError = 'A device name is required';
      document.getElementById('d-name')?.focus();
      return;
    }
    formError = '';
    saving = true;
    try {
      const result = await updateDevice(editingId, { name: formName.trim(), iosVersion: formIosVersion.trim(), toolchain: formToolchain.trim(), notes: formNotes.trim(), expectedUpdatedAt: editingUpdatedAt });
      if (result.ok) {
        clearFormDraft(deviceDraftKey);
        clearSyncedFormDraft(`device:${editingId}`, deviceDraftOwnerAccountId);
        initialDeviceDraft = JSON.stringify(deviceDraftValues());
        setFormUnsaved(deviceFormId, false);
        editOpen = false;
        await reloadDevices();
      } else {
        const response = result.data as unknown as { code?: string; remediation?: { current?: DeviceRecord } };
        if (response.code === 'revision_conflict' && response.remediation?.current) conflictDevice = response.remediation.current;
      }
    } finally {
      saving = false;
    }
  }

  function reloadConflictedDevice(): void {
    if (!conflictDevice) return;
    formName = conflictDevice.name;
    formIosVersion = conflictDevice.iosVersion ?? '';
    formToolchain = conflictDevice.toolchain ?? '';
    formNotes = conflictDevice.notes ?? '';
    editingUpdatedAt = conflictDevice.updatedAt;
    initialDeviceDraft = JSON.stringify(deviceDraftValues());
    clearFormDraft(deviceDraftKey);
    if (editingId) clearSyncedFormDraft(`device:${editingId}`, deviceDraftOwnerAccountId);
    conflictDevice = null;
  }

  async function applyEditsToLatest(): Promise<void> {
    if (!conflictDevice) return;
    editingUpdatedAt = conflictDevice.updatedAt;
    conflictDevice = null;
    await save();
  }

  async function remove(device: DeviceRecord): Promise<void> {
    if (!(await confirmDialog(`Remove "${device.name}"? Any of its running/queued jobs will fail.`))) return;
    deletingId = new Set(deletingId).add(device.id);
    try {
      await deleteDevice(device.id);
      clearSyncedFormDraft(`device:${device.id}`);
      await reloadDevices();
    } finally {
      const next = new Set(deletingId);
      next.delete(device.id);
      deletingId = next;
    }
  }

  async function toggleEnabled(device: DeviceRecord): Promise<void> {
    const enabled = !device.enabled;
    const impact = enabled ? undefined : await fetchDeviceDisableImpact(device.id);
    const consequence = impact ? ` ${impact.queuedJobCount} queued jobs may be affected. ${impact.runningJobCount} running jobs will not be cancelled.` : ' It can receive new jobs.';
    if (!(await confirmDialog(`${enabled ? 'Enable' : 'Disable'} ${device.name}?${consequence}`, { confirmLabel: enabled ? 'Enable device' : 'Disable device' }))) return;
    await updateDevice(device.id, { enabled });
    await reloadDevices();
  }

  async function startDrain(device: DeviceRecord): Promise<void> {
    const impact = await fetchDeviceDisableImpact(device.id);
    if (!(await confirmDialog(`Drain ${device.name}? It will stop receiving new jobs now and disable after ${impact.runningJobCount} running jobs finish. ${impact.queuedJobCount} queued jobs may be affected.`, { confirmLabel: 'Drain device' }))) return;
    await drainDevice(device.id);
    await reloadDevices();
  }

  async function makePrimary(device: DeviceRecord): Promise<void> {
    if (!(await confirmDialog(`Make ${device.name} the primary device? This changes the default device used for eligible jobs.`, { confirmLabel: 'Make primary' }))) return;
    await updateDevice(device.id, { isPrimary: true });
    await reloadDevices();
  }

  function connectionLabel(device: DeviceRecord): string {
    if (device.udid) return `${device.transport === 'usb' ? 'USB' : 'Wi-Fi pairing'} · ${device.udid}`;
    if (device.host) return `${device.user}@${device.host}:${device.port}`;
    return 'Legacy connection · finish setup to migrate';
  }
</script>

{#if canViewMaintenance}
  <Card title="Maintenance mode" class="mb-4">
    <div class="flex items-center justify-between gap-3">
      <div class="min-w-0">
        <div class="text-sm">Pause decrypts &amp; API</div>
        <div class="text-xs text-muted">Manual mode pauses decrypt requests. Automatic recovery only pauses work that needs the unavailable device; server-side App Store decrypts can continue.</div>
      </div>
      <Switch checked={maintenanceSettings?.maintenanceMode ?? false} disabled={!canManageMaintenance || !maintenanceSettings || togglingMaintenance} onCheckedChange={() => void toggleMaintenance()} aria-label="Maintenance mode" />
    </div>
    {#if maintenanceStatus?.auto && !maintenanceSettings?.maintenanceMode}<div class="text-warn mt-2 text-xs">Auto-engaged: {maintenanceStatus.reason}.</div>{/if}
  </Card>
{/if}

<Card title="Devices">
  {#snippet headerExtra()}
    <div class="flex items-center gap-1.5">
      <div class="inline-flex rounded-md border border-border/70 p-0.5" role="group" aria-label={msg('viewMode.label')}>
        <Button variant={homeViewModesState.value.devices === 'list' ? 'secondary' : 'ghost'} size="icon" class="h-7 w-7" aria-label={msg('viewMode.list')} aria-pressed={homeViewModesState.value.devices === 'list'} onclick={() => void pushHomeViewMode('devices', 'list')}><List class="h-3.5 w-3.5" /></Button>
        <Button variant={homeViewModesState.value.devices === 'cards' ? 'secondary' : 'ghost'} size="icon" class="h-7 w-7" aria-label={msg('viewMode.cards')} aria-pressed={homeViewModesState.value.devices === 'cards'} onclick={() => void pushHomeViewMode('devices', 'cards')}><Grid2X2 class="h-3.5 w-3.5" /></Button>
      </div>
      {#if canManageDevices}<Button size="sm" onclick={() => void openDiscovery()}><Search class="h-3.5 w-3.5" />Find a device</Button>{/if}
    </div>
  {/snippet}
  <div class="mb-4 max-w-3xl text-sm text-muted">Connect a jailbroken iPhone or iPad over USB or Wi-Fi. dkrypt discovers it, verifies the connection, checks every prerequisite, and adds it to the pool with a clear readiness summary.</div>
  {#if canManageDevices && setupOperation && setupOperation.status !== 'complete'}
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-panel-muted p-3 text-sm" role="status">
      <div><span class="font-medium">Device setup: {setupOperation.status}</span><div class="text-xs text-muted">{setupOperation.stages.at(-1)?.label ?? 'Waiting to connect'}</div></div>
      <Button size="sm" variant="secondary" onclick={() => (setupOpen = true)}>{setupOperation.status === 'interrupted' || setupOperation.status === 'failed' ? 'Continue setup' : 'View progress'}</Button>
    </div>
  {/if}
  {#if devices.length > 1}
    <Button size="sm" variant="secondary" class="mb-3" aria-expanded={comparingDevices} onclick={() => (comparingDevices = !comparingDevices)}>{comparingDevices ? 'Close comparison' : 'Compare devices'}</Button>
    {#if comparingDevices}<DeviceComparison {devices} {health} />{/if}
  {/if}
  {#if devices.length === 0}
    <EmptyState icon={Smartphone} message="No devices connected yet." />
  {:else}
    <div class={homeViewModesState.value.devices === 'cards' ? 'grid gap-3 xl:grid-cols-2' : 'grid grid-cols-1 gap-2'}>
      {#each devices as device (device.id)}
        {@const h = health[device.id]}
        {@const chain = connectionChain(device, h)}
        {@const failingStage = chain.find((stage) => stage.status === 'offline' || stage.status === 'degraded')}
        {@const model = getAppleDeviceModelName(device.productType, device.name)}
        <div id={`device-${encodeURIComponent(device.id)}`} tabindex="-1" class="density-row border-border/80 bg-background/30 min-w-0 scroll-mt-4 rounded-xl border p-4">
          <div class="flex items-start gap-3">
            <DeviceArtwork productType={device.productType} name={device.name} />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-1.5"><span class="truncate text-sm font-semibold" data-sensitive="true">{device.name}</span>{#if device.isPrimary}<Badge variant="default"><Star class="mr-1 h-3 w-3" />primary</Badge>{/if}<Badge variant="secondary">{device.transport === 'usb' ? 'USB' : 'Wi-Fi'}</Badge>{#if h}<Badge variant={h.reachable ? 'success' : 'destructive'}>{h.reachable ? 'online' : 'offline'}</Badge>{/if}{#if h?.readiness}<Badge variant={h.readiness.state === 'ready' ? 'success' : h.readiness.state === 'caution' ? 'secondary' : 'destructive'}>{h.readiness.score}/100 ready</Badge>{/if}</div>
              <div class="mt-1 text-xs font-medium text-foreground/80">{model ?? 'Apple device'}{device.productType && model !== device.productType ? ` · ${device.productType}` : ''}</div>
              <div class="mt-1 truncate font-mono text-[11px] text-muted" data-sensitive="true">{connectionLabel(device)}</div>
            </div>
            {#if canManageDevices}<Button size="icon" variant="ghost" class="h-8 w-8 shrink-0" onclick={() => openEdit(device)} aria-label={`Edit ${device.name}`} title="Edit device"><Pencil class="h-3.5 w-3.5" /></Button>{/if}
          </div>
          <div class="mt-3 grid grid-cols-2 gap-2 text-xs"><div class="bg-muted/30 rounded-lg px-2.5 py-2"><div class="text-muted">iOS</div><div class="mt-0.5 truncate font-medium">{device.iosVersion ?? 'Not reported'}</div></div><div class="bg-muted/30 rounded-lg px-2.5 py-2"><div class="text-muted">Bridge</div><div class="mt-0.5 truncate font-medium">{h?.bridgeHeartbeats?.springboard?.bridgeVersion ?? 'Not checked'}</div></div></div>
          <div class="mt-3" aria-label="Device connection chain">
            <div class="mb-1.5 text-[11px] font-medium text-muted">Connection path</div>
            <ol class="flex flex-wrap items-center gap-1 text-[10px]">
              {#each chain as stage, index (stage.label)}
                {#if index > 0}<li aria-hidden="true" class="text-muted">→</li>{/if}
                <li title={stage.reason ?? stage.status} class="rounded-md border border-border px-1.5 py-1" class:border-err={stage.status === 'offline'} class:border-warn={stage.status === 'degraded'}>{stage.label} · {statusLabel(stage.status, stage.label === 'App Store' || stage.label === 'TestFlight')}</li>
              {/each}
            </ol>
            {#if failingStage}<p class="mt-1.5 text-xs text-warn">{failingStage.label} needs attention{failingStage.reason ? `: ${failingStage.reason}` : '.'}</p>{/if}
          </div>
          {#if h?.subsystems}
            <div class="mt-3 rounded-lg border border-border/70 p-2.5" aria-label="Device subsystem status">
              <div class="flex flex-wrap gap-1.5">
                {#each Object.entries(h.subsystems) as [name, status]}
                  {@const subsystem = name as DeviceSubsystemId}
                  {@const state = status as DeviceSubsystemState}
                  {@const detail = h.subsystemDetails?.[subsystem]}
                  <div class="min-w-[9rem] flex-1 rounded-md bg-muted/20 px-2 py-1">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <span class="text-[11px] font-medium">{msg(subsystemNames[subsystem])}</span>
                      <Badge variant={subsystemVariant(state)} class="px-1.5 py-0 text-[9px]">{statusLabel(state, subsystem === 'appStore' || subsystem === 'testFlight')}</Badge>
                    </div>
                    {#if detail?.reason}<p class="mt-0.5 break-words text-[10px] leading-4 text-muted">{detail.reason}</p>{/if}
                    {#if detail?.lastChangedAt}<p class="mt-0.5 text-[9px] text-muted">{msg('device.lastChanged')} <RelativeTime ms={detail.lastChangedAt} /></p>{/if}
                  </div>
                {/each}
              </div>
              <details class="mt-3 border-t border-border/70 pt-2">
                <summary class="cursor-pointer text-xs text-muted">{msg('device.rawDiagnostics')}</summary>
                <pre class="mt-2 max-h-64 overflow-auto rounded-md bg-muted/30 p-2 text-[10px] whitespace-pre-wrap">{JSON.stringify({ error: h.error, readiness: h.readiness, subsystemDetails: h.subsystemDetails, bridgeHeartbeats: h.bridgeHeartbeats }, null, 2)}</pre>
              </details>
              <details class="mt-2 border-t border-border/70 pt-2">
                <summary class="cursor-pointer text-xs text-muted">{msg('device.statusDefinitions')}</summary>
                <dl class="mt-2 grid gap-x-4 gap-y-1 text-[10px] leading-4 text-muted sm:grid-cols-2">
                  <div><dt class="inline font-medium text-text">{msg('device.state.ready')}:</dt> <dd class="inline">{msg('device.definition.ready')}</dd></div>
                  <div><dt class="inline font-medium text-text">{msg('device.state.idle')}:</dt> <dd class="inline">{msg('device.definition.idle')}</dd></div>
                  <div><dt class="inline font-medium text-text">{msg('device.state.degraded')}:</dt> <dd class="inline">{msg('device.definition.degraded')}</dd></div>
                  <div><dt class="inline font-medium text-text">{msg('device.state.offline')}:</dt> <dd class="inline">{msg('device.definition.offline')}</dd></div>
                  <div><dt class="inline font-medium text-text">{msg('device.state.unsupported')}:</dt> <dd class="inline">{msg('device.definition.unsupported')}</dd></div>
                  <div><dt class="inline font-medium text-text">{msg('device.state.unknown')}:</dt> <dd class="inline">{msg('device.definition.unknown')}</dd></div>
                </dl>
              </details>
            </div>
          {/if}
          {#if h?.readiness?.reasons.length}<div class="text-warn mt-2 text-xs">{h.readiness.reasons.join(' · ')}</div>{/if}
          <div class="border-border/70 mt-3 flex flex-wrap items-center gap-1.5 border-t pt-3"><Button size="sm" variant="secondary" loading={testingId.has(device.id)} onclick={() => void testConnection(device)}>Test connection</Button><AdvancedSection label="settings.deviceTools"><div class="flex flex-wrap items-center gap-1.5"><Button size="sm" variant="secondary" loading={inspectingId.has(device.id)} onclick={() => void inspectDevice(device)}>Preflight</Button><Button size="sm" variant="secondary" loading={inspectingId.has(device.id)} onclick={() => void inspectInventory(device)}>Inventory</Button>{#if canManageDevices}<Button size="sm" variant="secondary" loading={recoveringId.has(device.id)} onclick={() => void recover(device)}>Recover</Button>{/if}</div></AdvancedSection>{#if canManageDevices}{#if !device.isPrimary}<Button size="sm" variant="ghost" onclick={() => void makePrimary(device)}>Make primary</Button>{/if}{#if device.enabled && !device.draining}<Button size="sm" variant="ghost" onclick={() => void startDrain(device)}>Drain</Button>{/if}<Button size="sm" variant="ghost" onclick={() => void toggleEnabled(device)}>{device.enabled ? 'Disable' : 'Enable'}</Button><Button size="icon" variant="ghost" class="ml-auto h-8 w-8 text-muted hover:text-err" loading={deletingId.has(device.id)} onclick={() => void remove(device)} aria-label={`Remove ${device.name}`} title="Remove device"><Trash2 class="h-3.5 w-3.5" /></Button>{/if}</div>
          {#if device.draining}<div class="mt-2 text-xs text-warn">Draining: no new jobs will start on this device.</div>{/if}
          <AuditRibbon target={device.id} />
          {#if device.isPrimary && h?.reachable && h.darkEnabled !== undefined}<div class="border-border/70 mt-3 flex items-center justify-between gap-3 border-t pt-3"><div class="min-w-0"><div class="text-sm">Keep display dark</div><div class="text-xs text-muted">autoinstall keeps the device awake while the display is blacked out.</div></div><Switch checked={h.darkEnabled} disabled={!canManageDevices || updatingDarkModeId.has(device.id)} onCheckedChange={(enabled) => void toggleDarkMode(device, enabled)} aria-label="Keep display dark" /></div>{/if}
          {#if recoveryReceipts[device.id]?.[0]}
            {@const recovery = recoveryReceipts[device.id][0]}
            <div class="border-border/70 mt-3 rounded-lg border-t pt-3"><div class="flex flex-wrap items-center gap-2"><span class="text-xs font-medium">SpringBoard recovery receipt</span><Badge variant={recovery.status === 'complete' ? 'success' : recovery.status === 'failed' || recovery.status === 'interrupted' ? 'destructive' : 'secondary'}>{recovery.status}</Badge><span class="text-[10px] text-muted"><RelativeTime ms={recovery.updatedAt} /></span></div><p class="mt-1 text-xs text-muted">{recovery.stage}. Command exit: {recovery.commandExitCode ?? 'pending'} · Device: {recovery.reachable ? 'reachable' : recovery.reachable === false ? 'unreachable' : 'checking'} · Agent: {recovery.agentReady ? 'ready' : recovery.agentReady === false ? 'not ready' : 'checking'} · SpringBoard: {recovery.springboardReady ? 'ready' : recovery.springboardReady === false ? 'not ready' : 'checking'}</p>{#if recovery.error}<p class="mt-1 break-words text-xs text-err">{recovery.error}</p>{/if}<div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">{#each recovery.stages as stage (stage.at)}<span>{stage.label} · <RelativeTime ms={stage.at} /></span>{/each}</div></div>
          {/if}
          {#if activity[device.id]?.length}
            <div class="border-border/70 mt-3 border-t pt-3">
              <div class="mb-1.5 flex items-center justify-between gap-2 text-xs"><span class="text-muted">Recent activity</span>{#if activityNextCursor[device.id]}<Button size="sm" variant="link" class="h-auto p-0 text-xs" loading={loadingActivity.has(device.id)} onclick={() => void loadMoreActivity(device.id)}>Load older ({Math.max(0, activityTotals[device.id] - activity[device.id].length)})</Button>{/if}</div>
              <VirtualizedList
                items={activity[device.id]}
                itemKey={(entry) => entry.id}
                estimateSize={36}
                overscan={3}
                label={`${device.name} activity`}
                class="overflow-y-auto rounded-md"
                style={`height:min(8rem, ${Math.max(36, Math.min(activity[device.id].length * 36, 128))}px)`}
              >
                {#snippet children(entry: DeviceActivityEntry)}
                  <div class="flex items-start gap-2 py-1.5 text-xs"><span class="shrink-0 text-muted"><RelativeTime ms={entry.ts} /></span><span>{entry.message}{entry.bundleId ? ` · ${entry.bundleId}` : ''}</span></div>
                {/snippet}
              </VirtualizedList>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</Card>

{#if canManageDevices}
  <Dialog open={discoveryOpen} onOpenChange={(value) => (discoveryOpen = value)} class="max-w-2xl">
    <div class="mb-1 flex items-center justify-between gap-3"><div class="text-sm font-semibold">Find a device</div><Button size="icon" variant="ghost" class="h-8 w-8" loading={discoveryLoading} onclick={() => void openDiscovery(setupExistingId)} aria-label="Scan again" title="Scan again"><RefreshCw class="h-3.5 w-3.5" /></Button></div>
    <div class="mb-4 text-xs text-muted">Connect the device by USB for first-time setup. Paired Wi-Fi devices are discovered automatically afterward.</div>
    {#if discoveryError}<div class="border-err/40 bg-err/10 text-err mb-3 rounded-lg border px-3 py-2 text-sm">{discoveryError}</div>{/if}
    {#if discovery?.warnings.length}<div class="border-warn/40 bg-warn/10 text-warn mb-3 rounded-lg border px-3 py-2 text-xs">{discovery.warnings.join(' · ')}</div>{/if}
    {#if discoveryLoading}<div class="flex items-center justify-center gap-2 py-10 text-sm text-muted"><RefreshCw class="h-4 w-4 animate-spin" />Scanning for USB and paired Wi-Fi devices…</div>{:else if discovery?.devices.length}<div class="flex max-h-80 flex-col gap-2 overflow-auto">{#each discovery.devices as candidate (candidate.discoveryId)}<div class="border-border flex items-center gap-3 rounded-lg border p-3"><div class="bg-muted/40 flex h-8 w-8 shrink-0 items-center justify-center rounded-md">{#if candidate.transport === 'usb'}<Usb class="h-4 w-4" />{:else}<Wifi class="h-4 w-4" />{/if}</div><div class="min-w-0 flex-1"><div class="truncate text-sm font-medium">{candidate.name}</div><div class="truncate font-mono text-[11px] text-muted">{candidate.host ? `${candidate.user}@${candidate.host}:${candidate.port}` : candidate.udid}</div>{#if candidate.productType || candidate.productVersion}<div class="mt-0.5 text-[11px] text-muted">{candidate.productType ?? 'iDevice'}{candidate.productVersion ? ` · iOS ${candidate.productVersion}` : ''}</div>{/if}</div><Badge variant="secondary">{candidate.transport === 'usb' ? 'USB' : 'Wi-Fi'}</Badge><Button size="sm" onclick={() => prepareSetup(candidate)}>Set up</Button></div>{/each}</div>{:else}<EmptyState icon={Search} message="No devices found. Connect the device by USB for first-time setup; paired Wi-Fi devices appear automatically." />{/if}
  </Dialog>

  <Dialog open={setupOpen} onOpenChange={(value) => (setupOpen = value)} class="max-w-xl">
    <div class="mb-1 text-sm font-semibold">Set up {setupName || 'device'}</div><div class="mb-4 text-xs text-muted">dkrypt is connecting, identifying the device, preparing decrypt access, and checking decrypt prerequisites.</div>
    {#if setupError}<div class="border-err/40 bg-err/10 text-err mb-3 rounded-lg border px-3 py-2 text-sm">{setupError}</div>{/if}
    {#if setupOperation?.stages.length}<ol class="mb-3 space-y-2" aria-label="Device setup progress">{#each setupOperation.stages as stage (stage.at)}<li class="flex items-center gap-2 text-xs"><span class={stage.status === 'failed' ? 'text-err' : stage.status === 'complete' ? 'text-ok' : 'text-muted'}>{stage.status === 'complete' ? '✓' : stage.status === 'failed' ? '!' : '…'}</span><span>{stage.label}</span></li>{/each}</ol>{/if}
    {#if setupRunning}<div class="flex items-center justify-center gap-2 py-4 text-sm text-muted"><RefreshCw class="h-4 w-4 animate-spin" />{setupOperation?.stages.at(-1)?.label ?? 'Preparing device setup…'}</div><Button class="w-full" variant="secondary" onclick={() => (setupOpen = false)}>Continue in background</Button>{/if}
    {#if setupResult}<div class="mb-3 flex items-center gap-2 text-sm font-medium">{#if setupResult.ready}<CheckCircle2 class="text-ok h-4 w-4" />Device is ready for decrypts{:else}<AlertTriangle class="text-warn h-4 w-4" />Device connected with attention needed{/if}</div><div class="flex flex-col gap-2">{#each setupResult.steps as step (step.id)}<div class="border-border flex items-start gap-3 rounded-lg border p-3"><div class="mt-0.5">{#if step.status === 'ready'}<CheckCircle2 class="text-ok h-4 w-4" />{:else if step.status === 'attention'}<AlertTriangle class="text-warn h-4 w-4" />{:else}<CircleX class="text-err h-4 w-4" />{/if}</div><div class="min-w-0 flex-1"><div class="text-sm">{step.label}</div>{#if step.detail}<div class="mt-0.5 text-xs text-muted">{step.detail}</div>{/if}</div><Badge variant={step.status === 'ready' ? 'success' : step.status === 'attention' ? 'secondary' : 'destructive'}>{step.status === 'ready' ? 'ready' : step.status}</Badge></div>{/each}</div>{#if !setupResult.ready}<div class="border-warn/40 bg-warn/10 text-warn mt-3 rounded-lg border px-3 py-2 text-xs">The device is saved so you can fix the listed prerequisite and run setup again. No connection directory or CLI command is required.</div>{/if}<Button class="mt-4 w-full" onclick={() => (setupOpen = false)}>Done</Button>{:else if !setupRunning}<div class="mt-4 flex gap-2"><Button variant="secondary" class="flex-1" onclick={() => (setupOpen = false)}>Close</Button><Button class="flex-1" onclick={retrySetup}>Try again</Button></div>{/if}
  </Dialog>

  <Dialog open={editOpen} onOpenChange={(value) => void setEditOpen(value)} class="max-w-md">
    <div class="mb-3 text-sm font-semibold">Edit device</div>
    {#if formError}<div class="mb-3 rounded-md border border-err/40 bg-err/10 p-2 text-xs text-err" role="alert">{formError}</div>{/if}
    <label for="d-name" class="mb-1 block text-xs text-muted">Name</label><Input id="d-name" placeholder="e.g. iPad Pro" bind:value={formName} aria-invalid={Boolean(formError)} />
    <label for="d-ios" class="mt-3 mb-1 block text-xs text-muted">iOS version</label><Input id="d-ios" placeholder="Detected automatically during setup" bind:value={formIosVersion} />
    <label for="d-toolchain" class="mt-3 mb-1 block text-xs text-muted">Jailbreak</label><Input id="d-toolchain" placeholder="e.g. Dopamine" bind:value={formToolchain} />
    <label for="d-notes" class="mt-3 mb-1 block text-xs text-muted">Notes</label><Input id="d-notes" placeholder="Optional compatibility notes" bind:value={formNotes} />
    {#if conflictDevice}
      <section class="mt-4 rounded-lg border border-warn/50 bg-warn/5 p-3 text-xs" aria-label="Device edit conflict">
        <h3 class="font-semibold">This device changed while you were editing</h3>
        <p class="mt-1 text-muted">Review your values against the latest saved version. Nothing has been overwritten.</p>
        <div class="mt-2 grid grid-cols-[minmax(4rem,5rem)_repeat(2,minmax(0,1fr))] gap-2 break-words">
          <span></span><span class="font-medium">Your edits</span><span class="font-medium">Saved now</span>
          <span>Name</span><span>{formName}</span><span>{conflictDevice.name}</span>
          <span>iOS</span><span>{formIosVersion || '—'}</span><span>{conflictDevice.iosVersion || '—'}</span>
          <span>Jailbreak</span><span>{formToolchain || '—'}</span><span>{conflictDevice.toolchain || '—'}</span>
          <span>Notes</span><span>{formNotes || '—'}</span><span>{conflictDevice.notes || '—'}</span>
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onclick={reloadConflictedDevice}>Reload saved version</Button>
          <Button size="sm" variant="secondary" onclick={() => (conflictDevice = null)}>Keep editing</Button>
          <Button size="sm" loading={saving} onclick={() => void applyEditsToLatest()}>Apply my edits to latest</Button>
        </div>
      </section>
    {/if}
    <Button class="mt-4 w-full" loading={saving} onclick={() => void save()}>Save changes</Button>
  </Dialog>
{/if}

<Dialog open={preflightOpen} onOpenChange={(value) => (preflightOpen = value)} class="max-w-lg">
  <div class="mb-1 text-sm font-medium">Device preflight</div>{#if preflight}<div class="mb-3 text-xs text-muted">{preflight.device.name} · {preflight.ready ? 'ready for decrypts' : 'needs attention'}</div><div class="flex flex-col gap-2">{#each preflight.checks as check (check.label)}<div class="border-border flex items-start justify-between gap-3 rounded-lg border p-2.5 text-sm"><div><div>{check.label}</div>{#if check.detail}<div class="mt-0.5 text-xs text-muted">{check.detail}</div>{/if}</div><Badge variant={check.ok ? 'success' : 'destructive'}>{check.ok ? 'ready' : 'attention'}</Badge></div>{/each}</div>{#if preflight.bridge?.bridge.bridgeVersion}<div class="mt-3 text-xs text-muted">autoinstall {preflight.bridge.bridge.bridgeVersion} · {(preflight.bridge.bridge.capabilities ?? []).join(', ') || 'no capabilities reported'}</div>{/if}{/if}
</Dialog>

<Dialog open={inventoryOpen} onOpenChange={(value) => (inventoryOpen = value)} class="max-w-lg">
  <div class="mb-1 text-sm font-medium">Installed App Store inventory</div><div class="mb-3 text-xs text-muted">Encrypted App Store bundles currently present on the device.</div>{#if inventory?.bundles.length}<div class="max-h-96 overflow-auto rounded-lg border border-border">{#each inventory.bundles as bundle (bundle)}<div class="border-border border-b px-3 py-2 font-mono text-xs last:border-b-0">{bundle}</div>{/each}</div>{:else}<div class="text-sm text-muted">No encrypted App Store bundles found.</div>{/if}
</Dialog>
