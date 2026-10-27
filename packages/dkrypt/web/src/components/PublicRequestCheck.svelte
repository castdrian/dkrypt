<script lang="ts">
  import { ArrowRight, CheckCircle2, Link2, Search } from 'lucide-svelte';
  import { checkPublicDecryptRequest, type PublicRequestCheckResult } from '#lib/api';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import { buttonVariants } from '#lib/components/ui/variants';
  import { saveSignupRequestContinuation } from '#lib/requestContinuation';

  let input = $state('');
  let result = $state<PublicRequestCheckResult | null>(null);
  let error = $state('');
  let checking = $state(false);

  async function check(): Promise<void> {
    if (!input.trim() || checking) return;
    checking = true;
    result = null;
    error = '';
    try {
      result = await checkPublicDecryptRequest(input.trim());
    } catch (reason) {
      error = reason instanceof Error ? reason.message : 'Could not check this app. Try again.';
    } finally {
      checking = false;
    }
  }

  function continueToSignIn(): void {
    if (result) saveSignupRequestContinuation(result);
  }
</script>

<main class="min-h-screen bg-background px-4 py-10 sm:px-6 sm:py-16">
  <div class="mx-auto w-full max-w-2xl">
    <a href="/" class="text-sm font-semibold tracking-tight text-text">dkrypt</a>
    <div class="mt-8 max-w-xl">
      <div class="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-accent">Before you sign up</div>
      <h1 class="text-3xl font-semibold tracking-tight sm:text-4xl">Check an app</h1>
      <p class="mt-3 text-sm leading-6 text-muted">Paste an App Store link, bundle ID, or public TestFlight invite to see if dkrypt can resolve it. No account is needed for this check.</p>
    </div>

    <Card class="mt-7 p-4 sm:p-5">
      <form class="flex flex-col gap-2 sm:flex-row" onsubmit={(event) => { event.preventDefault(); void check(); }}>
        <div class="relative min-w-0 flex-1">
          <Link2 class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input bind:value={input} class="pl-9" placeholder="App Store link, bundle ID, or TestFlight link" aria-label="App Store link, bundle ID, or TestFlight link" />
        </div>
        <Button type="submit" loading={checking} disabled={!input.trim()}><Search class="h-4 w-4" />Check app</Button>
      </form>
      {#if error}
        <div class="mt-3 rounded-lg border border-err/30 bg-err/5 px-3 py-2 text-sm text-err" role="alert">{error}</div>
      {/if}
    </Card>

    {#if result}
      <Card class="mt-4 p-4 sm:p-5" aria-live="polite">
        <div class="flex items-start gap-3">
          {#if result.iconUrl}
            <img src={result.iconUrl} alt="" class="h-12 w-12 shrink-0 rounded-xl border border-border object-cover" />
          {:else}
            <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border bg-panel-muted"><CheckCircle2 class="h-5 w-5 text-ok" /></div>
          {/if}
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="text-base font-semibold">{result.displayName}</h2>
              <span class="rounded-full border border-ok/30 bg-ok/10 px-2 py-0.5 text-[11px] font-medium text-ok">Request resolved</span>
            </div>
            <div class="mt-1 break-all font-mono text-xs text-muted">{result.bundleId}</div>
            <div class="mt-2 text-sm text-muted">{result.channel === 'testflight' ? 'Public TestFlight invite' : 'App Store app'}{result.latestVersion ? ` · Latest App Store version ${result.latestVersion}` : ''}</div>
          </div>
        </div>
        <p class="mt-4 text-sm text-muted">{result.nextStep}</p>
        <div class="mt-4 flex flex-wrap gap-2">
          <a href="/?continue=decrypt" onclick={continueToSignIn} class={buttonVariants('default', 'sm')}>{result.channel === 'testflight' ? 'Sign in to request access' : 'Sign in to continue'}<ArrowRight class="h-4 w-4" /></a>
          <a href="/pricing" class={buttonVariants('secondary', 'sm')}>View plans</a>
        </div>
        <p class="mt-3 text-xs text-muted">Device availability is checked after sign-in. TestFlight access is only requested after you confirm it.</p>
      </Card>
    {/if}

    <div class="mt-7 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted">
      <a class="hover:text-text" href="/">Home</a>
      <a class="hover:text-text" href="/pricing">Pricing</a>
      <a class="hover:text-text" href="/status">Service status</a>
    </div>
  </div>
</main>
