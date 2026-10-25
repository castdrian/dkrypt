import Fastify from 'fastify';
import Stripe from 'stripe';
import { expect, test } from 'bun:test';
import type { Response as HttpResponse } from '#http.js';
import type { BillingCharge, BillingSubscription } from '#billing.js';
import { createBillingRevenueReader, type BillingRevenueSummary } from '#billingRevenue.js';
import { billingRoutes } from '#routes/billing.js';
import { PermissionFlag } from '#permissions.js';
import { isPublicApiKeyRoute } from '#publicApi.js';
import { setSessionCookie } from '#session.js';

function createCookie(permissions: bigint): string {
  let value = '';
  const response = { setHeader: (_name: string, header: string) => { value = header; } } as unknown as HttpResponse;
  setSessionCookie(response, { sub: 'root', permissions });
  return value.split(';', 1)[0];
}

function stripePage<T>(data: T[]): Stripe.ApiList<T> {
  return { data, has_more: false, object: 'list', url: '' } as Stripe.ApiList<T>;
}

test('billing revenue combines paid Stripe invoices and crypto payments while subtracting refunds', async () => {
  const subscriptions = [{ provider: 'stripe', subscriptionId: 'sub_revenue' }] as BillingSubscription[];
  const charges = [
    { provider: 'nowpayments', chargeId: 'crypto_paid', subscriptionId: 'sub_crypto', userId: 'root', status: 'succeeded', amount: 5, currency: 'EUR', occurredAt: '', updatedAt: '' },
    { provider: 'nowpayments', chargeId: 'crypto_refunded', subscriptionId: 'sub_crypto', userId: 'root', status: 'refunded', amount: 3, currency: 'EUR', occurredAt: '', updatedAt: '' },
  ] as BillingCharge[];
  const invoicePayment = {
    id: 'inpay_revenue',
    amount_paid: 1_000,
    currency: 'eur',
    payment: { type: 'payment_intent', payment_intent: { latest_charge: { id: 'ch_revenue', amount_refunded: 250 } } },
  } as unknown as Stripe.InvoicePayment;
  const client = {
    invoices: { list: async () => stripePage([{ id: 'in_revenue', amount_paid: 1_000, currency: 'eur' } as unknown as Stripe.Invoice]) },
    invoicePayments: { list: async () => stripePage([invoicePayment]) },
    charges: { retrieve: async () => { throw new Error('expanded charge should be reused'); } },
  } as unknown as Stripe;
  const readRevenue = createBillingRevenueReader({
    listSubscriptions: () => subscriptions,
    listCharges: () => charges,
    stripeConfigured: true,
    runStripe: (operation) => operation(client),
  });

  const summary = await readRevenue();

  expect(summary).toMatchObject({
    complete: true,
    totals: [{ currency: 'EUR', gross: 18, refunded: 5.5, net: 12.5 }],
    retention: { activeAccounts: 0, paymentIssues: 0, cancellationsUpdatedLast30Days: 0, recentCancellationRatePercent: 0 },
    providers: {
      stripe: { state: 'ready', paymentCount: 1, totals: [{ currency: 'EUR', gross: 10, refunded: 2.5, net: 7.5 }] },
      nowpayments: { state: 'ready', paymentCount: 2, totals: [{ currency: 'EUR', gross: 8, refunded: 3, net: 5 }] },
    },
  });
});

