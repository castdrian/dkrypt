<script lang="ts">
  import { ArrowDown, ArrowUp, Pin, PinOff } from 'lucide-svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import HomeLayoutSettings from '#features/settings/HomeLayoutSettings.svelte';
  import { artifactFilenameTemplateState, artifactLibraryPreferencesState, displayTimeZoneState, largeTargetsState, navigationPreferencesState, type ArtifactColumnId, type TabId } from '#lib/ui.svelte';
  import { pushArtifactFilenameTemplate, pushArtifactLibraryPreferences, pushDisplayTimeZonePref, pushLargeTargetsPref, pushNavigationPreferences, pushShortcutBindings } from '#lib/session.svelte';
  import { DEFAULT_SHORTCUT_BINDINGS, shortcutBindingsState, type ShortcutAction, type ShortcutBindings } from '#lib/shortcuts.svelte';
  import { showToast } from '#lib/ui.svelte';

  const shortcutLabels: Record<ShortcutAction, string> = { palette: 'Command palette', focusSearch: 'Focus search', batch: 'Batch decrypt', help: 'Shortcut help', jumpPrefix: 'Navigation prefix', home: 'Home', billing: 'Plans', keys: 'API keys', logs: 'Logs', insights: 'Insights', docs: 'Docs', settings: 'Settings' };
  let shortcutDraft = $state<ShortcutBindings>({ ...DEFAULT_SHORTCUT_BINDINGS });
  let shortcutBusy = $state(false);
  let filenameDraft = $state('{app}-{version}');
  let filenameBusy = $state(false);

  $effect(() => {
    filenameDraft = artifactFilenameTemplateState.value;
  });

  async function saveFilenameTemplate(): Promise<void> {
    filenameBusy = true;
    try {
      await pushArtifactFilenameTemplate(filenameDraft);
      showToast('Download filename template saved');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not save filename template', 'error');
    } finally {
      filenameBusy = false;
    }
  }

  $effect(() => {
    shortcutDraft = { ...shortcutBindingsState.value };
  });

  async function saveShortcuts(bindings: ShortcutBindings): Promise<void> {
    shortcutBusy = true;
    try {
      await pushShortcutBindings(bindings);
      showToast('Keyboard shortcuts saved', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not save shortcuts', 'error');
    } finally {
      shortcutBusy = false;
    }
  }

  const tabLabels: Record<TabId, string> = {
    home: 'Home',
    billing: 'Plans',
    keys: 'API keys',
    logs: 'Logs',
    insights: 'Insights',
    docs: 'Docs',
    settings: 'Settings',
  };
  const columnLabels: Record<ArtifactColumnId, string> = {
    app: 'App name',
    bundleId: 'Bundle ID',
    version: 'Version',
    source: 'Source',
    size: 'Size',
    created: 'Added',
  };
  const timeZones = [...new Set([
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    'UTC',
    ...(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []),
  ])].sort((left, right) => left.localeCompare(right));

  function moveNavigation(index: number, offset: -1 | 1): void {
    const order = [...navigationPreferencesState.order];
    const target = index + offset;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    void pushNavigationPreferences(order, navigationPreferencesState.pinned);
  }

  function togglePinned(id: TabId): void {
    const pinned = navigationPreferencesState.pinned.includes(id)
      ? navigationPreferencesState.pinned.filter((candidate) => candidate !== id)
      : [...navigationPreferencesState.pinned, id];
    void pushNavigationPreferences(navigationPreferencesState.order, pinned);
  }

  function toggleColumn(id: ArtifactColumnId): void {
    const columns = artifactLibraryPreferencesState.columns.includes(id)
      ? artifactLibraryPreferencesState.columns.filter((candidate) => candidate !== id)
      : [...artifactLibraryPreferencesState.columns, id];
    if (columns.length === 0) return;
    void pushArtifactLibraryPreferences(artifactLibraryPreferencesState.groupByApp, columns);
  }

  function moveColumn(id: ArtifactColumnId, offset: -1 | 1): void {
    const columns = [...artifactLibraryPreferencesState.columns];
    const index = columns.indexOf(id);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= columns.length) return;
    [columns[index], columns[target]] = [columns[target]!, columns[index]!];
    void pushArtifactLibraryPreferences(artifactLibraryPreferencesState.groupByApp, columns);
  }
</script>

