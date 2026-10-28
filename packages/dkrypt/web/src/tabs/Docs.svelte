<script lang="ts">
  import { ExternalLink } from 'lucide-svelte';
  import CopyButton from '#components/CopyButton.svelte';
  import { buttonVariants } from '#lib/components/ui/variants';
  import Button from '#lib/components/ui/Button.svelte';
  import ApiChanges from '#components/ApiChanges.svelte';
  import DkryptWorkflowGenerator from '#components/DkryptWorkflowGenerator.svelte';
  import ApiRequestBuilder from '#components/ApiRequestBuilder.svelte';
  import DkryptLockfileEditor from '#components/DkryptLockfileEditor.svelte';
  import ActionFailureExplainer from '#components/ActionFailureExplainer.svelte';
  import { sessionState } from '#lib/session.svelte';

  let docsView = $state<'reference' | 'changes'>('reference');
  let quickstartKind = $state<'appstore' | 'testflight' | 'library'>('appstore');
  const quickstartCommand = $derived.by(() => {
    const base = '$DKRYPT_BASE_URL';
    const auth = '-H "Authorization: Bearer $DKRYPT_API_KEY"';
    if (quickstartKind === 'testflight') {
      return [
        `curl --fail-with-body -X POST ${auth} -H "Content-Type: application/json" \\`,
        `  ${base}/v1/testflight/decrypt \\`,
        `  -d '{"bundleId":"com.example.app","appId":123456789,"build":{"id":987654321,"cfBundleShortVersion":"1.0","cfBundleVersion":"42","bundleId":"com.example.app"}}'`,
      ].join('\n');
    }
    if (quickstartKind === 'library') return `curl --fail-with-body ${auth} "${base}/v1/artifacts?limit=20"`;
    return [
      `curl --fail-with-body -X POST ${auth} -H "Content-Type: application/json" \\`,
      `  ${base}/v1/decrypts \\`,
      `  -d '{"bundleId":"com.example.app"}'`,
    ].join('\n');
  });
  const currentBaseUrl = $derived(sessionState.publicBaseUrl ?? (typeof window === 'undefined' ? '' : window.location.origin));
</script>

