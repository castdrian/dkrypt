<script lang="ts">
  import { RefreshCw } from 'lucide-svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import { fetchReleaseCoverage, refreshReleaseCoverage, type ReleaseCoverageItem } from '#lib/api';

  let items = $state<ReleaseCoverageItem[]>([]);
  let loading = $state(false);
  let refreshing = $state<string | null>(null);
  let error = $state('');
  let refreshMessage = $state('');
  let requestNumber = 0;

  async function load(): Promise<void> {
    const current = ++requestNumber;
    loading = true;
    error = '';
    try {
      const response = await fetchReleaseCoverage();
      if (current === requestNumber) items = response.items;
    } catch {
      if (current === requestNumber) error = 'Release coverage is unavailable.';
    } finally {
      if (current === requestNumber) loading = false;
    }
  }

  async function refresh(bundleId: string): Promise<void> {
    const current = requestNumber;
    refreshing = bundleId;
    refreshMessage = '';
    try {
      const response = await refreshReleaseCoverage(bundleId);
      if (current !== requestNumber) return;
      items = items.map((item) => item.bundleId === bundleId ? response.item : item);
      refreshMessage = response.failures.length ? response.failures.join(' · ') : `${response.item.name} updated`;
    } catch {
      if (current !== requestNumber) return;
      refreshMessage = 'Release lookup failed. The saved coverage is unchanged.';
    } finally {
      refreshing = null;
    }
  }

  $effect(() => { void load(); });
</script>

<Card title="Release coverage" class="mt-4">
  <p class="mb-3 text-xs text-muted">Cached App Store releases and verified TestFlight access. Refresh an app to check for newer releases.</p>
  {#if loading}
    <p class="text-sm text-muted">Loading coverage…</p>
  {:else if error}
    <p class="text-sm text-destructive">{error}</p>
    <Button size="sm" variant="secondary" onclick={() => void load()}>Retry</Button>
  {:else if items.length === 0}
    <p class="text-sm text-muted">No apps have jobs or artifacts yet.</p>
  {:else}
    <div class="space-y-2">
      {#each items as item (item.bundleId)}
        <div class="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
          {#if item.iconUrl}<img src={item.iconUrl} alt="" class="h-9 w-9 rounded-lg" />{/if}
          <div class="min-w-36 flex-1">
            <div class="truncate text-sm font-medium">{item.name}</div>
            <div class="truncate text-xs text-muted">{item.bundleId}</div>
          </div>
          <div class="grid min-w-48 grid-cols-2 gap-x-4 gap-y-1 text-xs sm:min-w-64">
            <span class="text-muted">App Store</span><span>{item.appStore.latestVersion ?? 'Not checked'}{item.appStore.latestVersion ? (item.appStore.artifactId ? ' · IPA saved' : ' · no matching IPA') : ''}</span>
            <span class="text-muted">TestFlight</span><span>{item.testFlight ? `${item.testFlight.latestVersion ?? 'Not checked'}${item.testFlight.stale ? ' · stale' : ''}${item.testFlight.artifactId ? ' · IPA saved' : ''}` : 'Not verified'}</span>
            <span class="text-muted">Recent job</span><span>{item.recentJob?.status ?? 'None'}</span>
            <span class="text-muted">Last checked</span><span>{item.appStore.checkedAt ? new Date(item.appStore.checkedAt).toLocaleString() : 'Never'}</span>
          </div>
          <Button size="icon" variant="ghost" aria-label={`Refresh ${item.name} releases`} title="Check releases" disabled={refreshing !== null} onclick={() => void refresh(item.bundleId)}><RefreshCw class={refreshing === item.bundleId ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /></Button>
        </div>
      {/each}
    </div>
  {/if}
  {#if refreshMessage}<p role="status" class="mt-3 text-xs text-muted">{refreshMessage}</p>{/if}
</Card>
