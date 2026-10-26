<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Copy, Download, FileSearch, FolderTree, Share2, ShieldCheck } from 'lucide-svelte';
  import AppIcon from '#components/AppIcon.svelte';
  import InspectorPane from '#components/InspectorPane.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import { buttonVariants } from '#lib/components/ui/variants';
  import { fetchDashboardArtifact, fetchDashboardArtifactAnalysis, fetchDashboardArtifactAssetPreview, fetchDashboardArtifactContents, fetchDashboardArtifactNote, updateDashboardArtifactNote, type ArtifactPackageEntry, type ArtifactRecord, type IpaAnalysisReport } from '#lib/api';
  import { appDisplayName, appIconUrl } from '#lib/appCatalog.svelte';
  import { fmtSize, fmtTime } from '#lib/format.svelte';
  import { artifactDetailJumpState } from '#lib/ui.svelte';
  import { setQueryParams } from '#lib/urlState';
  import { showToast } from '#lib/ui.svelte';
  import IpaAnalysisPanel from '#features/artifacts/IpaAnalysisPanel.svelte';

  let artifact = $state<ArtifactRecord | null>(null);
  let open = $state(false);
  let error = $state('');
  let loading = $state(false);
  let contentsOpen = $state(false);
  let contentsLoading = $state(false);
  let contentsError = $state('');
  let contentsQuery = $state('');
  let contentsEntries = $state<ArtifactPackageEntry[]>([]);
  let contentsNextOffset = $state<number | undefined>();
  let contentsTotal = $state(0);
  let analysisOpen = $state(false);
  let analysisLoading = $state(false);
  let analysisError = $state('');
  let analysisReport = $state<IpaAnalysisReport | null>(null);
  let note = $state('');
  let savedNote = $state('');
  let noteLoading = $state(false);
  let noteSaving = $state(false);
  let noteError = $state('');
  let requestVersion = 0;

  async function loadArtifact(id: string): Promise<void> {
    const version = ++requestVersion;
    loading = true;
    error = '';
    open = true;
    try {
      const result = await fetchDashboardArtifact(id);
      if (version === requestVersion) {
        artifact = result;
        contentsOpen = false;
        contentsEntries = [];
        contentsNextOffset = undefined;
        contentsQuery = '';
        analysisOpen = false;
        analysisLoading = false;
        analysisError = '';
        analysisReport = null;
        note = '';
        savedNote = '';
        noteLoading = false;
        noteSaving = false;
        noteError = '';
        setQueryParams({ artifact: id });
        void loadNote(result.id, version);
      }
    } catch (cause) {
      if (version === requestVersion) error = cause instanceof Error ? cause.message : 'Could not load artifact details';
    } finally {
      if (version === requestVersion) loading = false;
    }
  }

  $effect(() => {
    const id = artifactDetailJumpState.id;
    if (id === '') {
      closeInspector(false);
      return;
    }
    if (!id) return;
    artifactDetailJumpState.id = null;
    void loadArtifact(id);
  });

  function closeInspector(next: boolean): void {
    open = next;
    if (!next) {
      requestVersion += 1;
      artifact = null;
      contentsOpen = false;
      contentsEntries = [];
      contentsNextOffset = undefined;
      loading = false;
      error = '';
      analysisOpen = false;
      analysisReport = null;
      analysisError = '';
      note = '';
      savedNote = '';
      noteLoading = false;
      noteSaving = false;
      noteError = '';
      artifactDetailJumpState.id = null;
      setQueryParams({ artifact: undefined });
    }
  }

  async function copyDeepLink(): Promise<void> {
    const url = new URL(location.href);
    url.searchParams.set('artifact', artifact?.id ?? '');
    await navigator.clipboard.writeText(url.toString());
    showToast('Artifact link copied', 'success');
  }

  async function shareArtifact(): Promise<void> {
    const url = new URL(location.href);
    url.searchParams.set('artifact', artifact?.id ?? '');
    try {
      const nativeShare = Reflect.get(navigator, 'share');
      const shared = typeof nativeShare === 'function';
      if (shared) await nativeShare.call(navigator, { title: artifact?.bundleId ?? 'dkrypt IPA', url: url.toString() });
      else await navigator.clipboard.writeText(url.toString());
      showToast(shared ? 'Artifact shared' : 'Artifact link copied', 'success');
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      showToast('Could not share this artifact', 'error');
    }
  }

  async function loadContents(reset = false): Promise<void> {
    if (!artifact) return;
    contentsLoading = true;
    contentsError = '';
    try {
      const page = await fetchDashboardArtifactContents(artifact.id, {
        q: contentsQuery.trim() || undefined,
        offset: reset ? 0 : contentsNextOffset ?? 0,
        limit: 100,
      });
      contentsEntries = reset ? page.entries : [...contentsEntries, ...page.entries];
      contentsNextOffset = page.nextOffset;
      contentsTotal = page.total;
    } catch (cause) {
      contentsError = cause instanceof Error ? cause.message : 'Could not read package contents';
    } finally {
      contentsLoading = false;
    }
  }

  async function toggleContents(): Promise<void> {
    contentsOpen = !contentsOpen;
    if (contentsOpen && contentsEntries.length === 0) await loadContents(true);
  }

  async function loadNote(id: string, version: number): Promise<void> {
    noteLoading = true;
    try {
      const result = await fetchDashboardArtifactNote(id);
      if (version !== requestVersion) return;
      note = result.note;
      savedNote = result.note;
    } catch (cause) {
      if (version === requestVersion) noteError = cause instanceof Error ? cause.message : 'Could not load your private note';
    } finally {
      if (version === requestVersion) noteLoading = false;
    }
  }

  async function saveNote(): Promise<void> {
    if (!artifact || noteSaving) return;
    const artifactId = artifact.id;
    const version = requestVersion;
    const submittedNote = note;
    noteSaving = true;
    noteError = '';
    try {
      const result = await updateDashboardArtifactNote(artifactId, submittedNote);
      if (version !== requestVersion || artifact?.id !== artifactId) return;
      note = result.note;
      savedNote = result.note;
      showToast('Private note saved', 'success');
    } catch (cause) {
      if (version === requestVersion && artifact?.id === artifactId) noteError = cause instanceof Error ? cause.message : 'Could not save your private note';
    } finally {
      if (version === requestVersion && artifact?.id === artifactId) noteSaving = false;
    }
  }

  async function toggleAnalysis(): Promise<void> {
    analysisOpen = !analysisOpen;
    if (!analysisOpen || !artifact || analysisReport || analysisLoading) return;
    analysisLoading = true;
    analysisError = '';
    const version = requestVersion;
    try {
      const result = await fetchDashboardArtifactAnalysis(artifact.id);
      if (version === requestVersion) analysisReport = result.report;
    } catch (cause) {
      if (version === requestVersion) analysisError = cause instanceof Error ? cause.message : 'Could not analyze this IPA';
    } finally {
      if (version === requestVersion) analysisLoading = false;
    }
  }

  onDestroy(() => {
    requestVersion += 1;
  });
