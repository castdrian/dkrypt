import { createHash, createHmac } from 'node:crypto';
import Fastify from 'fastify';
import Stripe from 'stripe';
import { describe, expect, test } from 'bun:test';
import type { Response as HttpResponse } from '#http.js';
import { hasPermission, PermissionFlag } from '#permissions.js';
import {
  exportBillingSnapshot,
  getBillingCustomerId,
  getBillingEntitlements,
  getBillingSubscriptionById,
  replaceBillingSnapshot,
} from '#billing.js';
import { config } from '#config.js';
import { billingRoutes, processStripeEvent } from '#routes/billing.js';
import { buildTestServer } from '#testServer.js';
import { STRIPE_WEBHOOK_EVENTS } from '#stripeWebhookEvents.js';
import { clearStripeWebhookHealthCache } from '#stripeWebhookHealth.js';
import { getAuditLog, getUserEffectivePermissions } from '#store/state.js';
import { flushTelemetry } from '#telemetry.js';
import { setSessionCookie } from '#session.js';
import { claimWebhook, getWebhookInboxRecord, markWebhookFailed, markWebhookProcessed, quarantineWebhook, receiveWebhook, releaseWebhookClaim } from '#webhookInbox.js';

const webhookSecret = 'whsec_dkrypt_test';

function createSessionCookie(permissions: bigint): string {
  let cookieHeader = '';
  const response = { setHeader: (_name: string, value: string) => { cookieHeader = value; } } as unknown as HttpResponse;
  setSessionCookie(response, { sub: 'root', permissions });
  return cookieHeader.split(';', 1)[0];
}

function createStripeCheckoutDouble() {
  const calls: Array<{ parameters: Record<string, unknown>; idempotencyKey: string }> = [];
  const retrievals: string[] = [];
  const sessions = new Map<string, { fingerprint: string; session: { id: string; url: string } }>();
  const client = {
    checkout: {
      sessions: {
        create: async (parameters: Record<string, unknown>, options: { idempotencyKey?: string }) => {
          const idempotencyKey = options.idempotencyKey;
          if (!idempotencyKey) throw new Error('Stripe idempotency key is required');
          const fingerprint = JSON.stringify(parameters);
          calls.push({ parameters, idempotencyKey });
          const existing = sessions.get(idempotencyKey);
          if (existing && existing.fingerprint !== fingerprint) throw new Error('Stripe idempotency parameters conflict');
          if (existing) return existing.session;
          const session = { id: `cs_${sessions.size + 1}`, url: `https://checkout.stripe.com/c/${sessions.size + 1}` };
          sessions.set(idempotencyKey, { fingerprint, session });
          return session;
        },
        retrieve: async (sessionId: string) => {
          retrievals.push(sessionId);
          const entry = [...sessions.values()].find(({ session }) => session.id === sessionId);
          if (!entry) throw new Error('Stripe checkout session was not found');
          return entry.session;
        },
      },
    },
  } as unknown as Stripe;
  return { calls, client, retrievals, sessions };
}

function event(type: string, object: Record<string, unknown>): Stripe.Event {
  return {
    id: `evt_${crypto.randomUUID()}`,
    object: 'event',
    api_version: null,
    created: Math.floor(Date.now() / 1000),
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
  } as unknown as Stripe.Event;
}

function signedStripeWebhook(stripeEvent: Stripe.Event, extraHeaders: Record<string, string> = {}) {
  const payload = JSON.stringify(stripeEvent);
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', webhookSecret).update(`${timestamp}.${payload}`).digest('hex');
  return {
    payload,
    headers: {
      'content-type': 'application/json',
      'stripe-signature': `t=${timestamp},v1=${digest}`,
      ...extraHeaders,
    },
  };
}

function checkoutIdempotencyKey(provider: 'crypto' | 'stripe', userId: string, key: string): string {
  const operation = `checkout-${provider}`;
  return `dkrypt-${operation}-${createHash('sha256').update(`${operation}:${userId}:${key}`).digest('hex')}`;
}

function checkoutEvent(userId: string, customerId: string, subscriptionId: string, type = 'checkout.session.completed'): Stripe.Event {
  return event(type, {
    id: `cs_${crypto.randomUUID()}`,
    object: 'checkout.session',
    customer: customerId,
    subscription: subscriptionId,
    metadata: { dkrypt_user_id: userId },
  });
}

function subscriptionEvent(userId: string, customerId: string, subscriptionId: string): Stripe.Event {
  return event('customer.subscription.created', {
    id: subscriptionId,
    object: 'subscription',
    customer: customerId,
    status: 'active',
    metadata: { dkrypt_user_id: userId },
    current_period_end: Math.floor(Date.now() / 1000) + 2_592_000,
    cancel_at: null,
    cancel_at_period_end: false,
    items: {
      data: [{ id: 'si_priority_test', current_period_end: Math.floor(Date.now() / 1000) + 2_592_000, price: { id: 'price_priority_test', product: 'prod_priority_test' } }],
    },
  });
}

