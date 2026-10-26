<script lang="ts">
  import { Popover } from 'bits-ui';
  import { Bell, CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-svelte';
  import { fetchNotifications, markNotificationsRead, type DashboardNotification } from '#lib/api';
  import { buttonVariants } from '#lib/components/ui/variants';
  import Button from '#lib/components/ui/Button.svelte';
  import { clearToastHistory, toastHistoryState } from '#lib/ui.svelte';
  import RelativeTime from '#components/RelativeTime.svelte';
  import VirtualizedList from '#components/VirtualizedList.svelte';
  import { cn } from '#lib/utils';

  const LAST_VIEWED_KEY = 'notificationsLastViewedAt';

  let open = $state(false);
  let notifications = $state<DashboardNotification[]>([]);
  let unread = $state(0);
  let nextCursor = $state<string | undefined>(undefined);
  let loadingOlder = $state(false);
  let loaded = $state(false);
  let lastViewedAt = $state(Number(localStorage.getItem(LAST_VIEWED_KEY) ?? 0));

  async function load(): Promise<void> {
    try {
      const result = await fetchNotifications();
      notifications = result.notifications;
      unread = result.unread;
      nextCursor = result.nextCursor;
      loaded = true;
    } catch {
      loaded = false;
    }
  }

  async function loadOlder(): Promise<void> {
    if (loadingOlder || !nextCursor) return;
    loadingOlder = true;
    try {
      const result = await fetchNotifications(50, nextCursor);
      notifications = [...notifications, ...result.notifications];
      nextCursor = result.nextCursor;
    } finally {
      loadingOlder = false;
    }
  }

  async function onOpenChange(value: boolean): Promise<void> {
    open = value;
    if (!value) return;
    lastViewedAt = Date.now();
    localStorage.setItem(LAST_VIEWED_KEY, String(lastViewedAt));
    await load();
    const unreadIds = notifications.filter((notification) => !notification.readAt).map((notification) => notification.id);
    if (unreadIds.length > 0) {
      await markNotificationsRead(unreadIds);
      notifications = notifications.map((notification) => unreadIds.includes(notification.id) ? { ...notification, readAt: Date.now() } : notification);
      unread = 0;
    }
  }

  $effect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  });

  const localItems = $derived(toastHistoryState.items);
  const unseenLocal = $derived(localItems.filter((item) => item.ts > lastViewedAt).length);
  const unseenCount = $derived(loaded && notifications.length > 0 ? unread : unseenLocal);

  function iconFor(severity: DashboardNotification['severity']): typeof CircleCheck {
    if (severity === 'error') return CircleX;
    if (severity === 'warning') return TriangleAlert;
    if (severity === 'info') return Info;
    return CircleCheck;
  }
</script>

<Popover.Root bind:open {onOpenChange}>
  <Popover.Trigger class={cn(buttonVariants('secondary', 'icon'), 'relative')} aria-label={unseenCount > 0 ? `Notifications ${unseenCount > 9 ? '9+' : unseenCount}` : 'Notifications'} title="Notifications">
    <Bell class="h-4 w-4" />
    {#if unseenCount > 0}
      <span aria-hidden="true" class="bg-err absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-medium text-white">
        {unseenCount > 9 ? '9+' : unseenCount}
      </span>
    {/if}
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content class="border-border bg-popover text-popover-foreground z-50 w-80 rounded-md border p-3 shadow-md" sideOffset={8} align="end">
      <div class="mb-2 flex items-center justify-between">
        <span class="text-sm font-medium">Notifications</span>
        {#if localItems.length > 0}
          <Button variant="link" size="sm" class="h-auto p-0 text-xs text-muted" onclick={clearToastHistory}>Clear local</Button>
        {/if}
      </div>
      {#if notifications.length > 0}
        <VirtualizedList
          items={notifications}
          itemKey={(notification) => notification.id}
          estimateSize={84}
          overscan={4}
          label="Dashboard notifications"
          class="h-80 max-h-[calc(100dvh-8rem)] overflow-y-auto"
        >
          {#snippet children(notification: DashboardNotification)}
            {@const Icon = iconFor(notification.severity)}
            <div class="flex items-start gap-2 text-xs">
              <Icon class={cn('mt-0.5 h-3.5 w-3.5 shrink-0', notification.severity === 'error' ? 'text-err' : notification.severity === 'warning' ? 'text-warn' : notification.severity === 'success' ? 'text-ok' : 'text-accent')} />
              <div class="min-w-0 flex-1">
                <div class="font-medium text-text">{notification.title}</div>
                <div class="mt-0.5 text-muted">{notification.message}</div>
                {#if (notification.occurrenceCount ?? 1) > 1}
                  <div class="mt-1 text-muted">
                    Occurred {notification.occurrenceCount} times · last <RelativeTime ms={notification.lastOccurredAt ?? notification.createdAt} />
                  </div>
                {/if}
                <div class="mt-1 flex items-center justify-between gap-2">
                  <span class="text-muted"><RelativeTime ms={notification.createdAt} /></span>
                  {#if notification.href}
                    <a class="text-accent hover:text-text font-medium" href={notification.href} onclick={() => void onOpenChange(false)}>
                      {notification.jobId ? 'Open job' : notification.deviceId ? 'Open device' : notification.deploymentId ? 'Open deployment' : 'Inspect'}
                    </a>
                  {/if}
                </div>
              </div>
            </div>
          {/snippet}
        </VirtualizedList>
        {#if nextCursor}
          <Button class="mt-2 w-full" size="sm" variant="secondary" loading={loadingOlder} onclick={() => void loadOlder()}>Load older notifications</Button>
        {/if}
      {:else if localItems.length > 0}
        <div class="flex max-h-80 flex-col gap-2 overflow-y-auto">
          {#each localItems as item (item.id)}
            <div class="flex items-start gap-2 text-xs">
              {#if item.type === 'error'}<CircleX class="text-err mt-0.5 h-3.5 w-3.5 shrink-0" />{:else}<CircleCheck class="text-ok mt-0.5 h-3.5 w-3.5 shrink-0" />{/if}
              <div class="min-w-0 flex-1">
                <div class="text-text">{item.message}</div>
                <div class="mt-0.5 flex items-center justify-between gap-2">
                  <span class="text-muted"><RelativeTime ms={item.ts} /></span>
                  {#if item.downloadUrl}<a class="text-accent hover:text-text font-medium" href={item.downloadUrl}>Download</a>{/if}
                </div>
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <div class="text-sm text-muted">Nothing yet.</div>
      {/if}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
