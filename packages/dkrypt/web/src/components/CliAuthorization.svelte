<script lang="ts">
  import { onMount } from 'svelte';
  import { Check, CircleAlert, Terminal } from 'lucide-svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';

  interface AuthorizationDetails {
    application: string;
    permissions: string[];
    expiresAt: number;
    canApprove: boolean;
    reason?: string;
  }

  let userCode = $state('');
  let details = $state<AuthorizationDetails>();
  let error = $state('');
  let decision = $state<'approved' | 'denied'>();
  let busy = $state(false);

  onMount(() => {
    const params = new URLSearchParams(location.search);
    userCode = params.get('user_code') ?? '';
    if (!userCode) {
      error = 'The sign-in link is missing its code. Start a new sign-in from the CLI.';
      return;
    }
    void loadAuthorization();
  });

  async function loadAuthorization(): Promise<void> {
    error = '';
    try {
      const response = await fetch(`/v1/cli/device/authorization?user_code=${encodeURIComponent(userCode)}`, { credentials: 'same-origin', cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? 'This code is invalid or expired. Start a new sign-in from the CLI.');
      details = body as AuthorizationDetails;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not load the sign-in request.';
    }
  }

  async function respond(next: 'approve' | 'deny'): Promise<void> {
    if (busy || (next === 'approve' && !details?.canApprove)) return;
    busy = true;
    error = '';
    try {
      const response = await fetch('/v1/cli/device/authorization', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code: userCode, decision: next }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? 'Could not update this sign-in request.');
      decision = next === 'approve' ? 'approved' : 'denied';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not update this sign-in request.';
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Authorize dkrypt CLI</title></svelte:head>

<main class="flex min-h-screen items-center justify-center bg-background px-4 py-8 text-text">
  <Card class="w-full max-w-lg p-6 sm:p-8">
    {#if decision === 'approved'}
      <div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-ok/10 text-ok"><Check class="h-6 w-6" /></div>
      <h1 class="text-center text-xl font-semibold">CLI sign-in approved</h1>
      <p class="mt-2 text-center text-sm text-muted">Return to your terminal. The CLI will finish signing in automatically.</p>
    {:else if decision === 'denied'}
      <div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-panel-muted text-muted"><CircleAlert class="h-6 w-6" /></div>
      <h1 class="text-center text-xl font-semibold">CLI sign-in denied</h1>
      <p class="mt-2 text-center text-sm text-muted">The CLI request will not receive access to your account.</p>
    {:else if details}
      <div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Terminal class="h-6 w-6" /></div>
      <p class="text-center text-xs font-semibold uppercase tracking-[0.14em] text-accent">Confirm sign-in</p>
      <h1 class="mt-2 text-center text-xl font-semibold">Authorize {details.application}</h1>
      <p class="mt-2 text-center text-sm text-muted">Approve this request only if the code matches the one shown in your terminal.</p>
      <div class="my-5 rounded-xl border border-border bg-background px-4 py-3 text-center font-mono text-lg font-semibold tracking-[0.15em]">{userCode}</div>
      <div class="rounded-xl border border-border bg-background p-4">
        <div class="text-sm font-medium">This CLI key can</div>
        <ul class="mt-3 grid gap-2 text-sm text-muted">
          {#each details.permissions as permission (permission)}<li class="flex items-center gap-2"><Check class="h-4 w-4 shrink-0 text-ok" />{permission}</li>{/each}
        </ul>
        <p class="mt-3 text-xs text-muted">The key expires in 90 days. It uses the same decrypt and IPA access your API keys have.</p>
      </div>
      {#if !details.canApprove}<p class="mt-4 rounded-lg border border-warn/30 bg-warn/5 p-3 text-sm text-muted">{details.reason}</p>{/if}
      {#if error}<p class="mt-4 text-sm text-err" role="alert">{error}</p>{/if}
      <div class="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" disabled={busy} onclick={() => void respond('deny')}>Deny</Button>
        <Button loading={busy} disabled={!details.canApprove} onclick={() => void respond('approve')}>Approve CLI sign-in</Button>
      </div>
    {:else}
      <div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-panel-muted text-muted"><CircleAlert class="h-6 w-6" /></div>
      <h1 class="text-center text-xl font-semibold">Sign-in request unavailable</h1>
      <p class="mt-2 text-center text-sm text-muted" role="alert">{error || 'Loading sign-in request…'}</p>
      {#if error}<div class="mt-5 text-center"><a href="/" class="text-sm text-accent underline">Return to dkrypt</a></div>{/if}
    {/if}
  </Card>
</main>
