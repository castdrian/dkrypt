<script lang="ts">
  import { onMount } from 'svelte';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasPermission, sessionState } from '#lib/session.svelte';
  import { buttonVariants } from '#lib/components/ui/variants';

  let quota = $state<{ limit: number | null; used: number; remaining: number | null; nextAvailableAt?: number; windowMs?: number }>();
  let billingEnabled = $state(false);
  let dismissed = $state(false);
  const hasRoleApiAccess = $derived(sessionHasPermission(PermissionFlag.createApiKeys) || sessionHasPermission(PermissionFlag.accessApi));

  onMount(() => {
    const accountId = sessionState.sub;
    if (!accountId || !sessionState.freeTier) return;
    const key = `dkrypt-free-banner-dismissed:${accountId}`;
    const dismissedUntil = Number(localStorage.getItem(key) ?? 0);
    dismissed = dismissedUntil > Date.now();
    void fetch('/v1/billing')
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json() as { enabled?: boolean; quota?: typeof quota };
        billingEnabled = data.enabled === true;
        quota = data.quota;
      })
      .catch(() => {});
  });

  function dismiss(): void {
    if (sessionState.sub) localStorage.setItem(`dkrypt-free-banner-dismissed:${sessionState.sub}`, String(Date.now() + 7 * 24 * 60 * 60 * 1000));
    dismissed = true;
  }
</script>

{#if sessionState.freeTier && !dismissed}
  <section class="mb-4 rounded-2xl border border-accent/30 bg-accent/5 p-4" aria-label="Free plan">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <div class="font-semibold">Free plan</div>
        <p class="mt-1 text-sm text-muted">Three new dashboard decrypts every 30 days, with 30 minutes to download each result. The IPA Library is read-only. {#if hasRoleApiAccess}Your assigned role grants uncapped API access; explicit limits on an individual key still apply.{:else}Paid plans add shared IPA downloads and API access.{/if}</p>
        {#if quota}
          <div class="mt-3 max-w-xl">
            <div class="flex justify-between gap-3 text-xs"><span>{quota.remaining ?? 0} of {quota.limit ?? 3} decrypts remaining</span>{#if quota.nextAvailableAt && quota.remaining === 0}<span class="text-muted">Next slot {new Date(quota.nextAvailableAt).toLocaleDateString()}</span>{/if}</div>
            <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-panel-muted"><div class="h-full rounded-full bg-accent" style={`width: ${Math.min(100, ((quota.used ?? 0) / Math.max(1, quota.limit ?? 3)) * 100)}%`}></div></div>
          </div>
        {/if}
      </div>
      <div class="flex shrink-0 items-center gap-2">
        {#if billingEnabled}<a href="/?tab=billing" class={buttonVariants('default', 'sm')}>Compare plans</a>{/if}
        <button type="button" class="min-h-9 rounded-lg px-2 text-xs text-muted hover:text-foreground" onclick={dismiss}>Hide for 7 days</button>
      </div>
    </div>
  </section>
{/if}
