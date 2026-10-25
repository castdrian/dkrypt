<script lang="ts">
  import { Inbox, RefreshCw } from 'lucide-svelte';
  import EmptyState from '#components/EmptyState.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import { fetchDiagnosticReportInbox, type DiagnosticReport } from '#lib/api';
  import { fmtDateTime } from '#lib/format.svelte';

  let reports = $state<DiagnosticReport[] | null>(null);
  let error = $state('');
  let refreshing = $state(false);

  $effect(() => {
    void load();
  });

  async function load(): Promise<void> {
    refreshing = true;
    error = '';
    try {
      reports = (await fetchDiagnosticReportInbox()).reports;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not load diagnostic reports.';
    } finally {
      refreshing = false;
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
    <div class="grid gap-3">
      {#each reports as report (report.id)}
        <article class="rounded-lg border border-border/70 bg-panel/40 p-3">
          <div class="flex flex-wrap items-start justify-between gap-2"><div><h3 class="text-sm font-semibold">{report.summary}</h3><p class="mt-1 text-xs text-muted">{report.category} · {fmtDateTime(report.createdAt)}</p></div><span class="rounded-full bg-muted/20 px-2 py-1 text-[10px] text-muted">Received</span></div>
          <pre class="mt-3 whitespace-pre-wrap break-words text-xs text-muted">{report.details}</pre>
          <div data-sensitive="true" class="mt-3 font-mono text-[10px] text-muted">{report.userDisplayName ?? report.userId} · {report.id}</div>
        </article>
      {/each}
    </div>
  {/if}
</Card>
