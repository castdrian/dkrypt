<script lang="ts">
  import { onMount } from 'svelte';
  import { CircleCheck, ExternalLink, RefreshCw } from 'lucide-svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import { buttonVariants } from '#lib/components/ui/variants';
  import { fetchDashboardApiChanges, type DashboardApiChanges } from '#lib/api';

  let data = $state<DashboardApiChanges | null>(null);
  let loading = $state(true);
  let error = $state('');
  let methods = $derived.by(() => Object.entries(data?.operations ?? {}).flatMap(([path, allowed]) => allowed.map((method) => ({ method: method.toUpperCase(), path }))).sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)));

  onMount(() => {
    void load();
  });

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      data = await fetchDashboardApiChanges();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not load API changes.';
    } finally {
      loading = false;
    }
  }
</script>

<section class="flex min-w-0 flex-col gap-4">
  <div class="flex flex-wrap items-start justify-between gap-3"><div><h1 class="text-base font-semibold">API changes</h1><p class="mt-1 text-sm text-muted">Compatibility rules, active notices, and the operations available to API keys.</p></div><Button size="sm" variant="secondary" loading={loading} onclick={() => void load()} aria-label="Refresh API changes"><RefreshCw class="size-3.5" /></Button></div>
  {#if error}<div role="alert" class="rounded-lg border border-err/30 bg-err/5 p-3 text-sm text-err">{error}</div>{:else if loading}<div role="status" class="rounded-lg border border-border/70 p-4 text-sm text-muted">Loading API policy…</div>{:else if data}
    <Card>
      <div class="flex flex-wrap items-center justify-between gap-3"><div><div class="text-xs text-muted">Current compatibility version</div><div class="mt-1 text-lg font-semibold">v{data.lifecycle.currentVersion}</div></div><a class={buttonVariants('secondary', 'sm')} href={data.lifecycle.versions.find((version) => version.status === 'current')?.documentation ?? '/reference/'} target="_blank" rel="noreferrer"><ExternalLink class="size-3.5" />Open API reference</a></div>
      <p class="mt-4 text-sm text-muted">{data.lifecycle.policy.compatibility}</p>
      <div class="mt-3 rounded-lg border border-border/70 bg-panel-muted/30 p-3 text-xs"><span class="font-medium">Notice period</span><span class="ml-2 text-muted">At least {data.lifecycle.policy.noticePeriodDays} days before a sunset. Notices use {data.lifecycle.policy.noticeHeaders.join(', ')} response headers.</span></div>
    </Card>
    <Card title="Active deprecations">
      {#if data.lifecycle.deprecations.length === 0}<div class="flex items-center gap-2 text-sm text-muted"><CircleCheck class="size-4 text-ok" />No public API operations are currently scheduled for removal.</div>{:else}<ul class="divide-y divide-border/70">{#each data.lifecycle.deprecations as notice (`${notice.method}-${notice.path}`)}<li class="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"><span class="font-mono text-xs">{notice.method} {notice.path}</span><span class="text-xs text-muted">Sunsets {new Date(notice.sunsetAt).toLocaleDateString()}</span><a class={buttonVariants('link', 'sm')} href={notice.migrationUrl}>Migration guidance</a></li>{/each}</ul>{/if}
    </Card>
    <Card title={`Public API key operations · ${methods.length}`}>
      <p class="text-xs text-muted">These routes are available to approved API keys. Dashboard, billing, account, and session routes are not included.</p>
      <ul class="mt-3 grid gap-1.5 sm:grid-cols-2">{#each methods as operation (`${operation.method}-${operation.path}`)}<li class="flex min-w-0 items-center gap-2 rounded-md border border-border/60 px-2.5 py-2"><span class="w-12 shrink-0 text-[10px] font-semibold text-accent">{operation.method}</span><code class="min-w-0 truncate text-[11px]">{operation.path}</code></li>{/each}</ul>
    </Card>
    <Card title="Importable API collections">
      <p class="text-sm text-muted">Start with dkrypt’s public API operations and set your instance URL and API key in your local environment.</p>
      <div class="mt-3 flex flex-wrap gap-2"><a class={buttonVariants('secondary', 'sm')} href="/downloads/dkrypt-postman.json" download>Postman collection</a><a class={buttonVariants('secondary', 'sm')} href="/downloads/dkrypt-bruno.zip" download>Bruno collection</a></div>
    </Card>
    <Card title="Go, Swift, and Rust SDKs">
      <p class="text-sm text-muted">Download a small client for decrypt requests, job status, and IPA downloads. Each client uses only the public API-key operations.</p>
      <div class="mt-3 flex flex-wrap gap-2"><a class={buttonVariants('secondary', 'sm')} href="/downloads/dkrypt-go-sdk.zip" download>Go SDK</a><a class={buttonVariants('secondary', 'sm')} href="/downloads/dkrypt-swift-sdk.zip" download>Swift SDK</a><a class={buttonVariants('secondary', 'sm')} href="/downloads/dkrypt-rust-sdk.zip" download>Rust SDK</a><a class={buttonVariants('link', 'sm')} href="https://github.com/castdrian/dkrypt/tree/main/packages/dkrypt/clients" target="_blank" rel="noreferrer">Source files</a></div>
    </Card>
  {/if}
</section>
