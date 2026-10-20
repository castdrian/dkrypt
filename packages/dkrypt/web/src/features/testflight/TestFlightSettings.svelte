<script lang="ts">
  import { Check, LockKeyhole, RefreshCw, ShieldCheck, UserRound, X } from 'lucide-svelte';
  import { onMount } from 'svelte';
  import {
    approveTestFlightSubscription,
    denyTestFlightSubscription,
    fetchDevices,
    fetchTestFlightSubscriptions,
    syncTestFlightSubscription,
    unsubscribeTestFlightCatalogApp,
    unsubscribeTestFlightSubscription,
    type DeviceRecord,
    type TestFlightCatalogApp,
    type TestFlightSubscription,
    type TestFlightSubscriptionDeviceStatus,
  } from '#lib/api';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasAnyPermission, sessionHasPermission } from '#lib/session.svelte';
  import { loadTestFlightCatalog, testFlightCatalogState } from '#lib/testflightCatalog.svelte';
  import { confirmDialog, showToast } from '#lib/ui.svelte';

  const canManage = $derived(sessionHasPermission(PermissionFlag.manageTestFlightSubscriptions));
  const canViewDevices = $derived(sessionHasAnyPermission([PermissionFlag.viewDevices, PermissionFlag.manageDevices]));
  let subscriptions = $state<TestFlightSubscription[]>([]);
  let devices = $state<DeviceRecord[]>([]);
  let loading = $state(true);
  let loadingMore = $state(false);
  let nextCursor = $state<string | undefined>(undefined);
  let total = $state(0);
  let busyId = $state<string | null>(null);
  let busyBundleId = $state<string | null>(null);

  const deviceNames = $derived(new Map(devices.map((device) => [device.id, device.name])));

  interface UnifiedTestFlightEntry {
    key: string;
    app?: TestFlightCatalogApp;
    subscription?: TestFlightSubscription;
  }

  const unifiedEntries = $derived.by(() => {
    const entries = new Map<string, UnifiedTestFlightEntry>();
    for (const app of testFlightCatalogState.apps) entries.set(`app:${app.bundleId}`, { key: `app:${app.bundleId}`, app });
    for (const subscription of subscriptions) {
      const appEntry = subscription.bundleId ? entries.get(`app:${subscription.bundleId}`) : undefined;
      if (appEntry && subscription.status === 'approved' && !appEntry.subscription) {
        appEntry.subscription = subscription;
        continue;
      }
      const key = `subscription:${subscription.id}`;
      entries.set(key, { key, subscription });
    }
    return [...entries.values()].sort((a, b) => (a.app?.displayName ?? a.subscription?.displayName ?? a.subscription?.url ?? '').localeCompare(b.app?.displayName ?? b.subscription?.displayName ?? b.subscription?.url ?? ''));
  });

  function statusLabel(status: TestFlightSubscriptionDeviceStatus | TestFlightSubscription['status']): string {
    return status === 'active' ? 'Verified' : status === 'syncing' ? 'Syncing' : status === 'unavailable' ? 'Unavailable' : status === 'unsupported' ? 'Unsupported' : status === 'error' ? 'Error' : status === 'approved' ? 'Approved' : status === 'denied' ? 'Denied' : status === 'withdrawn' ? 'Withdrawn' : 'Pending';
  }

  function statusVariant(status: TestFlightSubscriptionDeviceStatus | TestFlightSubscription['status']): 'success' | 'warning' | 'destructive' | 'secondary' | 'default' {
    if (status === 'active' || status === 'approved') return 'success';
    if (status === 'syncing' || status === 'pending') return 'default';
    if (status === 'unavailable' || status === 'unsupported') return 'warning';
    if (status === 'error' || status === 'denied') return 'destructive';
    return 'secondary';
  }

  async function load(): Promise<void> {
    loading = true;
    void loadTestFlightCatalog();
    try {
      const [subscriptionData, deviceData] = await Promise.all([
        fetchTestFlightSubscriptions(),
        canViewDevices ? fetchDevices() : Promise.resolve({ devices: [] as DeviceRecord[] }),
      ]);
      subscriptions = subscriptionData.subscriptions;
      total = subscriptionData.total;
      nextCursor = subscriptionData.nextCursor;
      devices = deviceData.devices;
    } catch {
      subscriptions = [];
    } finally {
      loading = false;
    }
  }

  async function loadMore(): Promise<void> {
    if (loadingMore || !nextCursor) return;
    loadingMore = true;
    try {
      const result = await fetchTestFlightSubscriptions(nextCursor);
      subscriptions = [...subscriptions, ...result.subscriptions];
      total = result.total;
      nextCursor = result.nextCursor;
    } finally {
      loadingMore = false;
    }
  }

  onMount(() => {
    void load();
  });

  async function decide(subscription: TestFlightSubscription, action: 'approve' | 'deny'): Promise<void> {
    busyId = subscription.id;
    try {
      const result = action === 'approve' ? await approveTestFlightSubscription(subscription.id) : await denyTestFlightSubscription(subscription.id);
      if (result.ok) {
        await loadTestFlightCatalog(true);
        await load();
      }
    } finally {
      busyId = null;
    }
  }

  async function sync(subscription: TestFlightSubscription): Promise<void> {
    busyId = subscription.id;
    try {
      const result = await syncTestFlightSubscription(subscription.id);
      if (result.ok) {
        showToast('Device verification started', 'success');
        await loadTestFlightCatalog(true);
        await load();
      }
    } finally {
      busyId = null;
    }
  }

  async function unsubscribe(subscription: TestFlightSubscription): Promise<void> {
    if (!(await confirmDialog(`Stop dkrypt automation for ${subscription.displayName ?? subscription.url}? The app will be removed from enabled devices where possible.`, { confirmLabel: 'Unsubscribe', variant: 'destructive' }))) return;
    busyId = subscription.id;
    try {
      const result = await unsubscribeTestFlightSubscription(subscription.id);
      if (result.ok) {
        showToast('TestFlight subscription removed', 'success');
        await loadTestFlightCatalog(true);
        await load();
      }
    } finally {
      busyId = null;
    }
  }

  async function unsubscribeDeviceApp(app: TestFlightCatalogApp): Promise<void> {
    if (!(await confirmDialog(`Remove ${app.displayName} from the connected devices? TestFlight membership itself may remain active with Apple.`, { confirmLabel: 'Remove from devices', variant: 'destructive' }))) return;
    busyBundleId = app.bundleId;
    try {
      const result = await unsubscribeTestFlightCatalogApp(app.bundleId);
      if (result.ok) {
        showToast(result.data.failures.length > 0 ? 'Removed with device warnings' : 'Removed from connected devices', result.data.failures.length > 0 ? 'error' : 'success');
        await loadTestFlightCatalog(true);
        await load();
      }
    } finally {
      busyBundleId = null;
    }
  }