</script>

<InspectorPane bind:open title="Artifact details" onOpenChange={closeInspector}>
  {#if loading}
    <div class="py-12 text-center text-sm text-muted" role="status">Loading artifact details…</div>
  {:else if error}
    <div class="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-err" role="alert">{error}</div>
  {:else if artifact}
    <div class="mb-5 flex items-start gap-3">
      <AppIcon bundleId={artifact.bundleId} src={appIconUrl(artifact.bundleId)} label={appDisplayName(artifact.bundleId)} class="h-12 w-12" />
      <div class="min-w-0 flex-1">
        <h2 class="truncate text-lg font-semibold">{appDisplayName(artifact.bundleId)}</h2>
        <div class="mt-1 break-all font-mono text-xs text-muted" data-sensitive="true">{artifact.bundleId}</div>
        <div class="mt-2 flex flex-wrap gap-1.5">
          <Badge variant={artifact.channel === 'testflight' ? 'secondary' : 'default'}>{artifact.channel === 'testflight' ? 'TestFlight' : 'App Store'}</Badge>
          {#if artifact.versionLabel}<Badge variant="outline">{artifact.versionLabel}</Badge>{/if}
          {#if artifact.pinnedAt}<Badge variant="success">Pinned</Badge>{/if}
          {#if artifact.archivedAt}<Badge variant="secondary">Archived</Badge>{/if}
        </div>
      </div>
      <div class="flex shrink-0 gap-1"><Button variant="secondary" size="icon" aria-label="Share artifact" onclick={() => void shareArtifact()}><Share2 class="h-4 w-4" /></Button><Button variant="secondary" size="icon" aria-label="Copy artifact link" onclick={() => void copyDeepLink()}><Copy class="h-4 w-4" /></Button><a href={artifact.fileUrl} download class={buttonVariants('secondary', 'sm')}><Download class="h-3.5 w-3.5" />Download</a></div>
    </div>
    <section class="rounded-xl border border-border/70 p-4" aria-labelledby="artifact-inspector-metadata">
      <h3 id="artifact-inspector-metadata" class="mb-3 flex items-center gap-2 text-sm font-semibold"><FileSearch class="h-4 w-4 text-accent" />Artifact metadata</h3>
      <dl class="grid gap-4 text-xs sm:grid-cols-2">
        <div><dt class="text-muted">Size</dt><dd class="mt-1 font-medium">{fmtSize(artifact.fileSizeBytes)}</dd></div>
        <div><dt class="text-muted">Build</dt><dd class="mt-1 font-medium">{artifact.buildNumber ?? 'Unavailable'}</dd></div>
        <div><dt class="text-muted">Created</dt><dd class="mt-1 font-medium">{fmtTime(Date.parse(artifact.createdAt))}</dd></div>
        <div><dt class="text-muted">Last accessed</dt><dd class="mt-1 font-medium">{fmtTime(Date.parse(artifact.lastAccessedAt))}</dd></div>
        <div><dt class="text-muted">Access count</dt><dd class="mt-1 font-medium">{artifact.accessCount}</dd></div>
        <div><dt class="text-muted">Source job</dt><dd class="mt-1 break-all font-mono" data-sensitive="true">{artifact.sourceJobId ?? 'Unavailable'}</dd></div>
        <div class="sm:col-span-2"><dt class="text-muted">SHA-256</dt><dd class="mt-1 break-all font-mono" data-sensitive="true">{artifact.sha256}</dd></div>
      </dl>
      <details class="mt-4 border-t border-border/70 pt-3 text-xs">
        <summary class="cursor-pointer font-medium focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">What do these IPA terms mean?</summary>
        <dl class="mt-3 space-y-2 text-muted">
          <div><dt class="font-medium text-text">Build</dt><dd>The developer's identifier for this specific release.</dd></div>
          <div><dt class="font-medium text-text">SHA-256</dt><dd>A fingerprint you can use to verify that two IPA files are identical.</dd></div>
          <div><dt class="font-medium text-text">cryptid</dt><dd>An iOS binary flag. A nonzero value means that binary is still encrypted.</dd></div>
          <div><dt class="font-medium text-text">Extensions</dt><dd>Small companion programs bundled with an app. A warning about one does not necessarily mean the main app failed to decrypt.</dd></div>
          <div><dt class="font-medium text-text">Signing</dt><dd>The code signature used by iOS to validate an app. Decrypting does not automatically make an IPA installable on every device.</dd></div>
        </dl>
      </details>
    </section>
    <section class="mt-4 overflow-hidden rounded-xl border border-border/70" aria-labelledby="artifact-inspector-analysis">
      <button id="artifact-inspector-analysis" class="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" aria-expanded={analysisOpen} onclick={() => void toggleAnalysis()}>
        <ShieldCheck class="h-4 w-4 text-accent" /> Executable, signing and asset analysis <span class="ml-auto text-xs font-normal text-muted">{analysisReport ? `${analysisReport.executables.length} binaries` : 'Inspect IPA'}</span>
      </button>
      {#if analysisOpen}
        <div class="border-t border-border/70 p-3">
          {#if analysisLoading}<div class="py-6 text-center text-xs text-muted" role="status">Analyzing package…</div>
          {:else if analysisError}<div class="text-xs text-err" role="alert">{analysisError}</div>
          {:else if analysisReport}<IpaAnalysisPanel report={analysisReport} previewAsset={(assetPath) => fetchDashboardArtifactAssetPreview(artifact!.id, assetPath)} />{/if}
        </div>
      {/if}
    </section>
    <section class="mt-4 rounded-xl border border-border/70 p-4" aria-labelledby="artifact-inspector-note">
      <h3 id="artifact-inspector-note" class="text-sm font-semibold">Your private note</h3>
      <p class="mt-1 text-xs text-muted">Only you can see this note.</p>
      <textarea class="mt-3 min-h-24 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm" maxlength="2000" bind:value={note} disabled={noteLoading || noteSaving} aria-label="Private artifact note" placeholder="Add a note for yourself"></textarea>
      {#if noteError}<p class="mt-2 text-xs text-err" role="alert">{noteError}</p>{/if}
      <div class="mt-2 flex items-center justify-between gap-2">
        <span class="text-[11px] text-muted">{note.length}/2000</span>
        <Button size="sm" variant="secondary" loading={noteSaving || noteLoading} disabled={note === savedNote} onclick={() => void saveNote()}>Save note</Button>
      </div>
    </section>
    <section class="mt-4 overflow-hidden rounded-xl border border-border/70" aria-labelledby="artifact-inspector-contents">
      <button id="artifact-inspector-contents" class="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" aria-expanded={contentsOpen} onclick={() => void toggleContents()}>
        <FolderTree class="h-4 w-4 text-accent" /> Package contents <span class="ml-auto text-xs font-normal text-muted">{contentsOpen ? `${contentsTotal} files` : 'Browse IPA files'}</span>
      </button>
      {#if contentsOpen}
        <div class="border-t border-border/70 p-3">
          <div class="flex gap-2">
            <input class="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm" aria-label="Filter package files" placeholder="Filter paths" bind:value={contentsQuery} onkeydown={(event) => { if (event.key === 'Enter') void loadContents(true); }} />
            <Button size="sm" variant="secondary" loading={contentsLoading} onclick={() => void loadContents(true)}>Search</Button>
          </div>
          {#if contentsError}<div class="mt-3 text-xs text-err" role="alert">{contentsError}</div>
          {:else if contentsLoading && contentsEntries.length === 0}<div class="py-6 text-center text-xs text-muted" role="status">Reading package contents…</div>
          {:else if contentsEntries.length === 0}<div class="py-6 text-center text-xs text-muted">No matching files.</div>
          {:else}
            <ul class="mt-3 max-h-72 space-y-1 overflow-auto font-mono text-[11px]">
              {#each contentsEntries as entry (entry.path)}
                <li class="flex items-start justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-panel-muted/50"><span class="min-w-0 break-all">{entry.path}</span><span class="shrink-0 text-muted">{fmtSize(entry.uncompressedSize)}</span></li>
              {/each}
            </ul>
            {#if contentsNextOffset !== undefined}<Button class="mt-2 w-full" variant="ghost" size="sm" loading={contentsLoading} onclick={() => void loadContents()}>Load more</Button>{/if}
          {/if}
        </div>
      {/if}
    </section>
    {#if artifact.warnings?.length}
      <section class="mt-4 rounded-xl border border-warn/30 bg-warn/5 p-4" aria-labelledby="artifact-inspector-warnings">
        <h3 id="artifact-inspector-warnings" class="text-sm font-semibold text-warn">Decrypt warnings</h3>
        <ul class="mt-2 space-y-2 break-words text-xs text-muted">
          {#each artifact.warnings as warning, index (`${artifact.id}-${index}`)}<li>{warning}</li>{/each}
        </ul>
      </section>
    {/if}
  {:else}
    <div class="py-12 text-center text-sm text-muted">Select an artifact to inspect its details.</div>
  {/if}
</InspectorPane>
