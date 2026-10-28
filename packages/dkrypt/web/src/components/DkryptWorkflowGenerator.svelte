<script lang="ts">
  import { Check, Copy, Workflow } from 'lucide-svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import { sessionState } from '#lib/session.svelte';

  const bundleIdPattern = /^[A-Za-z0-9.-]{3,200}$/;
  const actionVersion = 'v1.1.1';
  let bundleIdsText = $state('com.example.app');
  let channel = $state<'appstore' | 'testflight'>('appstore');
  let version = $state('');
  let resolveOnly = $state(false);
  let useLockfile = $state(false);
  let updateLockfile = $state(false);
  let copied = $state(false);

  const bundleIds = $derived([...new Set(bundleIdsText.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean))]);
  const invalidBundleIds = $derived(bundleIds.filter((bundleId) => !bundleIdPattern.test(bundleId)));
  const tooManyBundleIds = $derived(bundleIds.length > 20);
  const invalidVersion = $derived(!useLockfile && Boolean(version.trim()) && (!/^v?\d+(?:\.\d+)*(?:_\d+)?$/i.test(version.trim()) || (channel === 'testflight' && !version.includes('_')) || (channel === 'appstore' && version.includes('_'))));
  const workflow = $derived.by(() => {
    const baseUrl = sessionState.publicBaseUrl ?? (typeof window === 'undefined' ? 'https://ipa.dylib.dev' : window.location.origin);
    const lines = [
      'name: Resolve or decrypt apps with dkrypt',
      '',
      'on:',
      '  workflow_dispatch:',
      '',
      'jobs:',
      '  dkrypt:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      `      - uses: castdrian/dkrypt@${actionVersion}`,
      '        id: dkrypt',
      '        with:',
      `          api-url: \${{ vars.DKRYPT_API_URL || '${baseUrl}' }}`,
      '          api-key: \${{ secrets.DKRYPT_API_KEY }}',
      `          bundle-ids: '${JSON.stringify(bundleIds)}'`,
      ...(useLockfile ? ['          lockfile: dkrypt.lock'] : [`          channel: ${channel}`]),
    ];
    if (useLockfile && updateLockfile) lines.push("          update-lockfile: 'true'");
    if (!useLockfile && version.trim()) lines.push(`          version: ${version.trim()}`);
    if (resolveOnly || (useLockfile && updateLockfile)) lines.push("          resolve-only: 'true'");
    return lines.join('\n');
  });

  async function copyWorkflow(): Promise<void> {
    await navigator.clipboard.writeText(workflow);
    copied = true;
    setTimeout(() => (copied = false), 1800);
  }
</script>

<Card title="GitHub Actions workflow">
  <div class="flex items-start justify-between gap-3">
    <div class="flex min-w-0 items-start gap-2.5">
      <Workflow class="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
      <p class="text-xs text-muted">Generate a workflow for one or more apps. Store your API key in the repository’s <code>DKRYPT_API_KEY</code> secret.</p>
    </div>
    <a class="shrink-0 text-xs text-accent hover:underline" href={`https://github.com/castdrian/dkrypt/releases/tag/${actionVersion}`} target="_blank" rel="noreferrer">Action {actionVersion}</a>
  </div>

  <div class="mt-3 grid gap-3 sm:grid-cols-2">
    <label class="grid gap-1 text-xs">Bundle IDs <span class="text-muted">Separate multiple IDs with commas or new lines.</span><textarea class="min-h-24 rounded-md border border-border bg-background px-3 py-2 font-mono text-xs" bind:value={bundleIdsText} aria-invalid={invalidBundleIds.length > 0 || tooManyBundleIds}></textarea></label>
    <div class="grid content-start gap-3">
      <label class="grid gap-1 text-xs">Channel<select class="h-9 rounded-md border border-border bg-background px-2" bind:value={channel} disabled={useLockfile}><option value="appstore">App Store</option><option value="testflight">TestFlight</option></select></label>
      <label class="grid gap-1 text-xs">Exact version <span class="text-muted">Leave blank to resolve the latest.</span><Input bind:value={version} placeholder={channel === 'testflight' ? '352.0_118977' : '350.0'} aria-invalid={invalidVersion} disabled={useLockfile} /></label>
      <label class="flex items-center gap-2 text-xs"><input type="checkbox" bind:checked={resolveOnly} />Resolve metadata only; do not queue or download</label>
      <label class="flex items-center gap-2 text-xs"><input type="checkbox" bind:checked={useLockfile} />Read pins from <code>dkrypt.lock</code></label>
      {#if useLockfile}<label class="flex items-center gap-2 text-xs"><input type="checkbox" bind:checked={updateLockfile} />Update the lockfile with resolved releases</label>{/if}
    </div>
  </div>

  {#if tooManyBundleIds}
    <p class="mt-2 text-xs text-err" role="alert">Choose no more than 20 apps per action.</p>
  {:else if invalidBundleIds.length > 0 || invalidVersion}
    <p class="mt-2 text-xs text-err" role="alert">{invalidBundleIds.length > 0 ? `Invalid bundle ID${invalidBundleIds.length === 1 ? '' : 's'}: ${invalidBundleIds.join(', ')}` : 'Use a valid release version, including the build number for TestFlight.'}</p>
  {:else if bundleIds.length === 0}
    <p class="mt-2 text-xs text-err" role="alert">Enter at least one bundle ID.</p>
  {/if}

  <div class="mt-3 overflow-hidden rounded-lg border border-border bg-background">
    <div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2"><span class="text-[11px] font-medium text-muted">.github/workflows/dkrypt.yml</span><Button size="sm" variant="secondary" disabled={bundleIds.length === 0 || invalidBundleIds.length > 0 || tooManyBundleIds || invalidVersion} onclick={() => void copyWorkflow()}>{#if copied}<Check class="h-3.5 w-3.5" />Copied{:else}<Copy class="h-3.5 w-3.5" />Copy YAML{/if}</Button></div>
    <pre class="max-h-80 overflow-auto p-3 text-[11px] leading-5"><code>{workflow}</code></pre>
  </div>
  <p class="mt-2 text-[11px] text-muted">The action reports each app’s version, channel, cache status, artifact, checksum, and size. Failed apps appear in the results and fail the workflow step.</p>
</Card>
