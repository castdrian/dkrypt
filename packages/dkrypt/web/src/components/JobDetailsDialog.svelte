<script lang="ts">
  import { Copy, Download, FileSearch, GitBranch, Mail } from 'lucide-svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import { fetchJobResolutionNotice, fetchJobTimeline, jobDiagnosticUrl, sendJobResolutionNotice, type JobResolutionNoticePreview, type JobTimeline } from '#lib/api';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import InspectorPane from '#components/InspectorPane.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasPermission } from '#lib/session.svelte';
  import { fmtDurationApprox, fmtSize, fmtTime } from '#lib/format.svelte';
  import { buttonVariants, statusToBadgeVariant } from '#lib/components/ui/variants';
  import { showToast } from '#lib/ui.svelte';

  let { open = $bindable(), jobId, title }: { open: boolean; jobId: string; title: string } = $props();
  let timeline = $state<JobTimeline | null>(null);
  let loading = $state(false);
  let resolutionPreview = $state<JobResolutionNoticePreview | null>(null);
  let resolutionDialogOpen = $state(false);
  let sendingResolution = $state(false);

  async function load(): Promise<void> {
    if (!jobId) return;
    loading = true;
    resolutionPreview = null;
    try {
      timeline = await fetchJobTimeline(jobId);
      if (timeline.status === 'failed' && sessionHasPermission(PermissionFlag.notifyFailedJobOwners)) {
        try {
          resolutionPreview = await fetchJobResolutionNotice(jobId);
        } catch {
          resolutionPreview = null;
        }
      }
    } catch {
      timeline = null;
    } finally {
      loading = false;
    }
  }

  async function sendResolution(): Promise<void> {
    sendingResolution = true;
    try {
      resolutionPreview = await sendJobResolutionNotice(jobId);
      resolutionDialogOpen = false;
      showToast(resolutionPreview.notice?.emailStatus === 'failed' ? 'In-app notice sent; email delivery failed' : 'Requester notified', resolutionPreview.notice?.emailStatus === 'failed' ? 'error' : 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not send the notice', 'error');
    } finally {
      sendingResolution = false;
    }
  }

  $effect(() => {
    if (open) void load();
  });

  async function copyDeepLink(): Promise<void> {
    const url = new URL(location.href);
    url.searchParams.set('job', jobId);
    await navigator.clipboard.writeText(url.toString());
    showToast('Job link copied', 'success');
  }

  function pretty(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }
</script>

<InspectorPane bind:open title={title}>
  <div class="mb-4 flex items-start gap-3">
    <div class="min-w-0 flex-1">
      <div class="text-sm font-medium">{title}</div>
      <div class="mt-1 flex items-center gap-1.5 text-xs text-muted">
        <GitBranch class="h-3.5 w-3.5" />
        Correlation <span data-sensitive="true">{timeline?.correlationId ?? jobId}</span>
      </div>
    </div>
    <div class="flex shrink-0 gap-1.5">
      <Button size="sm" variant="secondary" onclick={() => void copyDeepLink()}><Copy class="h-3.5 w-3.5" />Link</Button>
      <a href={jobDiagnosticUrl(jobId)} download class={buttonVariants('secondary', 'sm')}><Download class="h-3.5 w-3.5" />Diagnostic</a>
    </div>
  </div>

  {#if loading}
    <div class="text-sm text-muted">Loading job timeline…</div>
  {:else if timeline}
    <div class="border-border mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-3">
      <Badge variant={statusToBadgeVariant(timeline.status)}>{timeline.status}</Badge>
      {#if timeline.versionLabel}<span class="text-xs text-muted">{timeline.versionLabel}</span>{/if}
      {#if timeline.deviceId}<span class="text-xs text-muted">Device: <span data-sensitive="true">{timeline.deviceId}</span></span>{/if}
      {#if timeline.sizeBytes}<span class="text-xs text-muted">{fmtSize(timeline.sizeBytes)}</span>{/if}
    </div>
    {#if timeline.dependencies?.length}
      <section class="mb-4 rounded-xl border border-border/70 p-3" aria-labelledby="job-dependencies-heading">
        <h3 id="job-dependencies-heading" class="text-xs font-semibold">What this job depends on</h3>
        <ul class="mt-2 grid gap-2 sm:grid-cols-2">
          {#each timeline.dependencies as dependency (dependency.id)}
            <li class="rounded-lg bg-muted/20 p-2.5">
              <div class="flex items-center justify-between gap-2"><span class="text-xs font-medium">{dependency.label}</span><Badge variant={dependency.state === 'ready' ? 'success' : dependency.state === 'failed' || dependency.state === 'blocked' ? 'warning' : 'outline'}>{dependency.state.replaceAll('_', ' ')}</Badge></div>
              <p class="mt-1 break-words text-[11px] text-muted">{dependency.detail}</p>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
    {#if timeline.executionPath === 'appstore_offline' || timeline.executionPath === 'device_fallback'}
      <section class="mb-4 rounded-xl border border-border/70 bg-muted/20 p-3" aria-label="Processing path">
        <div class="text-xs font-semibold">Processing path</div>
        <div class="mt-2 flex flex-wrap gap-2 text-xs">
          {#if timeline.offlineAttemptDurationMs !== undefined}<span class="rounded-full border border-border px-2 py-1">Server attempt · {fmtDurationApprox(timeline.offlineAttemptDurationMs)}</span>{/if}
          {#if timeline.executionPath === 'device_fallback' && timeline.offlineFailureReason}<span class="max-w-full rounded-full border border-border px-2 py-1">Fallback · {timeline.offlineFailureReason}</span>{/if}
          {#if timeline.deviceFallbackDurationMs !== undefined}<span class="rounded-full border border-border px-2 py-1">Device attempt · {fmtDurationApprox(timeline.deviceFallbackDurationMs)}</span>{/if}
        </div>
      </section>
    {/if}
    {#if timeline.warnings?.length}
      <Alert variant="warning" class="mb-4">
        <div class="font-medium">Completed with warnings</div>
        <div class="mt-1 text-xs">{timeline.warnings.join(' ')}</div>
      </Alert>
    {/if}
    {#if resolutionPreview}
      <section class="border-border mb-4 rounded-lg border p-3 text-sm">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div class="font-medium">Requester update</div>
            <div class="mt-1 text-xs text-muted" data-sensitive="true">{resolutionPreview.requester}</div>
          </div>
          {#if !resolutionPreview.notice}
            <Button size="sm" variant="secondary" onclick={() => (resolutionDialogOpen = true)}><Mail class="h-3.5 w-3.5" />Notify issue resolved</Button>
          {/if}
        </div>
        {#if resolutionPreview.notice}
          <div class="mt-2 text-xs text-muted">In-app notice sent {fmtTime(resolutionPreview.notice.sentAt)} · Email {resolutionPreview.notice.emailStatus === 'sent' ? 'sent' : resolutionPreview.notice.emailStatus === 'unavailable' ? 'unavailable' : resolutionPreview.notice.emailStatus === 'failed' ? 'failed' : 'pending'}</div>
        {/if}
      </section>
    {/if}
    {#if timeline.guidance || timeline.queueReason}
      <div class="border-warn/40 bg-warn/10 mb-4 rounded-lg border p-3 text-sm">
        <div class="font-medium">{timeline.guidance?.title ?? 'Queue blocker'}</div>
        {#if timeline.queueReason}<div class="mt-1 break-words">{timeline.queueReason}</div>{/if}
        {#if timeline.guidance}<div class="mt-1 text-muted">{timeline.guidance.action}</div>{/if}
      </div>
    {/if}
    {#if timeline.ipaMetadata}
      <section class="border-border mb-4 rounded-lg border p-3">
        <div class="mb-2 flex items-center gap-2 text-sm font-medium"><FileSearch class="text-accent h-4 w-4" />IPA inspection</div>
        <div class="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
          <div><div class="text-muted">App version</div><div>{timeline.ipaMetadata.shortVersion ?? '-'}</div></div>
          <div><div class="text-muted">Build</div><div>{timeline.ipaMetadata.bundleVersion ?? '-'}</div></div>
          <div><div class="text-muted">Minimum iOS</div><div>{timeline.ipaMetadata.minOsVersion ?? '-'}</div></div>
          <div><div class="text-muted">Executable</div><div class="truncate" title={timeline.ipaMetadata.executable}>{timeline.ipaMetadata.executable ?? '-'}</div></div>
          <div><div class="text-muted">Architectures</div><div>{timeline.ipaMetadata.architectures?.join(', ') || '-'}</div></div>
          <div><div class="text-muted">Files</div><div>{timeline.ipaMetadata.fileCount ?? '-'}</div></div>
          <div><div class="text-muted">Archive size</div><div>{timeline.ipaMetadata.compressedSizeBytes ? fmtSize(timeline.ipaMetadata.compressedSizeBytes) : '-'}</div></div>
          <div><div class="text-muted">Unpacked size</div><div>{timeline.ipaMetadata.uncompressedSizeBytes ? fmtSize(timeline.ipaMetadata.uncompressedSizeBytes) : '-'}</div></div>
          <div><div class="text-muted">Signature files</div><div>{timeline.ipaMetadata.codeSignaturePresent ? 'Detected' : 'Not detected'}</div></div>
        </div>
        {#if timeline.ipaMetadata.entitlementKeys?.length}
          <details class="border-border mt-3 border-t pt-2">
            <summary class="cursor-pointer text-xs text-muted">Entitlements ({timeline.ipaMetadata.entitlementKeys.length})</summary>
            <div class="mt-2 flex flex-wrap gap-1.5">{#each timeline.ipaMetadata.entitlementKeys as key (key)}<code class="bg-panel-muted rounded px-1.5 py-0.5 text-[11px]">{key}</code>{/each}</div>
          </details>
        {/if}
        {#if timeline.ipaMetadata.embeddedFrameworks?.length}
          <details class="border-border mt-3 border-t pt-2">
            <summary class="cursor-pointer text-xs text-muted">Embedded frameworks ({timeline.ipaMetadata.embeddedFrameworks.length})</summary>
            <div class="mt-2 flex flex-wrap gap-1.5">{#each timeline.ipaMetadata.embeddedFrameworks as framework (framework)}<code class="bg-panel-muted rounded px-1.5 py-0.5 text-[11px]">{framework}</code>{/each}</div>
          </details>
        {/if}
        {#if timeline.ipaInfoPlist}
          <details class="border-border mt-3 border-t pt-2">
            <summary class="cursor-pointer text-xs text-muted">Info.plist values</summary>
            <pre class="bg-panel-muted mt-2 max-h-48 overflow-auto rounded-lg p-2 text-[10px] leading-4">{pretty(timeline.ipaInfoPlist)}</pre>
          </details>
        {/if}
      </section>
    {/if}
    <ol class="max-h-80 space-y-3 overflow-y-auto pr-1">
      {#each timeline.events as event, index (`${event.at}-${event.label}`)}
        <li class="flex gap-3">
          <div class="flex flex-col items-center">
            <span class="bg-accent mt-1 h-2.5 w-2.5 rounded-full"></span>
            {#if index < timeline.events.length - 1}<span class="bg-border mt-1 h-full w-px"></span>{/if}
          </div>
          <div class="min-w-0 pb-2">
            <div class="text-sm text-text">{event.label}</div>
            <div class="mt-0.5 text-xs text-muted">{fmtTime(event.at)}{#if event.durationMs !== undefined} · {fmtDurationApprox(event.durationMs)}{/if}</div>
          </div>
        </li>
      {/each}
    </ol>
  {:else}
    <div class="text-sm text-muted">Timeline is unavailable for this job.</div>
  {/if}
</InspectorPane>

<Dialog bind:open={resolutionDialogOpen} title="Notify requester" class="max-w-lg">
  <div class="text-sm font-medium">Notify the requester that this issue is resolved?</div>
  <p class="mt-2 text-sm text-muted">Send this only after verifying the cause of this failed job has been fixed.</p>
  <div class="border-border bg-panel-muted mt-3 rounded-lg border p-3 text-sm">
    <div class="font-medium" data-sensitive="true">{resolutionPreview?.requester}</div>
    <p class="mt-2">{resolutionPreview?.message}</p>
    <p class="mt-2 text-xs text-muted">In-app notification{resolutionPreview?.emailAvailable ? ' and email' : ' · Email unavailable for this account'}</p>
  </div>
  <div class="mt-4 flex justify-end gap-2">
    <Button variant="secondary" onclick={() => (resolutionDialogOpen = false)}>Cancel</Button>
    <Button loading={sendingResolution} onclick={() => void sendResolution()}>Send notice</Button>
  </div>
</Dialog>
