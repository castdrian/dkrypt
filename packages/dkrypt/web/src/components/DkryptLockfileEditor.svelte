<script lang="ts">
  import { Check, Copy, Download, Plus, Trash2 } from 'lucide-svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Input from '#lib/components/ui/Input.svelte';

  interface LockEntry {
    bundleId: string;
    source: 'appstore' | 'testflight';
    resolvedVersion: string;
    build: string;
  }

  let entries = $state<LockEntry[]>([{ bundleId: '', source: 'appstore', resolvedVersion: '', build: '' }]);
  let importText = $state('');
  let importError = $state('');
  let copied = $state(false);
  const bundleIdPattern = /^[A-Za-z0-9.-]{3,200}$/;
  const versionPattern = /^v?\d+(?:\.\d+)*(?:_\d+)?$/i;
  const validation = $derived(entries.map((entry) => {
    const validBundle = bundleIdPattern.test(entry.bundleId.trim());
    const validVersion = versionPattern.test(entry.resolvedVersion.trim());
    const validChannelVersion = entry.source === 'testflight' ? entry.resolvedVersion.includes('_') : !entry.resolvedVersion.includes('_');
    const duplicate = entries.filter((candidate) => candidate.bundleId.trim().toLowerCase() === entry.bundleId.trim().toLowerCase()).length > 1;
    return validBundle && validVersion && validChannelVersion && !duplicate && (!entry.build || /^\d+$/.test(entry.build));
  }));
  const lockfile = $derived.by(() => {
    const apps = Object.fromEntries(entries.filter((entry) => entry.bundleId.trim()).map((entry) => [entry.bundleId.trim(), {
      source: entry.source,
      resolvedVersion: entry.resolvedVersion.trim(),
      ...(entry.build.trim() ? { build: entry.build.trim() } : {}),
    }]).sort(([left], [right]) => String(left).localeCompare(String(right))));
    return `${JSON.stringify({ version: 1, apps }, null, 2)}\n`;
  });
  const canExport = $derived(entries.length > 0 && validation.every(Boolean));

  function updateEntry(index: number, patch: Partial<LockEntry>): void {
    entries = entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...patch } : entry);
  }

  function importLockfile(): void {
    importError = '';
    try {
      const parsed = JSON.parse(importText) as { version?: unknown; apps?: Record<string, { source?: unknown; resolvedVersion?: unknown; build?: unknown }> };
      if (parsed.version !== 1 || !parsed.apps || typeof parsed.apps !== 'object' || Array.isArray(parsed.apps)) throw new Error('Use a version 1 lockfile with an apps object.');
      const loaded = Object.entries(parsed.apps).map(([bundleId, value]) => {
        if (!value || (value.source !== 'appstore' && value.source !== 'testflight') || typeof value.resolvedVersion !== 'string' || (value.build !== undefined && typeof value.build !== 'string')) throw new Error(`Invalid lockfile entry for ${bundleId}.`);
        return { bundleId, source: value.source, resolvedVersion: value.resolvedVersion, build: value.build ?? '' } as LockEntry;
      });
      entries = loaded.length ? loaded : [{ bundleId: '', source: 'appstore', resolvedVersion: '', build: '' }];
    } catch (error) {
      importError = error instanceof Error ? error.message : 'Could not read this lockfile.';
    }
  }

  async function copyLockfile(): Promise<void> {
    await navigator.clipboard.writeText(lockfile);
    copied = true;
    setTimeout(() => copied = false, 1800);
  }

  function downloadLockfile(): void {
    const url = URL.createObjectURL(new Blob([lockfile], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'dkrypt.lock';
    link.click();
    URL.revokeObjectURL(url);
  }
</script>

<Card title="Pinned release lockfile">
  <p class="text-xs text-muted">Create or edit the <code>dkrypt.lock</code> file used by the GitHub Action. TestFlight pins must include the exact version and build selector, such as <code>352.0_118977</code>.</p>
  <div class="mt-3 space-y-2">
    {#each entries as entry, index (index)}
      <div class="grid gap-2 rounded-lg border border-border/70 p-3 sm:grid-cols-[minmax(10rem,1.4fr)_8rem_minmax(8rem,1fr)_7rem_auto] sm:items-end">
        <label class="grid gap-1 text-[11px]">Bundle ID<Input bind:value={entry.bundleId} oninput={(event) => updateEntry(index, { bundleId: event.currentTarget.value })} placeholder="com.example.app" aria-invalid={!validation[index] && Boolean(entry.bundleId)} /></label>
        <label class="grid gap-1 text-[11px]">Source<select class="h-9 rounded-md border border-border bg-background px-2 text-xs" value={entry.source} onchange={(event) => updateEntry(index, { source: event.currentTarget.value as LockEntry['source'] })}><option value="appstore">App Store</option><option value="testflight">TestFlight</option></select></label>
        <label class="grid gap-1 text-[11px]">Resolved version<Input bind:value={entry.resolvedVersion} oninput={(event) => updateEntry(index, { resolvedVersion: event.currentTarget.value })} placeholder={entry.source === 'testflight' ? '352.0_118977' : '350.0'} aria-invalid={!validation[index] && Boolean(entry.resolvedVersion)} /></label>
        <label class="grid gap-1 text-[11px]">Build (optional)<Input bind:value={entry.build} oninput={(event) => updateEntry(index, { build: event.currentTarget.value })} placeholder="118977" aria-invalid={Boolean(entry.build) && !/^\d+$/.test(entry.build)} /></label>
        <Button size="icon" variant="ghost" aria-label="Remove app" disabled={entries.length === 1} onclick={() => entries = entries.filter((_, entryIndex) => entryIndex !== index)}><Trash2 class="size-4" /></Button>
      </div>
    {/each}
  </div>
  {#if entries.some((entry, index) => !validation[index] && (entry.bundleId || entry.resolvedVersion || entry.build))}<p class="mt-2 text-xs text-err" role="alert">Check bundle IDs, unique entries, numeric build numbers, and exact source-specific version formats.</p>{/if}
  <div class="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="secondary" onclick={() => entries = [...entries, { bundleId: '', source: 'appstore', resolvedVersion: '', build: '' }]}><Plus class="size-3.5" />Add app</Button><Button size="sm" variant="secondary" disabled={!canExport} onclick={() => void copyLockfile()}>{#if copied}<Check class="size-3.5" />Copied{:else}<Copy class="size-3.5" />Copy lockfile{/if}</Button><Button size="sm" variant="secondary" disabled={!canExport} onclick={downloadLockfile}><Download class="size-3.5" />Download</Button></div>
  <pre class="mt-3 max-h-64 overflow-auto rounded-lg border border-border/70 bg-background p-3 font-mono text-[11px] leading-5">{lockfile}</pre>
  <details class="mt-3 rounded-lg border border-border/70 p-3"><summary class="cursor-pointer text-xs font-medium">Load an existing lockfile</summary><textarea class="mt-2 min-h-24 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px]" bind:value={importText} aria-label="Existing dkrypt lockfile JSON"></textarea>{#if importError}<p class="mt-1 text-xs text-err" role="alert">{importError}</p>{/if}<Button class="mt-2" size="sm" variant="secondary" onclick={importLockfile}>Load into editor</Button></details>
</Card>
