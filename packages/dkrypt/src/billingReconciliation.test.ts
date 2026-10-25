import Fastify from 'fastify';
import Stripe from 'stripe';
import { expect, test } from 'bun:test';
import type { Response as HttpResponse } from '#http.js';
import { getBillingEntitlements, getPlan, replaceBillingSnapshot, exportBillingSnapshot } from '#billing.js';
import { billingRoutes } from '#routes/billing.js';
import { isPublicApiKeyRoute } from '#publicApi.js';
import { PermissionFlag } from '#permissions.js';
import { getAuditLog } from '#store/state.js';
import { setSessionCookie } from '#session.js';

function createCookie(permissions: bigint): string {
  let value = '';
  const response = { setHeader: (_name: string, header: string) => { value = header; } } as unknown as HttpResponse;
  setSessionCookie(response, { sub: 'root', permissions });
  return value.split(';', 1)[0];
}

test('billing reconciliation previews Stripe drift and syncs only after an unchanged manager review', async () => {
  const previous = exportBillingSnapshot();
  const updatedAt = '2026-10-20T10:00:00.000Z';
  const regular = getPlan('regular');
  const priority = getPlan('priority');
  if (!regular || !priority) throw new Error('Stripe plans are required for reconciliation tests');
  replaceBillingSnapshot({
    ...previous,
    customers: [{ provider: 'stripe', customerId: 'cus_reconciliation', email: 'member@example.test', userId: 'root', updatedAt }],
    subscriptions: [{
      provider: 'stripe',
      subscriptionId: 'sub_reconciliation',
      customerId: 'cus_reconciliation',
      userId: 'root',
      status: 'canceled',
      planId: 'regular',
      priceId: regular.priceId,
      productId: 'prod_regular_reconciliation',
      occurredAt: updatedAt,
      updatedAt,
    }],
  });
  let stripeSubscription = {
    id: 'sub_reconciliation',
    customer: 'cus_reconciliation',
    status: 'active',
    metadata: { dkrypt_user_id: 'root' },
    current_period_end: Math.floor(Date.now() / 1000) + 2_592_000,
    cancel_at: null,
    cancel_at_period_end: false,
    items: { data: [{ id: 'si_reconciliation', current_period_end: Math.floor(Date.now() / 1000) + 2_592_000, price: { id: priority.priceId, product: 'prod_priority_reconciliation' } }] },
  } as unknown as Stripe.Subscription;
  const stripeClient = { subscriptions: { retrieve: async () => stripeSubscription } } as unknown as Stripe;
  const server = Fastify();
  await server.register(billingRoutes, { stripeClient: () => stripeClient });
  const manager = { cookie: createCookie(PermissionFlag.manageBilling) };
  const viewer = { cookie: createCookie(0n) };

  try {
    const anonymous = await server.inject({ method: 'GET', url: '/v1/billing/reconciliation' });
    const unauthorized = await server.inject({ method: 'GET', url: '/v1/billing/reconciliation', headers: viewer });
    const preview = await server.inject({ method: 'GET', url: '/v1/billing/reconciliation', headers: manager });
    expect(preview.statusCode).toBe(200);
    const item = preview.json().entries[0];
    const stale = await server.inject({
      method: 'POST',
      url: '/v1/billing/reconciliation/sub_reconciliation/sync',
      headers: manager,
      payload: { expectedUpdatedAt: '2026-10-19T10:00:00.000Z', expectedStripeStatus: 'active', expectedStripePriceId: priority.priceId },
    });
    stripeSubscription = { ...stripeSubscription, status: 'canceled' };
    const providerChanged = await server.inject({
      method: 'POST',
      url: '/v1/billing/reconciliation/sub_reconciliation/sync',
      headers: manager,
      payload: { expectedUpdatedAt: updatedAt, expectedStripeStatus: 'active', expectedStripePriceId: priority.priceId },
    });
    stripeSubscription = { ...stripeSubscription, status: 'active' };
    const synced = await server.inject({
      method: 'POST',
      url: '/v1/billing/reconciliation/sub_reconciliation/sync',
      headers: manager,
      payload: { expectedUpdatedAt: updatedAt, expectedStripeStatus: 'active', expectedStripePriceId: priority.priceId },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(unauthorized.statusCode).toBe(403);
    expect(preview.statusCode).toBe(200);
    expect(item).toMatchObject({
      subscriptionId: 'sub_reconciliation',
      local: { planId: 'regular', status: 'canceled', updatedAt },
      stripe: { state: 'ready', planId: 'priority', status: 'active', priceId: priority.priceId },
      discrepancies: expect.arrayContaining(['plan_mismatch', 'status_mismatch', 'entitlement_mismatch']),
      syncAllowed: true,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'billing_reconciliation_stale' });
    expect(providerChanged.statusCode).toBe(409);
    expect(providerChanged.json()).toMatchObject({ code: 'billing_reconciliation_provider_changed' });
    expect(synced.statusCode).toBe(200);
    expect(synced.json()).toMatchObject({
      subscriptionId: 'sub_reconciliation',
      status: 'active',
      planId: 'priority',
      entitlement: { planId: 'priority', provider: 'stripe', status: 'active' },
    });
    expect(getBillingEntitlements('root').planId).toBe('priority');
    expect(getAuditLog().some((entry) => entry.action === 'billing.reconciliation.sync' && entry.target === 'sub_reconciliation')).toBe(true);
    expect(isPublicApiKeyRoute('GET', '/v1/billing/reconciliation')).toBe(false);
    expect(isPublicApiKeyRoute('POST', '/v1/billing/reconciliation/sub_reconciliation/sync')).toBe(false);

    const snapshot = exportBillingSnapshot();
    replaceBillingSnapshot({
      ...snapshot,
      subscriptions: snapshot.subscriptions.map((subscription) => subscription.subscriptionId === 'sub_reconciliation'
        ? { ...subscription, status: 'revoked', failureReason: 'payment refunded', updatedAt: '2026-10-25T12:00:00.000Z' }
        : subscription),
    });
    const refundProtected = await server.inject({
      method: 'POST',
      url: '/v1/billing/reconciliation/sub_reconciliation/sync',
      headers: manager,
      payload: { expectedUpdatedAt: '2026-10-25T12:00:00.000Z', expectedStripeStatus: 'active', expectedStripePriceId: priority.priceId },
    });
    expect(refundProtected.statusCode).toBe(409);
    expect(refundProtected.json()).toMatchObject({ code: 'billing_refund_protected' });
    expect(getBillingEntitlements('root').provider).not.toBe('stripe');
  } finally {
    await server.close();
    replaceBillingSnapshot(previous);
  }
});
