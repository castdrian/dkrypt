<script lang="ts">
  import { AlertTriangle, Ban, Copy, CreditCard, Gift, LoaderCircle, Pause, Play, RefreshCw, RotateCcw, ShieldAlert, WalletCards } from 'lucide-svelte';
  import { onMount } from 'svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import EmptyState from '#components/EmptyState.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import { createBillingAccessCode, fetchBillingAccessCodes, fetchBillingProviderStatus, fetchBillingReconciliation, fetchBillingRevenue, fetchBillingSubscriptions, fetchBillingWebhookInbox, quarantineBillingWebhook, replayBillingWebhook, revokeBillingAccessCode, setBillingCheckoutPaused, syncBillingReconciliation, syncStripeBillingWebhookEvents, type BillingAccessCode, type BillingManagerSubscription, type BillingProviderStatus, type BillingReconciliationDiscrepancy, type BillingReconciliationEntry, type BillingRevenueSummary, type BillingWebhookInboxRecord } from '#lib/api';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasPermission } from '#lib/session.svelte';
  import { liveState } from '#lib/live.svelte';
  import { confirmDialog, showToast } from '#lib/ui.svelte';
  import type { BadgeVariant } from '#lib/components/ui/variants';
  import { fmtCalendarDate, fmtCurrency } from '#lib/format.svelte';

  const canManage = $derived(sessionHasPermission(PermissionFlag.manageBilling));
  let subscriptions = $state<BillingManagerSubscription[]>([]);
  let providerStatus = $state<BillingProviderStatus | null>(null);
  let revenue = $state<BillingRevenueSummary | null>(null);
  let revenueLoading = $state(true);
  let revenueRefreshing = $state(false);
  let revenueError = $state<string | undefined>(undefined);
  let revenueCurrency = $state('EUR');
  const revenueTrendCurrencies = $derived([...new Set((revenue?.trend ?? []).map((entry) => entry.currency))].sort());
  const revenueTrendSeries = $derived.by(() => {
    const current = new Date();
    const entries = new Map((revenue?.trend ?? []).filter((entry) => entry.currency === revenueCurrency).map((entry) => [entry.month, entry]));
    return Array.from({ length: 12 }, (_, index) => {
      const date = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 11 + index, 1));
      const month = date.toISOString().slice(0, 7);
      const entry = entries.get(month);
      return { month, label: new Intl.DateTimeFormat(undefined, { month: 'short' }).format(date), gross: entry?.gross ?? 0, refunded: entry?.refunded ?? 0, net: entry?.net ?? 0, stripe: entry?.providers.stripe ?? 0, nowpayments: entry?.providers.nowpayments ?? 0, paymentCount: entry?.paymentCount ?? 0 };
    });
  });
  const revenueTrendMax = $derived(Math.max(1, ...revenueTrendSeries.map((entry) => entry.net)));
  let accessCodes = $state<BillingAccessCode[]>([]);
  let accessCodesLoading = $state(false);
  let accessCodeCreating = $state(false);
  let generatedAccessCode = $state<string | undefined>(undefined);
  let accessCodePlan = $state('access');
  let accessCodeDuration = $state(30);
  let accessCodeRedeemWindow = $state(30);
  let accessCodeAction = $state<string | undefined>(undefined);
  let loading = $state(true);
  let refreshing = $state(false);
  let search = $state('');
  let planId = $state('');
  let statusFilter = $state('');
  let paymentRecoveryCount = $state(0);
  let providerFilter = $state('');
  let from = $state('');
  let to = $state('');
  let wallet = $state('');
  let invoice = $state('');
  let total = $state(0);
  let nextCursor = $state<string | undefined>(undefined);
  let loadingMore = $state(false);
  let webhooks = $state<BillingWebhookInboxRecord[]>([]);
  let reconciliation = $state<BillingReconciliationEntry[]>([]);
  let reconciliationCheckedAt = $state<string | undefined>(undefined);
  let reconciliationNextCursor = $state<string | undefined>(undefined);
  let reconciliationTotal = $state(0);
  let reconciliationLoading = $state(false);
  let reconciliationAction = $state<string | undefined>(undefined);
  const reconciliationDrift = $derived(reconciliation.filter((entry) => entry.discrepancies.length > 0));
  let webhookLoading = $state(false);
  let webhookNextCursor = $state<string | undefined>(undefined);
  let webhookTotal = $state(0);
  let webhookAction = $state<string | undefined>(undefined);
  let webhookProviderFilter = $state('');
  let webhookStatusFilter = $state('needs_attention');
  let checkoutPauseLoading = $state(false);
  let stripeWebhookSyncLoading = $state(false);
  let observedBillingRevision = liveState.billingRevision;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let loadGeneration = 0;

  function subscriptionFilters(cursor?: string): Parameters<typeof fetchBillingSubscriptions>[0] {
    return { q: search || undefined, planId: planId || undefined, provider: providerFilter || undefined, status: statusFilter || undefined, from: from || undefined, to: to || undefined, wallet: wallet || undefined, invoice: invoice || undefined, cursor, limit: 50 };
  }

  function stripeWebhookStatusText(): string {
    if (!providerStatus) return '';
    if (providerStatus.stripe.missingConfiguration.includes('STRIPE_WEBHOOK_SECRET')) return 'Stripe signing secret is missing; incoming webhook deliveries will be rejected.';
    const webhook = providerStatus.stripe.webhook;
    if (webhook.state === 'ready') return 'All required events are enabled on the endpoint. Delivery status is shown in the inbox below.';
    if (webhook.state === 'missing_endpoint') return 'The Stripe webhook endpoint is missing or disabled.';
    if (webhook.state === 'missing_events') return `Missing events: ${webhook.missingEvents.join(', ')}`;
    if (webhook.state === 'unavailable') return 'Could not verify the Stripe webhook configuration.';
    return 'Webhook verification requires a Stripe API key.';
  }

  function stripeWebhookStatusVariant(): BadgeVariant {
    if (!providerStatus) return 'secondary';
    if (providerStatus.stripe.missingConfiguration.includes('STRIPE_WEBHOOK_SECRET')) return 'warning';
    const state = providerStatus.stripe.webhook.state;
    return state === 'ready' ? 'success' : state === 'not_configured' ? 'secondary' : 'warning';
  }

  function stripeWebhookStatusLabel(): string {
    if (!providerStatus) return '';
    if (providerStatus.stripe.missingConfiguration.includes('STRIPE_WEBHOOK_SECRET')) return 'Signing secret missing';
    const state = providerStatus.stripe.webhook.state;
    return state === 'ready' ? 'Events configured' : state === 'not_configured' ? 'Webhook not configured' : 'Webhook needs attention';
  }

  async function load(refreshProviderStatus = false): Promise<void> {
    const generation = ++loadGeneration;
    refreshing = true;
    try {
      const [ledger, status, recovery] = await Promise.all([
        fetchBillingSubscriptions(subscriptionFilters()),
        canManage ? fetchBillingProviderStatus(refreshProviderStatus) : Promise.resolve(null),
        canManage ? fetchBillingSubscriptions({ status: 'needs_attention', limit: 1 }) : Promise.resolve(null),
      ]);
      if (generation !== loadGeneration) return;
      subscriptions = ledger.subscriptions;
      total = ledger.total;
      nextCursor = ledger.nextCursor;
      providerStatus = status;
      paymentRecoveryCount = recovery?.total ?? 0;
      if (canManage) await loadWebhooks();
    } catch (error) {
      if (generation !== loadGeneration) return;
      showToast(error instanceof Error ? error.message : "Couldn't load billing subscriptions", 'error');
    } finally {
      if (generation === loadGeneration) {
        loading = false;
        refreshing = false;
      }
    }
  }

  async function loadMore(): Promise<void> {
    if (loadingMore || !nextCursor) return;
    loadingMore = true;
    try {
      const page = await fetchBillingSubscriptions(subscriptionFilters(nextCursor));
      subscriptions = [...subscriptions, ...page.subscriptions];
      total = page.total;
      nextCursor = page.nextCursor;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't load more subscriptions", 'error');
    } finally {
      loadingMore = false;
    }
  }

  async function loadRevenue(refresh = false): Promise<void> {
    if (!canManage) return;
    revenueRefreshing = refresh;
    revenueLoading = true;
    try {
      revenue = await fetchBillingRevenue(refresh);
      if (!revenueTrendCurrencies.includes(revenueCurrency)) revenueCurrency = revenueTrendCurrencies.includes('EUR') ? 'EUR' : revenueTrendCurrencies[0] ?? 'EUR';
      revenueError = undefined;
    } catch (error) {
      revenueError = error instanceof Error ? error.message : "Couldn't load revenue summary";
    } finally {
      revenueLoading = false;
      revenueRefreshing = false;
    }
  }

  async function loadAccessCodes(): Promise<void> {
    if (!canManage) return;
    accessCodesLoading = true;
    try {
      accessCodes = (await fetchBillingAccessCodes()).accessCodes;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't load prepaid codes", 'error');
    } finally {
      accessCodesLoading = false;
    }
  }

  async function issueAccessCode(): Promise<void> {
    accessCodeCreating = true;
    generatedAccessCode = undefined;
    try {
      const result = await createBillingAccessCode({ planId: accessCodePlan, durationDays: accessCodeDuration, redeemWithinDays: accessCodeRedeemWindow });
      generatedAccessCode = result.code;
      accessCodes = [result.accessCode, ...accessCodes];
      showToast('Prepaid access code created. Copy it now; it will not be shown again.', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't create prepaid code", 'error');
    } finally {
      accessCodeCreating = false;
    }
  }

  async function copyAccessCode(): Promise<void> {
    if (!generatedAccessCode) return;
    try {
      await navigator.clipboard.writeText(generatedAccessCode);
      showToast('Access code copied', 'success');
    } catch {
      showToast('Clipboard access was blocked; select and copy the code.', 'error');
    }
  }

  async function revokeAccessCode(accessCode: BillingAccessCode): Promise<void> {
    if (!(await confirmDialog('Revoke this prepaid code now? Any active access from it will end.', { confirmLabel: 'Revoke code' }))) return;
    accessCodeAction = accessCode.id;
    try {
      await revokeBillingAccessCode(accessCode.id);
      await loadAccessCodes();
      showToast('Prepaid code revoked', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't revoke prepaid code", 'error');
    } finally {
      accessCodeAction = undefined;
    }
  }

  async function loadWebhooks(cursor?: string): Promise<void> {
    if (!canManage) return;
    webhookLoading = true;
    try {
      const page = await fetchBillingWebhookInbox({ provider: webhookProviderFilter || undefined, status: webhookStatusFilter || undefined, cursor, limit: 25 });
      webhooks = cursor ? [...webhooks, ...page.inbox] : page.inbox;
      webhookTotal = page.total;
      webhookNextCursor = page.nextCursor;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't load billing reconciliation queue", 'error');
    } finally {
      webhookLoading = false;
    }
  }

  async function checkBillingReconciliation(cursor?: string): Promise<void> {
    reconciliationLoading = true;
    try {
      const page = await fetchBillingReconciliation(cursor);
      reconciliation = cursor ? [...reconciliation, ...page.entries] : page.entries;
      reconciliationTotal = page.total;
      reconciliationNextCursor = page.nextCursor;
      reconciliationCheckedAt = page.checkedAt;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't compare Stripe subscriptions", 'error');
    } finally {
      reconciliationLoading = false;
    }
  }

  function reconciliationReason(discrepancy: BillingReconciliationDiscrepancy): string {
    const labels: Record<BillingReconciliationDiscrepancy, string> = {
      provider_unavailable: 'Stripe could not be checked',
      unrecognized_price: 'Stripe price is not mapped to a dkrypt plan',
      plan_mismatch: 'Plan differs from Stripe',
      status_mismatch: 'Status differs from Stripe',
      entitlement_mismatch: 'Account access differs from Stripe',
      refund_protected: 'Refund revocation is protected',
    };
    return labels[discrepancy];
  }

  async function syncReconciliationEntry(entry: BillingReconciliationEntry): Promise<void> {
    const member = entry.displayName ?? entry.userId ?? 'this account';
    const reviewedState = `Stripe reports ${entry.stripe.planId ?? 'an unmapped plan'} · ${entry.stripe.status ?? 'unknown status'}. dkrypt currently records ${entry.local.planId} · ${entry.local.status}.`;
    if (!(await confirmDialog(`Apply the current Stripe state for ${member}? ${reviewedState} Any refund-based access revocation remains protected.`, { confirmLabel: 'Sync from Stripe' }))) return;
    reconciliationAction = entry.subscriptionId;
    try {
      await syncBillingReconciliation(entry);
      showToast('Stripe subscription and access were reconciled', 'success');
      await Promise.all([checkBillingReconciliation(), load()]);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't reconcile this subscription", 'error');
      await checkBillingReconciliation();
    } finally {
      reconciliationAction = undefined;
    }
  }

  async function replayWebhook(record: BillingWebhookInboxRecord): Promise<void> {
    webhookAction = record.id;
    try {
      const result = await replayBillingWebhook(record.id);
      if (result.ok) await loadWebhooks();
    } finally {
      webhookAction = undefined;
    }
  }

  async function quarantineWebhook(record: BillingWebhookInboxRecord): Promise<void> {
    webhookAction = record.id;
    try {
      const result = await quarantineBillingWebhook(record.id, 'quarantined by manager');
      if (result.ok) await loadWebhooks();
    } finally {
      webhookAction = undefined;
    }
  }

  async function changeCheckoutPause(paused: boolean): Promise<void> {
    if (!providerStatus) return;
    const action = paused ? 'pause' : 'resume';
    if (!(await confirmDialog(`Review billing change: ${action} new subscriptions? Existing subscriptions and renewals are not affected.`, { confirmLabel: paused ? 'Pause checkouts' : 'Resume checkouts' }))) return;
    checkoutPauseLoading = true;
    try {
      const result = await setBillingCheckoutPaused(paused);
      providerStatus = { ...providerStatus, checkoutsPaused: result.paused };
      showToast(result.paused ? 'New checkouts paused' : 'New checkouts resumed', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't update checkout availability", 'error');
    } finally {
      checkoutPauseLoading = false;
    }
  }

  async function syncStripeWebhookEvents(): Promise<void> {
    stripeWebhookSyncLoading = true;
    try {
      const result = await syncStripeBillingWebhookEvents();
      if (result.ok) await load(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't synchronize Stripe webhook events", 'error');
    } finally {
      stripeWebhookSyncLoading = false;
    }
  }

  function statusVariant(status: string): BadgeVariant {
    if (status === 'active' || status === 'trialing') return 'success';
    if (status === 'past_due') return 'warning';
    if (status === 'cancelled' || status === 'canceled' || status === 'unpaid' || status === 'revoked') return 'destructive';
    return 'secondary';
  }

  function providerLabel(provider: BillingManagerSubscription['provider']): string {
    return provider === 'nowpayments' ? 'Crypto · NOWPayments' : provider === 'stripe' ? 'Stripe' : 'Historical record';
  }

  function money(value?: number, currency = 'EUR'): string {
    if (value === undefined) return '—';
    return fmtCurrency(value, currency);
  }

  function date(value?: string): string {
    if (!value) return '—';
    return fmtCalendarDate(value);
  }

  function short(value?: string): string {
    if (!value) return '—';
    return value.length > 20 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value;
  }

  onMount(() => {
    void load();
    void loadRevenue();
    void loadAccessCodes();
  });

  $effect(() => {
    const revision = liveState.billingRevision;
    if (revision === observedBillingRevision) return;
    observedBillingRevision = revision;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void load();
      void loadRevenue();
    }, 150);
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = undefined;
    };
  });
</script>

<div class="flex flex-col gap-4">
  {#if canManage}
    <Card title="Revenue to date">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p class="text-sm text-muted">Customer subscription payments after refunds, before provider fees and tax remittance.</p>
        <Button size="sm" variant="secondary" loading={revenueRefreshing} onclick={() => void loadRevenue(true)}><RefreshCw class="h-4 w-4" /> Refresh totals</Button>
      </div>
      {#if revenueLoading && !revenue}
        <div class="flex min-h-24 items-center justify-center"><LoaderCircle class="h-5 w-5 animate-spin text-muted" /></div>
      {:else if revenue}
        <div class="mb-3 flex items-center gap-2">
          <Badge variant={revenue.complete ? 'success' : 'warning'}>{revenue.complete ? 'Complete totals' : 'Partial totals'}</Badge>
          <span class="text-xs text-muted">Updated {new Date(revenue.updatedAt).toLocaleTimeString()}</span>
        </div>
        {#if revenue.totals.length}
          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {#each revenue.totals as total (total.currency)}
              <div class="rounded-xl border border-border/70 bg-panel/50 p-4">
                <div class="text-xs font-medium uppercase tracking-wide text-muted">Collected after refunds · {total.currency}</div>
                <div class="mt-1 text-2xl font-semibold tabular-nums text-text">{money(total.net, total.currency)}</div>
                <div class="mt-2 text-xs text-muted">{money(total.gross, total.currency)} paid · {money(total.refunded, total.currency)} refunded</div>
              </div>
            {/each}
          </div>
        {:else}
          <p class="rounded-lg border border-border/70 px-3 py-4 text-sm text-muted">No paid subscription payments were found.</p>
        {/if}
        <section class="mt-4 rounded-xl border border-border/70 bg-panel/30 p-3" aria-label="Monthly revenue trend">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div><h3 class="text-sm font-semibold">Collected over time</h3><p class="mt-0.5 text-xs text-muted">Monthly net after refunds, attributed to the original payment month.</p></div>
            {#if revenueTrendCurrencies.length > 1}<label class="flex items-center gap-2 text-xs text-muted">Currency<select class="rounded-lg border border-border bg-bg px-2 py-1.5 text-text" bind:value={revenueCurrency}>{#each revenueTrendCurrencies as currency}<option value={currency}>{currency}</option>{/each}</select></label>{/if}
          </div>
          <div class="grid h-36 grid-cols-6 items-end gap-2 sm:grid-cols-12" role="img" aria-label="Monthly net revenue for {revenueCurrency}">
            {#each revenueTrendSeries as entry (entry.month)}
              {@const stripeHeight = entry.net ? entry.stripe / revenueTrendMax * 100 : 0}
              {@const cryptoHeight = entry.net ? entry.nowpayments / revenueTrendMax * 100 : 0}
              <div class="flex h-full min-w-0 flex-col justify-end" title="{entry.label}: {money(entry.net, revenueCurrency)} net, {money(entry.refunded, revenueCurrency)} refunded across {entry.paymentCount} payments">
                <div class="flex min-h-1 flex-1 flex-col justify-end overflow-hidden rounded-t bg-panel-muted/30">
                  {#if entry.net > 0}<div class="bg-accent/80" style="height: {cryptoHeight}%"></div><div class="bg-accent" style="height: {stripeHeight}%"></div>{:else}<div class="h-1 w-full bg-border/70"></div>{/if}
                </div>
                <div class="mt-1 truncate text-center text-[10px] text-muted">{entry.label}</div>
              </div>
            {/each}
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted"><span class="inline-flex items-center gap-1.5"><span class="h-2 w-2 rounded-sm bg-accent"></span>Stripe</span><span class="inline-flex items-center gap-1.5"><span class="h-2 w-2 rounded-sm bg-accent/80"></span>Crypto</span><span class="ml-auto">{revenueTrendSeries.reduce((sum, entry) => sum + entry.refunded, 0) > 0 ? `${money(revenueTrendSeries.reduce((sum, entry) => sum + entry.refunded, 0), revenueCurrency)} refunds in view` : 'No refunds in this period'}</span></div>
        </section>
        <div data-testid="billing-revenue-provider-breakdown" class="mt-3 grid min-w-0 grid-cols-1 gap-2 text-xs text-muted">
          <div class="min-w-0 break-words"><span class="font-medium text-text">Stripe:</span> {revenue.providers.stripe.state === 'ready' ? `${revenue.providers.stripe.paymentCount} paid invoice payments` : revenue.providers.stripe.state === 'not_configured' ? 'Not configured' : 'History unavailable'}{#if revenue.providers.stripe.totals.length} · {revenue.providers.stripe.totals.map((total) => `${money(total.net, total.currency)} ${total.currency}`).join(', ')}{/if}</div>
          <div class="min-w-0 break-words"><span class="font-medium text-text">NOWPayments:</span> {revenue.providers.nowpayments.state === 'ready' ? `${revenue.providers.nowpayments.paymentCount} paid crypto payments` : 'History unavailable'}{#if revenue.providers.nowpayments.totals.length} · {revenue.providers.nowpayments.totals.map((total) => `${money(total.net, total.currency)} ${total.currency}`).join(', ')}{/if}</div>
        </div>
        <div class="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4" aria-label="Subscription retention summary">
          <div class="rounded-lg border border-border/70 bg-panel/40 p-3"><div class="text-xs text-muted">Active accounts</div><div class="mt-1 text-xl font-semibold tabular-nums">{revenue.retention.activeAccounts}</div></div>
          <div class="rounded-lg border border-border/70 bg-panel/40 p-3"><div class="text-xs text-muted">Payment issues</div><div class="mt-1 text-xl font-semibold tabular-nums">{revenue.retention.paymentIssues}</div></div>
          <div class="rounded-lg border border-border/70 bg-panel/40 p-3"><div class="text-xs text-muted">Cancellations updated in 30 days</div><div class="mt-1 text-xl font-semibold tabular-nums">{revenue.retention.cancellationsUpdatedLast30Days}</div></div>
          <div class="rounded-lg border border-border/70 bg-panel/40 p-3"><div class="text-xs text-muted" title="Recent cancellation records divided by active accounts plus those recent cancellations">Recent cancellation rate</div><div class="mt-1 text-xl font-semibold tabular-nums">{revenue.retention.recentCancellationRatePercent}%</div></div>
        </div>
        {#if revenue.warnings.length || revenueError}
          <div class="mt-3 space-y-1 rounded-lg border border-warning/30 bg-panel-muted/50 p-3 text-xs text-muted">
            {#if revenueError}<div class="flex items-center gap-2"><AlertTriangle class="h-4 w-4 shrink-0 text-warning" /> Refresh failed: {revenueError}</div>{/if}
            {#each revenue.warnings as warning}<div class="flex items-start gap-2"><AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-warning" /> <span>{warning}</span></div>{/each}
          </div>
        {/if}
      {:else}
        <div class="flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-panel-muted/50 p-3 text-sm">
          <span class="text-muted">{revenueError ?? 'Revenue totals are temporarily unavailable.'}</span>
          <Button size="sm" variant="secondary" onclick={() => void loadRevenue(true)}>Try again</Button>
        </div>
      {/if}
    </Card>
  {/if}

  {#if canManage}
    <Card title="Prepaid access codes">
      <p class="mb-4 text-sm text-muted">Create a one-time code for a fixed number of access days. Codes do not start recurring billing and can be revoked.</p>
      <form class="grid gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(10rem,1fr)_9rem_9rem_auto]" onsubmit={(event) => { event.preventDefault(); void issueAccessCode(); }}>
        <label class="text-xs text-muted">Plan<select class="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text" bind:value={accessCodePlan}><option value="access">Access · €2.50</option><option value="standard">Standard · €5</option><option value="plus">Plus · €10</option><option value="developer">Developer · €15</option><option value="unlimited">Unlimited · €20</option><option value="unlimited_priority">Unlimited Priority · €30</option></select></label>
        <label class="text-xs text-muted">Access days<Input type="number" min="1" max="3650" bind:value={accessCodeDuration} /></label>
        <label class="text-xs text-muted">Redeem within days<Input type="number" min="1" max="365" bind:value={accessCodeRedeemWindow} /></label>
        <div class="flex items-end"><Button type="submit" loading={accessCodeCreating}><Gift class="h-4 w-4" /> Create code</Button></div>
      </form>
      {#if generatedAccessCode}
        <div class="mt-4 rounded-lg border border-accent/40 bg-accent/5 p-3" data-sensitive="true">
          <div class="text-sm font-medium">Copy this code now</div>
          <div class="mt-2 flex flex-wrap items-center gap-2"><code class="min-w-0 flex-1 break-all rounded-md bg-bg px-3 py-2 font-mono text-sm">{generatedAccessCode}</code><Button size="sm" variant="secondary" onclick={() => void copyAccessCode()}><Copy class="h-4 w-4" /> Copy</Button></div>
          <p class="mt-2 text-xs text-muted">The full code is only shown once. The server stores a hash.</p>
        </div>
      {/if}
      <div class="mt-4 flex items-center justify-between gap-2"><h3 class="text-sm font-medium">Issued codes</h3><Button size="sm" variant="secondary" loading={accessCodesLoading} onclick={() => void loadAccessCodes()}><RefreshCw class="h-4 w-4" /> Refresh</Button></div>
      {#if accessCodesLoading && accessCodes.length === 0}
        <div class="flex min-h-20 items-center justify-center"><LoaderCircle class="h-5 w-5 animate-spin text-muted" /></div>
      {:else if accessCodes.length === 0}
        <p class="mt-3 rounded-lg border border-border/70 px-3 py-4 text-sm text-muted">No prepaid codes have been issued.</p>
      {:else}
        <div class="mt-3 divide-y divide-border/70">
          {#each accessCodes as accessCode (accessCode.id)}
            <div class="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><span class="font-medium">{accessCode.planId.replace('_', ' ')} · {accessCode.durationDays} days</span><Badge variant={statusVariant(accessCode.status)}>{accessCode.status}</Badge></div><div class="mt-1 font-mono text-xs text-muted" data-sensitive="true">{accessCode.prefix}</div><div class="mt-1 text-xs text-muted">{accessCode.redeemedAt ? `Redeemed ${date(accessCode.redeemedAt)} · expires ${date(accessCode.expiresAt)}` : `Redeem by ${date(accessCode.redeemBy)}`}{#if accessCode.redeemedBy} · {accessCode.redeemedBy}{/if}</div></div>
              {#if accessCode.status === 'available' || accessCode.status === 'redeemed'}<Button size="sm" variant="secondary" loading={accessCodeAction === accessCode.id} onclick={() => void revokeAccessCode(accessCode)}><Ban class="h-4 w-4" /> Revoke</Button>{/if}
            </div>
          {/each}
        </div>
      {/if}
    </Card>
  {/if}

  <Card title="Billing subscriptions">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm text-muted"><span class="flex items-center gap-2"><CreditCard class="h-4 w-4" /> View active, pending, failed, and canceled member subscriptions across billing providers.</span><Button size="sm" variant="secondary" loading={refreshing} onclick={() => void load(true)}><RefreshCw class="h-4 w-4" /> Refresh</Button></div>
    <div class="grid gap-2 md:grid-cols-[minmax(0,1fr)_10rem_10rem_auto]">
      <Input bind:value={search} placeholder="Search member, email, plan, or subscription" aria-label="Search subscriptions" />
      <select class="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text" bind:value={providerFilter} onchange={() => void load()} aria-label="Filter by provider"><option value="">All providers</option><option value="stripe">Stripe</option><option value="nowpayments">Crypto</option><option value="legacy">Historical records</option></select>
      <select class="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text" bind:value={statusFilter} onchange={() => void load()} aria-label="Filter by status"><option value="">All statuses</option><option value="needs_attention">Payment needs attention</option><option value="active">Active</option><option value="past_due">Past due</option><option value="cancelled">Canceled</option><option value="revoked">Revoked</option></select>
      <Button variant="secondary" onclick={() => void load()}><RefreshCw class="h-4 w-4" /> Apply</Button>
    </div>
    {#if canManage && paymentRecoveryCount > 0 && statusFilter !== 'needs_attention'}
      <div class="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-panel-muted/50 p-3">
        <div class="flex items-start gap-2 text-sm"><AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-warning" /><div><div class="font-medium">{paymentRecoveryCount} subscription{paymentRecoveryCount === 1 ? '' : 's'} need payment attention</div><p class="mt-0.5 text-xs text-muted">Review the latest charge, grace period, and entitlement before contacting the member.</p></div></div>
        <Button size="sm" variant="secondary" onclick={() => { statusFilter = 'needs_attention'; void load(); }}>Open payment recovery</Button>
      </div>
    {/if}
    <details class="mt-3 rounded-lg border border-border/70 px-3 py-2">
      <summary class="cursor-pointer text-sm font-medium">More filters</summary>
      <div class="mt-3 grid gap-2 md:grid-cols-2 lg:grid-cols-5">
        <Input bind:value={planId} placeholder="Plan ID" aria-label="Filter by plan" />
        <Input bind:value={from} type="date" aria-label="Updated from" />
        <Input bind:value={to} type="date" aria-label="Updated through" />
        <Input bind:value={wallet} placeholder="Wallet address" aria-label="Filter by wallet" />
        <Input bind:value={invoice} placeholder="Invoice or payment ID" aria-label="Filter by invoice" />
      </div>
    </details>
  </Card>

  {#if providerStatus}
    <div class="grid gap-3 md:grid-cols-2">
      <Card title="Stripe"><div class="flex flex-wrap items-center justify-between gap-3 text-sm"><span>{providerStatus.stripe.enabled ? 'Stripe credentials are configured' : 'Not configured'}</span><div class="flex items-center gap-2">{#if providerStatus.stripe.webhook.state === 'missing_events' && !providerStatus.stripe.missingConfiguration.includes('STRIPE_SECRET_KEY') && !providerStatus.stripe.missingConfiguration.includes('STRIPE_WEBHOOK_SECRET')}<Button size="sm" variant="secondary" loading={stripeWebhookSyncLoading} onclick={() => void syncStripeWebhookEvents()}><RefreshCw class="h-4 w-4" /> Sync events</Button>{/if}<Badge variant={providerStatus.stripe.enabled ? 'success' : 'secondary'}>{providerStatus.stripe.environment}</Badge></div></div><div class="mt-3 flex items-start gap-2 text-xs text-muted"><Badge variant={stripeWebhookStatusVariant()}>{stripeWebhookStatusLabel()}</Badge><span class="min-w-0 break-words">{stripeWebhookStatusText()}</span></div>{#if providerStatus.stripe.webhook.state === 'missing_events' && !providerStatus.stripe.missingConfiguration.includes('STRIPE_SECRET_KEY')}<p class="mt-2 text-xs text-muted">Sync updates the existing endpoint’s event list and leaves its signing secret unchanged.</p>{/if}</Card>
      <Card title="Crypto · NOWPayments"><div class="flex items-center justify-between gap-3 text-sm"><span>{!providerStatus.crypto.enabled ? 'Disabled for new checkouts' : providerStatus.crypto.ready ? 'Ready for EUR-priced crypto invoices' : providerStatus.crypto.issues[0] ?? 'Not ready'}</span><Badge variant={providerStatus.crypto.enabled && providerStatus.crypto.ready ? 'success' : 'warning'}>{providerStatus.crypto.environment}</Badge></div><div class="mt-2 text-xs text-muted">Crypto checkout is separate from Stripe and does not collect billing information.</div></Card>
    </div>
    <Card title="New checkout availability">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="max-w-3xl text-sm text-muted">{providerStatus.checkoutsPaused ? 'New subscriptions are paused. Existing subscriptions, renewals, cancellations, and payment events continue normally.' : 'New subscriptions are available through configured payment providers.'}</p>
        <Button variant={providerStatus.checkoutsPaused ? 'default' : 'destructive'} loading={checkoutPauseLoading} onclick={() => void changeCheckoutPause(!providerStatus?.checkoutsPaused)}>
          {#if providerStatus.checkoutsPaused}<Play class="h-4 w-4" /> Resume new checkouts{:else}<Pause class="h-4 w-4" /> Pause new checkouts{/if}
        </Button>
      </div>
    </Card>
    <Card title="Stripe subscription reconciliation">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p class="max-w-3xl text-sm text-muted">Compare saved subscriptions and account access with Stripe. Nothing changes until you review a mismatch and sync it.</p>
        <Button size="sm" variant="secondary" loading={reconciliationLoading} onclick={() => void checkBillingReconciliation()}><RefreshCw class="h-4 w-4" /> Check Stripe</Button>
      </div>
      {#if reconciliationCheckedAt}
        <p class="mb-3 text-xs text-muted">Checked {date(reconciliationCheckedAt)} · {reconciliationTotal} Stripe subscription{reconciliationTotal === 1 ? '' : 's'}</p>
        {#if reconciliationLoading && reconciliation.length === 0}
          <div class="flex min-h-20 items-center justify-center"><LoaderCircle class="h-5 w-5 animate-spin text-muted" /></div>
        {:else if reconciliationDrift.length === 0}
          <EmptyState icon={CreditCard} message="No Stripe and dkrypt access mismatches were found." />
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full min-w-[760px] text-left text-sm">
              <thead class="border-b border-border text-xs text-muted"><tr><th class="px-2 py-2 font-medium">Member</th><th class="px-2 py-2 font-medium">Stripe</th><th class="px-2 py-2 font-medium">dkrypt</th><th class="px-2 py-2 font-medium">Review</th><th class="px-2 py-2 font-medium">Action</th></tr></thead>
              <tbody class="divide-y divide-border/70">
                {#each reconciliationDrift as entry (entry.subscriptionId)}
                  <tr class="align-top">
                    <td class="px-2 py-3"><div class="font-medium">{entry.displayName ?? entry.userId ?? 'Unknown account'}</div><div class="max-w-48 truncate font-mono text-[10px] text-muted" title={entry.subscriptionId}>{entry.subscriptionId}</div></td>
                    <td class="px-2 py-3"><Badge variant={entry.stripe.state === 'ready' ? 'success' : 'warning'}>{entry.stripe.state === 'ready' ? `${entry.stripe.planId ?? 'Unmapped'} · ${entry.stripe.status ?? 'unknown'}` : 'Unavailable'}</Badge></td>
                    <td class="px-2 py-3"><div>{entry.local.planId} · {entry.local.status}</div><div class="text-xs text-muted">Access: {entry.entitlement?.planId ?? 'viewer'} · {entry.entitlement?.provider ?? 'none'}</div></td>
                    <td class="px-2 py-3"><div class="space-y-1">{#each entry.discrepancies as discrepancy}<div class="flex items-start gap-1 text-xs text-warning"><AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />{reconciliationReason(discrepancy)}</div>{/each}</div></td>
                    <td class="px-2 py-3">{#if entry.syncAllowed}<Button size="sm" variant="secondary" loading={reconciliationAction === entry.subscriptionId} onclick={() => void syncReconciliationEntry(entry)}>Sync from Stripe</Button>{:else}<span class="text-xs text-muted">Manual review required</span>{/if}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if reconciliationNextCursor}<div class="mt-3 flex justify-center"><Button size="sm" variant="secondary" loading={reconciliationLoading} onclick={() => void checkBillingReconciliation(reconciliationNextCursor)}>Load more ({Math.max(0, reconciliationTotal - reconciliation.length)} remaining)</Button></div>{/if}
        {/if}
      {:else}
        <p class="rounded-lg border border-border/70 bg-panel-muted/40 p-3 text-sm text-muted">Run a check to compare each saved Stripe subscription with the provider and its effective account access.</p>
      {/if}
    </Card>
  {/if}

  <Card>
    {#if loading}
      <div class="flex min-h-32 items-center justify-center"><LoaderCircle class="h-5 w-5 animate-spin text-muted" /></div>
    {:else if subscriptions.length === 0}
      <EmptyState icon={WalletCards} message="No subscriptions match these filters." />
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full min-w-[860px] text-left text-sm">
          <thead class="border-b border-border text-xs text-muted"><tr><th class="px-2 py-3 font-medium">Member</th><th class="px-2 py-3 font-medium">Plan</th><th class="px-2 py-3 font-medium">Provider</th><th class="px-2 py-3 font-medium">Status</th><th class="px-2 py-3 font-medium">Renewal</th><th class="px-2 py-3 font-medium">Payment details</th><th class="px-2 py-3 font-medium">Last charge</th></tr></thead>
          <tbody class="divide-y divide-border/70">
            {#each subscriptions as subscription (subscription.provider + subscription.subscriptionId)}
              <tr class="align-top"><td class="px-2 py-3"><div class="font-medium" data-sensitive="true">{subscription.user?.displayName ?? subscription.user?.id ?? 'Unknown member'}</div><div class="text-xs text-muted" data-sensitive="true">{subscription.user?.email ?? subscription.user?.username ?? subscription.user?.id ?? '—'}</div></td><td class="px-2 py-3"><div class="font-medium">{subscription.plan.name ?? subscription.plan.id}</div><div class="text-xs text-muted">{money(subscription.plan.amount, subscription.plan.currency)}{#if subscription.interval} · {subscription.interval}{/if}</div><div class="max-w-32 truncate font-mono text-[10px] text-muted" data-sensitive="true">{subscription.priceId}</div></td><td class="px-2 py-3"><Badge variant="secondary">{providerLabel(subscription.provider)}</Badge><div class="mt-1 max-w-28 truncate font-mono text-[10px] text-muted" data-sensitive="true">{short(subscription.subscriptionId)}</div><div class="max-w-28 truncate font-mono text-[10px] text-muted" data-sensitive="true">{short(subscription.customerId)}</div></td><td class="px-2 py-3"><Badge variant={statusVariant(subscription.status)}>{subscription.status.replace('_', ' ')}</Badge>{#if subscription.lastCharge.graceUntil}<div class="mt-1 text-[11px] text-muted">Grace until {date(subscription.lastCharge.graceUntil)}</div>{/if}</td><td class="px-2 py-3 text-muted">{date(subscription.nextBilledAt)}</td><td class="px-2 py-3 text-xs text-muted">{#if subscription.crypto}<div>{subscription.crypto.asset ?? 'Token'} · {subscription.crypto.chain ?? 'Base'}</div><div class="font-mono" data-sensitive="true">{short(subscription.crypto.walletAddress)}</div>{:else}<div>Provider-managed payment</div>{/if}{#if subscription.tax}<div class="mt-1">Tax {subscription.tax.status}{#if subscription.tax.country} · {subscription.tax.country}{/if}</div>{/if}</td><td class="px-2 py-3 text-xs text-muted"><div>{subscription.lastCharge.status ?? '—'} · {date(subscription.lastCharge.at)}</div>{#if subscription.lastCharge.txHash}<div class="font-mono" data-sensitive="true">{short(subscription.lastCharge.txHash)}</div>{/if}{#if subscription.lastCharge.failureReason}<div class="max-w-36 text-err">{subscription.lastCharge.failureReason}</div>{/if}{#if subscription.entitlementHistory?.length}<details class="mt-2"><summary class="cursor-pointer">History ({subscription.entitlementHistory.length})</summary><div class="mt-1 space-y-1">{#each subscription.entitlementHistory.slice(-5).reverse() as event}<div>{event.kind} · {date(event.at)}{#if event.detail} · {event.detail}{/if}</div>{/each}</div></details>{/if}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if nextCursor}
        <div class="mt-3 flex justify-center">
          <Button size="sm" variant="secondary" loading={loadingMore} onclick={() => void loadMore()}>Load more ({Math.max(0, total - subscriptions.length)} older)</Button>
        </div>
      {/if}
    {/if}
  </Card>

  {#if canManage}
  <Card title="Billing reconciliation queue">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm text-muted"><span class="flex items-center gap-2"><ShieldAlert class="h-4 w-4" /> Review, replay, reconcile, or quarantine payment events that need attention.</span><div class="flex flex-wrap gap-2"><select class="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text" bind:value={webhookProviderFilter} onchange={() => void loadWebhooks()} aria-label="Filter webhook provider"><option value="">All providers</option><option value="stripe">Stripe</option><option value="nowpayments">Crypto</option></select><select class="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text" bind:value={webhookStatusFilter} onchange={() => void loadWebhooks()} aria-label="Filter payment event status"><option value="needs_attention">Needs attention</option><option value="">All statuses</option><option value="received">Received</option><option value="failed">Failed</option><option value="processed">Processed</option><option value="quarantined">Quarantined</option></select><Button size="sm" variant="secondary" loading={webhookLoading} onclick={() => void loadWebhooks()}><RefreshCw class="h-4 w-4" /> Refresh</Button></div></div>
      {#if webhookLoading && webhooks.length === 0}
        <div class="flex min-h-24 items-center justify-center"><LoaderCircle class="h-5 w-5 animate-spin text-muted" /></div>
      {:else if webhooks.length === 0}
        <EmptyState icon={ShieldAlert} message="No payment webhook events have been received." />
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full min-w-[760px] text-left text-sm">
            <thead class="border-b border-border text-xs text-muted"><tr><th class="px-2 py-3 font-medium">Provider</th><th class="px-2 py-3 font-medium">Event</th><th class="px-2 py-3 font-medium">Status</th><th class="px-2 py-3 font-medium">Received</th><th class="px-2 py-3 font-medium">Attempts</th><th class="px-2 py-3 font-medium">Action</th></tr></thead>
            <tbody class="divide-y divide-border/70">
              {#each webhooks as record (record.id)}
                <tr class="align-top"><td class="px-2 py-3"><Badge variant="secondary">{record.provider === 'nowpayments' ? 'Crypto' : 'Stripe'}</Badge><div class="mt-1 text-xs text-muted">{record.rawBodyBytes} bytes</div></td><td class="px-2 py-3"><div class="max-w-64 truncate font-mono text-xs" title={record.eventId}>{record.eventId}</div><div class="mt-1 max-w-64 truncate font-mono text-[10px] text-muted" title={record.rawBodySha256}>{record.rawBodySha256}</div></td><td class="px-2 py-3"><Badge variant={statusVariant(record.status)}>{record.status}</Badge>{#if record.lastError}<div class="mt-1 flex max-w-64 items-start gap-1 text-xs text-err"><AlertTriangle class="mt-0.5 h-3 w-3 shrink-0" />{record.lastError}</div>{/if}</td><td class="px-2 py-3 text-xs text-muted">{date(new Date(record.receivedAt).toISOString())}</td><td class="px-2 py-3 text-xs text-muted">{record.attempts}</td><td class="px-2 py-3"><div class="flex flex-wrap gap-2">{#if record.replayableProcessed}<Button size="sm" variant="secondary" loading={webhookAction === record.id} onclick={() => void replayWebhook(record)}><RefreshCw class="h-3.5 w-3.5" /> Reconcile</Button>{:else if record.status !== 'processed' && record.status !== 'quarantined'}<Button size="sm" variant="secondary" loading={webhookAction === record.id} onclick={() => void replayWebhook(record)}><RotateCcw class="h-3.5 w-3.5" /> Replay</Button><Button size="sm" variant="ghost" loading={webhookAction === record.id} onclick={() => void quarantineWebhook(record)}><ShieldAlert class="h-3.5 w-3.5" /> Quarantine</Button>{/if}</div></td></tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if webhookNextCursor}<div class="mt-3 flex justify-center"><Button size="sm" variant="secondary" loading={webhookLoading} onclick={() => void loadWebhooks(webhookNextCursor)}>Load more ({Math.max(0, webhookTotal - webhooks.length)} older)</Button></div>{/if}
      {/if}
    </Card>
  {/if}
</div>