test('billing retention summarizes each account using its latest subscription state', async () => {
  const now = Date.parse('2026-10-25T00:00:00.000Z');
  const subscriptions = [
    { provider: 'stripe', subscriptionId: 'sub-active', customerId: 'cus-active', userId: 'active@example.com', status: 'active', updatedAt: new Date(now - 2 * 86400000).toISOString() },
    { provider: 'stripe', subscriptionId: 'sub-old', customerId: 'cus-past-due', userId: 'past-due@example.com', status: 'active', updatedAt: new Date(now - 4 * 86400000).toISOString() },
    { provider: 'stripe', subscriptionId: 'sub-new', customerId: 'cus-past-due', userId: 'past-due@example.com', status: 'past_due', updatedAt: new Date(now - 86400000).toISOString() },
    { provider: 'nowpayments', subscriptionId: 'sub-canceled', customerId: 'wallet-canceled', userId: 'canceled@example.com', status: 'cancelled', updatedAt: new Date(now - 10 * 86400000).toISOString() },
    { provider: 'nowpayments', subscriptionId: 'sub-old-canceled', customerId: 'wallet-old', userId: 'old-canceled@example.com', status: 'canceled', updatedAt: new Date(now - 40 * 86400000).toISOString() },
  ] as BillingSubscription[];
  const readRevenue = createBillingRevenueReader({
    listSubscriptions: () => subscriptions,
    listCharges: () => [],
    stripeConfigured: false,
    now: () => now,
  });

  const summary = await readRevenue();

  expect(summary.retention).toEqual({ activeAccounts: 1, paymentIssues: 1, cancellationsUpdatedLast30Days: 1, recentCancellationRatePercent: 50 });
});

test('billing revenue marks incomplete Stripe history instead of claiming a precise total', async () => {
  const subscriptions = [{ provider: 'stripe', subscriptionId: 'sub_revenue' }] as BillingSubscription[];
  const client = {
    invoices: { list: async () => stripePage([{ id: 'in_unitemized', amount_paid: 1_000, currency: 'eur' } as unknown as Stripe.Invoice]) },
    invoicePayments: { list: async () => stripePage([]) },
  } as unknown as Stripe;
  const readRevenue = createBillingRevenueReader({
    listSubscriptions: () => subscriptions,
    listCharges: () => [],
    stripeConfigured: true,
    runStripe: (operation) => operation(client),
  });

  const summary = await readRevenue();

  expect(summary.complete).toBe(false);
  expect(summary.totals).toEqual([{ currency: 'EUR', gross: 10, refunded: 0, net: 10 }]);
  expect(summary.warnings).toContain('A paid Stripe invoice has no itemized payment record; refund totals may be incomplete.');
});

test('billing revenue caches requests briefly and supports an explicit refresh', async () => {
  let now = 0;
  let chargeReads = 0;
  const readRevenue = createBillingRevenueReader({
    listSubscriptions: () => [],
    listCharges: () => { chargeReads += 1; return []; },
    stripeConfigured: false,
    now: () => now,
  });

  await readRevenue();
  await readRevenue();
  await readRevenue(true);
  now += 60_000;
  await readRevenue();

  expect(chargeReads).toBe(3);
});

test('billing revenue endpoint is manager-only and excluded from API-key routes', async () => {
  const summary: BillingRevenueSummary = {
    updatedAt: new Date(0).toISOString(),
    complete: true,
    totals: [],
    retention: { activeAccounts: 0, paymentIssues: 0, cancellationsUpdatedLast30Days: 0, recentCancellationRatePercent: 0 },
    providers: {
      stripe: { state: 'not_configured', totals: [], paymentCount: 0 },
      nowpayments: { state: 'ready', totals: [], paymentCount: 0 },
    },
    warnings: [],
  };
  const server = Fastify();
  const refreshRequests: boolean[] = [];
  await server.register(billingRoutes, { billingRevenue: async (refresh = false) => { refreshRequests.push(refresh); return summary; } });
  const manager = createCookie(PermissionFlag.manageBilling);
  const member = createCookie(0n);

  try {
    const anonymous = await server.inject({ method: 'GET', url: '/v1/billing/revenue' });
    const unauthorized = await server.inject({ method: 'GET', url: '/v1/billing/revenue', headers: { cookie: member } });
    const allowed = await server.inject({ method: 'GET', url: '/v1/billing/revenue', headers: { cookie: manager } });
    const refreshed = await server.inject({ method: 'GET', url: '/v1/billing/revenue?refresh=true', headers: { cookie: manager } });

    expect(anonymous.statusCode).toBe(401);
    expect(unauthorized.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    expect(refreshed.statusCode).toBe(200);
    expect(JSON.parse(allowed.body)).toEqual(summary);
    expect(refreshRequests).toEqual([false, true]);
    expect(isPublicApiKeyRoute('GET', '/v1/billing/revenue')).toBe(false);
  } finally {
    await server.close();
  }
});
