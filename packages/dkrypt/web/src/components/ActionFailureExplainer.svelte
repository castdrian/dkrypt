<script lang="ts">
  import Card from '#lib/components/ui/Card.svelte';

  let failureText = $state('');

  const explanations = [
    { id: 'scope', pattern: /public_api_scope_denied|limited to decrypt and IPA artifact routes/i, title: 'The action used an API route outside its key scope', detail: 'Create a key with decrypt access for the requested bundle and the required TestFlight scope. The action cannot use dashboard-only routes.', next: 'Use the action’s resolve-only option or its supported decrypt and artifact operations.' },
    { id: 'auth', pattern: /\b401\b|invalid api key|unauthorized|authentication failed/i, title: 'The API key was rejected', detail: 'The key may be revoked, mistyped, or missing from the repository environment.', next: 'Rotate the key in dkrypt, update the repository secret, and rerun the workflow.' },
    { id: 'permission', pattern: /\b403\b|bundle.*not allowed|testflight.*scope|forbidden/i, title: 'The key does not have access to this request', detail: 'The request may use a bundle ID outside the key scope or a channel the key cannot access.', next: 'Update the key’s allowed bundle IDs and TestFlight permission.' },
    { id: 'rate', pattern: /\b429\b|rate.?limit|allowance|too many requests/i, title: 'A request or decrypt limit was reached', detail: 'dkrypt limits may be per account or per key, and decrypt allowances apply only to new work.', next: 'Wait for Retry-After or the next-available time, then retry with the same idempotency key.' },
    { id: 'conflict', pattern: /\b409\b|idempotency.*conflict|already used with a different/i, title: 'The retry key was reused for different request details', detail: 'An idempotency key can safely repeat the original request, but cannot identify changed inputs.', next: 'Retry unchanged inputs with the same key, or create a new key after changing the request.' },
    { id: 'missing', pattern: /\b404\b|not found|could not resolve.*release|no artifact/i, title: 'The requested release or artifact was not found', detail: 'The release may have expired, the bundle ID or version may be wrong, or the API key may not be able to see the item.', next: 'Resolve the release first and verify the bundle ID, channel, version, and artifact ID.' },
    { id: 'checksum', pattern: /checksum|sha-?256|size mismatch|integrity verification/i, title: 'The downloaded IPA did not match dkrypt’s metadata', detail: 'The action stopped before handing an unverified file to the workflow.', next: 'Rerun the action. If the mismatch repeats, keep the file quarantined and include the job ID in a support report.' },
    { id: 'timeout', pattern: /timeout|timed out|deadline|did not finish within/i, title: 'The action reached its time limit', detail: 'The job may still be queued or running even when a workflow step stops waiting.', next: 'Check the job ID in dkrypt before submitting again. Increase timeout-seconds only if the job is progressing.' },
    { id: 'network', pattern: /econnreset|enotfound|fetch failed|network error|tls|certificate|socket hang up/i, title: 'The runner could not reach dkrypt or its download host', detail: 'This is usually a runner network, DNS, proxy, or certificate problem.', next: 'Retry the workflow and check the runner’s network path and the configured API URL.' },
    { id: 'server', pattern: /\b5\d\d\b|internal server error|service unavailable|bad gateway/i, title: 'dkrypt or a provider returned a temporary server error', detail: 'A 5xx response is retryable when the action reuses the same request identity.', next: 'Retry after a short delay. Include the request or correlation ID if it repeats.' },
    { id: 'lock', pattern: /dkrypt\.lock|lockfile|does not match the dkrypt\.lock/i, title: 'The resolved release conflicts with the checked-in lockfile', detail: 'The action protects builds from silently changing a pinned version, source, or build.', next: 'Review the resolved version and update the lockfile deliberately with resolve-only and update-lockfile enabled.' },
  ] as const;

  const matches = $derived(explanations.filter((item) => item.pattern.test(failureText)).slice(0, 3));
</script>

<Card title="GitHub Action failure helper">
  <p class="text-xs text-muted">Paste the failed step’s message or a short log excerpt. The check runs in this browser and does not upload logs or secrets.</p>
  <textarea class="mt-3 min-h-28 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs" bind:value={failureText} placeholder="Paste the dkrypt action error here…" aria-label="GitHub Action error or log excerpt"></textarea>
  {#if failureText.trim()}
    {#if matches.length}
      <div class="mt-3 space-y-2" aria-live="polite">{#each matches as item (item.id)}<div class="rounded-lg border border-border/70 bg-panel-muted/30 p-3"><div class="text-xs font-medium">{item.title}</div><p class="mt-1 text-xs text-muted">{item.detail}</p><p class="mt-2 text-xs">{item.next}</p></div>{/each}</div>
    {:else}
      <div class="mt-3 rounded-lg border border-border/70 bg-panel-muted/30 p-3 text-xs text-muted" role="status">No known pattern matched. Check the request ID, job status, and dkrypt API URL. Remove API keys and other secrets before sharing logs.</div>
    {/if}
  {/if}
</Card>
