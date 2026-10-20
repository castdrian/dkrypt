<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { Archive, ArchiveRestore, Download, Grid2X2, List, Pin, PinOff, RefreshCw, X } from 'lucide-svelte';
  import AppIcon from '#components/AppIcon.svelte';
  import EmptyState from '#components/EmptyState.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import { downloadDashboardArtifactsZip, fetchArtifacts, observeArtifacts, setDashboardArtifactArchived, setDashboardArtifactPinned, setDashboardArtifactsArchived, setDashboardArtifactsArchivedByQuery, setDashboardArtifactsPinned, setDashboardArtifactsPinnedByQuery, undoDashboardArtifactChanges, type ArtifactRecord, type ArtifactUndoChange } from '#lib/api';
  import { appDisplayName, appIconUrl, ensureAppCatalog } from '#lib/appCatalog.svelte';
  import { fmtBytesGB, fmtSize } from '#lib/format.svelte';
  import { createSavedViews } from '#lib/savedViews.svelte';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasPermission } from '#lib/session.svelte';
  import { isServerQueryCancelled, mergeServerPage, serverQueryStatus } from '#lib/serverStateCache.svelte';
  import { projectSelectionState } from '#lib/projectSelection.svelte';
  import VirtualizedList from '#components/VirtualizedList.svelte';
  import { artifactDetailJumpState, artifactLibraryPreferencesState, homeViewModesState } from '#lib/ui.svelte';
  import { pushHomeViewMode } from '#lib/session.svelte';
  import { interfaceLanguageState, systemLocalesState } from '#lib/ui.svelte';
  import { resolveInterfaceLanguage } from '#lib/locale';
  import { translateMessage } from '#lib/messages';
  import { showToast } from '#lib/ui.svelte';
  import { startBackgroundTask, updateBackgroundTask } from '#lib/backgroundTasks.svelte';
  import { getQueryParam, setQueryParams } from '#lib/urlState';
  import ArtifactLibraryRow from '#features/artifacts/ArtifactLibraryRow.svelte';
  import ArtifactCompareDialog from '#features/artifacts/ArtifactCompareDialog.svelte';

  type ArtifactSourceFilter = 'all' | ArtifactRecord['channel'];

  interface ArtifactFilterPreset {
    name: string;
    query: string;
    channel: ArtifactSourceFilter;
    archived?: boolean;
  }

  const ARTIFACT_SOURCE_OPTIONS = [
    { value: 'all', label: 'All sources' },
    { value: 'appstore', label: 'App Store' },
    { value: 'testflight', label: 'TestFlight' },
  ];
  const ARTIFACT_STATUS_OPTIONS = [
    { value: 'active', label: 'Active' },
    { value: 'archived', label: 'Archived' },
  ];
  const savedViews = createSavedViews<ArtifactFilterPreset>('artifactFilterPresets');

  const canDecrypt = $derived(sessionHasPermission(PermissionFlag.requestDecrypt));
  const canManageStorage = $derived(sessionHasPermission(PermissionFlag.manageAutomation));
  let artifacts = $state<ArtifactRecord[]>([]);
  let total = $state(0);
  let totalBytes = $state(0);
  let maxBytes = $state(0);
  let query = $state(getQueryParam('aq') ?? '');
  let channelFilter = $state<ArtifactSourceFilter>(getQueryParam('asource') === 'appstore' || getQueryParam('asource') === 'testflight' ? getQueryParam('asource') as ArtifactSourceFilter : 'all');
  let archiveFilter = $state<'active' | 'archived'>(getQueryParam('astatus') === 'archived' ? 'archived' : 'active');
  let newFilterName = $state('');
  let loading = $state(false);
  let loadingMore = $state(false);
  let updatingArtifactIds = $state<string[]>([]);
  let selectedArtifactIds = $state<Set<string>>(new Set());
  let selectingArtifacts = $state(false);
  let selectAllMatching = $state(false);
  let zipBusy = $state(false);
  let comparisonOpen = $state(false);
  let comparisonIds = $state<[string, string]>(['', '']);
  let collapsedArtifactGroups = $state<Set<string>>(new Set());
  let bulkUpdating = $state(false);
  let nextCursor = $state<string | undefined>(undefined);
  let error = $state('');
  let refreshError = $state('');
  let archiveAnnouncement = $state('');
  let stopObservingArtifacts: (() => void) | undefined;
  let artifactLoadVersion = 0;
  let artifactPageVersion = 0;
  let activeArtifactQueryKey = '';
  const artifactGroups = $derived.by(() => {
    const groups = new Map<string, { bundleId: string; artifacts: ArtifactRecord[] }>();
    for (const artifact of artifacts) {
      const group = groups.get(artifact.bundleId) ?? { bundleId: artifact.bundleId, artifacts: [] };
      group.artifacts.push(artifact);
      groups.set(artifact.bundleId, group);
    }
    return [...groups.values()];
  });
  const selectedArtifactBytes = $derived(artifacts.filter((artifact) => selectedArtifactIds.has(artifact.id)).reduce((sum, artifact) => sum + artifact.fileSizeBytes, 0));

  function createArtifactQuery(cursorOrOffset?: string | number) {
    return {
      cursorOrOffset,
      limit: 50,
      q: query.trim() || undefined,
      channel: channelFilter === 'all' ? undefined : channelFilter,
      archived: archiveFilter === 'archived',
    };
  }

  function currentArtifactQueryKey(): string {
    return JSON.stringify([projectSelectionState.id, createArtifactQuery()]);
  }

  async function load(force = false): Promise<void> {
    if (!canDecrypt) return;
    const loadVersion = ++artifactLoadVersion;
    artifactPageVersion += 1;
    loadingMore = false;
    stopObservingArtifacts?.();
    loading = true;
    error = '';
    nextCursor = undefined;
    const artifactQuery = createArtifactQuery();
    const artifactQueryKey = currentArtifactQueryKey();
    const previousArtifactQueryKey = activeArtifactQueryKey;
    if (artifactQueryKey !== previousArtifactQueryKey || force) {
      selectedArtifactIds = new Set();
      selectAllMatching = false;
    }
    activeArtifactQueryKey = artifactQueryKey;
    const request = fetchArtifacts(artifactQuery, force);
    const applyPage = (result: Awaited<ReturnType<typeof fetchArtifacts>>) => {
      artifacts = force
        ? result.artifacts
        : mergeServerPage(result.artifacts, artifacts, previousArtifactQueryKey, artifactQueryKey);
      total = result.total;
      totalBytes = result.totalBytes;
      maxBytes = result.maxBytes;
      nextCursor = result.nextCursor;
    };
    stopObservingArtifacts = observeArtifacts(artifactQuery, (snapshot) => {
      if (loadVersion !== artifactLoadVersion) return;
      if (snapshot.data) {
        applyPage(snapshot.data);
        refreshError = snapshot.error ? serverQueryStatus(snapshot) : '';
        if (!snapshot.error) error = '';
      } else {
        refreshError = '';
        artifacts = [];
        total = 0;
        totalBytes = 0;
        maxBytes = 0;
        nextCursor = undefined;
      }
      loading = snapshot.isFetching;
    });
    try {
      const result = await request;
      if (loadVersion !== artifactLoadVersion || artifactQueryKey !== currentArtifactQueryKey()) return;
      applyPage(result);
      loading = false;
      refreshError = '';
    } catch (err) {
      if (loadVersion === artifactLoadVersion && !isServerQueryCancelled(err)) error = err instanceof Error ? err.message : 'Failed to load artifacts';
    }
  }

  onDestroy(() => {
    artifactLoadVersion += 1;
    artifactPageVersion += 1;
    stopObservingArtifacts?.();
  });

  async function loadMore(): Promise<void> {
    if (loadingMore || !nextCursor) return;
    loadingMore = true;
    const loadVersion = artifactLoadVersion;
    const pageVersion = ++artifactPageVersion;
    const queryKey = activeArtifactQueryKey;
    const artifactQuery = createArtifactQuery(nextCursor);
    try {
      const result = await fetchArtifacts(artifactQuery);
      if (
        loadVersion !== artifactLoadVersion ||
        pageVersion !== artifactPageVersion ||
        queryKey !== activeArtifactQueryKey ||
        queryKey !== currentArtifactQueryKey()
      ) return;
      const seenIds = new Set(artifacts.map((artifact) => artifact.id));
      artifacts = [...artifacts, ...result.artifacts.filter((artifact) => !seenIds.has(artifact.id))];
      total = result.total;
      totalBytes = result.totalBytes;
      maxBytes = result.maxBytes;
      nextCursor = result.nextCursor;
    } catch (err) {
      if (loadVersion === artifactLoadVersion && !isServerQueryCancelled(err)) error = err instanceof Error ? err.message : 'Failed to load more artifacts';
    } finally {
      if (pageVersion === artifactPageVersion) loadingMore = false;
    }
  }

  $effect(() => {
    projectSelectionState.id;
    if (canDecrypt) untrack(() => void load());
  });

  $effect(() => {
    setQueryParams({
      aq: query.trim() || undefined,
      asource: channelFilter === 'all' ? undefined : channelFilter,
      astatus: archiveFilter === 'active' ? undefined : archiveFilter,
    });
  });

  $effect(() => {
    if (canDecrypt) void ensureAppCatalog(artifacts.map((artifact) => artifact.bundleId));
  });


  function estimateArtifactRowHeight(_artifact: ArtifactRecord): number {
    const width = typeof window === 'undefined' ? 1024 : window.innerWidth;
    const compact = width < 640;
    return compact ? 164 : width < 1024 ? 142 : 116;
  }

  const interfaceLanguage = $derived(resolveInterfaceLanguage(interfaceLanguageState.value, systemLocalesState.value));
  const viewMessage = (key: 'viewMode.label' | 'viewMode.list' | 'viewMode.cards') => translateMessage(key, interfaceLanguage);

  function applySavedFilter(preset: ArtifactFilterPreset): void {
    query = preset.query;
    channelFilter = preset.channel;
    archiveFilter = preset.archived ? 'archived' : 'active';
    void load(true);
  }

  function saveCurrentFilter(): void {
    const name = newFilterName.trim().slice(0, 40);
    if (!name) return;
    savedViews.save({ name, query: query.trim(), channel: channelFilter, archived: archiveFilter === 'archived' });
    newFilterName = '';
  }

  function removeSavedFilter(name: string): void {
    savedViews.remove(name);
  }

  function focusArchiveStatus(): void {
    document.getElementById('artifact-archive-status')?.focus();
  }

  async function toggleArtifactPin(artifact: ArtifactRecord): Promise<void> {
    if (updatingArtifactIds.includes(artifact.id)) return;
    updatingArtifactIds = [...updatingArtifactIds, artifact.id];
    try {
      const result = await setDashboardArtifactPinned(artifact.id, artifact.pinnedAt === undefined);
      if (!result.ok) return;
      const expectedCurrentState = result.data.pinned;
      artifacts = artifacts.map((candidate) => candidate.id === artifact.id
        ? { ...candidate, pinnedAt: result.data.pinnedAt, pinnedStateChangedAt: result.data.pinnedStateChangedAt }
        : candidate);
      if (result.data.changed && result.data.pinnedStateChangedAt !== undefined) {
        const change: ArtifactUndoChange = {
          id: artifact.id,
          kind: 'pin',
          expectedStateChangedAt: result.data.pinnedStateChangedAt,
          expectedCurrentState,
          restoreAt: result.data.previousPinnedAt,
        };
        offerUndo([change], artifact.pinnedAt === undefined ? 'undo.artifactPinned' : 'undo.artifactUnpinned');
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not update artifact protection';
    } finally {
      updatingArtifactIds = updatingArtifactIds.filter((id) => id !== artifact.id);
    }
  }

  async function toggleArtifactArchived(artifact: ArtifactRecord): Promise<void> {
    if (updatingArtifactIds.includes(artifact.id)) return;
    updatingArtifactIds = [...updatingArtifactIds, artifact.id];
    error = '';
    const archived = artifact.archivedAt === undefined;
    try {
      const result = await setDashboardArtifactArchived(artifact.id, archived);
      if (result.ok) {
        if (result.data.changed && result.data.archived !== (archiveFilter === 'archived')) {
          artifacts = artifacts.filter((candidate) => candidate.id !== artifact.id);
          total = Math.max(0, total - 1);
        }
        const nextSelectedIds = new Set(selectedArtifactIds);
        nextSelectedIds.delete(artifact.id);
        selectedArtifactIds = nextSelectedIds;
        archiveAnnouncement = `${archived ? 'Archived' : 'Restored'} ${appDisplayName(artifact.bundleId)}.`;
        focusArchiveStatus();
        if (result.data.changed && result.data.archivedStateChangedAt !== undefined) {
          offerUndo([{
            id: artifact.id,
            kind: 'archive',
            expectedStateChangedAt: result.data.archivedStateChangedAt,
            expectedCurrentState: result.data.archived,
            restoreAt: result.data.previousArchivedAt,
          }], archived ? 'undo.artifactArchived' : 'undo.artifactRestored');
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not update artifact archive status';
    } finally {
      updatingArtifactIds = updatingArtifactIds.filter((id) => id !== artifact.id);
    }
  }

  function offerUndo(changes: ArtifactUndoChange[], messageKey: 'undo.artifactArchived' | 'undo.artifactRestored' | 'undo.artifactPinned' | 'undo.artifactUnpinned'): void {
    showToast(translateMessage(messageKey, interfaceLanguage), 'success', {
      duration: 8000,
      action: {
        label: translateMessage('undo.action', interfaceLanguage),
        onClick: () => void undoChanges(changes),
      },
    });
  }

  async function undoChanges(changes: ArtifactUndoChange[]): Promise<void> {
    const result = await undoDashboardArtifactChanges(changes);
    if (!result.ok) return;
    if (result.data.conflictIds.length > 0) showToast(translateMessage('undo.conflict', interfaceLanguage), 'error');
    if (result.data.undoneIds.length > 0) await load(true);
  }

  function toggleArtifactSelection(artifactId: string, selected: boolean): void {
    const next = new Set(selectedArtifactIds);
    if (selected && next.size >= 100 && !next.has(artifactId)) {
      error = 'Select up to 100 artifacts at a time';
      return;
    }
    if (selected) next.add(artifactId);
    else next.delete(artifactId);
    selectedArtifactIds = next;
    error = '';
  }

  function toggleAllLoadedArtifacts(): void {
    const allLoadedSelected = artifacts.length > 0 && artifacts.every((artifact) => selectedArtifactIds.has(artifact.id));
    if (allLoadedSelected) {
      selectedArtifactIds = new Set();
      selectAllMatching = false;
      error = '';
      return;
    }
    const next = new Set([...selectedArtifactIds, ...artifacts.map((artifact) => artifact.id)]);
    if (next.size > 100) {
      error = 'Select up to 100 artifacts at a time';
      return;
    }
    selectedArtifactIds = next;
    selectAllMatching = false;
    error = '';
  }

  function selectAllMatchingArtifacts(): void {
    if (total > 5000) {
      error = 'Narrow this filter to 5,000 artifacts or fewer before selecting all matching';
      return;
    }
    selectedArtifactIds = new Set();
    selectAllMatching = true;
    error = '';
  }

  function clearArtifactSelection(): void {
    selectedArtifactIds = new Set();
    selectAllMatching = false;
  }

  function toggleArtifactSelectionMode(): void {
    if (selectingArtifacts) clearArtifactSelection();
    selectingArtifacts = !selectingArtifacts;
  }

  function currentSelectionFilter() {
    return {
      projectId: projectSelectionState.id,
      q: query.trim() || undefined,
      channel: channelFilter === 'all' ? undefined : channelFilter,
      archived: archiveFilter === 'archived',
    };
  }

  async function downloadSelectedZip(): Promise<void> {
    if (zipBusy || selectAllMatching || selectedArtifactIds.size === 0) return;
    const taskId = startBackgroundTask('export', `Export ${selectedArtifactIds.size} artifacts`, 'Preparing ZIP archive', '/?tab=home');
    zipBusy = true;
    error = '';
    try {
      await downloadDashboardArtifactsZip([...selectedArtifactIds]);
      updateBackgroundTask(taskId, 'complete', 'ZIP downloaded');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not export selected artifacts';
      updateBackgroundTask(taskId, 'failed', 'ZIP export failed', error);
    } finally {
      zipBusy = false;
    }
  }

  function openArtifactComparison(): void {
    if (selectedArtifactIds.size !== 2) return;
    comparisonIds = [...selectedArtifactIds] as [string, string];
    comparisonOpen = true;
  }

  async function bulkSetPinned(pinned: boolean): Promise<void> {
    if (bulkUpdating || (!selectAllMatching && selectedArtifactIds.size === 0)) return;
    const taskId = startBackgroundTask('bulk', pinned ? 'Pin artifacts' : 'Unpin artifacts', 'Applying selection', '/?tab=home');
    bulkUpdating = true;
    error = '';
    try {
      const previousById = new Map(artifacts.filter((artifact) => selectedArtifactIds.has(artifact.id)).map((artifact) => [artifact.id, artifact]));
      const result = selectAllMatching
        ? await setDashboardArtifactsPinnedByQuery(currentSelectionFilter(), pinned)
        : await setDashboardArtifactsPinned([...selectedArtifactIds], pinned);
      if (!result.ok) {
        updateBackgroundTask(taskId, 'failed', 'Bulk pin change failed');
        return;
      }
      updateBackgroundTask(taskId, 'complete', `Updated ${result.data.changedIds.length} artifacts`);
      const updatedById = new Map(result.data.artifacts.map((artifact) => [artifact.artifactId, artifact]));
      artifacts = artifacts.map((artifact) => {
        const updated = updatedById.get(artifact.id);
        return updated ? { ...artifact, pinnedAt: updated.pinnedAt, pinnedStateChangedAt: updated.pinnedStateChangedAt } : artifact;
      });
      const changes = result.data.artifacts.filter((updated) => result.data.changedIds.includes(updated.artifactId)).flatMap((updated) => {
        const previous = previousById.get(updated.artifactId);
        if (updated.pinnedStateChangedAt === undefined || (!previous && !selectAllMatching)) return [];
        return [{ id: updated.artifactId, kind: 'pin' as const, expectedStateChangedAt: updated.pinnedStateChangedAt, expectedCurrentState: updated.pinned, restoreAt: updated.previousPinnedAt }];
      });
      if (changes.length > 0) offerUndo(changes, pinned ? 'undo.artifactPinned' : 'undo.artifactUnpinned');
      selectedArtifactIds = new Set();
      selectAllMatching = false;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not update the selected artifacts';
      updateBackgroundTask(taskId, 'failed', 'Bulk pin change failed', error);
    } finally {
      bulkUpdating = false;
    }
  }

  async function bulkSetArchived(archived: boolean): Promise<void> {
    if (bulkUpdating || (!selectAllMatching && selectedArtifactIds.size === 0)) return;
    const taskId = startBackgroundTask('bulk', archived ? 'Archive artifacts' : 'Restore artifacts', 'Applying selection', '/?tab=home');
    const querySelection = selectAllMatching;
    bulkUpdating = true;
    error = '';
    try {
      const previousById = new Map(artifacts.filter((artifact) => selectedArtifactIds.has(artifact.id)).map((artifact) => [artifact.id, artifact]));
      const result = selectAllMatching
        ? await setDashboardArtifactsArchivedByQuery(currentSelectionFilter(), archived)
        : await setDashboardArtifactsArchived([...selectedArtifactIds], archived);
      if (!result.ok) {
        updateBackgroundTask(taskId, 'failed', 'Bulk archive change failed');
        return;
      }
      updateBackgroundTask(taskId, 'complete', `Updated ${result.data.changedIds.length} artifacts`);
      selectedArtifactIds = new Set();
      selectAllMatching = false;
      const count = result.data.changedIds.length;
      archiveAnnouncement = `${archived ? 'Archived' : 'Restored'} ${count} ${count === 1 ? 'artifact' : 'artifacts'}.`;
      focusArchiveStatus();
      const changedIds = new Set(result.data.changedIds);
      const hiddenArtifacts = artifacts.filter((artifact) => changedIds.has(artifact.id) && result.data.archived !== (archiveFilter === 'archived'));
      if (hiddenArtifacts.length > 0) {
        artifacts = artifacts.filter((artifact) => !changedIds.has(artifact.id));
        total = Math.max(0, total - hiddenArtifacts.length);
      }
      const changes = result.data.artifacts.filter((updated) => result.data.changedIds.includes(updated.artifactId)).flatMap((updated) => {
        const previous = previousById.get(updated.artifactId);
        if (updated.archivedStateChangedAt === undefined || (!previous && !querySelection)) return [];
        return [{ id: updated.artifactId, kind: 'archive' as const, expectedStateChangedAt: updated.archivedStateChangedAt, expectedCurrentState: updated.archived, restoreAt: updated.previousArchivedAt }];
      });
      if (changes.length > 0) offerUndo(changes, archived ? 'undo.artifactArchived' : 'undo.artifactRestored');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not update the selected artifacts';
      updateBackgroundTask(taskId, 'failed', 'Bulk archive change failed', error);
    } finally {
      bulkUpdating = false;
    }
  }
</script>

{#if canDecrypt}
  <Card class="overflow-hidden">
    <div class="-m-5 overflow-hidden">
      <div class="border-border/70 flex flex-col gap-3 border-b px-4 py-3.5 sm:px-5">
        <span id="artifact-archive-announcement" class="sr-only" role="status" aria-live="polite">{archiveAnnouncement}</span>
        <div class="flex min-w-0 items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <div class="text-sm font-semibold tracking-tight">IPA Library</div>
              <Badge variant="secondary">{total}</Badge>
            </div>
            <div class="text-muted mt-0.5 text-xs">{fmtBytesGB(totalBytes)} / {fmtBytesGB(maxBytes)} used</div>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            {#if artifacts.length > 0}
              <Button variant={selectingArtifacts ? 'secondary' : 'ghost'} size="sm" aria-pressed={selectingArtifacts} onclick={toggleArtifactSelectionMode}>{selectingArtifacts ? 'Done selecting' : 'Select items'}</Button>
            {/if}
            <div class="inline-flex rounded-md border border-border/70 p-0.5" role="group" aria-label={viewMessage('viewMode.label')}>
              <Button variant={homeViewModesState.value.artifacts === 'list' ? 'secondary' : 'ghost'} size="icon" class="h-7 w-7" aria-label={viewMessage('viewMode.list')} aria-pressed={homeViewModesState.value.artifacts === 'list'} onclick={() => void pushHomeViewMode('artifacts', 'list')}><List class="h-3.5 w-3.5" /></Button>
              <Button variant={homeViewModesState.value.artifacts === 'cards' ? 'secondary' : 'ghost'} size="icon" class="h-7 w-7" aria-label={viewMessage('viewMode.cards')} aria-pressed={homeViewModesState.value.artifacts === 'cards'} onclick={() => void pushHomeViewMode('artifacts', 'cards')}><Grid2X2 class="h-3.5 w-3.5" /></Button>
            </div>
            <Button variant="ghost" size="icon" class="text-muted hover:text-foreground h-8 w-8 shrink-0 p-0" disabled={loading} onclick={() => void load(true)} aria-label="Refresh IPA Library" title="Refresh IPA Library">
              <RefreshCw class={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            </Button>
          </div>
        </div>
        <div class="flex w-full min-w-0 flex-wrap items-center gap-2">
          <Input bind:value={query} onkeydown={(event) => event.key === 'Enter' && void load(true)} placeholder="Search apps or versions…" class="min-w-[12rem] flex-1" />
          <Select
            items={ARTIFACT_SOURCE_OPTIONS}
            value={channelFilter}
            onValueChange={(value) => {
              channelFilter = value as ArtifactSourceFilter;
              void load(true);
            }}
            class="w-36 shrink-0"
          />
          <Select
            id="artifact-archive-status"
            items={ARTIFACT_STATUS_OPTIONS}
            value={archiveFilter}
            onValueChange={(value) => {
              archiveFilter = value as 'active' | 'archived';
              void load(true);
            }}
            class="w-32 shrink-0"
          />
        </div>
      </div>

      <div class="p-4 sm:p-5">
        <div class="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Saved library filters">
          {#each savedViews.presets as preset (preset.name)}
            <span class="border-border text-muted hover:text-foreground hover:border-accent inline-flex items-center gap-1 rounded-full border pr-1 pl-2.5 py-1 text-[12px]">
              <Button variant="link" size="sm" class="h-auto p-0 text-xs text-muted" onclick={() => applySavedFilter(preset)}>{preset.name}</Button>
              <Button
                variant="ghost"
                size="icon"
                class="text-muted hover:text-destructive h-6 w-6 rounded-full p-0"
                onclick={() => removeSavedFilter(preset.name)}
                aria-label="Delete saved filter {preset.name}"
                title="Delete saved filter"
              >
                <X class="h-3 w-3" />
              </Button>
            </span>
          {/each}
          <div class="flex items-center gap-1.5">
            <Input
              bind:value={newFilterName}
              maxlength={40}
              placeholder="Name this filter…"
              aria-label="Saved filter name"
              class="h-7 w-36 text-xs"
              onkeydown={(event) => event.key === 'Enter' && saveCurrentFilter()}
            />
            <Button size="sm" variant="secondary" disabled={!newFilterName.trim()} onclick={saveCurrentFilter}>Save filter</Button>
          </div>
        </div>
        {#if refreshError}
          <div class="mb-3 rounded-md border border-border/70 px-3 py-2 text-xs text-muted" role="status" aria-live="polite">{refreshError}</div>
        {/if}
        {#if archiveFilter === 'archived'}
          <div class="mb-3 text-muted text-xs" role="note">Archived items still use library storage and may be removed automatically unless pinned.</div>
        {/if}
        {#if selectingArtifacts && canDecrypt && artifacts.length > 0}
          <div class="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Bulk artifact actions">
            {#if canManageStorage}
              <Button variant="ghost" size="sm" onclick={toggleAllLoadedArtifacts}>
                {artifacts.every((artifact) => selectedArtifactIds.has(artifact.id)) && !selectAllMatching ? 'Clear selection' : 'Select loaded'}
              </Button>
              {#if total > artifacts.length && total <= 5000 && !selectAllMatching}
                <Button variant="ghost" size="sm" onclick={selectAllMatchingArtifacts}>Select all {total} matching</Button>
              {/if}
            {/if}
            {#if selectAllMatching || selectedArtifactIds.size > 0}
              <span class="text-muted text-xs" role="status" aria-live="polite">{selectAllMatching ? `${total} matching artifacts` : `${selectedArtifactIds.size} selected`}</span>
              {#if !selectAllMatching && selectedArtifactIds.size > 0}
                <span class="text-muted text-xs">{fmtSize(selectedArtifactBytes)} selected</span>
                <Button variant="secondary" size="sm" loading={zipBusy} disabled={bulkUpdating} onclick={() => void downloadSelectedZip()}><Download class="h-3.5 w-3.5" />Download ZIP</Button>
                {#if selectedArtifactIds.size === 2}<Button variant="secondary" size="sm" onclick={openArtifactComparison}>Compare IPA contents</Button>{/if}
              {/if}
              {#if canManageStorage}
                <Button variant="secondary" size="sm" loading={bulkUpdating} onclick={() => void bulkSetPinned(true)}><Pin class="h-3.5 w-3.5" />Pin selected</Button>
                <Button variant="secondary" size="sm" loading={bulkUpdating} onclick={() => void bulkSetPinned(false)}><PinOff class="h-3.5 w-3.5" />Unpin selected</Button>
                <Button variant="secondary" size="sm" loading={bulkUpdating} onclick={() => void bulkSetArchived(archiveFilter !== 'archived')}>{#if archiveFilter === 'archived'}<ArchiveRestore class="h-3.5 w-3.5" />Restore selected{:else}<Archive class="h-3.5 w-3.5" />Archive selected{/if}</Button>
              {/if}
              <Button variant="ghost" size="sm" disabled={bulkUpdating || zipBusy} onclick={clearArtifactSelection}>Clear</Button>
            {/if}
          </div>
        {/if}
        {#if error && artifacts.length > 0}
          <div class="text-err mb-3 text-[13px]" role="alert">{error}</div>
        {/if}
        {#if error && artifacts.length === 0}
          <div class="text-err text-[13px]" role="alert">{error}</div>
        {:else if artifacts.length === 0}
          {#if loading}
            <div class="flex flex-col gap-1.5" role="status" aria-label="Loading artifacts">
              {#each Array(3) as _, index (index)}
                <div class="skeleton bg-panel-muted h-20 rounded-md" aria-hidden="true"></div>
              {/each}
            </div>
          {:else}
            <EmptyState message={query.trim() || channelFilter !== 'all' || archiveFilter === 'archived' ? 'No artifacts match these filters.' : 'No IPA artifacts have been saved in this project yet.'} />
          {/if}
        {:else}
          {#if artifactLibraryPreferencesState.groupByApp}
            <div class="space-y-2">
              {#each artifactGroups as group (group.bundleId)}
                <details class="overflow-hidden rounded-xl border border-border/70" open={!collapsedArtifactGroups.has(group.bundleId)} ontoggle={(event) => {
                  const next = new Set(collapsedArtifactGroups);
                  if (event.currentTarget.open) next.delete(group.bundleId);
                  else next.add(group.bundleId);
                  collapsedArtifactGroups = next;
                }}>
                  <summary class="flex min-h-14 cursor-pointer list-none items-center gap-3 bg-panel/40 px-4 py-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring">
                    <AppIcon bundleId={group.bundleId} src={appIconUrl(group.bundleId)} label={appDisplayName(group.bundleId)} class="h-8 w-8" />
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-sm font-semibold">{appDisplayName(group.bundleId)}</span>
                      <span class="text-muted block truncate font-mono text-[11px]" data-sensitive="true">{group.bundleId}</span>
                    </span>
                    <Badge variant="secondary">{group.artifacts.length} {group.artifacts.length === 1 ? 'version' : 'versions'}</Badge>
                  </summary>
                  <VirtualizedList items={group.artifacts} itemKey={(artifact) => artifact.id} estimateSize={estimateArtifactRowHeight} overscan={4} scrollMode="window" label="Versions for {appDisplayName(group.bundleId)}" class={homeViewModesState.value.artifacts === 'list' ? 'divide-y divide-border' : 'space-y-2 p-2'}>
                    {#snippet children(artifact: ArtifactRecord)}
                      <ArtifactLibraryRow artifact={artifact} columns={artifactLibraryPreferencesState.columns} listView={homeViewModesState.value.artifacts === 'list'} {canManageStorage} canSelect={selectingArtifacts} selected={selectAllMatching || selectedArtifactIds.has(artifact.id)} selectionDisabled={bulkUpdating || selectAllMatching || (selectedArtifactIds.size >= 100 && !selectedArtifactIds.has(artifact.id))} updating={updatingArtifactIds.includes(artifact.id)} onSelection={(selected) => toggleArtifactSelection(artifact.id, selected)} onPin={() => void toggleArtifactPin(artifact)} onArchive={() => void toggleArtifactArchived(artifact)} onDetails={() => (artifactDetailJumpState.id = artifact.id)} />
                    {/snippet}
                  </VirtualizedList>
                </details>
              {/each}
            </div>
          {:else}
            <VirtualizedList items={artifacts} itemKey={(artifact) => artifact.id} estimateSize={estimateArtifactRowHeight} overscan={4} scrollMode="window" label="IPA library artifacts" class={homeViewModesState.value.artifacts === 'list' ? 'rounded-xl border border-border/70 divide-y divide-border' : 'space-y-2'}>
              {#snippet children(artifact: ArtifactRecord)}
                <ArtifactLibraryRow artifact={artifact} columns={artifactLibraryPreferencesState.columns} listView={homeViewModesState.value.artifacts === 'list'} {canManageStorage} canSelect={selectingArtifacts} selected={selectAllMatching || selectedArtifactIds.has(artifact.id)} selectionDisabled={bulkUpdating || selectAllMatching || (selectedArtifactIds.size >= 100 && !selectedArtifactIds.has(artifact.id))} updating={updatingArtifactIds.includes(artifact.id)} onSelection={(selected) => toggleArtifactSelection(artifact.id, selected)} onPin={() => void toggleArtifactPin(artifact)} onArchive={() => void toggleArtifactArchived(artifact)} onDetails={() => (artifactDetailJumpState.id = artifact.id)} />
              {/snippet}
            </VirtualizedList>
          {/if}
          {#if nextCursor}
            <div class="mt-3 flex justify-center">
              <Button variant="secondary" size="sm" loading={loadingMore} onclick={() => void loadMore()}>Load more ({Math.max(0, total - artifacts.length)} older)</Button>
            </div>
          {/if}
        {/if}
      </div>
    </div>
</Card>
{/if}
<ArtifactCompareDialog bind:open={comparisonOpen} ids={comparisonIds} />