<section class="flex min-w-0 flex-col gap-3">
  <div class="rounded-xl border border-border/70 bg-panel-muted/30 p-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h2 class="text-sm font-semibold">Get started with the API</h2>
        <p class="mt-1 text-xs text-muted">Create a key, keep it in an environment variable, then copy the request for the operation you need.</p>
      </div>
      <a href="/?tab=keys" class={buttonVariants('secondary', 'sm')}>Create an API key</a>
    </div>
    <ol class="mt-3 grid gap-2 text-xs sm:grid-cols-3">
      <li class="rounded-lg border border-border/60 p-3"><span class="font-medium">1. Limit access</span><p class="mt-1 text-muted">Restrict the key to the app bundle IDs it needs. TestFlight calls also require TestFlight access.</p></li>
      <li class="rounded-lg border border-border/60 p-3"><span class="font-medium">2. Store it safely</span><p class="mt-1 text-muted">Copy the key once and store it in a secret manager or environment variable. dkrypt never shows the full key again.</p></li>
      <li class="rounded-lg border border-border/60 p-3"><span class="font-medium">3. Submit and follow a job</span><p class="mt-1 text-muted">Decrypt requests return a job ID. Check job status, then download its artifact.</p></li>
    </ol>
    <div class="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
      <label for="api-quickstart-kind" class="text-xs text-muted">Example</label>
      <select id="api-quickstart-kind" class="h-8 rounded-md border border-border bg-background px-2 text-xs" bind:value={quickstartKind}>
        <option value="appstore">App Store decrypt</option>
        <option value="testflight">TestFlight decrypt</option>
        <option value="library">List IPA artifacts</option>
      </select>
      <span class="min-w-0 text-[11px] text-muted">Base URL: {currentBaseUrl || 'this dkrypt instance'}</span>
    </div>
    <div class="mt-2 flex min-w-0 items-start gap-2 rounded-lg border border-border/60 bg-background p-3">
      <pre class="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-5">{quickstartCommand}</pre>
      <CopyButton text={quickstartCommand} label="Copy" />
    </div>
    <div class="mt-2 grid gap-2 sm:grid-cols-2">
      <div class="min-w-0 rounded-lg border border-border/60 bg-background p-3"><div class="mb-2 text-[11px] font-medium">Check a job</div><div class="flex items-start gap-2"><pre class="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px]">curl --fail-with-body -H "Authorization: Bearer $DKRYPT_API_KEY" "$DKRYPT_BASE_URL/v1/jobs/$JOB_ID"</pre><CopyButton text={'curl --fail-with-body -H "Authorization: Bearer $DKRYPT_API_KEY" "$DKRYPT_BASE_URL/v1/jobs/$JOB_ID"'} label="Copy" /></div></div>
      <div class="min-w-0 rounded-lg border border-border/60 bg-background p-3"><div class="mb-2 text-[11px] font-medium">Download an artifact</div><div class="flex items-start gap-2"><pre class="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px]">curl --fail-with-body -H "Authorization: Bearer $DKRYPT_API_KEY" "$DKRYPT_BASE_URL/v1/artifacts/$ARTIFACT_ID/file" -o app.ipa</pre><CopyButton text={'curl --fail-with-body -H "Authorization: Bearer $DKRYPT_API_KEY" "$DKRYPT_BASE_URL/v1/artifacts/$ARTIFACT_ID/file" -o app.ipa'} label="Copy" /></div></div>
    </div>
    <p class="mt-2 text-[11px] text-muted">Set <code>DKRYPT_BASE_URL={currentBaseUrl || 'https://your-dkrypt-host'}</code> and <code>DKRYPT_API_KEY</code> before running the command. Replace the example bundle, app, and build values with ones your key can access.</p>
    <details class="mt-3 text-xs">
      <summary class="cursor-pointer font-medium">API terms, briefly</summary>
      <dl class="mt-2 grid gap-2 sm:grid-cols-3">
        <div><dt class="font-medium">Bundle scope</dt><dd class="mt-0.5 text-muted">The app bundle IDs this API key may request or list.</dd></div>
        <div><dt class="font-medium">Job</dt><dd class="mt-0.5 text-muted">The queued or running work for a decrypt request.</dd></div>
        <div><dt class="font-medium">Artifact</dt><dd class="mt-0.5 text-muted">The verified IPA produced by a completed job.</dd></div>
      </dl>
    </details>
    <details class="mt-3 rounded-lg border border-border/60 bg-background p-3 text-xs">
      <summary class="cursor-pointer font-medium">API errors and recovery</summary>
      <p class="mt-2 text-muted">Errors include a message, code, request ID, and retryable flag. Rate-limited responses may also include <code>Retry-After</code> and a next-available time.</p>
      <dl class="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-[4rem_minmax(0,1fr)]">
        <dt class="font-medium">400</dt><dd class="text-muted">Check the bundle ID, version, channel, and required fields.</dd>
        <dt class="font-medium">401</dt><dd class="text-muted">The API key is missing, invalid, or revoked. Create or rotate a key and update your secret.</dd>
        <dt class="font-medium">403</dt><dd class="text-muted">The key does not allow this bundle ID or TestFlight access. Update its scopes in dkrypt.</dd>
        <dt class="font-medium">404</dt><dd class="text-muted">The app release, job, or artifact was not found. Finished jobs are retained for a limited time.</dd>
        <dt class="font-medium">409</dt><dd class="text-muted">The request conflicts with its idempotency key or current state. Reuse the same key and request for a safe retry; use a new key only for changed request details.</dd>
        <dt class="font-medium">410</dt><dd class="text-muted">The result for an older idempotency key has expired. Submit again with a new key.</dd>
        <dt class="font-medium">429</dt><dd class="text-muted">A decrypt allowance or request limit was reached. Wait for <code>Retry-After</code> or the returned next-available time.</dd>
        <dt class="font-medium">5xx</dt><dd class="text-muted">dkrypt or a provider is temporarily unavailable. Retry with the same idempotency key and include the request ID when contacting support.</dd>
      </dl>
      <p class="mt-3 text-muted">To check what would be selected without submitting a job, send <code>POST /v1/decrypts</code> with <code>resolveOnly: true</code>. This does not use decrypt allowance.</p>
    </details>
  </div>
  <DkryptWorkflowGenerator />
  <DkryptLockfileEditor />
  <ApiRequestBuilder />
  <ActionFailureExplainer />
  <div class="flex min-w-0 items-center justify-between gap-3">
    <div class="min-w-0">
      <h1 class="text-base font-semibold">API documentation</h1>
      <p class="mt-1 text-muted text-sm">Browse and try the public API on this dkrypt instance. Add an API key in Scalar’s authorization panel. Decrypt requests create real jobs and use your account’s allowance.</p>
    </div>
    {#if docsView === 'reference'}<a href="/reference/" target="_blank" rel="noopener noreferrer" class={buttonVariants('secondary', 'sm')}><ExternalLink class="h-4 w-4" />Open API reference in new tab</a>{/if}
  </div>
  <div class="flex gap-1 border-b border-border/70" role="tablist" aria-label="API documentation views">
    <Button role="tab" aria-selected={docsView === 'reference'} variant={docsView === 'reference' ? 'secondary' : 'ghost'} size="sm" onclick={() => (docsView = 'reference')}>API reference</Button>
    <Button role="tab" aria-selected={docsView === 'changes'} variant={docsView === 'changes' ? 'secondary' : 'ghost'} size="sm" onclick={() => (docsView = 'changes')}>API changes</Button>
  </div>
  {#if docsView === 'reference'}
    <div class="min-w-0 overflow-hidden rounded-xl border border-border/70 bg-background"><iframe src="/reference/" title="dkrypt API reference" loading="lazy" referrerpolicy="same-origin" class="block h-[min(78vh,58rem)] min-h-[36rem] w-full border-0"></iframe></div>
  {:else}
    <ApiChanges />
  {/if}
</section>
