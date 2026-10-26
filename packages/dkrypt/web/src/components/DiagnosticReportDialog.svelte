<script lang="ts">
  import { AlertTriangle, Check, Send, ShieldCheck } from 'lucide-svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import { fetchDiagnosticReports, previewDiagnosticReport, replyToDiagnosticReport, submitDiagnosticReport, type DiagnosticReport, type DiagnosticReportCategory, type DiagnosticReportPreview } from '#lib/api';
  import { sessionState } from '#lib/session.svelte';
  import { clearFormDraft, readFormDraft, setFormUnsaved, writeFormDraft } from '#lib/formDrafts.svelte';
  import { fmtDateTime } from '#lib/format.svelte';
  import { showToast } from '#lib/ui.svelte';

  interface Props {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
  }

  let { open = $bindable(), onOpenChange }: Props = $props();
  let category = $state<DiagnosticReportCategory>('bug');
  let summary = $state('');
  let details = $state('');
  let preview = $state<DiagnosticReportPreview | null>(null);
  let reports = $state<DiagnosticReport[] | null>(null);
  let loading = $state(false);
  let submitting = $state(false);
  let consent = $state(false);
  let selectedReportId = $state<string | null>(null);
  let replyText = $state('');
  let sendingReply = $state(false);
  let lastLoadedDraftKey = '';
  const formId = 'diagnostic-report';
  const draftKey = $derived(sessionState.sub ? `${formId}:${sessionState.sub}` : '');
  const categoryItems = [
    { value: 'bug', label: 'Bug or broken workflow' },
    { value: 'device', label: 'Device connection or setup' },
    { value: 'job', label: 'Decrypt job' },
    { value: 'other', label: 'Other' },
  ];
  const hasDraft = $derived(Boolean(summary.trim() || details.trim()));
  const selectedReport = $derived(reports?.find((report) => report.id === selectedReportId));

  $effect(() => {
    if (!open || !draftKey || draftKey === lastLoadedDraftKey) return;
    lastLoadedDraftKey = draftKey;
    void loadReports();
    const draft = readFormDraft<{ category: DiagnosticReportCategory; summary: string; details: string }>(draftKey)?.values;
    if (draft) {
      category = draft.category;
      summary = draft.summary;
      details = draft.details;
    } else {
      category = 'bug';
      summary = '';
      details = '';
    }
  });

  $effect(() => {
    if (open && hasDraft) setFormUnsaved(formId, true);
    else setFormUnsaved(formId, false);
  });

  async function loadReports(): Promise<void> {
    try {
      reports = (await fetchDiagnosticReports()).reports;
      if (!selectedReportId && reports.length > 0) selectedReportId = reports[0]!.id;
    } catch {
      reports = [];
    }
  }

  function changed(): void {
    preview = null;
    consent = false;
    if (draftKey) clearFormDraft(draftKey);
  }

  async function createPreview(): Promise<void> {
    if (!summary.trim() || !details.trim()) return;
    loading = true;
    try {
      preview = await previewDiagnosticReport({ category, summary, details });
      summary = preview.summary;
      details = preview.details;
      writeFormDraft(draftKey, { category: preview.category, summary: preview.summary, details: preview.details });
      showToast('Review the redacted preview before submitting.', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not prepare the report preview.', 'error');
    } finally {
      loading = false;
    }
  }

  async function submit(): Promise<void> {
    if (!preview || !consent || preview.expiresAt <= Date.now()) return;
    submitting = true;
    try {
      const report = await submitDiagnosticReport(preview);
      reports = [report, ...(reports ?? [])].slice(0, 50);
      selectedReportId = report.id;
      summary = '';
      details = '';
      preview = null;
      consent = false;
      if (draftKey) clearFormDraft(draftKey);
      setFormUnsaved(formId, false);
      showToast('Your report was submitted.', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not submit the report.', 'error');
    } finally {
      submitting = false;
    }
  }

  async function sendReply(): Promise<void> {
    if (!selectedReport || !replyText.trim()) return;
    sendingReply = true;
    try {
      const updated = await replyToDiagnosticReport(selectedReport.id, replyText);
      reports = (reports ?? []).map((report) => report.id === updated.id ? updated : report);
      replyText = '';
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not send your reply.', 'error');
    } finally {
      sendingReply = false;
    }
  }

  function requestOpenChange(nextOpen: boolean): void {
    if (!nextOpen && hasDraft && !preview) {
      showToast('Preview the redacted report before closing, or clear the draft.', 'error');
      return;
    }
    open = nextOpen;
    onOpenChange?.(nextOpen);
  }
</script>

<Dialog bind:open onOpenChange={requestOpenChange} title="Report an issue" class="max-h-[90dvh] max-w-xl overflow-y-auto">
  <div class="mb-4 flex items-start gap-3">
    <div class="bg-accent/10 text-accent flex size-9 shrink-0 items-center justify-center rounded-full"><AlertTriangle class="size-4" /></div>
    <div><h2 class="text-base font-semibold">Report an issue</h2><p class="mt-1 text-xs text-muted">Only submit information you are comfortable sharing with dkrypt support.</p></div>
  </div>

  <div class="grid gap-3">
    <label class="grid gap-1.5 text-xs font-medium">Issue type
      <Select items={categoryItems} bind:value={category} onValueChange={changed} />
    </label>
    <label class="grid gap-1.5 text-xs font-medium">Short summary
      <input class="min-h-10 rounded-md border border-border bg-background px-3 text-sm" maxlength="200" bind:value={summary} oninput={changed} placeholder="Example: TestFlight lookup stays unavailable" />
    </label>
    <label class="grid gap-1.5 text-xs font-medium">What happened?
      <textarea class="min-h-28 rounded-md border border-border bg-background px-3 py-2 text-sm" maxlength="5000" bind:value={details} oninput={changed} placeholder="Include the step you tried, what you expected, and any visible error."></textarea>
    </label>
    <p class="text-xs text-muted">Emails, IP addresses, device IDs, URLs, and credential-like values are removed from the preview.</p>
    <div class="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" loading={loading} disabled={!summary.trim() || !details.trim()} onclick={() => void createPreview()}><ShieldCheck class="size-3.5" />Preview redactions</Button>
      {#if preview}
        <span class="text-xs text-muted">Preview expires {fmtDateTime(preview.expiresAt)}</span>
      {/if}
    </div>

    {#if preview}
      <section class="rounded-lg border border-border bg-panel-muted/40 p-3" aria-label="Redacted report preview">
        <div class="text-xs font-semibold">Redacted preview</div>
        <div class="mt-2 text-sm font-medium">{preview.summary}</div>
        <pre class="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words text-xs text-muted">{preview.details}</pre>
        <label class="mt-3 flex items-start gap-2 text-xs"><input class="mt-0.5 size-4 accent-accent" type="checkbox" bind:checked={consent} /><span>I reviewed this redacted preview and agree to submit it to dkrypt support.</span></label>
        <Button class="mt-3" size="sm" loading={submitting} disabled={!consent || preview.expiresAt <= Date.now()} onclick={() => void submit()}><Send class="size-3.5" />Submit report</Button>
      </section>
    {/if}

    {#if reports?.length}
      <section class="border-t border-border pt-3">
        <h3 class="text-xs font-semibold">Your support conversations</h3>
        <div class="mt-2 grid gap-3">
          <div class="flex gap-2 overflow-x-auto pb-1">{#each reports.slice(0, 20) as report (report.id)}<button type="button" class="max-w-56 shrink-0 rounded-lg border px-3 py-2 text-left text-xs {selectedReportId === report.id ? 'border-accent bg-accent/5' : 'border-border/70'}" aria-pressed={selectedReportId === report.id} onclick={() => (selectedReportId = report.id)}><span class="block truncate font-medium">{report.summary}</span><span class="mt-1 block text-muted"><Check class="mr-1 inline size-3 text-ok" />{report.messages?.length ? `${report.messages.length} replies` : 'Received'} · {fmtDateTime(report.createdAt)}</span></button>{/each}</div>
          {#if selectedReport}
            <article class="rounded-xl border border-border/70 bg-panel/30 p-3">
              <div class="grid gap-2"><div class="max-w-[90%] rounded-xl border border-border/70 bg-bg/50 p-3"><div class="mb-1 text-[10px] font-medium text-muted">Your report · {fmtDateTime(selectedReport.createdAt)}</div><p class="text-xs font-medium">{selectedReport.summary}</p><pre class="mt-1 whitespace-pre-wrap break-words text-xs text-muted">{selectedReport.details}</pre></div>{#each selectedReport.messages ?? [] as message (message.id)}<div class="max-w-[90%] rounded-xl border border-accent/20 bg-accent/5 p-3 {message.authorRole === 'reporter' ? 'ml-auto' : ''}"><div class="mb-1 text-[10px] font-medium text-muted">{message.authorDisplayName} · {fmtDateTime(message.createdAt)}</div><p class="whitespace-pre-wrap break-words text-xs">{message.body}</p></div>{/each}</div>
              <form class="mt-3 border-t border-border/70 pt-3" onsubmit={(event) => { event.preventDefault(); void sendReply(); }}><label class="grid gap-1.5 text-xs font-medium">Reply to support<textarea class="min-h-20 rounded-lg border border-border bg-bg px-3 py-2 text-sm" bind:value={replyText} maxlength="5000" placeholder="Add details or reply to support"></textarea></label><div class="mt-2 flex items-center justify-between gap-2"><span class="text-[10px] text-muted">Contact details and credential-like values are redacted.</span><Button size="sm" loading={sendingReply} disabled={!replyText.trim()}>Send reply</Button></div></form>
            </article>
          {/if}
        </div>
      </section>
    {/if}
  </div>
</Dialog>
