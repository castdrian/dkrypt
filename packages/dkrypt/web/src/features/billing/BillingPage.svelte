<script lang="ts">
  import { Check, CircleCheck, CircleX, Download, ExternalLink, Gauge, KeyRound, LoaderCircle, LockKeyhole, RefreshCw, Search, ShieldCheck, X, Zap } from 'lucide-svelte';
  import { onMount } from 'svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import LegalLinks from '#components/LegalLinks.svelte';
  import { pushDecryptUsageAlertThresholds, refreshSession, sessionHasPermission } from '#lib/session.svelte';
  import { PermissionFlag } from '#lib/permissions';
  import { confirmDialog, decryptUsageAlertThresholdsState, showToast } from '#lib/ui.svelte';
  import type { BadgeVariant } from '#lib/components/ui/variants';
  import { fmtCalendarDate, fmtCurrency } from '#lib/format.svelte';
  import { fetchBillingInvoices, fetchBillingQuotaHistory, redeemBillingAccessCode, type BillingInvoice, type BillingQuotaHistoryEntry } from '#lib/api';

  type PlanId = 'viewer' | 'regular' | 'priority' | 'api' | 'priority_api' | 'access' | 'standard' | 'plus' | 'developer' | 'unlimited' | 'unlimited_priority';
  type CheckoutState = 'success' | 'cancelled' | undefined;
  type ActivationStatus = 'idle' | 'checking' | 'active' | 'pending';
  type PaymentProvider = 'stripe' | 'crypto';

  interface Plan {
    id: Exclude<PlanId, 'viewer'>;
    name: string;
    description: string;
    amount: number;
    currency: string;
    priceId: string;
    api: boolean;
    priority: number;
    legacy: boolean;
    dailyDecryptLimit?: number;
    apiRatePerMinute?: number;
  }

  interface ProviderStatus {
    enabled: boolean;
    ready: boolean;
    environment: 'test' | 'live';
    settlementCurrency?: string;
    issues?: string[];
    minimumByAsset?: Record<string, number>;
  }

  interface Entitlement {
    planId: PlanId;
    decrypt: boolean;
    api: boolean;
    priority: number;
    provider?: 'stripe' | 'nowpayments' | 'legacy' | 'gift';
    status?: string;
    subscriptionId?: string;
    expiresAt?: string;
    accessCodeId?: string;
    nextBilledAt?: string;
    scheduledChangeAction?: string;
    scheduledChangeAt?: string;
    dailyDecryptLimit?: number;
    apiRatePerMinute?: number;
    legacy?: boolean;
  }

  interface BillingData {
    enabled: boolean;
    provider: 'stripe' | 'nowpayments' | 'legacy' | 'gift';
    environment: 'test' | 'live';
    managedPayments: boolean;
    missingConfiguration: string[];
    plans: Plan[];
    currentPlan?: Plan;
    customerId?: string;
    customerEmail?: string;
    legacyBilling: boolean;
    entitlement: Entitlement;
    quota: { limit: number | null; used: number; remaining: number | null; nextAvailableAt?: number };
    apiRateUsage?: { limit: number; used: number; remaining: number; resetAt: number };
    usageForecast: { sampleDays: number; jobsInSample: number; averagePerDay: number; daysUntilAllowanceUsed: number | null };
    providers: {
      stripe: ProviderStatus;
      crypto: ProviderStatus & { provider: 'nowpayments'; assets: string[] };
    };
  }

  let billing = $state<BillingData | undefined>();
  let invoices = $state<BillingInvoice[]>([]);
  let invoiceWarnings = $state<string[]>([]);
  let receiptQuery = $state('');
  let receiptProvider = $state<'all' | 'stripe' | 'nowpayments'>('all');
  let receiptStatus = $state('all');
  let quotaHistory = $state<BillingQuotaHistoryEntry[] | null>(null);
  let quotaHistoryOpen = $state(false);
  let quotaHistoryLoading = $state(false);
  let accessCheckLoading = $state(false);
  let accessCheckLines = $state<Array<{ label: string; ok: boolean; detail: string }> | null>(null);
  let loading = $state(true);
  let loadError = $state(false);
  let openingPlan = $state<PlanId | undefined>();
  let openingPortal = $state(false);
  let cancelling = $state(false);
  let accessCode = $state('');
  let redeemingAccessCode = $state(false);
  let cancelIdempotencyKey = $state<string | undefined>();
  let activationStatus = $state<ActivationStatus>('idle');
  let checkoutIdempotencyKey = $state<string | undefined>();
  let checkoutIdempotencyPlan = $state<PlanId | undefined>();
  let checkoutIdempotencyProvider = $state<PaymentProvider | undefined>();
  let paymentProvider = $state<PaymentProvider>('stripe');
  let planChangeOpen = $state(false);
  let pendingPlanChange = $state<Plan | undefined>();
  let cryptoAsset = $state('USDC');
  const checkoutParams = new URLSearchParams(location.search);
  let checkoutState = $state<CheckoutState>((checkoutParams.get('checkout') ?? checkoutParams.get('crypto_checkout')) as CheckoutState);
  const visibleInvoices = $derived.by(() => invoices.filter((invoice) => {
    const query = receiptQuery.trim().toLowerCase();
    return (receiptProvider === 'all' || invoice.provider === receiptProvider)
      && (receiptStatus === 'all' || invoice.status === receiptStatus)
      && (!query || `${invoice.id} ${invoice.paymentId ?? ''} ${invoice.planId} ${invoice.provider}`.toLowerCase().includes(query));
  }));
  const planFit = $derived.by(() => {
    if (!billing || billing.usageForecast.jobsInSample < 3) return null;
    if (billing.entitlement.legacy) return { legacy: true as const, plan: undefined, expectedDaily: 0 };
    const expectedDaily = billing.usageForecast.averagePerDay * 1.25;
    const needsApi = billing.currentPlan?.api === true;
    const needsPriority = (billing.currentPlan?.priority ?? 0) > 0;
    const plan = [...billing.plans]
      .filter((candidate) => !candidate.legacy && (!needsApi || candidate.api) && (!needsPriority || candidate.priority > 0))
      .sort((a, b) => a.amount - b.amount)
      .find((candidate) => candidate.dailyDecryptLimit === undefined || candidate.dailyDecryptLimit >= expectedDaily);
    return { legacy: false as const, plan, expectedDaily };
  });

  async function loadBilling(): Promise<void> {
    const response = await fetch('/v1/billing');
    if (!response.ok) throw new Error('billing unavailable');
    billing = (await response.json()) as BillingData;
    try {
      const history = await fetchBillingInvoices();
      invoices = history.invoices;
      invoiceWarnings = history.warnings;
    } catch {
      invoiceWarnings = ['Payment history is temporarily unavailable'];
    }
    if (billing.entitlement.provider === 'nowpayments' || (!billing.providers.stripe.enabled && billing.providers.crypto.enabled)) paymentProvider = 'crypto';
  }

  async function initializeBilling(): Promise<void> {
    loading = true;
    loadError = false;
    try {
      await loadBilling();
    } catch {
      loadError = true;
      showToast("Couldn't load billing right now", 'error');
    } finally {
      loading = false;
    }
  }

  function toggleUsageAlert(threshold: number): void {
    const current = decryptUsageAlertThresholdsState.value;
    const next = current.includes(threshold) ? current.filter((value) => value !== threshold) : [...current, threshold];
    void pushDecryptUsageAlertThresholds(next).catch((error) => showToast(error instanceof Error ? error.message : 'Could not save usage alerts', 'error'));
  }

  async function checkAccess(): Promise<void> {
    accessCheckLoading = true;
    try {
      await Promise.all([loadBilling(), refreshSession()]);
      if (!billing) return;
      const decryptReady = billing.entitlement.decrypt && sessionHasPermission(PermissionFlag.requestDecrypt);
      const apiReady = billing.entitlement.api && sessionHasPermission(PermissionFlag.accessApi);
      accessCheckLines = [
        { label: 'Decrypt jobs', ok: decryptReady, detail: decryptReady ? 'Your plan and account permission both allow decrypt requests.' : billing.entitlement.decrypt ? 'Your plan is active, but your account role does not allow decrypt requests.' : 'Your current plan does not include paid decrypt access.' },
        { label: 'IPA Library', ok: billing.entitlement.decrypt, detail: billing.entitlement.decrypt ? 'Your plan includes artifact library access.' : 'An active decrypt plan is required for paid library access.' },
        { label: 'API keys', ok: apiReady, detail: apiReady ? 'Your plan and account permission allow API access.' : billing.entitlement.api ? 'Your plan includes API access, but your account role does not allow it.' : 'Your plan does not include API access.' },
      ];
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not check account access.', 'error');
    } finally {
      accessCheckLoading = false;
    }
  }

  async function toggleQuotaHistory(): Promise<void> {
    quotaHistoryOpen = !quotaHistoryOpen;
    if (!quotaHistoryOpen || quotaHistory !== null) return;
    quotaHistoryLoading = true;
    try {
      quotaHistory = (await fetchBillingQuotaHistory()).entries;
    } catch (error) {
      quotaHistory = [];
      showToast(error instanceof Error ? error.message : 'Could not load quota history.', 'error');
    } finally {
      quotaHistoryLoading = false;
    }
  }

  function showPlan(plan: Plan): void {
    document.getElementById(`billing-plan-${plan.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function usageForecastLabel(): string {
    const days = billing?.usageForecast.daysUntilAllowanceUsed;
    if (days === null || days === undefined) return 'Not enough recent usage to estimate';
    if (days < 1) return 'At your recent pace, you may use this allowance within a day';
    return `At your recent pace, the remaining allowance may last about ${days.toFixed(days < 10 ? 1 : 0)} days`;
  }

  async function refreshAfterCheckout(): Promise<void> {
    try {
      await loadBilling();
      await refreshSession();
    } catch {}
  }

  async function waitForActivation(): Promise<void> {
    activationStatus = 'checking';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await refreshAfterCheckout();
      if (billing?.entitlement.planId !== 'viewer') {
        activationStatus = 'active';
        showToast('Subscription active. Your paid features are ready.', 'success');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1250));
    }
    activationStatus = 'pending';
  }

  async function manageSubscription(): Promise<void> {
    openingPortal = true;
    try {
      const response = await fetch('/v1/billing/portal', { method: 'POST' });
      const data = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!response.ok || !data.url) {
        showToast(data.error ?? "Couldn't open the billing portal", 'error');
        return;
      }
      location.assign(data.url);
    } finally {
      openingPortal = false;
    }
  }

  async function cancelSubscription(): Promise<void> {
    if (!(await confirmDialog('Stop this crypto renewal now? Access ends immediately.', { confirmLabel: 'Stop renewal' }))) return;
    cancelling = true;
    cancelIdempotencyKey ??= crypto.randomUUID();
    try {
      const response = await fetch('/v1/billing/cancel', { method: 'POST', headers: { 'Idempotency-Key': cancelIdempotencyKey } });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        showToast(data.error ?? "Couldn't cancel the subscription", 'error');
        return;
      }
      showToast('Subscription cancelled', 'success');
      await refreshAfterCheckout();
    } finally {
      cancelling = false;
    }
  }

  async function redeemAccessCode(): Promise<void> {
    if (!accessCode.trim()) return;
    redeemingAccessCode = true;
    try {
      const result = await redeemBillingAccessCode(accessCode);
      accessCode = '';
      showToast(`${planLabel(result.planId as PlanId)} access is active until ${formatDate(result.expiresAt)}.`, 'success');
      await refreshAfterCheckout();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't redeem this access code", 'error');
    } finally {
      redeemingAccessCode = false;
    }
  }

  async function startCheckout(plan: Plan): Promise<void> {
    openingPlan = plan.id;
    if (checkoutIdempotencyPlan !== plan.id || checkoutIdempotencyProvider !== paymentProvider) {
      checkoutIdempotencyKey = crypto.randomUUID();
      checkoutIdempotencyPlan = plan.id;
      checkoutIdempotencyProvider = paymentProvider;
    }
    const idempotencyKey = checkoutIdempotencyKey;
    if (!idempotencyKey) {
      openingPlan = undefined;
      showToast("Couldn't start checkout", 'error');
      return;
    }
    try {
      const response = await fetch('/v1/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ planId: plan.id, provider: paymentProvider, cryptoAsset: paymentProvider === 'crypto' ? cryptoAsset : undefined }),
      });
      const data = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!response.ok || !data.url) {
        showToast(data.error ?? "Couldn't start checkout", 'error');
        return;
      }
      location.assign(data.url);
    } finally {
      openingPlan = undefined;
    }
  }

  async function changePlan(plan: Plan): Promise<void> {
    if (billing?.entitlement.provider === 'nowpayments' && billing.entitlement.status === 'past_due') {
      if (plan.id !== billing.entitlement.planId) {
        showToast('Cancel the current crypto plan before choosing a different tier.', 'error');
        return;
      }
      return void startCheckout(plan);
    }
    if (billing?.entitlement.provider === 'nowpayments') {
      showToast('Crypto plan changes require cancellation and a new checkout.', 'error');
      return;
    }
    openingPlan = plan.id;
    try {
      const response = await fetch('/v1/billing/subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: plan.id, acknowledgeLegacyLoss: billing?.entitlement.legacy === true }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        showToast(data.error ?? 'Plan change failed', 'error');
        return;
      }
      showToast('Plan updated. Your access is refreshing…', 'success');
      await refreshAfterCheckout();
    } finally {
      openingPlan = undefined;
    }
  }

  function choosePlan(plan: Plan): void {
    if (openingPlan) return;
    if (billing?.entitlement.subscriptionId) {
      if (billing.entitlement.provider === 'nowpayments') {
        void changePlan(plan);
        return;
      }
      pendingPlanChange = plan;
      planChangeOpen = true;
      return;
    }
    void startCheckout(plan);
  }

  async function confirmPlanChange(): Promise<void> {
    const plan = pendingPlanChange;
    planChangeOpen = false;
    pendingPlanChange = undefined;
    if (plan) await changePlan(plan);
  }

  function fallbackPrice(plan: Plan): string {
    return fmtCurrency(plan.amount, plan.currency);
  }

  function formatDate(value: string): string {
    return fmtCalendarDate(value);
  }

  function planLabel(planId: PlanId): string {
    return planId === 'viewer' ? 'Viewer' : planId.replace('_', ' ');
  }

  function statusVariant(status?: string): BadgeVariant {
    if (status === 'active' || status === 'trialing') return 'success';
    if (status === 'past_due' || status === 'incomplete') return 'warning';
    if (status === 'canceled' || status === 'cancelled' || status === 'unpaid') return 'destructive';
    return 'secondary';
  }

  function statusLabel(status?: string): string {
    return status ? status.replace('_', ' ') : 'Not subscribed';
  }

  function cryptoReady(): boolean {
    return billing?.providers.crypto.ready === true && billing.providers.crypto.minimumByAsset?.[cryptoAsset] !== undefined;
  }

  function cryptoReadyForPlan(plan: Plan): boolean {
    const minimum = billing?.providers.crypto.minimumByAsset?.[cryptoAsset];
    return cryptoReady() && minimum !== undefined && plan.amount >= minimum;
  }

  function cryptoAssetLabel(asset: string): string {
    return asset.toUpperCase() === 'USDCBASE' ? 'USDC · Base' : asset;
  }

  onMount(() => {
    void initializeBilling().then(() => {
      if (checkoutState === 'success') void waitForActivation();
    });
  });
</script>

<div class="flex flex-col gap-4">
  {#if checkoutState === 'success'}
    <div class="flex items-start gap-3 rounded-[1.2rem] border border-ok/30 bg-ok/10 px-4 py-3 text-sm" aria-live="polite">
      <CircleCheck class="mt-0.5 h-5 w-5 shrink-0 text-ok" />
      <div>
        <div class="font-semibold text-ok">Checkout completed</div>
        <p class="mt-1 text-muted">
          {#if activationStatus === 'active'}
            Your subscription is active and paid features are ready.
          {:else if activationStatus === 'pending'}
            Your provider is still confirming the subscription. Access remains unchanged until the verified webhook arrives.
            <Button class="mt-3" size="sm" variant="secondary" onclick={() => void waitForActivation()}><RefreshCw class="h-4 w-4" /> Check again</Button>
          {:else}
            Your provider is confirming the subscription. This usually takes a few seconds.
          {/if}
        </p>
      </div>
    </div>
  {:else if checkoutState === 'cancelled'}
    <div class="flex items-start gap-3 rounded-[1.2rem] border border-border bg-panel-muted/40 px-4 py-3 text-sm" aria-live="polite">
      <CircleX class="mt-0.5 h-5 w-5 shrink-0 text-muted" />
      <div><div class="font-semibold">Checkout canceled</div><p class="mt-1 text-muted">No charge was made. Choose a plan whenever you’re ready.</p></div>
    </div>
  {/if}

  <Card>
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <div class="mb-1 flex flex-wrap items-center gap-2">
          <h2 class="text-lg font-semibold">Choose your dkrypt plan</h2>
          {#if billing?.providers.stripe.enabled && billing.providers.stripe.environment === 'test'}<Badge variant="outline">Test mode</Badge>{/if}
        </div>
        <p class="max-w-2xl text-sm text-muted">Unlock authorized decrypt processing, API access, and higher queue priority with one monthly plan.</p>
      </div>
      {#if billing}
        <div class="flex flex-wrap items-center gap-2">
          <div class="rounded-xl border border-border bg-bg/60 px-3 py-2 text-right"><div class="text-xs text-muted">Current plan</div><div class="font-semibold capitalize">{planLabel(billing.entitlement.planId)}</div><Badge variant={statusVariant(billing.entitlement.status)} class="mt-1">{billing.entitlement.provider === 'gift' ? 'Prepaid' : statusLabel(billing.entitlement.status)}</Badge></div>
          <Button variant="secondary" loading={accessCheckLoading} onclick={() => void checkAccess()}>Check my access</Button>
          {#if billing.entitlement.provider === 'stripe' && billing.customerId}<Button variant="secondary" loading={openingPortal} onclick={() => void manageSubscription()}><ExternalLink class="h-4 w-4" /> Manage billing</Button>{:else if billing.entitlement.provider === 'nowpayments'}<Button variant="secondary" loading={cancelling} onclick={() => void cancelSubscription()}>Stop crypto renewal</Button>{/if}
        </div>
      {/if}
    </div>
    {#if accessCheckLines}<div class="mt-4 grid gap-2 rounded-xl border border-border bg-bg/40 p-3 sm:grid-cols-3" aria-live="polite">{#each accessCheckLines as line (line.label)}<div class="flex items-start gap-2 text-xs"><span class={line.ok ? 'text-ok' : 'text-warn'}>{#if line.ok}<Check class="size-3.5" />{:else}<CircleX class="size-3.5" />{/if}</span><span><span class="font-medium">{line.label}</span><span class="mt-0.5 block text-muted">{line.detail}</span></span></div>{/each}</div>{/if}
    {#if billing && billing.entitlement.planId !== 'viewer'}
      <div class="mt-4 rounded-xl border border-border bg-bg/50 px-3 py-3 text-sm">
        <div class="flex flex-wrap items-center gap-2 font-medium">Your decrypt allowance {#if billing.entitlement.legacy}<Badge variant="secondary">Grandfathered</Badge>{/if}</div>
        <div class="mt-1 text-muted">{billing.quota.limit === null ? 'Unlimited new decrypts' : `${billing.quota.remaining ?? 0} of ${billing.quota.limit} new decrypts available in the rolling 24-hour window`}. IPA Library downloads do not use this allowance.</div>
        {#if billing.quota.nextAvailableAt && billing.quota.remaining === 0}<div class="mt-1 text-xs text-muted">Next slot opens {formatDate(new Date(billing.quota.nextAvailableAt).toISOString())}.</div>{/if}
        {#if billing.quota.limit !== null}<div class="mt-2 text-xs text-muted">{usageForecastLabel()} · based on {billing.usageForecast.jobsInSample} jobs over {billing.usageForecast.sampleDays} days.</div><fieldset class="mt-3"><legend class="text-xs font-medium">Alert me when I use</legend><div class="mt-1 flex flex-wrap gap-x-4 gap-y-2">{#each [50, 75, 90, 100] as threshold}<label class="inline-flex min-h-9 items-center gap-2 text-xs"><input type="checkbox" class="size-4 accent-accent" checked={decryptUsageAlertThresholdsState.value.includes(threshold)} onchange={() => toggleUsageAlert(threshold)} />{threshold}%</label>{/each}</div></fieldset>{/if}
        {#if billing.entitlement.apiRatePerMinute}<div class="mt-2 rounded-lg border border-border/70 px-3 py-2"><div class="flex items-center justify-between gap-3 text-xs"><span>API request limit</span><span class="tabular-nums">{billing.apiRateUsage?.used ?? 0} of {billing.apiRateUsage?.limit ?? billing.entitlement.apiRatePerMinute} per minute</span></div><div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-panel-muted"><div class="h-full rounded-full bg-accent transition-[width]" style={`width: ${Math.min(100, ((billing.apiRateUsage?.used ?? 0) / (billing.apiRateUsage?.limit ?? billing.entitlement.apiRatePerMinute)) * 100)}%`}></div></div><div class="mt-1 text-[11px] text-muted">Shared across all your API keys. Resets continuously over a rolling minute.</div></div>{/if}
        {#if billing.entitlement.provider === 'gift' && billing.entitlement.expiresAt}<div class="mt-1 text-xs text-muted">Prepaid access ends {formatDate(billing.entitlement.expiresAt)}. It does not renew.</div>{/if}
        <div class="mt-3 flex flex-wrap gap-2"><a class="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-panel-muted" href="/v1/billing/usage.csv"><Download class="h-3.5 w-3.5" />Download usage journal</a><Button size="sm" variant="secondary" onclick={() => void toggleQuotaHistory()}>{quotaHistoryOpen ? 'Hide allowance history' : 'View allowance history'}</Button></div>
        {#if quotaHistoryOpen}<div class="mt-3 border-t border-border pt-3">{#if quotaHistoryLoading}<div class="text-xs text-muted" role="status">Loading allowance history…</div>{:else if quotaHistory?.length}<ul class="divide-y divide-border/70">{#each quotaHistory as entry (`${entry.jobId}-${entry.at}`)}<li class="flex flex-wrap items-center justify-between gap-2 py-2 text-xs"><span class="min-w-0"><span class="font-medium">{entry.bundleId ?? 'Decrypt request'}</span>{#if entry.versionLabel}<span class="text-muted"> · {entry.versionLabel}</span>{/if}<span class="mt-0.5 block text-muted">{entry.status} · {entry.source ?? 'unknown source'}</span></span><span class="shrink-0 text-muted">{formatDate(new Date(entry.at).toISOString())} · {entry.state === 'consumed' ? 'used' : 'reserved'}</span></li>{/each}</ul>{:else}<div class="text-xs text-muted">No allowance activity is recorded yet.</div>{/if}</div>{/if}
        {#if planFit}<div class="mt-3 rounded-lg border border-border/70 bg-panel-muted/30 p-3 text-xs"><div class="font-medium">Plan fit for your recent usage</div>{#if planFit.legacy}<p class="mt-1 text-muted">Your current plan is grandfathered. Its benefits stay in place; dkrypt will not recommend a switch that could remove them.</p>{:else if planFit.plan}<p class="mt-1 text-muted">At about {planFit.expectedDaily.toFixed(1)} decrypts per day with a 25% buffer, {planFit.plan.name} is the lowest-priced tier that fits. This estimate uses your recent usage and preserves any API or priority access already on your plan.</p><Button class="mt-2" size="sm" variant="secondary" onclick={() => showPlan(planFit.plan!)}>Compare {planFit.plan.name}</Button>{:else}<p class="mt-1 text-muted">No new tier covers this usage while preserving your current API and priority benefits. Your existing plan remains unchanged.</p>{/if}</div>{/if}
      </div>
    {/if}
  </Card>

  {#if billing && (invoices.length > 0 || invoiceWarnings.length > 0)}
    <Card>
      <div><h3 class="text-sm font-semibold">Invoices and payment receipts</h3><p class="mt-1 text-xs text-muted">Recent Stripe invoices and dkrypt crypto payment records for this account.</p></div>
      {#if invoiceWarnings.length}<div class="mt-3 text-xs text-muted">{invoiceWarnings.join(' · ')}</div>{/if}
      <div class="mt-3 grid gap-2 sm:grid-cols-[minmax(12rem,1fr)_10rem_10rem]"><label class="relative"><Search class="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted" /><input class="h-9 w-full rounded-lg border border-border bg-bg pl-9 pr-3 text-xs" bind:value={receiptQuery} placeholder="Search receipts" aria-label="Search receipts" /></label><select class="h-9 rounded-lg border border-border bg-bg px-2 text-xs" bind:value={receiptProvider} aria-label="Filter by payment provider"><option value="all">All providers</option><option value="stripe">Stripe</option><option value="nowpayments">Crypto</option></select><select class="h-9 rounded-lg border border-border bg-bg px-2 text-xs" bind:value={receiptStatus} aria-label="Filter by payment status"><option value="all">All statuses</option>{#each [...new Set(invoices.map((invoice) => invoice.status))].sort() as status (status)}<option value={status}>{status}</option>{/each}</select></div>
      {#if visibleInvoices.length}
        <ul class="mt-3 divide-y divide-border/70">
          {#each visibleInvoices as invoice (invoice.id)}
            <li class="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"><div class="min-w-0"><div class="font-medium">{planLabel(invoice.planId as PlanId)} · {invoice.provider === 'stripe' ? 'Stripe' : 'Crypto'}</div><div class="mt-1 text-xs text-muted">{formatDate(invoice.createdAt)} · {invoice.status}</div><div class="mt-1 max-w-full truncate font-mono text-[10px] text-muted" data-sensitive="true">{invoice.provider === 'stripe' ? invoice.id : invoice.paymentId ?? invoice.id}</div></div><div class="flex items-center gap-3"><span class="font-medium">{fmtCurrency(invoice.amountMinor / 100, invoice.currency)}</span>{#if invoice.invoiceUrl}<a class="rounded-md border border-border p-2" href={invoice.invoiceUrl} target="_blank" rel="noreferrer" aria-label="Open invoice"><ExternalLink class="h-4 w-4" /></a>{/if}</div></li>
          {/each}
        </ul>
      {:else if invoices.length}<p class="mt-3 text-sm text-muted">No receipts match these filters.</p>{:else if !invoiceWarnings.length}<p class="mt-3 text-sm text-muted">No payments have been recorded yet.</p>{/if}
    </Card>
  {/if}

  {#if billing?.entitlement.planId === 'viewer'}
    <Card>
      <div class="font-medium">Have a prepaid access code?</div>
      <p class="mt-1 text-sm text-muted">Redeem a one-time code for fixed-term access. It will not renew automatically.</p>
      <form class="mt-3 flex flex-col gap-2 sm:flex-row" onsubmit={(event) => { event.preventDefault(); void redeemAccessCode(); }}>
        <input class="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm uppercase text-text" bind:value={accessCode} autocomplete="off" autocapitalize="characters" maxlength="128" placeholder="DKR-XXXX-XXXX-…" aria-label="Prepaid access code" data-sensitive="true" />
        <Button type="submit" disabled={!accessCode.trim()} loading={redeemingAccessCode}>Redeem code</Button>
      </form>
    </Card>
  {/if}

  {#if billing?.legacyBilling}
    <Card class="border-accent/40 bg-accent/5"><div class="text-sm"><div class="font-medium">Previous billing record needs review</div><div class="mt-1 text-muted">Your previous payment-provider record was kept for reconciliation. Contact support before starting a new subscription so the account is not charged twice.</div></div></Card>
  {/if}

  {#if planChangeOpen && pendingPlanChange && billing}
    {@const currentPlan = billing.currentPlan}
    {@const newRemaining = pendingPlanChange.dailyDecryptLimit === undefined ? null : Math.max(0, pendingPlanChange.dailyDecryptLimit - billing.quota.used)}
    <Dialog open={planChangeOpen} onOpenChange={(open) => (planChangeOpen = open)} title="Review plan change" class="max-h-[85vh] max-w-lg overflow-y-auto">
      <div class="flex items-start justify-between gap-3"><div><h2 class="text-base font-semibold">Review your plan change</h2><p class="mt-1 text-xs text-muted">Nothing changes until you confirm.</p></div><Button size="icon" variant="ghost" aria-label="Close plan review" onclick={() => (planChangeOpen = false)}><X class="h-4 w-4" /></Button></div>
      <div class="mt-4 grid gap-3 sm:grid-cols-2">
        <div class="rounded-lg border border-border p-3"><div class="text-[11px] text-muted">Current</div><div class="mt-1 font-medium">{currentPlan?.name ?? planLabel(billing.entitlement.planId)}</div><div class="mt-1 text-sm">{currentPlan ? fallbackPrice(currentPlan) : 'Current price'}<span class="text-xs text-muted"> / month</span></div><div class="mt-2 text-xs text-muted">{billing.quota.limit === null ? 'Unlimited new decrypts' : `${billing.quota.limit} new decrypts per rolling 24 hours`}</div></div>
        <div class="rounded-lg border border-accent/50 bg-accent/5 p-3"><div class="text-[11px] text-muted">After switching</div><div class="mt-1 font-medium">{pendingPlanChange.name}</div><div class="mt-1 text-sm">{fallbackPrice(pendingPlanChange)}<span class="text-xs text-muted"> / month</span></div><div class="mt-2 text-xs text-muted">{pendingPlanChange.dailyDecryptLimit === undefined ? 'Unlimited new decrypts' : `${pendingPlanChange.dailyDecryptLimit} new decrypts per rolling 24 hours`}</div></div>
      </div>
      <div class="mt-3 rounded-lg border border-border/70 bg-panel-muted/20 p-3 text-xs">
        <div class="font-medium">What changes</div>
        <ul class="mt-2 space-y-1.5 text-muted">
          <li>Usage carries over: {billing.quota.used} decrypts are already counted in the current rolling 24-hour window{newRemaining === null ? '; the new plan has no daily cap.' : `; about ${newRemaining} slots remain under the new allowance.`}</li>
          <li>{pendingPlanChange.api ? `API access stays available${pendingPlanChange.apiRatePerMinute ? ` at ${pendingPlanChange.apiRatePerMinute} requests per minute` : ''}.` : 'API access will be removed with this plan.'}</li>
          <li>{pendingPlanChange.priority > (currentPlan?.priority ?? 0) ? 'Queue priority increases.' : pendingPlanChange.priority < (currentPlan?.priority ?? 0) ? 'Queue priority decreases to standard.' : pendingPlanChange.priority > 0 ? 'Higher queue priority remains.' : 'Standard queue priority remains.'}</li>
          <li>{billing.entitlement.nextBilledAt ? `Next billing date: ${formatDate(billing.entitlement.nextBilledAt)}.` : 'The plan price will apply through Stripe billing.'} {currentPlan && pendingPlanChange.amount > currentPlan.amount ? 'Stripe may invoice the prorated increase immediately.' : 'Stripe applies any price decrease as a billing proration.'} If payment cannot complete, the current plan remains unchanged.</li>
        </ul>
      </div>
      {#if billing.entitlement.legacy}
        <div class="mt-3 rounded-lg border border-warn/40 bg-warn/5 p-3 text-xs"><div class="font-medium">Grandfathered benefits will end</div><p class="mt-1 text-muted">This switch permanently ends your current legacy plan. Its price and benefits cannot be restored later.</p></div>
      {/if}
      <div class="mt-4 flex flex-wrap justify-end gap-2"><Button variant="secondary" onclick={() => (planChangeOpen = false)}>Keep current plan</Button><Button loading={openingPlan === pendingPlanChange.id} onclick={() => void confirmPlanChange()}>{billing.entitlement.legacy ? 'Switch and end legacy plan' : `Confirm switch to ${pendingPlanChange.name}`}</Button></div>
    </Dialog>
  {/if}

  {#if loading}
    <Card class="flex min-h-48 items-center justify-center"><LoaderCircle class="h-6 w-6 animate-spin text-muted" /></Card>
  {:else if loadError}
    <Card class="py-12 text-center"><CircleX class="mx-auto mb-3 h-8 w-8 text-err" /><div class="font-medium">Billing could not be loaded</div><div class="mt-1 text-sm text-muted">Check your connection and try again.</div><Button class="mt-5" variant="secondary" onclick={() => void initializeBilling()}>Try again</Button></Card>
  {:else if billing && !billing.enabled && billing.entitlement.planId === 'viewer'}
    <Card class="py-12 text-center"><LockKeyhole class="mx-auto mb-3 h-8 w-8 text-muted" /><div class="font-medium">Billing is not configured</div><div class="mx-auto mt-1 max-w-md text-sm text-muted">No payment details are collected while billing is disabled.</div></Card>
  {:else if billing}
    {#if !billing.entitlement.subscriptionId && billing.entitlement.provider !== 'gift'}
      <Card>
        <div class="mb-3 text-sm font-medium">Payment method</div>
        <div class="grid gap-2 sm:grid-cols-2">
          <button class={paymentProvider === 'stripe' ? 'rounded-xl border border-accent bg-accent/5 px-3 py-3 text-left transition' : 'rounded-xl border px-3 py-3 text-left transition'} onclick={() => (paymentProvider = 'stripe')}><div class="font-medium">Card or bank</div><div class="mt-1 text-xs text-muted">Hosted Stripe checkout with Managed Payments.</div></button>
          <button class={paymentProvider === 'crypto' ? 'rounded-xl border border-accent bg-accent/5 px-3 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50' : 'rounded-xl border px-3 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50'} disabled={!cryptoReady()} onclick={() => (paymentProvider = 'crypto')}><div class="flex items-center justify-between gap-2 font-medium"><span>Crypto</span><Badge variant="secondary">{billing.providers.crypto.assets.join(' / ')}</Badge></div><div class="mt-1 text-xs text-muted">Hosted NOWPayments invoice priced in EUR. Renew with a new crypto payment every 30 days.</div></button>
        </div>
        {#if paymentProvider === 'crypto'}
          <div class="mt-4 border-t border-border pt-4"><label class="block max-w-xs text-xs text-muted">Crypto currency<select class="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text" bind:value={cryptoAsset}>{#each billing.providers.crypto.assets as asset}<option value={asset}>{cryptoAssetLabel(asset)}</option>{/each}</select></label><p class="mt-3 text-xs text-muted">Crypto checkout is separate from Stripe and does not collect billing information.</p></div>
          {#if !cryptoReady()}<div class="mt-3 text-xs text-muted">Crypto checkout is not available until NOWPayments and the selected currency are ready.</div>{/if}
        {/if}
      </Card>
    {/if}

    {#if billing.entitlement.provider === 'gift'}
      <Card title="Prepaid access"><p class="text-sm text-muted">Your {planLabel(billing.entitlement.planId)} plan is active until {billing.entitlement.expiresAt ? formatDate(billing.entitlement.expiresAt) : 'its expiry date'}. This grant has no recurring payment.</p></Card>
    {:else}
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
      {#each billing.plans as plan (plan.id)}
        {@const current = billing.entitlement.planId === plan.id}
        {@const cryptoRenewal = billing.entitlement.provider === 'nowpayments' && billing.entitlement.status === 'past_due' && current}
        {@const blockedCryptoChange = billing.entitlement.provider === 'nowpayments' && billing.entitlement.status === 'past_due' && !current}
        {@const highlighted = plan.id === 'unlimited_priority' || plan.id === 'priority_api'}
        <Card id={`billing-plan-${plan.id}`} class={highlighted ? 'border-accent shadow-lg shadow-accent/10' : current ? 'border-ok/50' : ''}>
          <div class="flex h-full min-h-80 flex-col">
            <div class="mb-4 flex items-start justify-between gap-3"><div><div class="flex flex-wrap items-center gap-2"><h3 class="text-base font-semibold">{plan.name}</h3>{#if highlighted}<Badge>Highest priority</Badge>{/if}{#if current}<Badge variant="success">Current</Badge>{/if}</div><p class="mt-1 text-sm text-muted">{plan.description}</p></div>{#if plan.priority > 0}<Zap class="h-5 w-5 shrink-0 text-accent" />{:else if plan.api}<KeyRound class="h-5 w-5 shrink-0 text-accent" />{:else}<Gauge class="h-5 w-5 shrink-0 text-accent" />{/if}</div>
            <div class="mb-5"><span class="text-3xl font-semibold">{fallbackPrice(plan)}</span><span class="text-sm text-muted">{paymentProvider === 'crypto' ? '/30 days' : '/month'}</span></div>
            <div class="mb-6 flex flex-1 flex-col gap-2 text-sm"><div class="flex items-center gap-2"><Check class="h-4 w-4 text-ok" /> IPA Library access</div><div class="flex items-center gap-2"><Check class="h-4 w-4 text-ok" /> {plan.dailyDecryptLimit === undefined ? 'Unlimited new decrypts' : `${plan.dailyDecryptLimit} new decrypts per rolling 24 hours`}</div>{#if plan.api}<div class="flex items-center gap-2"><Check class="h-4 w-4 text-ok" /> API access{plan.apiRatePerMinute ? ` · ${plan.apiRatePerMinute} requests/min` : ''}</div>{:else}<div class="flex items-center gap-2 text-muted"><X class="h-4 w-4" /> API access</div>{/if}{#if plan.priority > 0}<div class="flex items-center gap-2"><Check class="h-4 w-4 text-ok" /> Higher queue priority</div>{:else}<div class="flex items-center gap-2 text-muted"><X class="h-4 w-4" /> Higher queue priority</div>{/if}<div class="mt-2 flex items-center gap-2 text-xs text-muted"><ShieldCheck class="h-4 w-4 text-accent" /> {paymentProvider === 'crypto' ? 'Hosted NOWPayments invoice' : 'Hosted Stripe checkout'}</div></div>
            {#if paymentProvider === 'crypto' && !cryptoReadyForPlan(plan)}<div class="mb-2 text-xs text-muted">Crypto is unavailable at this price for {cryptoAsset}. Choose card or bank checkout.</div>{/if}
            <Button class="w-full" variant={highlighted ? 'default' : 'secondary'} disabled={(current && !cryptoRenewal) || blockedCryptoChange || openingPlan !== undefined || (!billing.enabled && !billing.entitlement.subscriptionId) || (paymentProvider === 'crypto' && !cryptoReadyForPlan(plan))} loading={openingPlan === plan.id} onclick={() => choosePlan(plan)}>{cryptoRenewal ? 'Renew with crypto' : current ? 'Current plan' : blockedCryptoChange ? 'Cancel current plan first' : billing.entitlement.subscriptionId ? billing.entitlement.provider === 'nowpayments' ? 'Stop crypto renewal first' : `Switch to ${plan.name}` : 'Subscribe'}</Button>
          </div>
        </Card>
      {/each}
    </div>

    {#if billing.entitlement.scheduledChangeAt}<Card><div class="text-sm">Your subscription is scheduled to {billing.entitlement.scheduledChangeAction ?? 'change'} on {formatDate(billing.entitlement.scheduledChangeAt)}.</div></Card>{:else if billing.entitlement.nextBilledAt}<div class="text-center text-xs text-muted">Next billing date: {formatDate(billing.entitlement.nextBilledAt)}</div>{/if}

    <Card class="text-center text-xs leading-5 text-muted">Stripe handles automatic card or bank renewals. Crypto access lasts 30 days after a verified NOWPayments invoice and renews when you complete another crypto payment. dkrypt does not store payment credentials or private keys.<div class="mt-3"><LegalLinks /></div></Card>
    {/if}
  {/if}
</div>
