<script lang="ts">
  import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Eye, EyeOff, Plus, RotateCcw, Trash2 } from 'lucide-svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import { DEFAULT_HOME_LAYOUT, moveHomeModule, setHomeModuleCollapsed, setHomeModuleHidden, type HomeLayout, type HomeModuleId } from '#lib/homeLayouts';
  import { translateMessage, type MessageKey } from '#lib/messages';
  import { resolveInterfaceLanguage } from '#lib/locale';
  import { homeLayoutPreferencesState, interfaceLanguageState, showToast, systemLocalesState } from '#lib/ui.svelte';
  import { pushHomeLayoutPreferences } from '#lib/session.svelte';

  let newLayoutName = $state('');
  let renameValue = $state('');
  const interfaceLanguage = $derived(resolveInterfaceLanguage(interfaceLanguageState.value, systemLocalesState.value));
  const msg = (key: MessageKey) => translateMessage(key, interfaceLanguage);
  const layoutTitles: Record<HomeModuleId, MessageKey> = { artifacts: 'home.artifacts', activeJobs: 'home.activeJobs', jobHistory: 'home.jobHistory' };
  const activeLayout = $derived(homeLayoutPreferencesState.layouts.find((layout) => layout.id === homeLayoutPreferencesState.activeId) ?? homeLayoutPreferencesState.layouts[0] ?? DEFAULT_HOME_LAYOUT);
  const hiddenModules = $derived(activeLayout.order.filter((module) => activeLayout.hidden.includes(module)));

  function saveLayouts(layouts: HomeLayout[], activeId = homeLayoutPreferencesState.activeId): void {
    void pushHomeLayoutPreferences(layouts, activeId).catch(() => showToast(msg('home.preferencesFailed'), 'error'));
  }

  function updateActiveLayout(update: (layout: HomeLayout) => HomeLayout): void {
    saveLayouts(homeLayoutPreferencesState.layouts.map((layout) => layout.id === activeLayout.id ? update(layout) : layout));
  }

  function createLayout(): void {
    if (homeLayoutPreferencesState.layouts.length >= 10) return;
    const name = newLayoutName.trim().slice(0, 40);
    if (!name) return;
    if (homeLayoutPreferencesState.layouts.some((layout) => layout.name.trim().toLowerCase() === name.toLowerCase())) {
      showToast(msg('home.layoutNameTaken'), 'error');
      return;
    }
    const layout: HomeLayout = { ...activeLayout, id: crypto.randomUUID(), name, order: [...activeLayout.order], hidden: [...activeLayout.hidden], collapsed: [...activeLayout.collapsed] };
    newLayoutName = '';
    saveLayouts([...homeLayoutPreferencesState.layouts, layout], layout.id);
  }

  function renameLayout(): void {
    const name = renameValue.trim().slice(0, 40);
    if (!name) return;
    if (homeLayoutPreferencesState.layouts.some((layout) => layout.id !== activeLayout.id && layout.name.trim().toLowerCase() === name.toLowerCase())) {
      showToast(msg('home.layoutNameTaken'), 'error');
      return;
    }
    updateActiveLayout((layout) => ({ ...layout, name }));
  }

  function deleteLayout(): void {
    if (homeLayoutPreferencesState.layouts.length <= 1 || activeLayout.id === 'default') return;
    const layouts = homeLayoutPreferencesState.layouts.filter((layout) => layout.id !== activeLayout.id);
    saveLayouts(layouts, layouts[0]!.id);
  }

  $effect(() => { renameValue = activeLayout.name; });
</script>

