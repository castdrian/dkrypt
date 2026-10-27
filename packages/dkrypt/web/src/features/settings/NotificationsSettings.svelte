<script lang="ts">
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck, Clock3 } from 'lucide-svelte';
  import PendingIntegrationOwnership from '#features/administration/PendingIntegrationOwnership.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import Label from '#lib/components/ui/Label.svelte';
  import Switch from '#lib/components/ui/Switch.svelte';
  import { fetchSettings, fetchWebhookDeliveries, previewJobHistoryRetention, saveSettings, testWebhook, type DashboardSettings, type JobHistoryRetentionPreview, type WebhookDeliveryEntry, type WebhookTestResult } from '#lib/api';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasPermission } from '#lib/session.svelte';
  import { showToast } from '#lib/ui.svelte';

  const eventSettings: Array<{ key: keyof DashboardSettings; label: string }> = [
    { key: 'notifyOnJobCompleted', label: 'Decrypt completed' },
    { key: 'notifyOnQueueSloBreach', label: 'Queue objective breached' },
    { key: 'notifyOnAutomationSuccess', label: 'Payment succeeded' },
    { key: 'notifyOnAutomationFailure', label: 'Payment needs attention' },
    { key: 'notifyOnKeyRequest', label: 'API key requested' },
    { key: 'notifyOnKeyExpiringSoon', label: 'API key expiring soon' },
    { key: 'notifyOnDeviceOffline', label: 'Device unreachable' },
    { key: 'notifyOnDeviceBatteryHot', label: 'Device temperature high' },
    { key: 'notifyOnDeviceBatteryLow', label: 'Device battery low' },
    { key: 'notifyOnDeviceStorageLow', label: 'Device storage low' },
    { key: 'notifyOnDiskFull', label: 'Server storage low' },
    { key: 'notifyOnTestFlightBridgeDown', label: 'Autoinstall bridge unresponsive' },
  ];
  const canManage = $derived(sessionHasPermission(PermissionFlag.manageAutomation));
  let settings = $state<DashboardSettings | null>(null);
  let deliveries = $state<WebhookDeliveryEntry[]>([]);
  let retention = $state<JobHistoryRetentionPreview | null>(null);
  let retentionDays = $state(0);
  let loading = $state(true);
  let saving = $state(false);
  let testing = $state(false);
  let testResult = $state<WebhookTestResult | null>(null);
  let error = $state('');

  async function refresh(): Promise<void> {
    loading = true;
    error = '';
    try {
      const [nextSettings, nextDeliveries] = await Promise.all([fetchSettings(), fetchWebhookDeliveries(25)]);
      settings = nextSettings;
      retentionDays = nextSettings.jobHistoryRetentionDays;
      deliveries = nextDeliveries.deliveries;
      await refreshRetentionPreview();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not load notification settings.';
    } finally {
      loading = false;
    }
  }

  async function refreshRetentionPreview(): Promise<void> {
    try {
      retention = await previewJobHistoryRetention(retentionDays);
    } catch {
      retention = null;
    }
  }

  async function save(): Promise<void> {
    if (!settings || !canManage) return;
    saving = true;
    try {
      const result = await saveSettings({ ...settings, jobHistoryRetentionDays: retentionDays });
      if (result.ok) {
        settings = result.data;
        retentionDays = result.data.jobHistoryRetentionDays;
        await refreshRetentionPreview();
      }
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : 'Could not save notification settings.', 'error');
    } finally {
      saving = false;
    }
  }

  async function sendTest(): Promise<void> {
    if (!settings || !canManage) return;
    testing = true;
    try {
      const result = await testWebhook(settings.notifyWebhookUrl || undefined);
      testResult = result.data;
      showToast(result.data.ok ? `Endpoint accepted the test in ${result.data.durationMs} ms` : result.data.error ?? 'Test notification failed', result.data.ok ? 'success' : 'error');
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : 'Could not send a test notification.', 'error');
    } finally {
      testing = false;
    }
  }

  function updateBoolean(key: keyof DashboardSettings, value: boolean): void {
    if (!settings) return;
    settings = { ...settings, [key]: value };
  }

  function deliveryLabel(delivery: WebhookDeliveryEntry): string {
    if (delivery.kind === 'scheduler') return 'Legacy event';
    if (delivery.kind === 'automation') return 'Notification';
    return delivery.event.replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  onMount(() => {
    void refresh();
  });
</script>

<div class="flex flex-col gap-4">
  <PendingIntegrationOwnership />
  <Card title="Notifications">
    <div class="flex flex-wrap items-center gap-2">
      <Badge variant={settings?.notifyWebhookUrl ? 'success' : 'secondary'}>{settings?.notifyWebhookUrl ? 'Webhook configured' : 'Webhook not configured'}</Badge>
      <span class="text-xs text-muted">Send important dkrypt updates to Discord or Slack-compatible webhooks.</span>
      <Button class="ml-auto" size="sm" variant="secondary" loading={loading} onclick={() => void refresh()}>Refresh</Button>
    </div>
    {#if error}<p class="mt-3 text-sm text-err" role="alert">{error}</p>{/if}
    {#if settings}
      <div class="mt-4 grid gap-4 lg:grid-cols-2">
        <div class="space-y-3">
          <div class="space-y-1.5"><Label for="notification-webhook">Webhook URL</Label><Input id="notification-webhook" type="url" autocomplete="off" bind:value={settings.notifyWebhookUrl} disabled={!canManage} placeholder="https://discord.com/api/webhooks/…" /></div>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="space-y-1.5 text-xs"><span class="block text-muted">Message format</span><select class="min-h-9 w-full rounded-md border border-border bg-background px-2 text-sm" bind:value={settings.notifyFormat} disabled={!canManage}><option value="embed">Rich embed</option><option value="plain">Plain text</option></select></label>
            <label class="space-y-1.5 text-xs"><span class="block text-muted">Success delivery</span><select class="min-h-9 w-full rounded-md border border-border bg-background px-2 text-sm" bind:value={settings.notifySuccessMode} disabled={!canManage}><option value="instant">Immediately</option><option value="daily">Daily digest</option><option value="weekly">Weekly digest</option></select></label>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="space-y-1.5"><Label for="notification-quiet-start">Quiet hours start</Label><Input id="notification-quiet-start" type="time" bind:value={settings.notifyQuietHoursStart} disabled={!canManage} /></div>
            <div class="space-y-1.5"><Label for="notification-quiet-end">Quiet hours end</Label><Input id="notification-quiet-end" type="time" bind:value={settings.notifyQuietHoursEnd} disabled={!canManage} /></div>
          </div>
          {#if canManage}<div class="flex flex-wrap gap-2"><Button size="sm" loading={saving} onclick={() => void save()}>Save settings</Button><Button size="sm" variant="secondary" loading={testing} disabled={!settings.notifyWebhookUrl} onclick={() => void sendTest()}>Test endpoint</Button></div>{/if}
          {#if testResult}<div class={`rounded-lg border p-3 text-xs ${testResult.ok ? 'border-ok/30 bg-ok/5' : 'border-err/30 bg-err/5'}`} role="status"><div class="font-medium">{testResult.ok ? 'Endpoint accepted the sample event' : 'Endpoint test failed'}</div><p class="mt-1 text-muted">{testResult.targetHost ?? 'Webhook endpoint'} · {testResult.status ? `HTTP ${testResult.status} · ` : ''}{testResult.durationMs} ms{testResult.error ? ` · ${testResult.error}` : ''}</p>{#if testResult.eventId}<p class="mt-1 font-mono text-[10px] text-muted">Event ID: {testResult.eventId}</p>{/if}<p class="mt-1 text-muted">{#if testResult.signatureIncluded}{#if testResult.signatureAcknowledged}The receiver explicitly acknowledged signature validation.{:else}dkrypt signed this request. The endpoint did not explicitly confirm that it validated the signature.{/if}{:else}This request was unsigned because no outbound signing secret is configured.{/if}</p></div>{/if}
        </div>
        <div class="space-y-1.5">
          <h3 class="text-sm font-medium">Events</h3>
          <div class="divide-y divide-border/60 rounded-lg border border-border/70 px-3">
            {#each eventSettings as event (event.key)}
              <div class="flex min-h-10 items-center justify-between gap-3 py-2"><span class="text-sm">{event.label}</span><Switch checked={Boolean(settings[event.key])} disabled={!canManage} onCheckedChange={(value) => updateBoolean(event.key, value)} aria-label={event.label} /></div>
            {/each}
          </div>
        </div>
      </div>
    {/if}
  </Card>

  {#if canManage && settings}
    <Card title="Alert thresholds and history">
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label class="space-y-1.5 text-xs"><span class="block text-muted">Device offline alert (minutes)</span><Input type="number" min="5" max="180" bind:value={settings.deviceOfflineAlertMinutes} /></label>
        <label class="space-y-1.5 text-xs"><span class="block text-muted">High battery temperature (°C)</span><Input type="number" min="30" max="60" bind:value={settings.batteryHotAlertC} /></label>
        <label class="space-y-1.5 text-xs"><span class="block text-muted">Low battery (%)</span><Input type="number" min="5" max="50" bind:value={settings.batteryLowAlertPercent} /></label>
        <label class="space-y-1.5 text-xs"><span class="block text-muted">Server disk alert (%)</span><Input type="number" min="50" max="99" bind:value={settings.diskFullAlertPercent} /></label>
        <label class="space-y-1.5 text-xs"><span class="block text-muted">Device storage alert (%)</span><Input type="number" min="50" max="99" bind:value={settings.deviceStorageAlertPercent} /></label>
        <label class="space-y-1.5 text-xs"><span class="block text-muted">Bridge alert (minutes)</span><Input type="number" min="5" max="180" bind:value={settings.testFlightBridgeAlertMinutes} /></label>
        <label class="space-y-1.5 text-xs"><span class="block text-muted">Job history retention (days, 0 = unlimited)</span><Input type="number" min="0" max="365" bind:value={retentionDays} oninput={() => void refreshRetentionPreview()} /></label>
      </div>
      {#if retention}<p class="mt-3 text-xs text-muted">{retention.retained} records remain · {retention.removed} are removed by this policy · {retention.artifacts.reclaimable} artifacts become eligible for eviction.</p>{/if}
      <div class="mt-3 flex justify-end"><Button size="sm" loading={saving} onclick={() => void save()}>Save thresholds</Button></div>
    </Card>
  {/if}

  <Card title="Recent webhook deliveries">
    {#if deliveries.length === 0}<p class="text-sm text-muted">No webhook deliveries yet.</p>{:else}<div class="divide-y divide-border/60">{#each deliveries as delivery (delivery.id)}<div class="flex flex-wrap items-center gap-2 py-2 text-xs"><span class="shrink-0">{#if delivery.ok}<CircleCheck class="size-3.5 text-ok" aria-hidden="true" />{:else}<CircleAlert class="size-3.5 text-err" aria-hidden="true" />{/if}</span><span class="min-w-0 flex-1 font-medium">{deliveryLabel(delivery)}</span><Badge variant={delivery.ok ? 'success' : 'destructive'}>{delivery.ok ? 'Sent' : 'Failed'}</Badge><span class="text-muted">{new Date(delivery.ts).toLocaleString()}</span><span class="inline-flex items-center gap-1 text-muted"><Clock3 class="size-3" aria-hidden="true" />{delivery.durationMs} ms</span></div>{/each}</div>{/if}
  </Card>
</div>
