import Stripe from 'stripe';
import { listBillingCharges, listBillingSubscriptions } from '#billing.js';
import type { BillingCharge, BillingSubscription } from '#billing.js';
import { config } from '#config.js';
import { stripeRequest } from '#stripe.js';

export interface BillingRevenueCurrencyTotal {
  currency: string;
  gross: number;
  refunded: number;
  net: number;
}

export interface BillingRevenueProviderSummary {
  state: 'ready' | 'unavailable' | 'not_configured';
  totals: BillingRevenueCurrencyTotal[];
  paymentCount: number;
}

export interface BillingRevenueSummary {
  updatedAt: string;
  complete: boolean;
  totals: BillingRevenueCurrencyTotal[];
  retention: {
    activeAccounts: number;
    paymentIssues: number;
    cancellationsUpdatedLast30Days: number;
    recentCancellationRatePercent: number;
  };
  providers: {
    stripe: BillingRevenueProviderSummary;
    nowpayments: BillingRevenueProviderSummary;
  };
  warnings: string[];
}

export interface BillingRevenueReaderDependencies {
  listSubscriptions: typeof listBillingSubscriptions;
  listCharges: typeof listBillingCharges;
  runStripe<T>(operation: (client: Stripe) => Promise<T>): Promise<T>;
  stripeConfigured: boolean;
  now: () => number;
}

export type BillingRevenueReader = (forceRefresh?: boolean) => Promise<BillingRevenueSummary>;

interface AmountTotals {
  gross: number;
  refunded: number;
}

interface StripeChargeTotals {
  currency: string;
  gross: number;
  refunded: number;
}

interface StripeRevenueResult {
  summary: BillingRevenueProviderSummary;
  complete: boolean;
  warnings: string[];
}

function accountKey(subscription: BillingSubscription): string {
  if (subscription.userId) return `user:${subscription.userId.toLowerCase()}`;
  if (subscription.customerId) return `${subscription.provider}:${subscription.customerId}`;
  return `${subscription.provider}:${subscription.subscriptionId}`;
}

function summarizeRetention(subscriptions: BillingSubscription[], now: number): BillingRevenueSummary['retention'] {
  const latestByAccount = new Map<string, BillingSubscription>();
  for (const subscription of subscriptions) {
    const key = accountKey(subscription);
    const current = latestByAccount.get(key);
    if (!current || Date.parse(subscription.updatedAt) >= Date.parse(current.updatedAt)) latestByAccount.set(key, subscription);
  }
  const latest = [...latestByAccount.values()];
  const activeAccounts = latest.filter((subscription) => ['active', 'trialing'].includes(String(subscription.status ?? '').toLowerCase())).length;
  const paymentIssues = latest.filter((subscription) => ['past_due', 'unpaid'].includes(String(subscription.status ?? '').toLowerCase())).length;
  const cancellationsUpdatedLast30Days = latest.filter((subscription) =>
    ['canceled', 'cancelled'].includes(String(subscription.status ?? '').toLowerCase()) &&
    Number.isFinite(Date.parse(subscription.updatedAt)) &&
    Date.parse(subscription.updatedAt) >= now - 30 * 24 * 60 * 60 * 1000,
  ).length;
  const denominator = activeAccounts + cancellationsUpdatedLast30Days;
  return {
    activeAccounts,
    paymentIssues,
    cancellationsUpdatedLast30Days,
    recentCancellationRatePercent: denominator === 0 ? 0 : Number((cancellationsUpdatedLast30Days / denominator * 100).toFixed(1)),
  };
}

const CACHE_TTL_MS = 60_000;
const MAX_PAGINATION_PAGES = 1_000;
const STRIPE_READ_CONCURRENCY = 5;

function normalizeCurrency(currency: string): string | undefined {
  const normalized = currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) return undefined;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: normalized }).resolvedOptions().currency;
  } catch {
    return undefined;
  }
}

