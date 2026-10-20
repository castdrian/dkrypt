<script lang="ts">
  import { ChevronRight } from 'lucide-svelte';
  import DonationNudge from '#components/DonationNudge.svelte';
  import ArtifactInspector from '#components/ArtifactInspector.svelte';
  import ProjectSelector from '#components/ProjectSelector.svelte';
  import DecryptCompletion from '#components/DecryptCompletion.svelte';
  import OnboardingBanner from '#components/OnboardingBanner.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import { DEFAULT_HOME_LAYOUT, setHomeModuleCollapsed, type HomeLayout, type HomeModuleId } from '#lib/homeLayouts';
  import { translateMessage, type MessageKey } from '#lib/messages';
  import { resolveInterfaceLanguage } from '#lib/locale';
  import { interfaceLanguageState, systemLocalesState } from '#lib/ui.svelte';
  import { batchDecryptJumpState, focusSearchJumpState, homeLayoutPreferencesState } from '#lib/ui.svelte';
  import { pushHomeLayoutPreferences } from '#lib/session.svelte';
  import { showToast } from '#lib/ui.svelte';
  import ArtifactLibrary from '#features/artifacts/ArtifactLibrary.svelte';
  import ActiveJobsPanel from '#features/jobs/ActiveJobsPanel.svelte';
  import DecryptPanel from '#features/jobs/DecryptPanel.svelte';
  import JobHistoryPanel from '#features/jobs/JobHistoryPanel.svelte';

  let decryptPanel: DecryptPanel | undefined = $state();
  const interfaceLanguage = $derived(resolveInterfaceLanguage(interfaceLanguageState.value, systemLocalesState.value));
  const msg = (key: MessageKey) => translateMessage(key, interfaceLanguage);
  const layoutTitles: Record<HomeModuleId, MessageKey> = {
    artifacts: 'home.artifacts',
    activeJobs: 'home.activeJobs',
    jobHistory: 'home.jobHistory',
  };
  const activeLayout = $derived(homeLayoutPreferencesState.layouts.find((layout) => layout.id === homeLayoutPreferencesState.activeId) ?? homeLayoutPreferencesState.layouts[0] ?? DEFAULT_HOME_LAYOUT);

  export function focusSearch(bundleId?: string): void {
    decryptPanel?.focusSearch(bundleId);
  }

  export function openBatch(): void {
    decryptPanel?.openBatch();
  }

  function saveLayouts(layouts: HomeLayout[], activeId = homeLayoutPreferencesState.activeId): void {
    void pushHomeLayoutPreferences(layouts, activeId).catch(() => showToast(msg('home.preferencesFailed'), 'error'));
  }

  function updateActiveLayout(update: (layout: HomeLayout) => HomeLayout): void {
    saveLayouts(homeLayoutPreferencesState.layouts.map((layout) => layout.id === activeLayout.id ? update(layout) : layout));
  }


  $effect(() => {
    if (batchDecryptJumpState.requested) {
      batchDecryptJumpState.requested = false;
      decryptPanel?.openBatch();
    }
  });

  $effect(() => {
    if (focusSearchJumpState.requested) {
      const bundleId = focusSearchJumpState.bundleId;
      focusSearchJumpState.requested = false;
      focusSearchJumpState.bundleId = null;
      decryptPanel?.focusSearch(bundleId);
    }
  });

</script>

<div class="flex flex-col gap-4">
  <ProjectSelector />
  <OnboardingBanner />
  <DecryptPanel bind:this={decryptPanel} />
  <DonationNudge />
  <DecryptCompletion />

  {#each activeLayout.order as module (module)}
    {#if !activeLayout.hidden.includes(module) && activeLayout.collapsed.includes(module)}
      <Button variant="secondary" class="w-full justify-start" onclick={() => updateActiveLayout((layout) => setHomeModuleCollapsed(layout, module, false))}><ChevronRight class="h-4 w-4" />{msg(layoutTitles[module])}<span class="text-muted">{msg('home.expandSection')}</span></Button>
    {/if}
    <div class:hidden={activeLayout.hidden.includes(module) || activeLayout.collapsed.includes(module)}>
      {#if module === 'artifacts'}
        <ArtifactLibrary />
      {:else if module === 'activeJobs'}
        <ActiveJobsPanel />
      {:else if module === 'jobHistory'}
        <JobHistoryPanel />
      {/if}
    </div>
  {/each}
  <ArtifactInspector />
</div>
