<script lang="ts">
  import { Link2, ShieldCheck } from 'lucide-svelte';
  import { fetchTestFlightSubscriptions, submitTestFlightSubscription, type TestFlightSubscription, type TestFlightSubscriptionDeviceStatus } from '#lib/api';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import { appDisplayName, ensureAppCatalog } from '#lib/appCatalog.svelte';
  import { loadTestFlightCatalog } from '#lib/testflightCatalog.svelte';
  import { showToast } from '#lib/ui.svelte';

  interface Props {
    open: boolean;
    initialInviteUrl?: string;
    onOpenChange: (open: boolean) => void;
  }

  let { open, initialInviteUrl, onOpenChange }: Props = $props();
  let inviteUrl = $state('');
  let subscriptions = $state<TestFlightSubscription[]>([]);
  let nextCursor = $state<string | undefined>(undefined);
  let total = $state(0);
  let loadingMore = $state(false);
  let loading = $state(false);
  let submitting = $state(false);
  let lastInitialInviteUrl = '';

  $effect(() => {
    if (!open || !initialInviteUrl || initialInviteUrl === lastInitialInviteUrl) return;
    inviteUrl = initialInviteUrl;
    lastInitialInviteUrl = initialInviteUrl;
  });

  $effect(() => {
    if (open) void ensureAppCatalog(subscriptions.flatMap((subscription) => subscription.bundleId ? [subscription.bundleId] : []));
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
    try {
      const result = await fetchTestFlightSubscriptions();
      subscriptions = result.subscriptions;
      total = result.total;
      nextCursor = result.nextCursor;
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

  $effect(() => {
    if (open) void load();
  });

  async function submit(): Promise<void> {
    const url = inviteUrl.trim();
    if (!url) return;
    submitting = true;
    try {
      const result = await submitTestFlightSubscription(url);
      if (!result.ok) return;
      inviteUrl = '';
      showToast('TestFlight link submitted', 'success');
      void loadTestFlightCatalog(true);
      await load();
    } finally {
      submitting = false;
    }
  }
</script>

<Dialog {open} {onOpenChange} class="max-w-lg">
  <div class="mb-1 flex items-center gap-2 text-sm font-medium"><ShieldCheck class="h-4 w-4 text-accent" /> Add TestFlight access</div>
  <div class="mb-4 text-xs text-muted">Paste a public TestFlight link. Your request is checked against the connected devices and only needs approval when your account does not manage subscriptions.</div>
  <form class="flex flex-col gap-2 sm:flex-row" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
    <div class="relative min-w-0 flex-1">
      <Link2 class="text-muted pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
      <Input bind:value={inviteUrl} class="pl-9" placeholder="https://testflight.apple.com/join/ABC123" aria-label="TestFlight public link" />
    </div>
    <Button type="submit" loading={submitting} disabled={!inviteUrl.trim()}>Submit link</Button>
  </form>

  <div class="mt-6 border-t border-border pt-4">
    <div class="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted">Your requests</div>
    {#if loading}
      <div class="py-3 text-sm text-muted">Checking TestFlight requests…</div>
    {:else if subscriptions.length === 0}
      <div class="py-3 text-sm text-muted">No requests yet.</div>
    {:else}
      <div class="flex flex-col gap-2">
        {#each subscriptions as subscription (subscription.id)}
          <div class="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
            {#if subscription.iconUrl}
              <img src={subscription.iconUrl} alt="" class="h-8 w-8 shrink-0 rounded-lg" />
            {:else}
              <div class="bg-secondary text-muted flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"><ShieldCheck class="h-4 w-4" /></div>
            {/if}
            <div class="min-w-0 flex-1">
              <div class="truncate text-xs font-medium">{subscription.bundleId ? appDisplayName(subscription.bundleId, subscription.bundleId) : subscription.url}</div>
              <div class="truncate text-[11px] text-muted">{subscription.bundleId ?? subscription.url}</div>
            </div>
            <Badge variant={statusVariant(subscription.status)}>{statusLabel(subscription.status)}</Badge>
          </div>
          {#if subscription.devices.some((device) => device.lastError)}
            <div class="-mt-1 px-3 text-[11px] text-warn">{subscription.devices.find((device) => device.lastError)?.lastError}</div>
          {/if}
        {/each}
      </div>
      {#if nextCursor}
        <div class="mt-3 flex justify-center">
          <Button size="sm" variant="secondary" loading={loadingMore} onclick={() => void loadMore()}>Load more ({Math.max(0, total - subscriptions.length)} older)</Button>
        </div>
      {/if}
    {/if}
  </div>
</Dialog>