describe('Stripe billing webhooks', () => {
  test('configures the payment and refund events processed by dkrypt', () => {
    expect(new Set(STRIPE_WEBHOOK_EVENTS).size).toBe(STRIPE_WEBHOOK_EVENTS.length);
    expect(STRIPE_WEBHOOK_EVENTS).toEqual(expect.arrayContaining([
      'invoice.paid',
      'invoice.payment_failed',
      'charge.refunded',
    ]));
  });

  test('links checkout sessions and grants the plan from a subscription event', async () => {
    const userId = `stripe-user-${crypto.randomUUID()}`;
    const customerId = `cus_${crypto.randomUUID()}`;
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const currentSubscription = subscriptionEvent(userId, customerId, subscriptionId).data.object as Stripe.Subscription;
    const client = {
      subscriptions: {
        retrieve: async () => currentSubscription,
      },
    } as unknown as Stripe;

    await processStripeEvent(checkoutEvent(userId, customerId, subscriptionId), client);
    await processStripeEvent(subscriptionEvent(userId, customerId, subscriptionId), client);

    expect(getBillingCustomerId(userId)).toBe(customerId);
    expect(getBillingEntitlements(userId)).toMatchObject({ planId: 'priority', decrypt: true, priority: 5 });
  });

  test('grants access from a completed subscription checkout when the subscription event is delayed', async () => {
    const userId = `stripe-checkout-reconcile-${crypto.randomUUID()}`;
    const customerId = `cus_${crypto.randomUUID()}`;
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const currentSubscription = subscriptionEvent(userId, customerId, subscriptionId).data.object as Stripe.Subscription;
    const retrievedIds: string[] = [];
    const client = {
      subscriptions: {
        retrieve: async (id: string) => {
          retrievedIds.push(id);
          return currentSubscription;
        },
      },
    } as unknown as Stripe;

    await processStripeEvent(checkoutEvent(userId, customerId, subscriptionId), client);

    expect(retrievedIds).toEqual([subscriptionId]);
    expect(getBillingEntitlements(userId)).toMatchObject({ planId: 'priority', decrypt: true, priority: 5 });
  });

  test('reconciles a paid subscription invoice from Stripe when the subscription event is missing', async () => {
    const userId = `stripe-invoice-paid-${crypto.randomUUID()}`;
    const customerId = `cus_${crypto.randomUUID()}`;
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const currentSubscription = subscriptionEvent(userId, customerId, subscriptionId).data.object as Stripe.Subscription;
    const retrievedIds: string[] = [];
    const client = {
      subscriptions: {
        retrieve: async (id: string) => {
          retrievedIds.push(id);
          return currentSubscription;
        },
      },
    } as unknown as Stripe;

    await processStripeEvent(event('invoice.paid', {
      id: `in_${crypto.randomUUID()}`,
      object: 'invoice',
      parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId } },
    }), client);

    expect(retrievedIds).toEqual([subscriptionId]);
    expect(getBillingEntitlements(userId)).toMatchObject({ planId: 'priority', decrypt: true, priority: 5 });
  });

  test('reconciles failed subscription invoices without applying stale invoice state', async () => {
    const userId = `stripe-invoice-failed-${crypto.randomUUID()}`;
    const customerId = `cus_${crypto.randomUUID()}`;
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const activeSubscription = subscriptionEvent(userId, customerId, subscriptionId).data.object as Stripe.Subscription;
    await processStripeEvent(subscriptionEvent(userId, customerId, subscriptionId));
    const currentSubscription = { ...activeSubscription, status: 'past_due' } as Stripe.Subscription;
    const retrievedIds: string[] = [];
    const client = {
      subscriptions: {
        retrieve: async (id: string) => {
          retrievedIds.push(id);
          return currentSubscription;
        },
      },
    } as unknown as Stripe;

    await processStripeEvent(event('invoice.payment_failed', {
      id: `in_${crypto.randomUUID()}`,
      object: 'invoice',
      parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId } },
    }), client);

    expect(retrievedIds).toEqual([subscriptionId]);
    expect(getBillingSubscriptionById(subscriptionId)?.status).toBe('past_due');
    expect(getBillingEntitlements(userId).planId).toBe('priority');
  });

  test('revokes access and cancels the Stripe subscription after a full invoice refund', async () => {
    const userId = `stripe-refund-${crypto.randomUUID()}`;
    const customerId = `cus_${crypto.randomUUID()}`;
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    const chargeId = `ch_${crypto.randomUUID()}`;
    const paymentIntentId = `pi_${crypto.randomUUID()}`;
    const invoiceId = `in_${crypto.randomUUID()}`;
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    await processStripeEvent(event('customer.created', {
      id: customerId,
      object: 'customer',
      email: `${userId}@example.test`,
      metadata: { dkrypt_user_id: userId },
    }));
    await processStripeEvent(subscriptionEvent(userId, customerId, subscriptionId));

    const refundEvent = event('charge.refunded', {
      id: chargeId,
      object: 'charge',
      customer: customerId,
      amount: 1500,
      amount_refunded: 1500,
      currency: 'eur',
      refunded: true,
      payment_intent: paymentIntentId,
    });
    const currentSubscription = subscriptionEvent(userId, customerId, subscriptionId).data.object as Stripe.Subscription;
    let cancelledSubscription = 0;
    const client = {
      invoicePayments: {
        list: async () => ({
          data: [{ invoice: invoiceId, payment: { type: 'payment_intent', payment_intent: paymentIntentId } }],
        }),
      },
      invoices: {
        retrieve: async () => ({
          id: invoiceId,
          parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId } },
        }),
      },
      subscriptions: {
        retrieve: async () => currentSubscription,
        cancel: async () => {
          cancelledSubscription += 1;
          return { ...currentSubscription, status: 'canceled' };
        },
      },
    } as unknown as Stripe;

    await processStripeEvent(refundEvent, client);

    expect(getAuditLog()).toContainEqual(expect.objectContaining({
      actor: userId,
      action: 'billing.refund',
      target: chargeId,
      detail: expect.stringContaining(refundEvent.id),
    }));
    expect(cancelledSubscription).toBe(1);
    expect(getBillingSubscriptionById(subscriptionId)).toMatchObject({ status: 'revoked', failureReason: 'payment refunded' });
    expect(getBillingSubscriptionById(subscriptionId)?.nextBilledAt).toBeUndefined();
    expect(getBillingEntitlements(userId)).toMatchObject({ planId: 'viewer', decrypt: true, api: false, freeTier: true });
    expect(hasPermission(getUserEffectivePermissions(userId), PermissionFlag.requestDecrypt)).toBeTrue();
    expect(hasPermission(getUserEffectivePermissions(userId), PermissionFlag.createApiKeys)).toBeFalse();

    const laterActiveEvent = subscriptionEvent(userId, customerId, subscriptionId);
    laterActiveEvent.type = 'customer.subscription.updated';
    laterActiveEvent.created = refundEvent.created + 1;
    await processStripeEvent(laterActiveEvent, client);

    expect(getBillingSubscriptionById(subscriptionId)).toMatchObject({ status: 'revoked', failureReason: 'payment refunded' });
    expect(getBillingSubscriptionById(subscriptionId)?.nextBilledAt).toBeUndefined();
    expect(getBillingEntitlements(userId)).toMatchObject({ planId: 'viewer', decrypt: true, api: false, freeTier: true });
  });

  test('keeps an unresolved full refund retryable while its customer has paid access', async () => {
    const userId = `stripe-refund-unresolved-${crypto.randomUUID()}`;
    const customerId = `cus_${crypto.randomUUID()}`;
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    await processStripeEvent(subscriptionEvent(userId, customerId, subscriptionId));

    const client = {
      invoicePayments: { list: async () => ({ data: [] }) },
    } as unknown as Stripe;

    await expect(processStripeEvent(event('charge.refunded', {
      id: `ch_${crypto.randomUUID()}`,
      object: 'charge',
      customer: customerId,
      amount: 1500,
      amount_refunded: 1500,
      currency: 'eur',
      refunded: true,
      payment_intent: `pi_${crypto.randomUUID()}`,
    }), client)).rejects.toThrow(/could not be resolved to a subscription/);

    expect(getBillingSubscriptionById(subscriptionId)?.status).toBe('active');
    expect(getBillingEntitlements(userId).planId).toBe('priority');
  });

  test('keeps a full refund without a payment intent retryable while its customer has paid access', async () => {
    const userId = `stripe-refund-no-payment-intent-${crypto.randomUUID()}`;
    const customerId = `cus_${crypto.randomUUID()}`;
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    await processStripeEvent(subscriptionEvent(userId, customerId, subscriptionId));

    await expect(processStripeEvent(event('charge.refunded', {
      id: `ch_${crypto.randomUUID()}`,
      object: 'charge',
      customer: customerId,
      amount: 1500,
      amount_refunded: 1500,
      currency: 'eur',
      refunded: true,
      payment_intent: null,
    }))).rejects.toThrow(/could not be resolved to a subscription/);

    expect(getBillingSubscriptionById(subscriptionId)?.status).toBe('active');
    expect(getBillingEntitlements(userId).planId).toBe('priority');
  });

  test('does not revoke or cancel access after a partial Stripe refund', async () => {
    const userId = `stripe-partial-refund-${crypto.randomUUID()}`;
    const customerId = `cus_${crypto.randomUUID()}`;
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    await processStripeEvent(subscriptionEvent(userId, customerId, subscriptionId));

    let cancelledSubscription = 0;
    const client = {
      invoicePayments: { list: async () => { throw new Error('partial refunds should not resolve invoices'); } },
      subscriptions: { cancel: async () => { cancelledSubscription += 1; } },
    } as unknown as Stripe;
    await processStripeEvent(event('charge.refunded', {
      id: `ch_${crypto.randomUUID()}`,
      object: 'charge',
      customer: customerId,
      amount: 1500,
      amount_refunded: 500,
      currency: 'eur',
      refunded: false,
    }), client);

    expect(cancelledSubscription).toBe(0);
    expect(getBillingSubscriptionById(subscriptionId)?.status).toBe('active');
    expect(getBillingEntitlements(userId).planId).toBe('priority');
  });

  test('reconciles same-second subscription events from Stripe current state', async () => {
    const userId = `stripe-order-${crypto.randomUUID()}`;
    const customerId = `cus_${crypto.randomUUID()}`;
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const currentEvent = subscriptionEvent(userId, customerId, subscriptionId);
    await processStripeEvent(currentEvent);

    const incomingSubscription = { ...(currentEvent.data.object as Stripe.Subscription), status: 'canceled' } as Stripe.Subscription;
    const eventInSameSecond = {
      ...currentEvent,
      id: `evt_${crypto.randomUUID()}`,
      type: 'customer.subscription.deleted',
      data: { object: incomingSubscription },
    } as Stripe.Event;
    const currentSubscription = { ...incomingSubscription, status: 'active' } as Stripe.Subscription;
    const retrievedIds: string[] = [];
    const client = {
      subscriptions: {
        retrieve: async (id: string) => {
          retrievedIds.push(id);
          return currentSubscription;
        },
      },
    } as unknown as Stripe;

    await processStripeEvent(eventInSameSecond, client);

    expect(retrievedIds).toEqual([subscriptionId]);
    expect(getBillingSubscriptionById(subscriptionId)?.status).toBe('active');
  });

  test('does not apply an ambiguous same-second event when Stripe reconciliation fails', async () => {
    const userId = `stripe-unavailable-${crypto.randomUUID()}`;
    const customerId = `cus_${crypto.randomUUID()}`;
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const currentEvent = subscriptionEvent(userId, customerId, subscriptionId);
    await processStripeEvent(currentEvent);
    const staleEvent = {
      ...currentEvent,
      id: `evt_${crypto.randomUUID()}`,
      type: 'customer.subscription.deleted',
      data: { object: { ...(currentEvent.data.object as Stripe.Subscription), status: 'canceled' } },
    } as Stripe.Event;
    const client = {
      subscriptions: {
        retrieve: async () => { throw new Error('Stripe unavailable'); },
      },
    } as unknown as Stripe;

    await expect(processStripeEvent(staleEvent, client)).rejects.toThrow('Stripe unavailable');

    expect(getBillingSubscriptionById(subscriptionId)?.status).toBe('active');
  });

  test('does not overwrite a newer subscription event after a delayed Stripe lookup', async () => {
    const userId = `stripe-race-${crypto.randomUUID()}`;
    const customerId = `cus_${crypto.randomUUID()}`;
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const currentEvent = subscriptionEvent(userId, customerId, subscriptionId);
    await processStripeEvent(currentEvent);

    let signalLookup = () => {};
    let releaseLookup = () => {};
    const lookupStarted = new Promise<void>((resolve) => { signalLookup = resolve; });
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const client = {
      subscriptions: {
        retrieve: async () => {
          signalLookup();
          await lookupGate;
          return currentEvent.data.object as Stripe.Subscription;
        },
      },
    } as unknown as Stripe;
    const staleEvent = {
      ...currentEvent,
      id: `evt_${crypto.randomUUID()}`,
      type: 'customer.subscription.deleted',
      data: { object: { ...(currentEvent.data.object as Stripe.Subscription), status: 'canceled' } },
    } as Stripe.Event;
    const staleProcessing = processStripeEvent(staleEvent, client);
    await lookupStarted;

    const newerEvent = {
      ...currentEvent,
      id: `evt_${crypto.randomUUID()}`,
      created: currentEvent.created + 1,
      type: 'customer.subscription.updated',
      data: { object: { ...(currentEvent.data.object as Stripe.Subscription), status: 'canceled' } },
    } as Stripe.Event;
    const newerProcessing = processStripeEvent(newerEvent, client);
    const timeUntilNewerEvent = newerEvent.created * 1000 - Date.now() + 1;
    if (timeUntilNewerEvent > 0) await new Promise((resolve) => setTimeout(resolve, timeUntilNewerEvent));
    releaseLookup();
    await staleProcessing;
    await newerProcessing;

    expect(getBillingSubscriptionById(subscriptionId)?.status).toBe('canceled');
  });

  test('does not overwrite a newer subscription event after a delayed invoice lookup', async () => {
    const userId = `stripe-invoice-race-${crypto.randomUUID()}`;
    const customerId = `cus_${crypto.randomUUID()}`;
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const currentEvent = subscriptionEvent(userId, customerId, subscriptionId);
    await processStripeEvent(currentEvent);

    let signalLookup = () => {};
    let releaseLookup = () => {};
    const lookupStarted = new Promise<void>((resolve) => { signalLookup = resolve; });
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const client = {
      subscriptions: {
        retrieve: async () => {
          signalLookup();
          await lookupGate;
          return currentEvent.data.object as Stripe.Subscription;
        },
      },
    } as unknown as Stripe;
    const invoiceEvent = event('invoice.paid', {
      id: `in_${crypto.randomUUID()}`,
      object: 'invoice',
      subscription: subscriptionId,
    });
    invoiceEvent.created = currentEvent.created;
    const invoiceProcessing = processStripeEvent(invoiceEvent, client);
    await lookupStarted;

    const newerEvent = {
      ...currentEvent,
      id: `evt_${crypto.randomUUID()}`,
      created: invoiceEvent.created + 1,
      type: 'customer.subscription.updated',
      data: { object: { ...(currentEvent.data.object as Stripe.Subscription), status: 'canceled' } },
    } as Stripe.Event;
    const newerProcessing = processStripeEvent(newerEvent, client);
    const timeUntilNewerEvent = newerEvent.created * 1000 - Date.now() + 1;
    if (timeUntilNewerEvent > 0) await new Promise((resolve) => setTimeout(resolve, timeUntilNewerEvent));
    releaseLookup();
    await invoiceProcessing;
    await newerProcessing;

    expect(getBillingSubscriptionById(subscriptionId)?.status).toBe('canceled');
  });

  test('keeps async payment failures from granting entitlements', async () => {
    const userId = `stripe-failed-${crypto.randomUUID()}`;
    const customerId = `cus_${crypto.randomUUID()}`;
    replaceBillingSnapshot({ customers: [], subscriptions: [] });

    await processStripeEvent(checkoutEvent(userId, customerId, `sub_${crypto.randomUUID()}`, 'checkout.session.async_payment_failed'));

    expect(getBillingCustomerId(userId)).toBe(customerId);
    expect(getBillingEntitlements(userId).planId).toBe('viewer');
  });

  test('accepts a signed raw webhook request', async () => {
    const userId = `stripe-webhook-${crypto.randomUUID()}`;
    const customerId = `cus_${crypto.randomUUID()}`;
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    const request = signedStripeWebhook(checkoutEvent(userId, customerId, subscriptionId), {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
    const currentSubscription = subscriptionEvent(userId, customerId, subscriptionId).data.object as Stripe.Subscription;
    const stripeClient = {
      subscriptions: {
        retrieve: async () => currentSubscription,
      },
    } as unknown as Stripe;
    const server = await buildTestServer({ includePublicRoutes: false, stripeClient: () => stripeClient });
    const previousSampleRate = config.otelSampleRate;
    config.otelSampleRate = 1;

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/stripe/webhook',
        headers: request.headers,
        payload: request.payload,
      });

      expect(response.statusCode).toBe(200);
      expect(getBillingCustomerId(userId)).toBe(customerId);
      expect(getBillingEntitlements(userId)).toMatchObject({ planId: 'priority', decrypt: true, priority: 5 });
      const [, traceId, requestSpanId] = String(response.headers.traceparent).split('-');
      const failedEvent = { ...event('customer.subscription.created', {}), data: null } as unknown as Stripe.Event;
      const failedRequest = signedStripeWebhook(failedEvent, {
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4737-00f067aa0ba902b8-01',
      });
      const failedResponse = await server.inject({
        method: 'POST',
        url: '/v1/stripe/webhook',
        headers: failedRequest.headers,
        payload: failedRequest.payload,
      });
      expect(failedResponse.statusCode).toBe(500);
      expect(failedResponse.json()).toMatchObject({
        error: 'webhook processing failed',
        code: 'internal_error',
        message: 'webhook processing failed',
        retryable: true,
      });
      const [, failedTraceId, failedRequestSpanId] = String(failedResponse.headers.traceparent).split('-');
      let exportedSpans: Array<{ name: string; traceId: string; parentSpanId?: string; attributes: Array<{ key: string; value: Record<string, unknown> }>; status?: { code: number; message?: string } }> = [];
      await flushTelemetry({
        endpoint: 'https://collector.example/v1/traces',
        fetcher: async (_input, init) => {
          const payload = JSON.parse(String(init?.body)) as {
            resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string; traceId: string; parentSpanId?: string; attributes: Array<{ key: string; value: Record<string, unknown> }>; status?: { code: number; message?: string } }> }> }>;
          };
          exportedSpans = payload.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans));
          return Response.json({});
        },
      });

      const deliverySpan = exportedSpans.find((span) => span.name === 'billing.webhook.delivery' && span.traceId === traceId);
      expect(deliverySpan).toMatchObject({ traceId, parentSpanId: requestSpanId });
      expect(deliverySpan?.attributes).toContainEqual({ key: 'webhook.provider', value: { stringValue: 'stripe' } });
      expect(deliverySpan?.attributes).toContainEqual({ key: 'webhook.status', value: { stringValue: 'processed' } });
      const failedDeliverySpan = exportedSpans.find((span) => span.name === 'billing.webhook.delivery' && span.traceId === failedTraceId);
      expect(failedDeliverySpan).toMatchObject({ traceId: failedTraceId, parentSpanId: failedRequestSpanId, status: { code: 2 } });
      expect(failedDeliverySpan?.attributes).toContainEqual({ key: 'webhook.status', value: { stringValue: 'failed' } });
    } finally {
      await server.close();
      config.otelSampleRate = previousSampleRate;
    }
  });

  test('keeps subscriptions with unknown prices retryable instead of acknowledging them', async () => {
    const userId = `stripe-unknown-price-${crypto.randomUUID()}`;
    const customerId = `cus_${crypto.randomUUID()}`;
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    const unknownPriceId = `price_unconfigured_${crypto.randomUUID()}`;
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const original = subscriptionEvent(userId, customerId, subscriptionId);
    const subscription = original.data.object as Stripe.Subscription;
    const lineItem = subscription.items.data[0];
    if (!lineItem) throw new Error('subscription event has no line item');
    const unknownPriceSubscription = {
      ...subscription,
      items: {
        ...subscription.items,
        data: [{ ...lineItem, price: { ...(lineItem.price as Stripe.Price), id: unknownPriceId } }],
    },
    } as Stripe.Subscription;
    const stripeEvent = { ...original, id: `evt_${crypto.randomUUID()}`, data: { object: unknownPriceSubscription } } as Stripe.Event;
    const request = signedStripeWebhook(stripeEvent);
    const server = await buildTestServer({ includePublicRoutes: false });
    const headers = { cookie: createSessionCookie(PermissionFlag.manageBilling | PermissionFlag.viewLogs) };

    try {
      const delivery = await server.inject({
        method: 'POST',
        url: '/v1/stripe/webhook',
        headers: request.headers,
        payload: request.payload,
      });
      const inbox = await server.inject({
        method: 'GET',
        url: '/v1/billing/webhooks/inbox?provider=stripe&status=failed&limit=200',
        headers,
      });

      expect(delivery.statusCode).toBe(500);
      expect(inbox.json().inbox).toContainEqual(expect.objectContaining({
        eventId: stripeEvent.id,
        status: 'failed',
        lastError: expect.stringContaining(unknownPriceId),
      }));
      expect(getBillingEntitlements(userId).planId).toBe('viewer');
    } finally {
      await server.close();
    }
  });

  test('billing reconciliation queue groups received and failed events by newest first', async () => {
    const failedEventId = `evt_reconcile_failed_${crypto.randomUUID()}`;
    const receivedEventId = `evt_reconcile_received_${crypto.randomUUID()}`;
    const processedEventId = `evt_reconcile_processed_${crypto.randomUUID()}`;
    const quarantinedEventId = `evt_reconcile_quarantined_${crypto.randomUUID()}`;
    const failed = receiveWebhook('stripe', failedEventId, JSON.stringify({ id: failedEventId }));
    markWebhookFailed(failed.record.id, 'retry required');
    const received = receiveWebhook('stripe', receivedEventId, JSON.stringify({ id: receivedEventId }));
    const processed = receiveWebhook('stripe', processedEventId, JSON.stringify({ id: processedEventId }));
    markWebhookProcessed(processed.record.id);
    const quarantined = receiveWebhook('stripe', quarantinedEventId, JSON.stringify({ id: quarantinedEventId }));
    quarantineWebhook(quarantined.record.id, 'held for review');
    const server = await buildTestServer({ includePublicRoutes: false });

    try {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/billing/webhooks/inbox?provider=stripe&status=needs_attention&limit=200',
        headers: { cookie: createSessionCookie(PermissionFlag.manageBilling | PermissionFlag.viewLogs) },
      });

      const body = response.json();
      const eventIds = body.inbox.map((record: { eventId: string }) => record.eventId);
      expect(response.statusCode).toBe(200);
      expect(eventIds).toContain(failedEventId);
      expect(eventIds).toContain(receivedEventId);
      expect(eventIds).not.toContain(processedEventId);
      expect(eventIds).not.toContain(quarantinedEventId);
      expect(body.total).toBeGreaterThanOrEqual(2);
      expect(body.inbox.find((record: { eventId: string }) => record.eventId === receivedEventId).receivedAt).toBe(received.record.receivedAt);
      expect(body.inbox[0].receivedAt).toBeGreaterThanOrEqual(body.inbox.at(-1).receivedAt);
    } finally {
      await server.close();
    }
  });

  test('keeps subscription events with incomplete price data retryable', async () => {
    const userId = `stripe-incomplete-price-${crypto.randomUUID()}`;
    const customerId = `cus_${crypto.randomUUID()}`;
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const original = subscriptionEvent(userId, customerId, subscriptionId);
    const subscription = original.data.object as Stripe.Subscription;
    const lineItem = subscription.items.data[0];
    if (!lineItem) throw new Error('subscription event has no line item');
    const incompleteSubscription = {
      ...subscription,
      items: {
        ...subscription.items,
        data: [{ ...lineItem, price: { ...(lineItem.price as Stripe.Price), product: null } as unknown as Stripe.Price }],
      },
    } as Stripe.Subscription;
    const stripeEvent = { ...original, id: `evt_${crypto.randomUUID()}`, data: { object: incompleteSubscription } } as Stripe.Event;
    const request = signedStripeWebhook(stripeEvent);
    const server = await buildTestServer({ includePublicRoutes: false });

    try {
      const delivery = await server.inject({
        method: 'POST',
        url: '/v1/stripe/webhook',
        headers: request.headers,
        payload: request.payload,
      });

      expect(delivery.statusCode).toBe(500);
      expect(getBillingEntitlements(userId).planId).toBe('viewer');
    } finally {
      await server.close();
    }
  });

  test('returns the standard error envelope for an invalid webhook signature', async () => {
    const server = await buildTestServer({ includePublicRoutes: false });

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/stripe/webhook',
        headers: { 'content-type': 'application/json', 'stripe-signature': 'invalid' },
        payload: '{}',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: 'invalid webhook signature',
        code: 'request_error',
        message: 'invalid webhook signature',
        retryable: false,
      });
    } finally {
      await server.close();
    }
  });

  test('billing managers can replay quarantined webhook deliveries', async () => {
    const server = await buildTestServer({ includePublicRoutes: false });
    const eventId = `evt_quarantined_${crypto.randomUUID()}`;
    const payload = JSON.stringify(event('invoice.created', {}));
    const received = receiveWebhook('stripe', eventId, payload);
    quarantineWebhook(received.record.id, 'held for review');
    const headers = { cookie: createSessionCookie(PermissionFlag.manageBilling | PermissionFlag.viewLogs) };

    try {
      const replay = await server.inject({
        method: 'POST',
        url: `/v1/billing/webhooks/inbox/${received.record.id}/replay`,
        headers,
      });

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ replayed: true, status: 'processed' });

      const inbox = await server.inject({
        method: 'GET',
        url: `/v1/billing/webhooks/inbox?provider=stripe&limit=200`,
        headers,
      });

      expect(inbox.statusCode).toBe(200);
      expect(inbox.json().inbox).toContainEqual(expect.objectContaining({ eventId, status: 'processed' }));
      expect(getAuditLog()).toContainEqual(expect.objectContaining({ action: 'billing.webhook.replay', target: eventId, actor: 'root' }));
    } finally {
      await server.close();
    }
  });

  test('billing managers can replay processed Stripe invoice deliveries to restore stale access', async () => {
    const userId = `stripe-invoice-replay-${crypto.randomUUID()}`;
    const customerId = `cus_${crypto.randomUUID()}`;
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const currentSubscription = subscriptionEvent(userId, customerId, subscriptionId).data.object as Stripe.Subscription;
    const stripeClient = {
      subscriptions: {
        retrieve: async (id: string) => {
          expect(id).toBe(subscriptionId);
          return currentSubscription;
        },
      },
    } as unknown as Stripe;
    const server = await buildTestServer({ includePublicRoutes: false, stripeClient: () => stripeClient });
    const invoiceEvent = event('invoice.paid', {
      id: `in_${crypto.randomUUID()}`,
      object: 'invoice',
      parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId } },
    });
    const received = receiveWebhook('stripe', invoiceEvent.id, JSON.stringify(invoiceEvent));
    markWebhookProcessed(received.record.id);
    const headers = { cookie: createSessionCookie(PermissionFlag.manageBilling | PermissionFlag.viewLogs) };

    try {
      const inbox = await server.inject({
        method: 'GET',
        url: '/v1/billing/webhooks/inbox?provider=stripe&status=processed&limit=200',
        headers,
      });
      expect(inbox.json().inbox).toContainEqual(expect.objectContaining({ eventId: invoiceEvent.id, replayableProcessed: true }));

      const replay = await server.inject({
        method: 'POST',
        url: `/v1/billing/webhooks/inbox/${received.record.id}/replay`,
        headers,
      });

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ replayed: true, status: 'processed' });
      expect(getBillingEntitlements(userId)).toMatchObject({ planId: 'priority', decrypt: true, priority: 5 });
      expect(getWebhookInboxRecord(received.record.id)?.attempts).toBe(2);
      expect(getAuditLog()).toContainEqual(expect.objectContaining({
        action: 'billing.webhook.replay',
        target: invoiceEvent.id,
        actor: 'root',
        detail: 'stripe: previously processed subscription invoice',
      }));
    } finally {
      await server.close();
    }
  });

  test('processed Stripe webhook deliveries outside subscription invoices remain deduplicated', async () => {
    const server = await buildTestServer({ includePublicRoutes: false });
    const customerEvent = event('customer.updated', { id: `cus_${crypto.randomUUID()}`, object: 'customer' });
    const received = receiveWebhook('stripe', customerEvent.id, JSON.stringify(customerEvent));
    markWebhookProcessed(received.record.id);
    const headers = { cookie: createSessionCookie(PermissionFlag.manageBilling | PermissionFlag.viewLogs) };

    try {
      const replay = await server.inject({
        method: 'POST',
        url: `/v1/billing/webhooks/inbox/${received.record.id}/replay`,
        headers,
      });

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ replayed: false, duplicate: true, status: 'processed' });
      expect(getWebhookInboxRecord(received.record.id)?.attempts).toBe(1);
      const inbox = await server.inject({
        method: 'GET',
        url: '/v1/billing/webhooks/inbox?provider=stripe&status=processed&limit=200',
        headers,
      });
      expect(inbox.json().inbox).toContainEqual(expect.objectContaining({ eventId: customerEvent.id, replayableProcessed: false }));
    } finally {
      await server.close();
    }
  });

  test('billing manager webhook quarantine actions are audited', async () => {
    const server = await buildTestServer({ includePublicRoutes: false });
    const eventId = `evt_quarantine_audit_${crypto.randomUUID()}`;
    const payload = JSON.stringify(event('invoice.created', {}));
    const received = receiveWebhook('stripe', eventId, payload);
    const headers = { cookie: createSessionCookie(PermissionFlag.manageBilling | PermissionFlag.viewLogs) };

    try {
      const quarantine = await server.inject({
        method: 'POST',
        url: `/v1/billing/webhooks/inbox/${received.record.id}/quarantine`,
        headers,
        payload: { reason: 'held for review' },
      });

      expect(quarantine.statusCode).toBe(200);
      expect(quarantine.json()).toMatchObject({ record: { eventId, status: 'quarantined', lastError: 'held for review' } });
      expect(getAuditLog()).toContainEqual(expect.objectContaining({ action: 'billing.webhook.quarantine', target: eventId, actor: 'root', detail: expect.stringContaining('held for review') }));
    } finally {
      await server.close();
    }
  });

  test('billing managers cannot quarantine processed or in-flight webhook deliveries', async () => {
    const server = await buildTestServer({ includePublicRoutes: false });
    const processedEvent = receiveWebhook('stripe', `evt_processed_${crypto.randomUUID()}`, JSON.stringify(event('invoice.created', {})));
    markWebhookProcessed(processedEvent.record.id);
    const inFlightEvent = receiveWebhook('stripe', `evt_in_flight_${crypto.randomUUID()}`, JSON.stringify(event('invoice.created', {})));
    expect(claimWebhook(inFlightEvent.record.id)).toBe(true);
    const headers = { cookie: createSessionCookie(PermissionFlag.manageBilling | PermissionFlag.viewLogs) };

    try {
      for (const record of [processedEvent.record, inFlightEvent.record]) {
        const quarantine = await server.inject({
          method: 'POST',
          url: `/v1/billing/webhooks/inbox/${record.id}/quarantine`,
          headers,
          payload: { reason: 'held for review' },
        });

        expect(quarantine.statusCode).toBe(409);
      }

      expect(getWebhookInboxRecord(processedEvent.record.id)?.status).toBe('processed');
      expect(getWebhookInboxRecord(inFlightEvent.record.id)?.status).toBe('received');
    } finally {
      releaseWebhookClaim(inFlightEvent.record.id);
      await server.close();
    }
  });

  test('exposes Stripe billing metadata without returning a client secret', async () => {
    const server = await buildTestServer({ includePublicRoutes: false });
    const login = await server.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { password: process.env.ADMIN_PASSWORD },
    });
    const cookieHeader = login.headers['set-cookie'];
    const cookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    if (typeof cookie !== 'string') throw new Error('login did not set a session cookie');

    try {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/billing',
        headers: { cookie: cookie.split(';', 1)[0] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ enabled: true, provider: 'stripe', environment: 'test', missingConfiguration: [], plans: expect.any(Array) });
      expect(response.json()).not.toHaveProperty('clientToken');

      const stripeEvent = checkoutEvent(`stripe-inbox-${crypto.randomUUID()}`, `cus_${crypto.randomUUID()}`, `sub_${crypto.randomUUID()}`, 'checkout.session.async_payment_failed');
      const payload = JSON.stringify(stripeEvent);
      const timestamp = Math.floor(Date.now() / 1000);
      const digest = createHmac('sha256', webhookSecret).update(`${timestamp}.${payload}`).digest('hex');
      const delivery = await server.inject({
        method: 'POST',
        url: '/v1/stripe/webhook',
        headers: { 'content-type': 'application/json', 'stripe-signature': `t=${timestamp},v1=${digest}` },
        payload,
      });
      expect(delivery.statusCode).toBe(200);

      const inboxResponse = await server.inject({
        method: 'GET',
        url: '/v1/billing/webhooks/inbox?provider=stripe&status=processed&limit=200',
        headers: { cookie: cookie.split(';', 1)[0] },
      });
      const inboxResult = inboxResponse.json() as { inbox: Array<Record<string, unknown>>; total: number };
      const record = inboxResult.inbox.find((item) => item.eventId === stripeEvent.id);

      expect(inboxResponse.statusCode).toBe(200);
      expect(record).toMatchObject({ provider: 'stripe', status: 'processed', rawBodyBytes: Buffer.byteLength(payload) });
      expect(record).not.toHaveProperty('rawBody');
      expect(inboxResult.total).toBeGreaterThanOrEqual(1);
    } finally {
      await server.close();
    }
  });

  test('requires an idempotency key before creating checkout', async () => {
    const server = await buildTestServer({ includePublicRoutes: false });
    const login = await server.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { password: process.env.ADMIN_PASSWORD },
    });
    const cookieHeader = login.headers['set-cookie'];
    const cookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    if (typeof cookie !== 'string') throw new Error('login did not set a session cookie');

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/billing/checkout',
        headers: { cookie: cookie.split(';', 1)[0] },
        payload: { planId: 'regular' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'Idempotency-Key must be 1-200 URL-safe characters' });
    } finally {
      await server.close();
    }
  });

  test('Stripe checkout API grants access after a mocked sandbox checkout webhook', async () => {
    const previousBillingSnapshot = exportBillingSnapshot();
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const requests: Array<{ method: string; path: string; authorization: string | null; idempotencyKey: string | null; body: string }> = [];
    const checkoutSession = {
      id: 'cs_test_billing_api_http',
      object: 'checkout.session',
      url: 'https://checkout.stripe.com/c/pay/cs_test_billing_api_http',
      livemode: false,
    };
    const currentPeriodEnd = Math.floor(Date.now() / 1000) + 2_592_000;
    const mockedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      const url = new URL(request.url);
      const body = await request.text();
      requests.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get('authorization'),
        idempotencyKey: request.headers.get('idempotency-key'),
        body,
      });

      if (request.method === 'POST' && url.pathname === '/v1/checkout/sessions') return Response.json(checkoutSession);
      if (request.method === 'GET' && url.pathname === `/v1/checkout/sessions/${checkoutSession.id}`) return Response.json(checkoutSession);
      if (request.method === 'GET' && url.pathname === '/v1/subscriptions/sub_test_billing_api_http') {
        return Response.json({
          id: 'sub_test_billing_api_http',
          object: 'subscription',
          customer: 'cus_test_billing_api_http',
          status: 'active',
          metadata: { dkrypt_user_id: 'root', plan_id: 'regular' },
          current_period_end: currentPeriodEnd,
          cancel_at: null,
          cancel_at_period_end: false,
          items: {
            object: 'list',
            data: [{
              id: 'si_test_billing_api_http',
              object: 'subscription_item',
              current_period_end: currentPeriodEnd,
              price: { id: 'price_regular_test', object: 'price', product: 'prod_regular_test' },
            }],
            has_more: false,
          },
        });
      }
      return Response.json({ error: { message: `Unexpected mocked Stripe request ${request.method} ${url.pathname}` } }, { status: 404 });
    }) as unknown as typeof fetch;
    const stripeClient = new Stripe('sk_test_billing_api_http', {
      apiVersion: '2026-08-26.dahlia' as Stripe.LatestApiVersion,
      httpClient: Stripe.createFetchHttpClient(mockedFetch),
    });
    const server = await buildTestServer({ includePublicRoutes: false, stripeClient: () => stripeClient });
    const headers = { cookie: createSessionCookie(0n), 'idempotency-key': 'sandbox-checkout-api-flow' };

    try {
      const checkout = await server.inject({
        method: 'POST',
        url: '/v1/billing/checkout',
        headers,
        payload: { planId: 'regular', provider: 'stripe' },
      });
      const replay = await server.inject({
        method: 'POST',
        url: '/v1/billing/checkout',
        headers,
        payload: { planId: 'regular', provider: 'stripe' },
      });

      expect(checkout.statusCode).toBe(200);
      expect(checkout.json() as { url: string }).toEqual({ url: checkoutSession.url });
      expect(replay.statusCode).toBe(200);
      expect(replay.json() as { url: string }).toEqual(checkout.json() as { url: string });
      expect(requests.filter((request) => request.method === 'POST' && request.path === '/v1/checkout/sessions')).toHaveLength(1);
      expect(requests.filter((request) => request.method === 'GET' && request.path === `/v1/checkout/sessions/${checkoutSession.id}`)).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        authorization: 'Bearer sk_test_billing_api_http',
        idempotencyKey: checkoutIdempotencyKey('stripe', 'root', 'sandbox-checkout-api-flow'),
      });
      const checkoutParameters = new URLSearchParams(requests[0].body);
      expect(checkoutParameters.get('mode')).toBe('subscription');
      expect(checkoutParameters.get('line_items[0][price]')).toBe('price_regular_test');
      expect(checkoutParameters.get('managed_payments[enabled]')).toBe('true');
      expect(getBillingEntitlements('root').planId).toBe('viewer');

      const stripeEvent = checkoutEvent('root', 'cus_test_billing_api_http', 'sub_test_billing_api_http');
      const webhook = signedStripeWebhook(stripeEvent);
      const delivery = await server.inject({ method: 'POST', url: '/v1/stripe/webhook', headers: webhook.headers, payload: webhook.payload });

      expect(delivery.statusCode).toBe(200);
      expect(getBillingCustomerId('root')).toBe('cus_test_billing_api_http');
      expect(getBillingEntitlements('root')).toMatchObject({ planId: 'regular', decrypt: true, priority: 0 });
      expect(requests.filter((request) => request.method === 'GET' && request.path === '/v1/subscriptions/sub_test_billing_api_http')).toHaveLength(1);
    } finally {
      await server.close();
      replaceBillingSnapshot(previousBillingSnapshot);
    }
  });

  test('checkout pause is manager-only and blocks new provider checkouts', async () => {
    const previousBillingSnapshot = exportBillingSnapshot();
    const createdAt = new Date().toISOString();
    replaceBillingSnapshot({
      ...previousBillingSnapshot,
      customers: [],
      subscriptions: [],
      cryptoCheckouts: [{
        provider: 'nowpayments',
        checkoutId: 'existing-checkout-before-pause',
        userId: 'root',
        idempotencyKey: checkoutIdempotencyKey('crypto', 'root', 'paused-crypto-checkout'),
        planId: 'regular',
        amount: 5,
        currency: 'EUR',
        status: 'pending',
        checkoutUrl: 'https://nowpayments.example/invoice/already-created',
        asset: 'USDC',
        createdAt,
        updatedAt: createdAt,
      }],
    });
    const server = await buildTestServer({
      includePublicRoutes: false,
      stripeWebhookHealth: async () => ({
        state: 'not_configured',
        endpointUrl: 'https://dkrypt.example/v1/stripe/webhook',
        requiredEvents: [...STRIPE_WEBHOOK_EVENTS],
        missingEvents: [],
      }),
    });
    const managerCookie = createSessionCookie(PermissionFlag.manageBilling);
    const viewerCookie = createSessionCookie(0n);
    const managerHeaders = { cookie: managerCookie };

    try {
      const anonymous = await server.inject({ method: 'PUT', url: '/v1/billing/checkouts', payload: { paused: true } });
      const viewer = await server.inject({ method: 'PUT', url: '/v1/billing/checkouts', headers: { cookie: viewerCookie }, payload: { paused: true } });
      const resumed = await server.inject({ method: 'PUT', url: '/v1/billing/checkouts', headers: managerHeaders, payload: { paused: false } });
      const initialStatus = await server.inject({ method: 'GET', url: '/v1/billing/provider-status', headers: managerHeaders });
      const paused = await server.inject({ method: 'PUT', url: '/v1/billing/checkouts', headers: managerHeaders, payload: { paused: true } });
      const pausedStatus = await server.inject({ method: 'GET', url: '/v1/billing/provider-status', headers: managerHeaders });
      const stripeCheckout = await server.inject({
        method: 'POST',
        url: '/v1/billing/checkout',
        headers: { ...managerHeaders, 'idempotency-key': 'paused-stripe-checkout' },
        payload: { planId: 'regular', provider: 'stripe' },
      });
      const cryptoCheckout = await server.inject({
        method: 'POST',
        url: '/v1/billing/checkout',
        headers: { ...managerHeaders, 'idempotency-key': 'paused-crypto-checkout' },
        payload: { planId: 'regular', provider: 'crypto', cryptoAsset: 'USDC' },
      });
      const newCryptoCheckout = await server.inject({
        method: 'POST',
        url: '/v1/billing/checkout',
        headers: { ...managerHeaders, 'idempotency-key': 'paused-new-crypto-checkout' },
        payload: { planId: 'regular', provider: 'crypto', cryptoAsset: 'USDC' },
      });

      expect(anonymous.statusCode).toBe(401);
      expect(viewer.statusCode).toBe(403);
      expect(resumed.statusCode).toBe(200);
      expect(initialStatus.json()).toMatchObject({ checkoutsPaused: false });
      expect(paused.json()).toMatchObject({ paused: true });
      expect(pausedStatus.json()).toMatchObject({ checkoutsPaused: true });
      expect(stripeCheckout.statusCode).toBe(503);
      expect(stripeCheckout.json()).toMatchObject({ code: 'billing_checkouts_paused', retryable: true });
      expect(cryptoCheckout.statusCode).toBe(200);
      expect(cryptoCheckout.json()).toMatchObject({
        url: 'https://nowpayments.example/invoice/already-created',
        provider: 'nowpayments',
        checkoutId: 'existing-checkout-before-pause',
      });
      expect(newCryptoCheckout.statusCode).toBe(503);
      expect(newCryptoCheckout.json()).toMatchObject({ code: 'billing_checkouts_paused', retryable: true });
    } finally {
      await server.inject({ method: 'PUT', url: '/v1/billing/checkouts', headers: managerHeaders, payload: { paused: false } });
      await server.close();
      replaceBillingSnapshot(previousBillingSnapshot);
    }
  });

  test('checkout pause replays existing Stripe idempotency keys but rejects new checkouts', async () => {
    const previousBillingSnapshot = exportBillingSnapshot();
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const provider = createStripeCheckoutDouble();
    const server = Fastify();
    await server.register(billingRoutes, { stripeClient: () => provider.client });
    const managerCookie = createSessionCookie(PermissionFlag.manageBilling);
    const headers = { cookie: managerCookie, 'idempotency-key': 'stripe-pause-idempotency' };

    try {
      const created = await server.inject({ method: 'POST', url: '/v1/billing/checkout', headers, payload: { planId: 'regular', provider: 'stripe' } });
      const paused = await server.inject({ method: 'PUT', url: '/v1/billing/checkouts', headers: { cookie: managerCookie }, payload: { paused: true } });
      const retry = await server.inject({ method: 'POST', url: '/v1/billing/checkout', headers, payload: { planId: 'regular', provider: 'stripe' } });
      const changedRequest = await server.inject({ method: 'POST', url: '/v1/billing/checkout', headers, payload: { planId: 'priority', provider: 'stripe' } });
      const newCheckout = await server.inject({
        method: 'POST',
        url: '/v1/billing/checkout',
        headers: { cookie: managerCookie, 'idempotency-key': 'stripe-pause-new-idempotency' },
        payload: { planId: 'regular', provider: 'stripe' },
      });

      expect(created.statusCode).toBe(200);
      expect(paused.statusCode).toBe(200);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual(created.json());
      expect(changedRequest.statusCode).toBe(409);
      expect(changedRequest.json()).toMatchObject({ code: 'idempotency_conflict' });
      expect(newCheckout.statusCode).toBe(503);
      expect(newCheckout.json()).toMatchObject({ code: 'billing_checkouts_paused' });
      expect(provider.calls).toHaveLength(1);
      expect(provider.retrievals).toEqual(['cs_1']);
      expect(provider.sessions.size).toBe(1);
    } finally {
      await server.inject({ method: 'PUT', url: '/v1/billing/checkouts', headers: { cookie: managerCookie }, payload: { paused: false } });
      await server.close();
      replaceBillingSnapshot(previousBillingSnapshot);
    }
  });

  test('manager provider status reports missing live Stripe webhook events', async () => {
    const missingEvents = ['invoice.paid', 'invoice.payment_failed', 'charge.refunded'];
    const endpointUrl = 'https://dkrypt.example/v1/stripe/webhook';
    const server = Fastify();
    const managerCookie = createSessionCookie(PermissionFlag.manageBilling);
    let healthChecks = 0;
    const forceRefreshValues: boolean[] = [];
    await server.register(billingRoutes, {
      stripeWebhookHealth: async (forceRefresh = false) => {
        healthChecks += 1;
        forceRefreshValues.push(forceRefresh);
        return {
          state: 'missing_events',
          endpointUrl,
          requiredEvents: [...STRIPE_WEBHOOK_EVENTS],
          missingEvents,
          checkedAt: new Date().toISOString(),
        };
      },
    });

    try {
      const anonymous = await server.inject({ method: 'GET', url: '/v1/billing/provider-status' });
      const viewer = await server.inject({ method: 'GET', url: '/v1/billing/provider-status', headers: { cookie: createSessionCookie(0n) } });
      const status = await server.inject({ method: 'GET', url: '/v1/billing/provider-status', headers: { cookie: managerCookie } });
      const refreshed = await server.inject({ method: 'GET', url: '/v1/billing/provider-status?refresh=true', headers: { cookie: managerCookie } });

      expect(anonymous.statusCode).toBe(401);
      expect(viewer.statusCode).toBe(403);
      expect(status.statusCode).toBe(200);
      expect(refreshed.statusCode).toBe(200);
      expect(status.json().stripe.webhook).toMatchObject({
        state: 'missing_events',
        endpointUrl,
        missingEvents,
      });
      expect(status.json().stripe.webhook.checkedAt).toEqual(expect.any(String));
      expect(healthChecks).toBe(2);
      expect(forceRefreshValues).toEqual([false, true]);
    } finally {
      await server.close();
    }
  });

  test('only billing managers can synchronize events on the existing Stripe webhook endpoint', async () => {
    const previousSecretKey = config.stripeSecretKey;
    const previousPublicBaseUrl = config.publicBaseUrl;
    config.stripeSecretKey = 'sk_test_webhook_sync';
    config.publicBaseUrl = 'https://dkrypt.example';
    clearStripeWebhookHealthCache();
    const endpoint = {
      id: `we_${crypto.randomUUID()}`,
      url: 'https://dkrypt.example/v1/stripe/webhook',
      status: 'enabled',
      enabled_events: ['checkout.session.completed'],
      secret: 'whsec_preserved',
    };
    const updates: Array<{ id: string; parameters: Record<string, unknown> }> = [];
    const stripeClient = {
      webhookEndpoints: {
        list: async () => ({ data: [endpoint], has_more: false }),
        update: async (id: string, parameters: Record<string, unknown>) => {
          updates.push({ id, parameters });
          Object.assign(endpoint, parameters);
          return endpoint;
        },
      },
    } as unknown as Stripe;
    const server = await buildTestServer({ includePublicRoutes: false, stripeClient: () => stripeClient });

    try {
      const anonymous = await server.inject({ method: 'POST', url: '/v1/billing/stripe-webhook/sync' });
      const viewer = await server.inject({ method: 'POST', url: '/v1/billing/stripe-webhook/sync', headers: { cookie: createSessionCookie(0n) } });
      const manager = await server.inject({ method: 'POST', url: '/v1/billing/stripe-webhook/sync', headers: { cookie: createSessionCookie(PermissionFlag.manageBilling) } });

      expect(anonymous.statusCode).toBe(401);
      expect(viewer.statusCode).toBe(403);
      expect(manager.statusCode).toBe(200);
      expect(manager.json().webhook).toMatchObject({ state: 'ready', endpointUrl: endpoint.url, missingEvents: [] });
      expect(updates).toEqual([{ id: endpoint.id, parameters: { enabled_events: [...STRIPE_WEBHOOK_EVENTS] } }]);
      expect(endpoint.secret).toBe('whsec_preserved');
      expect(getAuditLog()).toContainEqual(expect.objectContaining({
        action: 'billing.webhook.sync',
        target: '[redacted-url]',
        actor: 'root',
      }));
    } finally {
      config.stripeSecretKey = previousSecretKey;
      config.publicBaseUrl = previousPublicBaseUrl;
      clearStripeWebhookHealthCache();
      await server.close();
    }
  });

  test('Stripe webhook synchronization does not create a missing endpoint', async () => {
    const previousSecretKey = config.stripeSecretKey;
    config.stripeSecretKey = 'sk_test_webhook_sync';
    clearStripeWebhookHealthCache();
    let updateCalls = 0;
    let createCalls = 0;
    const stripeClient = {
      webhookEndpoints: {
        list: async () => ({ data: [], has_more: false }),
        update: async () => { updateCalls += 1; },
        create: async () => { createCalls += 1; },
      },
    } as unknown as Stripe;
    const server = await buildTestServer({ includePublicRoutes: false, stripeClient: () => stripeClient });

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/billing/stripe-webhook/sync',
        headers: { cookie: createSessionCookie(PermissionFlag.manageBilling) },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'stripe_webhook_endpoint_missing', retryable: false });
      expect(updateCalls).toBe(0);
      expect(createCalls).toBe(0);
      expect(getAuditLog()).toContainEqual(expect.objectContaining({
        action: 'billing.webhook.sync',
        detail: 'no enabled matching endpoint found; no changes made',
        actor: 'root',
      }));
    } finally {
      config.stripeSecretKey = previousSecretKey;
      clearStripeWebhookHealthCache();
      await server.close();
    }
  });

  test('issues, redeems, hides, and revokes a prepaid access code through session routes', async () => {
    const previousBillingSnapshot = exportBillingSnapshot();
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const server = await buildTestServer({ includePublicRoutes: false });
    const managerCookie = createSessionCookie(PermissionFlag.manageBilling);
    const memberCookie = createSessionCookie(0n);

    try {
      const denied = await server.inject({ method: 'GET', url: '/v1/billing/access-codes', headers: { cookie: memberCookie } });
      const created = await server.inject({
        method: 'POST',
        url: '/v1/billing/access-codes',
        headers: { cookie: managerCookie },
        payload: { planId: 'standard', durationDays: 30, redeemWithinDays: 7 },
      });
      const issued = created.json() as { code: string; accessCode: { id: string } };
      const redeemed = await server.inject({
        method: 'POST',
        url: '/v1/billing/access-codes/redeem',
        headers: { cookie: memberCookie },
        payload: { code: issued.code },
      });
      const repeated = await server.inject({
        method: 'POST',
        url: '/v1/billing/access-codes/redeem',
        headers: { cookie: memberCookie },
        payload: { code: issued.code },
      });
      const checkoutBlocked = await server.inject({
        method: 'POST',
        url: '/v1/billing/checkout',
        headers: { cookie: memberCookie },
        payload: { planId: 'access' },
      });
      const listed = await server.inject({ method: 'GET', url: '/v1/billing/access-codes', headers: { cookie: managerCookie } });
      const record = (listed.json() as { accessCodes: Array<Record<string, unknown>> }).accessCodes.find((accessCode) => accessCode.id === issued.accessCode.id);
      const entitlementAfterRedeem = getBillingEntitlements('root');
      const revoked = await server.inject({ method: 'POST', url: `/v1/billing/access-codes/${issued.accessCode.id}/revoke`, headers: { cookie: managerCookie } });

      expect(denied.statusCode).toBe(403);
      expect(created.statusCode).toBe(201);
      expect(issued.code).toMatch(/^DKR-/);
      expect(redeemed.statusCode).toBe(200);
      expect(entitlementAfterRedeem).toMatchObject({ planId: 'standard', provider: 'gift', api: false });
      expect(repeated.statusCode).toBe(409);
      expect(checkoutBlocked.statusCode).toBe(409);
      expect(record).toMatchObject({ status: 'redeemed', redeemedBy: 'root' });
      expect(record).not.toHaveProperty('codeHash');
      expect(record).not.toHaveProperty('code');
      expect(revoked.statusCode).toBe(200);
      expect(getBillingEntitlements('root').planId).toBe('viewer');
    } finally {
      replaceBillingSnapshot(previousBillingSnapshot);
      await server.close();
    }
  });

  test('requires an idempotency key before cancellation', async () => {
    const server = await buildTestServer({ includePublicRoutes: false });
    const login = await server.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { password: process.env.ADMIN_PASSWORD },
    });
    const cookieHeader = login.headers['set-cookie'];
    const cookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    if (typeof cookie !== 'string') throw new Error('login did not set a session cookie');

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/billing/cancel',
        headers: { cookie: cookie.split(';', 1)[0] },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'Idempotency-Key must be 1-200 URL-safe characters' });
    } finally {
      await server.close();
    }
  });
});
