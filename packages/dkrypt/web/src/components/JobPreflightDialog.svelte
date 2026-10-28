<script lang="ts">
  import { CheckCircle2, CircleX, LoaderCircle, ShieldCheck } from 'lucide-svelte';
  import type { DecryptPreflight } from '#lib/api';
  import Button from '#lib/components/ui/Button.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import { fmtDateTime, fmtDurationApprox, fmtSize } from '#lib/format.svelte';
  import { sessionCanViewOperationalDashboard } from '#lib/session.svelte';

  interface Props {
    open: boolean;
    preflight: DecryptPreflight | null;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
  }

  let { open, preflight, onOpenChange, onConfirm }: Props = $props();
  const canViewOperations = $derived(sessionCanViewOperationalDashboard());
  const freeQuotaExhausted = $derived(preflight?.quota?.freeTier === true && preflight.quota.remaining === 0);
</script>

<Dialog {open} {onOpenChange} class="max-w-lg">
  <div class="mb-1 flex items-center gap-2 text-sm font-medium">
    <ShieldCheck class="text-accent h-4 w-4" />
    Check before queuing
  </div>
  <div class="mb-4 text-xs text-muted">
    {preflight?.bundleId}{preflight?.versionLabel ? ` · ${preflight.versionLabel}` : ''}
    {preflight?.testflight ? ' · TestFlight' : ''}
  </div>

  {#if preflight}
    {#if canViewOperations}
    <div class="mb-4 grid grid-cols-2 gap-2">
      <div class="border-border rounded-lg border p-2.5">
        <div class="text-[11px] text-muted">Estimated run time</div>
        <div class="mt-0.5 text-sm font-medium">{preflight.estimatedDurationMs ? fmtDurationApprox(preflight.estimatedDurationMs) : 'No baseline yet'}</div>
      </div>
      <div class="border-border rounded-lg border p-2.5">
        <div class="text-[11px] text-muted">Active queue</div>
        <div class="mt-0.5 text-sm font-medium">{preflight.queueLength ?? 0} job{preflight.queueLength === 1 ? '' : 's'}</div>
      </div>
    </div>
    <p class="mb-3 text-xs text-muted">Jobs are ordered by priority, then queue time. The estimate may change when higher-priority jobs or device issues appear.{preflight.estimatedDurationMs && preflight.devices.some((device) => device.ready) ? ` Approximate wait: ${fmtDurationApprox(preflight.estimatedDurationMs * (preflight.queueLength ?? 0) / preflight.devices.filter((device) => device.ready).length)}.` : ''}</p>
    {/if}
    {#if preflight.quota}
      <div class="mb-3 rounded-lg border border-border px-3 py-2 text-xs text-muted">
        {#if preflight.quota.legacy}<span class="font-medium text-foreground">Grandfathered plan.</span> {/if}
        {preflight.quota.limit === null ? 'Unlimited new decrypts' : `${preflight.quota.remaining ?? 0} of ${preflight.quota.limit} new decrypts available in your rolling ${preflight.quota.windowMs === 30 * 24 * 60 * 60 * 1000 ? '30-day' : '24-hour'} window`}.
        Existing jobs and cached results do not use a slot.
        {#if preflight.quota.nextAvailableAt && preflight.quota.remaining === 0} Next slot: {fmtDateTime(preflight.quota.nextAvailableAt)}.{/if}
        {#if preflight.quota.apiRatePerMinute} API rate: {preflight.quota.apiRatePerMinute} requests per minute across your keys.{/if}
        {#if preflight.quota.freeTier && preflight.quota.remaining === 0}<a class="ml-1 font-medium text-accent underline underline-offset-2" href="/?tab=billing">Compare paid plans</a>{/if}
      </div>
    {/if}

    {#if canViewOperations}
    <div class="mb-4 flex flex-col gap-2">
      {#each preflight.devices as device (device.id)}
        <div class="border-border rounded-lg border p-2.5">
          <div class="flex items-center gap-2">
            {#if device.checking}<LoaderCircle class="text-warn h-4 w-4 shrink-0 animate-spin" />{:else if device.ready}<CheckCircle2 class="text-ok h-4 w-4 shrink-0" />{:else}<CircleX class="text-err h-4 w-4 shrink-0" />{/if}
            <span class="min-w-0 flex-1 truncate text-sm font-medium">{device.name}</span>
            {#if device.isPrimary}<span class="text-[11px] text-muted">Primary</span>{/if}
            {#if device.storageFreeBytes !== undefined}<span class="text-[11px] text-muted">{fmtSize(device.storageFreeBytes)} free</span>{/if}
          </div>
          {#if device.blockers.length > 0}
            <div class="mt-1.5 text-xs {device.checking ? 'text-warn' : 'text-err'}">{device.blockers.join(' · ')}</div>
          {:else if device.warnings?.length}
            <div class="mt-1.5 text-xs text-warn">{device.warnings.join(' · ')}</div>
          {:else if device.readiness?.reasons.length}
            <div class="mt-1.5 text-xs text-muted">{device.readiness.reasons.join(' · ')}</div>
          {:else}
            <div class="mt-1.5 text-xs text-muted">Ready for this request</div>
          {/if}
        </div>
      {:else}
        <div class="border-warn/40 bg-warn/10 rounded-lg border p-3 text-sm text-warn">No enabled devices are configured.</div>
      {/each}
    </div>

    {#if !preflight.canQueue}
      <div class="border-warn/40 bg-warn/10 mb-4 rounded-lg border p-3 text-xs text-warn">{preflight.devices.some((device) => device.checking) ? 'Device verification is still running. You can queue now; the worker will recheck before starting.' : 'No device currently passes every check. You can still queue this job and resolve the device issue afterward.'}</div>
    {/if}
    {:else}
      {#if !preflight.canQueue}
        <div class="mb-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn" role="status">dkrypt could not confirm an available device yet. You can still queue; availability will be checked again when the job starts.</div>
      {/if}
      <div class="mb-4 rounded-lg border border-border px-3 py-2 text-xs text-muted">dkrypt will select and verify an available device automatically when the job starts.</div>
    {/if}
    <div class="flex justify-end gap-2">
      <Button size="sm" variant="secondary" onclick={() => onOpenChange(false)}>Cancel</Button>
      <Button size="sm" disabled={freeQuotaExhausted} onclick={onConfirm}>{freeQuotaExhausted ? 'Allowance used' : preflight.canQueue ? 'Queue job' : 'Queue anyway'}</Button>
    </div>
  {:else}
    <div class="text-sm text-muted">Checking devices…</div>
  {/if}
</Dialog>
