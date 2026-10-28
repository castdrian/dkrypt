<script lang="ts">
  import { Download, Share, Sparkles } from 'lucide-svelte';
  import CopyButton from '#components/CopyButton.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import { dashboardArtifactDownloadUrl, fetchJobStatus } from '#lib/api';
  import { appDisplayName } from '#lib/appCatalog.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import { buttonVariants } from '#lib/components/ui/variants';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import { myDecryptsState, updateDecrypt, type TrackedDecrypt } from '#lib/decrypts.svelte';
  import { notifyJobFinished } from '#lib/notifications';
  import { playChime, vibrateCompletion } from '#lib/sound';
  import { showToast, soundEnabledState } from '#lib/ui.svelte';
  import { fmtDurationApprox } from '#lib/format.svelte';
  import PickupQrButton from '#components/PickupQrButton.svelte';
  import { ipaFileSharingAvailable, prepareIpaForSharing, sharePreparedIpa } from '#lib/shareIpa';

  interface CompletedDecrypt {
    label: string;
    url: string;
    jobId: string;
    artifactId?: string;
    temporaryResultExpiresAt?: number;
    freeTierResult?: boolean;
    warnings?: string[];
    executionPath?: TrackedDecrypt['executionPath'];
    durationMs?: number;
    attempt?: number;
  }

  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let completed = $state<CompletedDecrypt[]>([]);
  let preparedIpa = $state<File | null>(null);
  let preparingIpa = $state(false);
  const current = $derived(completed[0]);
  const shareSupported = $derived(ipaFileSharingAvailable());

  function decryptLabel(d: TrackedDecrypt): string {
    const name = appDisplayName(d.bundleId, d.trackName);
    return d.versionLabel ? `${name} (${d.versionLabel})` : name;
  }

  function presentCompletion(d: TrackedDecrypt, artifactId: string | undefined, freeTierResult?: boolean, temporaryResultExpiresAt?: number): void {
    const label = decryptLabel(d);
    const warningText = d.warnings?.length ? ` Completed with warnings: ${d.warnings.join(' ')}` : '';
    const isTemporary = freeTierResult ?? d.freeTierResult ?? false;

    if (!artifactId && !isTemporary) {
      const message = `${label} finished, but its artifact is unavailable.${warningText}`;
      showToast(message, 'error', { track: true });
      notifyJobFinished(d.warnings?.length ? 'Decrypt finished with warnings' : 'Decrypt finished', message);
      return;
    }

    const url = isTemporary ? `/v1/dashboard/jobs/${encodeURIComponent(d.id)}/file` : dashboardArtifactDownloadUrl(artifactId!);
    const durationMs = d.finishedAt ? Math.max(0, Date.parse(d.finishedAt) - d.createdAt) : undefined;
    completed = [...completed, { label, url, jobId: d.id, artifactId, freeTierResult: isTemporary, temporaryResultExpiresAt, warnings: d.warnings, executionPath: d.executionPath, durationMs, attempt: d.attempt }];
    notifyJobFinished(d.warnings?.length ? 'Decrypt finished with warnings' : 'Decrypt finished', `${label} is ready to download.${warningText}`, url);
    showToast(`${label} is ready to download.${warningText}`, 'success', {
      track: true,
      downloadUrl: url,
      action: {
        label: 'Download',
        onClick: () => window.location.assign(url),
      },
    });
  }

  async function poll(): Promise<void> {
    clearTimeout(pollTimer);
    if (document.hidden) return;
    const pending = myDecryptsState.items.filter(
      (d) => d.status !== 'done' && d.status !== 'failed',
    );
    if (pending.length === 0) return;

    for (const d of pending) {
      try {
        const data = await fetchJobStatus(d.id);
        const finished = d.status !== data.status && (data.status === 'done' || data.status === 'failed');
        updateDecrypt(d.id, {
          status: data.status,
          progress: data.progress,
          queue: data.queue,
          warnings: data.warnings,
          error: data.error,
          artifactId: data.artifactId,
          artifactUrl: data.artifactUrl,
          freeTierResult: data.freeTierResult,
          temporaryResultExpiresAt: data.temporaryResultExpiresAt,
          executionPath: data.executionPath,
          attempt: data.attempt,
          finishedAt: data.finishedAt,
        });
        if (!finished) continue;
        if (soundEnabledState.value) {
          playChime();
          vibrateCompletion(data.status === 'done');
        }
        if (data.status === 'done') presentCompletion({ ...d, warnings: data.warnings, executionPath: data.executionPath, attempt: data.attempt, finishedAt: data.finishedAt, freeTierResult: data.freeTierResult, temporaryResultExpiresAt: data.temporaryResultExpiresAt }, data.artifactId, data.freeTierResult, data.temporaryResultExpiresAt);
        else {
          const label = decryptLabel(d);
          const message = `${label} failed: ${data.error ?? 'unknown error'}`;
          notifyJobFinished('Decrypt failed', message);
          showToast(message, 'error', { track: true });
        }
      } catch {}
    }

    pollTimer = setTimeout(poll, 2500);
  }

  function onVisibilityChange(): void {
    if (!document.hidden) void poll();
  }

  $effect(() => {
    void poll();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearTimeout(pollTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  });

  function onOpenChange(open: boolean): void {
    if (!open) {
      completed = completed.slice(1);
      preparedIpa = null;
    }
  }

  async function handoffCurrent(): Promise<void> {
    if (!current || preparingIpa) return;
    try {
      if (!preparedIpa) {
        preparingIpa = true;
        preparedIpa = await prepareIpaForSharing(current.url, current.label);
        showToast('IPA ready. Tap Share IPA now to choose an app.', 'success');
        return;
      }
      await sharePreparedIpa(preparedIpa, current.label);
      preparedIpa = null;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      showToast(error instanceof Error ? error.message : 'Could not send the IPA to another app', 'error');
    } finally {
      preparingIpa = false;
    }
  }
</script>

<Dialog open={Boolean(current)} {onOpenChange} class="max-w-md">
  {#if current}
    <div class="mb-4 text-center">
      <div class="text-xs font-medium uppercase tracking-[0.12em] text-ok">Decrypt complete</div>
      <h2 class="mt-1 text-lg font-semibold">Your IPA is ready</h2>
      <div class="mt-1 text-sm text-muted">{current.label}</div>
    </div>
    {#if current.warnings?.length}
      <Alert variant="warning" class="mb-4">
        <div class="font-medium">Completed with warnings</div>
        <div class="mt-1 text-xs">{current.warnings.join(' ')}</div>
      </Alert>
    {/if}
    {#if current.freeTierResult && current.temporaryResultExpiresAt}
      <div class="mb-4 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-muted">Temporary download · available until {new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(current.temporaryResultExpiresAt)}</div>
      <a href={`/?tab=billing&preserveResult=${encodeURIComponent(current.jobId)}`} class={buttonVariants('secondary', 'sm') + ' mb-2 w-full justify-center'}><Sparkles class="h-4 w-4" />Upgrade and keep this result</a>
    {/if}
    <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
      <a href={current.url} class={buttonVariants('default', 'sm') + ' justify-center'}><Download class="h-4 w-4" />Download IPA</a>
      <PickupQrButton artifactId={current.artifactId} jobId={current.freeTierResult ? current.jobId : undefined} label="QR code" />
    </div>
    {#if shareSupported}
      <Button class="mt-2 w-full" variant="secondary" size="sm" loading={preparingIpa} onclick={() => void handoffCurrent()}><Share class="h-4 w-4" />{preparedIpa ? 'Share IPA now' : 'Prepare to send to another app'}</Button>
      <p class="mt-1 text-center text-[11px] text-muted">After preparation, choose Files, Drive, Dropbox, or a sideloading app from your system share sheet.</p>
    {/if}
    <div class="mt-2 flex justify-end"><Button variant="ghost" size="sm" onclick={() => onOpenChange(false)}>Done</Button></div>
    <details class="mt-4 border-t border-border pt-3">
      <summary class="cursor-pointer text-xs text-muted">Job details and link</summary>
      <div class="mt-2 flex flex-col gap-2 text-xs text-muted">
        <div class="flex flex-wrap items-center gap-2">
          {#if current.executionPath === 'appstore_offline'}<Badge variant="secondary">Server-side</Badge>{:else if current.executionPath === 'device_fallback'}<Badge variant="secondary">Device fallback</Badge>{:else if current.executionPath === 'device'}<Badge variant="secondary">On device</Badge>{/if}
          {#if current.durationMs !== undefined}<span>Total time {fmtDurationApprox(current.durationMs)}</span>{/if}
          {#if current.attempt && current.attempt > 1}<span>{current.attempt} attempts</span>{/if}
        </div>
        <div class="bg-panel-muted flex items-center gap-2 rounded-lg p-2"><code class="min-w-0 flex-1 truncate" title={current.url}>{current.url}</code><CopyButton text={current.url} label="Copy" /></div>
      </div>
    </details>
  {/if}
</Dialog>