<section class="rounded-xl border border-border/70 bg-panel/40 p-4 xl:col-span-2">
  <h2 class="text-sm font-semibold">{msg('home.layoutLabel')}</h2>
  <p class="mt-1 text-xs text-muted">Choose the sections and order shown on Home. The decrypt panel stays pinned.</p>
  <div class="mt-3 grid gap-3">
    <div class="flex flex-wrap items-center gap-2">
      <label class="sr-only" for="home-layout-select">{msg('home.layoutLabel')}</label>
      <select id="home-layout-select" class="min-h-9 min-w-40 rounded-md border border-border bg-background px-2 text-sm focus-visible:ring-2 focus-visible:ring-accent" value={activeLayout.id} onchange={(event) => saveLayouts(homeLayoutPreferencesState.layouts, event.currentTarget.value)}>
        {#each homeLayoutPreferencesState.layouts as layout (layout.id)}<option value={layout.id}>{layout.name}</option>{/each}
      </select>
      <label class="sr-only" for="home-layout-rename">{msg('home.renameLayout')}</label>
      <input id="home-layout-rename" class="min-h-9 min-w-36 rounded-md border border-border bg-background px-2 text-sm focus-visible:ring-2 focus-visible:ring-accent" bind:value={renameValue} maxlength="40" aria-label={msg('home.renameLayout')} />
      <Button variant="secondary" size="sm" disabled={!renameValue.trim() || renameValue.trim() === activeLayout.name} onclick={renameLayout}>{msg('home.renameLayout')}</Button>
      <Button variant="ghost" size="sm" onclick={() => updateActiveLayout((layout) => ({ ...DEFAULT_HOME_LAYOUT, id: layout.id, name: layout.name }))}><RotateCcw class="h-3.5 w-3.5" />{msg('home.resetLayout')}</Button>
      {#if activeLayout.id !== 'default' && homeLayoutPreferencesState.layouts.length > 1}<Button variant="ghost" size="sm" onclick={deleteLayout}><Trash2 class="h-3.5 w-3.5" />{msg('home.deleteLayout')}</Button>{/if}
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <label class="sr-only" for="home-layout-new">{msg('home.newLayout')}</label>
      <input id="home-layout-new" class="min-h-9 min-w-36 rounded-md border border-border bg-background px-2 text-sm focus-visible:ring-2 focus-visible:ring-accent" bind:value={newLayoutName} maxlength="40" placeholder={msg('home.layoutNamePlaceholder')} />
      <Button variant="secondary" size="sm" disabled={!newLayoutName.trim() || homeLayoutPreferencesState.layouts.length >= 10} onclick={createLayout}><Plus class="h-3.5 w-3.5" />{msg('home.newLayout')}</Button>
    </div>
    <div class="grid gap-2" aria-label={msg('home.sections')}>
      {#each activeLayout.order as module, index (module)}
        <div class="flex min-h-10 flex-wrap items-center gap-2 rounded-lg border border-border/70 px-2 py-1.5">
          <span class="min-w-0 flex-1 text-sm">{msg(layoutTitles[module])}</span>
          <Button variant="ghost" size="icon" class="h-8 w-8" disabled={index === 0} onclick={() => updateActiveLayout((layout) => moveHomeModule(layout, module, -1))} aria-label={msg('home.moveEarlier')} title={msg('home.moveEarlier')}><ArrowUp class="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" class="h-8 w-8" disabled={index === activeLayout.order.length - 1} onclick={() => updateActiveLayout((layout) => moveHomeModule(layout, module, 1))} aria-label={msg('home.moveLater')} title={msg('home.moveLater')}><ArrowDown class="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" class="h-8 w-8" onclick={() => updateActiveLayout((layout) => setHomeModuleCollapsed(layout, module, !layout.collapsed.includes(module)))} aria-label={msg(activeLayout.collapsed.includes(module) ? 'home.expandSection' : 'home.collapseSection')} title={msg(activeLayout.collapsed.includes(module) ? 'home.expandSection' : 'home.collapseSection')}>{#if activeLayout.collapsed.includes(module)}<ChevronRight class="h-4 w-4" />{:else}<ChevronDown class="h-4 w-4" />{/if}</Button>
          <Button variant="ghost" size="icon" class="h-8 w-8" onclick={() => updateActiveLayout((layout) => setHomeModuleHidden(layout, module, !layout.hidden.includes(module)))} aria-label={msg(activeLayout.hidden.includes(module) ? 'home.showSection' : 'home.hideSection')} title={msg(activeLayout.hidden.includes(module) ? 'home.showSection' : 'home.hideSection')}>{#if activeLayout.hidden.includes(module)}<Eye class="h-4 w-4" />{:else}<EyeOff class="h-4 w-4" />{/if}</Button>
        </div>
      {/each}
    </div>
    {#if hiddenModules.length > 0}<div class="flex flex-wrap items-center gap-2" aria-label={msg('home.hiddenSections')}>{#each hiddenModules as module (module)}<Button variant="secondary" size="sm" onclick={() => updateActiveLayout((layout) => setHomeModuleHidden(layout, module, false))}><Eye class="h-3.5 w-3.5" />{msg(layoutTitles[module])}</Button>{/each}</div>{/if}
  </div>
</section>