function minorUnitExponent(currency: string): number {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

function toMajorUnits(amount: number, currency: string): number {
  return amount / (10 ** minorUnitExponent(currency));
}

function toTotals(amounts: Map<string, AmountTotals>): BillingRevenueCurrencyTotal[] {
  return [...amounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({
      currency,
      gross: roundMajorUnits(amount.gross, currency),
      refunded: roundMajorUnits(amount.refunded, currency),
      net: roundMajorUnits(Math.max(0, amount.gross - amount.refunded), currency),
    }));
}

function roundMajorUnits(amount: number, currency: string): number {
  const exponent = minorUnitExponent(currency);
  return Number(amount.toFixed(exponent));
}

function addAmount(amounts: Map<string, AmountTotals>, currencyValue: string, gross: number, refunded = 0): void {
  const currency = normalizeCurrency(currencyValue);
  if (!currency || !Number.isFinite(gross) || !Number.isFinite(refunded)) return;
  const current = amounts.get(currency) ?? { gross: 0, refunded: 0 };
  current.gross += gross;
  current.refunded += refunded;
  amounts.set(currency, current);
}

function combineTotals(...groups: BillingRevenueCurrencyTotal[][]): BillingRevenueCurrencyTotal[] {
  const amounts = new Map<string, AmountTotals>();
  for (const total of groups.flat()) addAmount(amounts, total.currency, total.gross, total.refunded);
  return toTotals(amounts);
}

function stripeObjectId(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | undefined {
  const parentSubscription = invoice.parent?.type === 'subscription_details'
    ? invoice.parent.subscription_details?.subscription
    : undefined;
  const legacySubscription = (invoice as Stripe.Invoice & { subscription?: string | Stripe.Subscription | null }).subscription;
  return stripeObjectId(parentSubscription) ?? stripeObjectId(legacySubscription);
}

async function listAllPages<T extends { id: string }>(
  listPage: (startingAfter?: string) => Promise<Stripe.ApiList<T>>,
): Promise<T[]> {
  const items: T[] = [];
  let startingAfter: string | undefined;
  for (let pageIndex = 0; pageIndex < MAX_PAGINATION_PAGES; pageIndex += 1) {
    const page = await listPage(startingAfter);
    items.push(...page.data);
    if (!page.has_more) return items;
    const last = page.data.at(-1);
    if (!last || last.id === startingAfter) throw new Error('Stripe pagination did not advance');
    startingAfter = last.id;
  }
  throw new Error('Stripe billing history exceeds the supported pagination limit');
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, operation: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < values.length; offset += concurrency) {
    const batch = values.slice(offset, offset + concurrency);
    results.push(...await Promise.all(batch.map(operation)));
  }
  return results;
}

function stripeSubscriptionIds(subscriptions: BillingSubscription[]): string[] {
  return [...new Set(subscriptions
    .filter((subscription) => subscription.provider === 'stripe')
    .map((subscription) => subscription.subscriptionId))];
}

function cryptoRevenue(charges: BillingCharge[]): BillingRevenueProviderSummary {
  const amounts = new Map<string, AmountTotals>();
  let paymentCount = 0;
  for (const charge of charges) {
    if (charge.provider !== 'nowpayments' || (charge.status !== 'succeeded' && charge.status !== 'refunded')) continue;
    const currency = normalizeCurrency(charge.currency);
    if (!currency || !Number.isFinite(charge.amount) || charge.amount < 0) continue;
    addAmount(amounts, currency, charge.amount, charge.status === 'refunded' ? charge.amount : 0);
    paymentCount += 1;
  }
  return { state: 'ready', totals: toTotals(amounts), paymentCount };
}

async function stripeRevenue(
  dependencies: BillingRevenueReaderDependencies,
  subscriptionIds: string[],
): Promise<StripeRevenueResult> {
  if (!dependencies.stripeConfigured) {
    return {
      summary: {
        state: subscriptionIds.length ? 'unavailable' : 'not_configured',
        totals: [],
        paymentCount: 0,
      },
      complete: subscriptionIds.length === 0,
      warnings: subscriptionIds.length ? ['Stripe payment history is not configured for stored subscriptions.'] : [],
    };
  }
  if (!subscriptionIds.length) {
    return {
      summary: { state: 'ready', totals: [], paymentCount: 0 },
      complete: true,
      warnings: [],
    };
  }
  const amounts = new Map<string, AmountTotals>();
  const chargeAmounts = new Map<string, StripeChargeTotals>();
  const warnings: string[] = [];
  let paymentCount = 0;
  let complete = true;
  await dependencies.runStripe(async (client) => {
    const invoiceGroups = await mapWithConcurrency(subscriptionIds, STRIPE_READ_CONCURRENCY, async (subscriptionId) => ({
      subscriptionId,
      invoices: await listAllPages((startingAfter) => client.invoices.list({
        limit: 100,
        status: 'paid',
        subscription: subscriptionId,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      })),
    }));
    const invoices = invoiceGroups.flatMap((group) => group.invoices.map((invoice) => ({ subscriptionId: group.subscriptionId, invoice })));
    const invoicesWithPayments = await mapWithConcurrency(invoices, STRIPE_READ_CONCURRENCY, async ({ subscriptionId, invoice }) => ({
      subscriptionId,
      invoice,
      payments: await listAllPages((startingAfter) => client.invoicePayments.list({
        limit: 100,
        invoice: invoice.id,
        status: 'paid',
        expand: ['data.payment.payment_intent.latest_charge', 'data.payment.charge'],
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      })),
    }));
    for (const { subscriptionId, invoice, payments } of invoicesWithPayments) {
      const invoiceSubscription = invoiceSubscriptionId(invoice);
      if (invoiceSubscription && invoiceSubscription !== subscriptionId) continue;
      if (!payments.length) {
        if (invoice.amount_paid > 0) {
          const currency = normalizeCurrency(invoice.currency);
          if (currency) {
            addAmount(amounts, currency, toMajorUnits(invoice.amount_paid, currency));
            paymentCount += 1;
            complete = false;
            warnings.push('A paid Stripe invoice has no itemized payment record; refund totals may be incomplete.');
          }
        }
        continue;
      }
      const invoiceCurrency = normalizeCurrency(invoice.currency);
      let itemizedInvoicePaid = 0;
      for (const payment of payments) {
        const paid = payment.amount_paid ?? 0;
        const currency = normalizeCurrency(payment.currency);
        if (!currency || paid <= 0) continue;
        addAmount(amounts, currency, toMajorUnits(paid, currency));
        if (currency === invoiceCurrency) itemizedInvoicePaid += paid;
        paymentCount += 1;
        const linkedPayment = payment.payment;
        const intent = linkedPayment.type === 'payment_intent' ? linkedPayment.payment_intent : undefined;
        const chargeValue = linkedPayment.type === 'charge' ? linkedPayment.charge : undefined;
        let charge: unknown = typeof intent === 'object' && intent !== null
          ? intent.latest_charge
          : chargeValue;
        if (!charge && linkedPayment.type === 'payment_intent') {
          const intentId = stripeObjectId(intent);
          if (intentId) {
            const resolvedIntent = await client.paymentIntents.retrieve(intentId, { expand: ['latest_charge'] });
            charge = resolvedIntent.latest_charge;
          }
        }
        const chargeId = stripeObjectId(charge);
        if (!chargeId) {
          complete = false;
          warnings.push('Some Stripe payments could not be matched to refund records.');
          continue;
        }
        const resolvedCharge = typeof charge === 'object' && charge !== null && 'amount_refunded' in charge
          ? charge
          : await client.charges.retrieve(chargeId);
        const chargeCurrency = 'currency' in resolvedCharge && typeof resolvedCharge.currency === 'string'
          ? normalizeCurrency(resolvedCharge.currency)
          : currency;
        if (chargeCurrency !== currency) {
          complete = false;
          warnings.push('A Stripe refund uses a different currency from its invoice payment and could not be included safely.');
          continue;
        }
        const previous = chargeAmounts.get(chargeId) ?? { currency, gross: 0, refunded: 0 };
        previous.gross += paid;
        previous.refunded = Math.max(previous.refunded, 'amount_refunded' in resolvedCharge && typeof resolvedCharge.amount_refunded === 'number' ? resolvedCharge.amount_refunded : 0);
        chargeAmounts.set(chargeId, previous);
      }
      if (invoiceCurrency && invoice.amount_paid > itemizedInvoicePaid) {
        addAmount(amounts, invoiceCurrency, toMajorUnits(invoice.amount_paid - itemizedInvoicePaid, invoiceCurrency));
        complete = false;
        warnings.push('A paid Stripe invoice amount exceeds its itemized payments; refund totals may be incomplete.');
      }
    }
  });
  for (const charge of chargeAmounts.values()) {
    if (charge.refunded > 0) addAmount(amounts, charge.currency, 0, toMajorUnits(Math.min(charge.gross, charge.refunded), charge.currency));
  }
  return {
    summary: { state: 'ready', totals: toTotals(amounts), paymentCount },
    complete,
    warnings: [...new Set(warnings)],
  };
}

export function createBillingRevenueReader(overrides: Partial<BillingRevenueReaderDependencies> = {}): BillingRevenueReader {
  const dependencies: BillingRevenueReaderDependencies = {
    listSubscriptions: listBillingSubscriptions,
    listCharges: listBillingCharges,
    runStripe: stripeRequest,
    stripeConfigured: false,
    now: Date.now,
    ...overrides,
  };
  let cached: { summary: BillingRevenueSummary; createdAt: number } | undefined;
  let inFlight: Promise<BillingRevenueSummary> | undefined;

  return async function getSummary(forceRefresh = false): Promise<BillingRevenueSummary> {
    const now = dependencies.now();
    if (!forceRefresh && cached && now - cached.createdAt < CACHE_TTL_MS) return structuredClone(cached.summary);
    if (inFlight) return structuredClone(await inFlight);
    const load = async (): Promise<BillingRevenueSummary> => {
      const subscriptions = dependencies.listSubscriptions();
      const subscriptionIds = stripeSubscriptionIds(subscriptions);
      const warnings: string[] = [];
      let stripe: StripeRevenueResult;
      try {
        stripe = await stripeRevenue(dependencies, subscriptionIds);
      } catch {
        stripe = {
          summary: { state: 'unavailable', totals: [], paymentCount: 0 },
          complete: false,
          warnings: ['Stripe payment history is currently unavailable.'],
        };
      }
      warnings.push(...stripe.warnings);
      const charges = dependencies.listCharges();
      const crypto = cryptoRevenue(charges);
      if (charges.length >= 5_000) warnings.push('Crypto payment history reached its storage cap; older payments may not be included.');
      const complete = stripe.complete && charges.length < 5_000;
      return {
        updatedAt: new Date(dependencies.now()).toISOString(),
        complete,
        totals: combineTotals(stripe.summary.totals, crypto.totals),
        retention: summarizeRetention(subscriptions, dependencies.now()),
        providers: { stripe: stripe.summary, nowpayments: crypto },
        warnings,
      };
    };
    const pending = load();
    inFlight = pending;
    try {
      const summary = await pending;
      cached = { summary, createdAt: dependencies.now() };
      return structuredClone(summary);
    } finally {
      if (inFlight === pending) inFlight = undefined;
    }
  };
}

export const getBillingRevenueSummary = createBillingRevenueReader({ stripeConfigured: Boolean(config.stripeSecretKey) });
