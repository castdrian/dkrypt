<script lang="ts">
  import { Check, Gauge, KeyRound, ShieldCheck, X, Zap } from 'lucide-svelte';
  import { onMount } from 'svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import { buttonVariants } from '#lib/components/ui/variants';
  import PublicPageFooter from '#components/PublicPageFooter.svelte';
  import PublicPageHeader from '#components/PublicPageHeader.svelte';

  interface PublicPlan {
    id: string;
    name: string;
    description: string;
    amount: number;
    currency: string;
    api: boolean;
    priority: number;
    dailyDecryptLimit?: number;
    apiRatePerMinute?: number;
  }

  let plans = $state<PublicPlan[]>([]);
  let loading = $state(true);
  let loadError = $state(false);

  async function loadPlans(): Promise<void> {
    loading = true;
    loadError = false;
    try {
      const response = await fetch('/pricing/catalog.json');
      if (!response.ok) throw new Error('pricing unavailable');
      plans = ((await response.json()) as { plans: PublicPlan[] }).plans;
    } catch {
      loadError = true;
    } finally {
      loading = false;
    }
  }

  function price(plan: PublicPlan): string {
    return `€${Number.isInteger(plan.amount) ? plan.amount : plan.amount.toFixed(2)}`;
  }

  onMount(() => { void loadPlans(); });
</script>

<div class="min-h-screen">
  <PublicPageHeader />
  <main class="mx-auto max-w-6xl px-5 py-12">
    <div class="mx-auto mb-10 max-w-3xl text-center">
      <div class="text-accent mb-3 text-sm font-semibold tracking-wide uppercase">Simple monthly access</div>
      <h1 class="text-3xl font-semibold tracking-tight sm:text-4xl">Choose a dkrypt plan</h1>
      <p class="mt-4 text-sm leading-6 text-muted">
        Start with three decrypts every 30 days. Upgrade for longer result access, downloadable IPA Library files, and higher limits.
      </p>
    </div>

    {#if loading}<p class="py-12 text-center text-sm text-muted">Loading plans…</p>{:else if loadError}<div class="py-12 text-center text-sm text-muted">Pricing is temporarily unavailable. <button class="underline" onclick={() => void loadPlans()}>Try again</button></div>{/if}
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      <Card class="flex h-full flex-col" contentClass="flex flex-1 flex-col">
        <div class="flex min-h-72 flex-1 flex-col">
          <div class="mb-4 min-h-24"><div class="flex items-center gap-2"><h2 class="text-base font-semibold">Free</h2><Badge variant="secondary">Start here</Badge></div><p class="mt-1 text-sm leading-5 text-muted">Try dkrypt with a small monthly allowance.</p></div>
          <div class="mb-5"><span class="text-3xl font-semibold">€0</span><span class="text-sm text-muted">/month</span></div>
          <div class="mb-5 flex flex-1 flex-col gap-2 text-sm">
            <div class="flex items-center gap-2"><Check class="h-4 w-4 text-ok" /> 3 new decrypts / rolling 30 days</div>
            <div class="flex items-center gap-2"><Check class="h-4 w-4 text-ok" /> 30 minutes to download each result</div>
            <div class="flex items-center gap-2"><Check class="h-4 w-4 text-ok" /> Browse IPA Library metadata</div>
            <div class="flex items-center gap-2 text-muted"><X class="h-4 w-4" /> Shared IPA downloads and API access</div>
            <div class="flex items-center gap-2 text-muted"><X class="h-4 w-4" /> Lowest queue priority</div>
          </div>
          <a href="/#sign-in" class="{buttonVariants('secondary')} w-full">Create a free account</a>
        </div>
      </Card>
      {#each plans as plan (plan.id)}
        <Card class={plan.id === 'unlimited_priority' || plan.id === 'priority_api' ? 'flex h-full flex-col border-accent shadow-lg shadow-accent/10' : 'flex h-full flex-col'} contentClass="flex flex-1 flex-col">
          <div class="flex min-h-72 flex-1 flex-col">
            <div class="mb-4 flex min-h-24 items-start justify-between gap-3">
              <div>
                <div class="flex flex-wrap items-center gap-2">
                  <h2 class="text-base font-semibold">{plan.name}</h2>
                  {#if plan.priority > 0}<Badge>Priority</Badge>{/if}
                </div>
                <p class="mt-1 text-sm leading-5 text-muted">{plan.description}</p>
              </div>
              {#if plan.priority > 0}
                <Zap class="h-5 w-5 shrink-0 text-accent" />
              {:else if plan.api}
                <KeyRound class="h-5 w-5 shrink-0 text-accent" />
              {:else}
                <Gauge class="h-5 w-5 shrink-0 text-accent" />
              {/if}
            </div>

            <div class="mb-5">
              <span class="text-3xl font-semibold">{price(plan)}</span>
              <span class="text-sm text-muted">/month</span>
            </div>

            <div class="mb-5 flex flex-1 flex-col gap-2 text-sm">
              <div class="flex items-center gap-2"><Check class="h-4 w-4 text-ok" /> IPA Library access</div>
              <div class="flex items-center gap-2"><Check class="h-4 w-4 text-ok" /> {plan.dailyDecryptLimit === undefined ? 'Unlimited new decrypts' : `${plan.dailyDecryptLimit} new decrypts / rolling 24h`}</div>
              {#if plan.api}
                <div class="flex items-center gap-2"><Check class="h-4 w-4 text-ok" /> API access{plan.apiRatePerMinute ? ` · ${plan.apiRatePerMinute} requests/min` : ''}</div>
              {:else}
                <div class="flex items-center gap-2 text-muted"><X class="h-4 w-4" /> API access</div>
              {/if}
              {#if plan.priority > 0}
                <div class="flex items-center gap-2"><Check class="h-4 w-4 text-ok" /> High queue priority</div>
              {:else}
                <div class="flex items-center gap-2 text-muted"><X class="h-4 w-4" /> High queue priority</div>
              {/if}
            </div>

            <div class="w-full pt-1">
              <div class="mb-3 flex items-center gap-2 text-xs text-muted"><ShieldCheck class="h-4 w-4 shrink-0 text-accent" /> Stripe checkout · crypto where available</div>
              <a
                href="/#sign-in"
                class="{buttonVariants('default')} w-full"
              >
                Sign in to subscribe
              </a>
            </div>
          </div>
        </Card>
      {/each}
    </div>

    <Card class="mx-auto mt-8 max-w-3xl text-sm leading-6 text-muted">
      Stripe renews card or bank payments monthly. Crypto access lasts 30 days after a verified NOWPayments payment. Crypto availability depends on the selected asset’s minimum payment amount; your plan price is never increased.
    </Card>
  </main>
  <PublicPageFooter />
</div>