<div class="grid gap-5 xl:grid-cols-2">
  <HomeLayoutSettings />
  <section class="rounded-xl border border-border/70 bg-panel/40 p-4">
    <h2 class="text-sm font-semibold">Display</h2>
    <label for="display-time-zone" class="mt-4 block text-xs font-medium">Dashboard time zone</label>
    <select
      id="display-time-zone"
      class="mt-1.5 min-h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
      value={displayTimeZoneState.value}
      onchange={(event) => void pushDisplayTimeZonePref(event.currentTarget.value)}
    >
      <option value="system">System local time</option>
      {#each timeZones as timeZone (timeZone)}<option value={timeZone}>{timeZone}</option>{/each}
    </select>
    <label class="mt-4 flex min-h-11 items-center justify-between gap-3 text-sm">
      <span>Larger touch targets</span>
      <input type="checkbox" class="size-5 accent-accent" checked={largeTargetsState.value} onchange={(event) => void pushLargeTargetsPref(event.currentTarget.checked)} />
    </label>
  </section>

  <section class="rounded-xl border border-border/70 bg-panel/40 p-4">
    <h2 class="text-sm font-semibold">Artifact Library</h2>
    <label for="artifact-filename-template" class="mt-4 block text-xs font-medium">IPA download filename</label>
    <p class="mt-1 text-xs text-muted">Use {'{app}'}, {'{version}'}, {'{build}'}, and {'{source}'}. App uses the bundle ID.</p>
    <div class="mt-2 flex flex-wrap gap-2">
      <input id="artifact-filename-template" class="min-h-10 min-w-0 flex-1 rounded-md border border-border bg-background px-3 font-mono text-sm" maxlength="120" bind:value={filenameDraft} />
      <Button size="sm" loading={filenameBusy} onclick={() => void saveFilenameTemplate()}>Save</Button>
    </div>
    <label class="mt-4 flex min-h-11 items-center justify-between gap-3 text-sm">
      <span>Group versions by app</span>
      <input type="checkbox" class="size-5 accent-accent" checked={artifactLibraryPreferencesState.groupByApp} onchange={(event) => void pushArtifactLibraryPreferences(event.currentTarget.checked, artifactLibraryPreferencesState.columns)} />
    </label>
    <div class="mt-3 text-xs font-medium text-muted">Visible columns</div>
    <div class="mt-1 divide-y divide-border/70">
        {#each Object.entries(columnLabels) as [id, label] (id)}
          <label class="flex min-h-10 items-center gap-3 text-sm">
            <input type="checkbox" class="size-4 accent-accent" checked={artifactLibraryPreferencesState.columns.includes(id as ArtifactColumnId)} disabled={artifactLibraryPreferencesState.columns.length === 1 && artifactLibraryPreferencesState.columns[0] === id} onchange={() => toggleColumn(id as ArtifactColumnId)} />
            <span class="min-w-0 flex-1">{label}</span>
            {#if artifactLibraryPreferencesState.columns.includes(id as ArtifactColumnId)}
              {@const columnIndex = artifactLibraryPreferencesState.columns.indexOf(id as ArtifactColumnId)}
              <Button variant="ghost" size="icon" class="h-8 w-8" aria-label="Move {label} column earlier" disabled={columnIndex === 0} onclick={() => moveColumn(id as ArtifactColumnId, -1)}><ArrowUp class="h-3.5 w-3.5" /></Button>
              <Button variant="ghost" size="icon" class="h-8 w-8" aria-label="Move {label} column later" disabled={columnIndex === artifactLibraryPreferencesState.columns.length - 1} onclick={() => moveColumn(id as ArtifactColumnId, 1)}><ArrowDown class="h-3.5 w-3.5" /></Button>
            {/if}
          </label>
        {/each}
    </div>
  </section>

  <section class="rounded-xl border border-border/70 bg-panel/40 p-4 xl:col-span-2">
    <h2 class="text-sm font-semibold">Navigation</h2>
    <p class="mt-1 text-xs text-muted">Pin frequently used pages and arrange their order.</p>
    <ol class="mt-3 divide-y divide-border/70">
      {#each navigationPreferencesState.order as id, index (id)}
        <li class="flex min-h-12 items-center gap-2">
          <span class="min-w-0 flex-1 truncate text-sm">{tabLabels[id]}</span>
          <Button variant="ghost" size="icon" class="h-10 w-10" aria-label="Move {tabLabels[id]} earlier" disabled={index === 0} onclick={() => moveNavigation(index, -1)}><ArrowUp class="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" class="h-10 w-10" aria-label="Move {tabLabels[id]} later" disabled={index === navigationPreferencesState.order.length - 1} onclick={() => moveNavigation(index, 1)}><ArrowDown class="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" class="h-10 w-10" aria-label={navigationPreferencesState.pinned.includes(id) ? `Unpin ${tabLabels[id]}` : `Pin ${tabLabels[id]}`} aria-pressed={navigationPreferencesState.pinned.includes(id)} onclick={() => togglePinned(id)}>
            {#if navigationPreferencesState.pinned.includes(id)}<PinOff class="h-4 w-4" />{:else}<Pin class="h-4 w-4" />{/if}
          </Button>
        </li>
      {/each}
    </ol>
  </section>

  <section class="rounded-xl border border-border/70 bg-panel/40 p-4 xl:col-span-2">
    <h2 class="text-sm font-semibold">Keyboard shortcuts</h2>
    <p class="mt-1 text-xs text-muted">Use one lowercase key for actions and navigation. The command palette also accepts Mod+K. Conflicting and browser-reserved keys are rejected.</p>
    <div class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {#each Object.entries(shortcutLabels) as [action, label] (action)}
        <label class="block text-xs"><span class="mb-1 block text-muted">{label}</span><input class="min-h-10 w-full rounded-md border border-border bg-background px-3 font-mono text-sm" maxlength="8" value={shortcutDraft[action as ShortcutAction]} oninput={(event) => shortcutDraft = { ...shortcutDraft, [action]: event.currentTarget.value }} /></label>
      {/each}
    </div>
    <div class="mt-3 flex gap-2"><Button size="sm" loading={shortcutBusy} onclick={() => void saveShortcuts(shortcutDraft)}>Save shortcuts</Button><Button size="sm" variant="secondary" loading={shortcutBusy} onclick={() => void saveShortcuts({ ...DEFAULT_SHORTCUT_BINDINGS })}>Reset defaults</Button></div>
  </section>
</div>
