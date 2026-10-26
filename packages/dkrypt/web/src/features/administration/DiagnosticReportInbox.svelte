<script lang="ts">
  import { Inbox, RefreshCw } from 'lucide-svelte';
  import EmptyState from '#components/EmptyState.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import { fetchDiagnosticReportInbox, replyToDiagnosticReport, type DiagnosticReport } from '#lib/api';
  import { fmtDateTime } from '#lib/format.svelte';

  let reports = $state<DiagnosticReport[] | null>(null);
  let error = $state('');
  let refreshing = $state(false);
  let selectedReportId = $state<string | null>(null);
  let replyText = $state('');
  let sendingReply = $state(false);
  const selectedReport = $derived(reports?.find((report) => report.id === selectedReportId));

  $effect(() => {
    void load();
  });

  async function load(): Promise<void> {
    refreshing = true;
    error = '';
    try {
      reports = (await fetchDiagnosticReportInbox()).reports;
      if (!selectedReportId && reports.length > 0) selectedReportId = reports[0]!.id;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not load diagnostic reports.';
    } finally {
      refreshing = false;
    }
  }

  async function sendReply(): Promise<void> {
    if (!selectedReport || !replyText.trim()) return;
    sendingReply = true;
    try {
      const updated = await replyToDiagnosticReport(selectedReport.id, replyText);
      reports = (reports ?? []).map((report) => report.id === updated.id ? { ...report, ...updated, userId: report.userId, userDisplayName: report.userDisplayName } : report);
      replyText = '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not send the reply.';
    } finally {
      sendingReply = false;
    }
  }
</script>

<Card title="Support reports">
  {#snippet headerExtra()}
    <Button size="sm" variant="secondary" loading={refreshing} onclick={() => void load()} aria-label="Refresh reports"><RefreshCw class="size-3.5" /></Button>
  {/snippet}
  {#if error}<div role="alert" class="text-sm text-err">{error}</div>
  {:else if reports === null}<div role="status" class="text-sm text-muted">Loading reports…</div>
  {:else if reports.length === 0}<EmptyState icon={Inbox} message="No support reports have been submitted." />
  {:else}
    <div class="grid gap-4 lg:grid-cols-[minmax(14rem,0.75fr)_minmax(0,1.5fr)]">
      <nav class="grid content-start gap-2" aria-label="Support reports">
        {#each reports as report (report.id)}
          <button type="button" class="rounded-lg border p-3 text-left transition hover:bg-panel-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent {selectedReportId === report.id ? 'border-accent bg-accent/5' : 'border-border/70'}" aria-current={selectedReportId === report.id ? 'true' : undefined} onclick={() => (selectedReportId = report.id)}>
            <span class="block truncate text-sm font-semibold">{report.summary}</span><span class="mt-1 block text-xs text-muted">{report.userDisplayName ?? report.userId} · {fmtDateTime(report.createdAt)}</span>
          </button>
        {/each}
      </nav>
      {#if selectedReport}
        <article class="min-w-0 rounded-xl border border-border/70 bg-panel/40 p-4">
          <div class="flex flex-wrap items-start justify-between gap-2"><div><h3 class="text-sm font-semibold">{selectedReport.summary}</h3><p class="mt-1 text-xs text-muted">{selectedReport.category} · {fmtDateTime(selectedReport.createdAt)}</p></div><span class="rounded-full bg-muted/20 px-2 py-1 text-[10px] text-muted">Received</span></div>
          <div class="mt-4 grid gap-3">
            <div class="max-w-[90%] rounded-xl border border-border/70 bg-bg/50 p-3"><div class="mb-1 text-[10px] font-medium text-muted">{selectedReport.userDisplayName ?? 'Reporter'} · {fmtDateTime(selectedReport.createdAt)}</div><pre class="whitespace-pre-wrap break-words text-xs">{selectedReport.details}</pre></div>
            {#each selectedReport.messages ?? [] as message (message.id)}
              <div class="max-w-[90%] rounded-xl border border-accent/20 bg-accent/5 p-3 {message.authorRole === 'support' ? 'ml-auto' : ''}"><div class="mb-1 text-[10px] font-medium text-muted">{message.authorDisplayName} · {fmtDateTime(message.createdAt)}</div><p class="whitespace-pre-wrap break-words text-xs">{message.body}</p></div>
            {/each}
          </div>
          <form class="mt-4 border-t border-border/70 pt-3" onsubmit={(event) => { event.preventDefault(); void sendReply(); }}><label class="grid gap-1.5 text-xs font-medium">Reply to this report<textarea class="min-h-24 rounded-lg border border-border bg-bg px-3 py-2 text-sm" bind:value={replyText} maxlength="5000" placeholder="Write a helpful response. Sensitive values are redacted before saving."></textarea></label><div class="mt-2 flex justify-end"><Button size="sm" loading={sendingReply} disabled={!replyText.trim()}>Send reply</Button></div></form>
          <div data-sensitive="true" class="mt-3 truncate font-mono text-[10px] text-muted">{selectedReport.userId} · {selectedReport.id}</div>
        </article>
      {/if}
    </div>
  {/if}
</Card>