</script>

<div class="flex flex-col gap-4">
  <Card title="TestFlight">
    <div class="mb-4 max-w-2xl text-sm text-muted">
      Requests and device access are managed together. The available apps below come from TestFlight on your enabled devices.
    </div>
    {#if loading && unifiedEntries.length === 0 && testFlightCatalogState.apps.length === 0}
      <div class="text-sm text-muted">Loading TestFlight…</div>
    {:else if unifiedEntries.length === 0}
      <div class="text-sm text-muted">No TestFlight apps or requests yet.</div>
    {:else}
      <div class="divide-border/70 divide-y">
        {#each unifiedEntries as entry (entry.key)}
          {@const app = entry.app}
          {@const subscription = entry.subscription}
          {@const bundleId = app?.bundleId ?? subscription?.bundleId}
          {@const protectedAccess = bundleId === 'com.hammerandchisel.discord'}
          {@const displayName = app?.displayName ?? subscription?.displayName ?? subscription?.url ?? 'TestFlight app'}
          <div class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="flex min-w-0 items-start gap-3">
                {#if app?.iconUrl ?? subscription?.iconUrl}
                  <img src={app?.iconUrl ?? subscription?.iconUrl} alt="" class="h-10 w-10 rounded-xl border border-border/70 object-cover" />
                {:else}
                  <div class="bg-secondary text-muted flex h-10 w-10 items-center justify-center rounded-xl"><ShieldCheck class="h-5 w-5" /></div>
                {/if}
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="truncate text-sm font-medium">{displayName}</span>
                    {#if protectedAccess}
                      <Badge variant="secondary"><LockKeyhole class="mr-1 h-3 w-3" /> Protected</Badge>
                    {:else if app}
                      <Badge variant="success">Available</Badge>
                    {:else if subscription}
                      <Badge variant={statusVariant(subscription.status)}>{statusLabel(subscription.status)}</Badge>
                    {/if}
                  </div>
                  <div class="mt-0.5 truncate text-xs text-muted">{bundleId ?? 'Waiting for app metadata'}</div>
                  {#if app}
                    <div class="mt-1 truncate text-[11px] text-muted">{app.devices.map((device) => device.name).join(', ')}</div>
                  {:else if subscription && canManage}
                    <div class="mt-1 flex items-center gap-1 text-[11px] text-muted"><UserRound class="h-3 w-3" /> {subscription.requestedByDisplayName ?? subscription.requestedBy}</div>
                  {/if}
                </div>
              </div>
              <div class="flex shrink-0 flex-wrap gap-2">
                {#if canManage && subscription && !protectedAccess && subscription.status === 'pending'}
                  <Button size="sm" loading={busyId === subscription.id} onclick={() => void decide(subscription, 'approve')}><Check class="h-3.5 w-3.5" /> Approve</Button>
                  <Button size="sm" variant="destructive" disabled={busyId === subscription.id} onclick={() => void decide(subscription, 'deny')}><X class="h-3.5 w-3.5" /> Deny</Button>
                {/if}
                {#if canManage && subscription && !protectedAccess && subscription.status === 'approved'}
                  <Button size="sm" variant="secondary" loading={busyId === subscription.id} onclick={() => void sync(subscription)}><RefreshCw class="h-3.5 w-3.5" /> Sync</Button>
                {/if}
                {#if !protectedAccess && subscription && subscription.status !== 'withdrawn' && subscription.status !== 'denied'}
                  <Button size="sm" variant="ghost" disabled={busyId === subscription.id} onclick={() => void unsubscribe(subscription)}>Unsubscribe</Button>
                {:else if !protectedAccess && app}
                  <Button size="sm" variant="ghost" loading={busyBundleId === app.bundleId} onclick={() => void unsubscribeDeviceApp(app)}>Remove from devices</Button>
                {/if}
              </div>
            </div>
            {#if subscription && subscription.devices.length > 0}
              <div class="flex flex-wrap gap-2">
                {#each subscription.devices as device (device.deviceId)}
                  <div class="bg-secondary/50 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs">
                    <span class="text-foreground" data-sensitive="true">{deviceNames.get(device.deviceId) ?? device.deviceId}</span>
                    <Badge variant={statusVariant(device.status)}>{statusLabel(device.status)}</Badge>
                  </div>
                {/each}
              </div>
            {/if}
            {#if subscription?.devices.some((device) => device.lastError)}
              <div class="text-xs text-warn">{subscription.devices.find((device) => device.lastError)?.lastError}</div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
    {#if nextCursor}
      <div class="mt-4 flex justify-center border-t border-border/70 pt-4">
        <Button size="sm" variant="secondary" loading={loadingMore} onclick={() => void loadMore()}>Load more ({Math.max(0, total - subscriptions.length)} older)</Button>
      </div>
    {/if}
    {#if testFlightCatalogState.loading && unifiedEntries.length === 0}
      <div class="mt-4 border-t border-border/70 pt-4 text-xs text-muted">Checking device access…</div>
    {:else if testFlightCatalogState.refreshing}
      <div class="mt-4 border-t border-border/70 pt-4 text-xs text-muted">Refreshing device access…</div>
    {/if}
  </Card>
</div>
