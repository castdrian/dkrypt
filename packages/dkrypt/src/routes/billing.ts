import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  BillingAccessCodeCreateRoute,
  BillingAccessCodeRedeemRoute,
  BillingAccessCodeRevokeRoute,
  BillingCancelRoute,
  BillingCheckoutControlRoute,
  BillingCheckoutRoute,
  BillingProviderStatusRoute,
  BillingRevenueRoute,
  BillingSubscriptionRoute,
  BillingSubscriptionsRoute,
  BillingWebhookInboxParamsRoute,
  BillingWebhookInboxRoute,
  BillingWebhookQuarantineRoute,
} from '#billingContracts.js';
import { getRouteContract } from '#contracts.js';
import {
  acquireBillingCheckoutLock,
  createBillingAccessCode,
  getBillingCustomerId,
  getBillingSubscriptionById,
  getBillingEntitlements,
  getBillingSubscription,
  getBillingUserId,
  listBillingAccessCodes,
  getPlan,
  getPurchasablePlan,
  isBillingSubscriptionActive,
  findCryptoCheckout,
  findStripeCheckoutIdempotencyAttempt,
  hasActiveBillingSubscription,
  hasLegacyBillingRecord,
  linkBillingCustomer,
  listBillingSubscriptions,
  listCryptoCheckouts,
  listPlans,
  planForPrice,
  upsertBillingCustomer,
  upsertBillingSubscription,
  releaseBillingCheckoutLock,
  redeemBillingAccessCode,
  revokeBillingAccessCode,
  recordStripeCheckoutIdempotencyAttempt,
} from '#billing.js';
import { config, stripeEnabled, stripeEnvironment, stripeMissingConfiguration, stripeNewCatalogMissingConfiguration } from '#config.js';
import { createBillingRevenueReader, getBillingRevenueSummary, type BillingRevenueReader } from '#billingRevenue.js';
import {
  cancelCryptoSubscription,
  createCryptoCheckout,
  CryptoBillingError,
  listManagerBillingSubscriptions,
  processNowPaymentsEvent,
  verifyNowPaymentsEvent,
} from '#cryptoBilling.js';
import { getNowPaymentsMinimumFiat, getNowPaymentsProviderStatus } from '#nowpayments.js';
import { getDecryptQuotaJournal, getDecryptQuotaUsage } from '#jobs/repository.js';
import { getAuthProfile, resolveAuthUserId } from '#identity.js';
import { log } from '#logger.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import { PermissionFlag } from '#permissions.js';
import { areNewBillingCheckoutsPaused, recordAudit, setNewBillingCheckoutsPaused } from '#store/state.js';
import { constructStripeWebhookEvent, stripeRequest } from '#stripe.js';
import { getStripeWebhookHealth as inspectStripeWebhookHealth, StripeWebhookEndpointNotFoundError, syncStripeWebhookEvents, type StripeWebhookHealth } from '#stripeWebhookHealth.js';
import { claimWebhook, countWebhookInbox, getWebhookInboxRecord, listWebhookInbox, markWebhookFailed, markWebhookProcessed, quarantineWebhook, receiveWebhook, releaseWebhookClaim } from '#webhookInbox.js';
import { withCorrelationSpan } from '#correlation.js';
import { decodeCursor, nextCursor, paginateCursor } from '#util/cursor.js';
import { runKeyedSerial } from '#util/keyedSerial.js';

function metadataUserId(metadata: unknown): string | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const value = (metadata as Record<string, unknown>).dkrypt_user_id;
  return typeof value === 'string' && value.length <= 160 ? resolveAuthUserId(value) : undefined;
}

function sendBillingError(request: FastifyRequest, reply: FastifyReply, statusCode: number, message: string, code?: string) {
  return reply.code(statusCode).send({
    error: message,
    code: code ?? (statusCode >= 500 ? 'internal_error' : 'request_error'),
    message,
    requestId: request.id,
    retryable: statusCode >= 500 || statusCode === 429 || statusCode === 503,
  });
}

function requireStripeBilling(request: FastifyRequest, reply: FastifyReply): boolean {
  if (stripeEnabled) return true;
  sendBillingError(request, reply, 503, 'Stripe billing is not configured');
  return false;
}

function stripeObjectId(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

function eventDate(event: Stripe.Event): string {
  return new Date(event.created * 1000).toISOString();
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | undefined {
  const parentSubscription = invoice.parent?.type === 'subscription_details'
    ? invoice.parent.subscription_details?.subscription
    : undefined;
  const legacySubscription = (invoice as Stripe.Invoice & { subscription?: string | Stripe.Subscription | null }).subscription;
  return stripeObjectId(parentSubscription) ?? stripeObjectId(legacySubscription);
}

function unixDate(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000).toISOString() : undefined;
}

function processCustomer(event: Stripe.Event): void {
  const customer = event.data.object as Stripe.Customer;
  if (!customer?.id) return;
  upsertBillingCustomer({
    provider: 'stripe',
    customerId: customer.id,
    email: customer.email ?? '',
    userId: metadataUserId(customer.metadata),
    updatedAt: eventDate(event),
  });
}

function processCheckoutSession(event: Stripe.Event): void {
  const session = event.data.object as Stripe.Checkout.Session;
  const customerId = stripeObjectId(session.customer);
  const userId = metadataUserId(session.metadata);
  if (customerId && userId) linkBillingCustomer(customerId, userId);
}

async function stripeOperation<T>(stripeClient: Stripe | undefined, operation: (client: Stripe) => Promise<T>): Promise<T> {
  return stripeClient ? operation(stripeClient) : stripeRequest(operation);
}

async function subscriptionIdForRefundedCharge(charge: Stripe.Charge, stripeClient?: Stripe): Promise<string | undefined> {
  const paymentIntentId = stripeObjectId(charge.payment_intent);
  if (!paymentIntentId) return undefined;

  const invoicePayments = await stripeOperation(stripeClient, (client) => client.invoicePayments.list({
    limit: 100,
    payment: { type: 'payment_intent', payment_intent: paymentIntentId },
  }));
  const invoiceIds = new Set(invoicePayments.data
    .map((payment) => stripeObjectId(payment.invoice))
    .filter((invoiceId): invoiceId is string => !!invoiceId));
  if (invoiceIds.size === 0) return undefined;
  const subscriptionIds = new Set<string>();

  for (const invoiceId of invoiceIds) {
    const invoice = await stripeOperation(stripeClient, (client) => client.invoices.retrieve(invoiceId));
    const subscriptionId = invoiceSubscriptionId(invoice);
    if (subscriptionId) subscriptionIds.add(subscriptionId);
  }

  if (subscriptionIds.size > 1) throw new Error(`fully refunded Stripe payment ${charge.id} maps to multiple subscriptions`);
  return subscriptionIds.values().next().value;
}

async function processStripeRefund(event: Stripe.Event, stripeClient?: Stripe): Promise<void> {
  const charge = event.data.object as Stripe.Charge;
  if (!charge?.id) return;
  const customerId = stripeObjectId(charge.customer);
  const actor = customerId ? getBillingUserId(customerId) ?? 'stripe' : 'stripe';
  const amount = Number.isFinite(charge.amount) ? charge.amount : undefined;
  const refundedAmount = Number.isFinite(charge.amount_refunded) ? charge.amount_refunded : undefined;
  const currency = charge.currency?.toUpperCase();
  const refundSummary = amount !== undefined && refundedAmount !== undefined && currency
    ? `${refundedAmount}/${amount} ${currency} minor units`
    : 'amount unavailable';
  recordAudit(actor, 'billing.refund', charge.id, `${refundSummary}; Stripe event ${event.id}`);

  if (!charge.refunded) return;
  const subscriptionId = await subscriptionIdForRefundedCharge(charge, stripeClient);
  if (!subscriptionId) {
    const customerHasActiveSubscription = customerId && listBillingSubscriptions().some((subscription) =>
      subscription.provider === 'stripe' &&
      subscription.customerId === customerId &&
      isBillingSubscriptionActive(subscription),
    );
    if (customerHasActiveSubscription) {
      throw new Error(`fully refunded Stripe payment ${charge.id} could not be resolved to a subscription`);
    }
    return;
  }

  await runKeyedSerial(`stripe:${subscriptionId}`, async () => {
    let billingSubscription = getBillingSubscriptionById(subscriptionId);
    if (!billingSubscription) {
      const current = await stripeOperation(stripeClient, (client) => client.subscriptions.retrieve(subscriptionId));
      persistStripeSubscription(current, new Date().toISOString(), customerId ? getBillingUserId(customerId) : undefined);
      billingSubscription = getBillingSubscriptionById(subscriptionId);
    }
    if (!billingSubscription || billingSubscription.provider !== 'stripe') {
      throw new Error(`refunded Stripe payment ${charge.id} maps to an unknown dkrypt subscription`);
    }
    if (customerId && billingSubscription.customerId !== customerId) {
      throw new Error(`refunded Stripe payment ${charge.id} maps to a different customer`);
    }

    const processedAt = new Date().toISOString();
    if (billingSubscription.status !== 'revoked' || billingSubscription.failureReason !== 'payment refunded') {
      upsertBillingSubscription({
        ...billingSubscription,
        status: 'revoked',
        nextBilledAt: undefined,
        scheduledChangeAction: undefined,
        scheduledChangeAt: undefined,
        failureReason: 'payment refunded',
        occurredAt: processedAt,
        updatedAt: processedAt,
      });
    }

    const current = await stripeOperation(stripeClient, (client) => client.subscriptions.retrieve(subscriptionId));
    const canceled = current.status === 'canceled' || current.status === 'incomplete_expired'
      ? current
      : await stripeOperation(stripeClient, (client) => client.subscriptions.cancel(subscriptionId));
    persistStripeSubscription(canceled, new Date().toISOString(), billingSubscription.userId);
    recordAudit(actor, 'billing.refund', subscriptionId, `full refund of ${charge.id} revoked access and canceled Stripe billing from event ${event.id}`);
  });
}

async function reconcileSuccessfulCheckoutSession(event: Stripe.Event, stripeClient?: Stripe): Promise<void> {
  processCheckoutSession(event);
  const session = event.data.object as Stripe.Checkout.Session;
  const subscriptionId = stripeObjectId(session.subscription);
  if (!subscriptionId) return;
  const userId = metadataUserId(session.metadata);
  await runKeyedSerial(`stripe:${subscriptionId}`, async () => {
    await reconcileStripeSubscription(subscriptionId, stripeClient, eventDate(event), userId);
  });
}

function persistStripeSubscription(subscription: Stripe.Subscription, occurredAt: string, fallbackUserId?: string, updatedAt = occurredAt): void {
  const item = subscription.items?.data?.[0];
  const customerId = stripeObjectId(subscription.customer);
  if (!item) throw new Error(`Stripe subscription ${subscription.id} has no billable items`);
  if (!customerId) throw new Error(`Stripe subscription ${subscription.id} has no customer`);

  const price = typeof item.price === 'string' ? undefined : item.price;
  const priceId = typeof item.price === 'string' ? item.price : price?.id;
  if (!priceId) throw new Error(`Stripe subscription ${subscription.id} has no price ID`);
  const productId = stripeObjectId(price?.product);
  if (!productId) throw new Error(`Stripe subscription ${subscription.id} price ${priceId} has no product ID`);
  const planId = planForPrice(priceId);
  if (!planId) throw new Error(`Stripe subscription ${subscription.id} uses an unconfigured price ${priceId}`);

  const scheduledChangeAction = subscription.cancel_at_period_end || subscription.cancel_at ? 'cancel' : undefined;
  const scheduledChangeAt = subscription.cancel_at
    ? unixDate(subscription.cancel_at)
    : subscription.cancel_at_period_end
      ? unixDate(item.current_period_end)
      : undefined;
  const existing = getBillingSubscriptionById(subscription.id);
  const refundRevoked = existing?.provider === 'stripe' && existing.status === 'revoked' && existing.failureReason === 'payment refunded';

  upsertBillingSubscription({
    provider: 'stripe',
    subscriptionId: subscription.id,
    customerId,
    userId: metadataUserId(subscription.metadata) ?? fallbackUserId ?? getBillingUserId(customerId),
    status: refundRevoked ? 'revoked' : subscription.status,
    planId,
    priceId,
    productId,
    subscriptionItemId: item.id,
    nextBilledAt: refundRevoked || scheduledChangeAction ? undefined : unixDate(item.current_period_end),
    scheduledChangeAction,
    scheduledChangeAt,
    failureReason: refundRevoked ? 'payment refunded' : undefined,
    occurredAt,
    updatedAt,
  });
}

async function reconcileStripeSubscription(subscriptionId: string, stripeClient?: Stripe, eventOccurredAt?: string, fallbackUserId?: string): Promise<void> {
  const current = stripeClient
    ? await stripeClient.subscriptions.retrieve(subscriptionId)
    : await stripeRequest((client) => client.subscriptions.retrieve(subscriptionId));
  const latest = getBillingSubscriptionById(subscriptionId);
  if (eventOccurredAt && latest && Date.parse(latest.occurredAt) > Date.parse(eventOccurredAt)) return;
  const updatedAt = new Date().toISOString();
  persistStripeSubscription(current, eventOccurredAt ?? updatedAt, fallbackUserId ?? latest?.userId, updatedAt);
}

async function processSubscription(event: Stripe.Event, stripeClient?: Stripe): Promise<void> {
  const incoming = event.data.object as Stripe.Subscription;
  await runKeyedSerial(`stripe:${incoming.id}`, async () => {
    const occurredAt = eventDate(event);
    const existing = getBillingSubscriptionById(incoming.id);
    if (existing && Date.parse(existing.occurredAt) >= Date.parse(occurredAt)) {
      await reconcileStripeSubscription(incoming.id, stripeClient, occurredAt, existing.userId);
      return;
    }
    persistStripeSubscription(incoming, occurredAt);
  });
}

async function processInvoice(event: Stripe.Event, stripeClient?: Stripe): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) return;

  await runKeyedSerial(`stripe:${subscriptionId}`, async () => {
    await reconcileStripeSubscription(subscriptionId, stripeClient, eventDate(event));
  });
}

export async function processStripeEvent(event: Stripe.Event, stripeClient?: Stripe): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      await reconcileSuccessfulCheckoutSession(event, stripeClient);
      return;
    case 'checkout.session.async_payment_failed':
      processCheckoutSession(event);
      return;
    case 'customer.created':
    case 'customer.updated':
      processCustomer(event);
      return;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await processSubscription(event, stripeClient);
      return;
    case 'charge.refunded':
      await processStripeRefund(event, stripeClient);
      return;
    case 'invoice.paid':
    case 'invoice.payment_failed':
      await processInvoice(event, stripeClient);
      return;
  }
}

type WebhookDeliveryResult =
  | { statusCode: 200; payload: Record<string, unknown> }
  | { statusCode: 500 };

function webhookSignatureHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function webhookRawBody(body: unknown): Buffer | undefined {
  const rawBody = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body) : undefined;
  return rawBody?.length ? rawBody : undefined;
}

async function processWebhookDelivery(
  provider: 'stripe' | 'nowpayments',
  eventId: string,
  rawBody: Buffer,
  processEvent: () => Promise<void>,
  onFailure: (error: unknown) => void,
): Promise<WebhookDeliveryResult> {
  return withCorrelationSpan('billing.webhook.delivery', { 'webhook.provider': provider }, async (span) => {
    const inbox = receiveWebhook(provider, eventId, rawBody);
    span.setAttributes({ 'webhook.inbox_id': inbox.record.id, 'webhook.duplicate': inbox.duplicate });
    if (inbox.duplicate && inbox.record.status === 'processed') {
      span.setAttributes({ 'webhook.status': 'duplicate_processed' });
      return { statusCode: 200, payload: { received: true, duplicate: true } };
    }
    if (inbox.duplicate && inbox.record.status === 'quarantined') {
      span.setAttributes({ 'webhook.status': 'duplicate_quarantined' });
      return { statusCode: 200, payload: { received: true, duplicate: true, quarantined: true } };
    }
    if (!claimWebhook(inbox.record.id)) {
      span.setAttributes({ 'webhook.status': 'in_progress' });
      return { statusCode: 200, payload: { received: true, duplicate: true, inProgress: true } };
    }
    try {
      await processEvent();
      markWebhookProcessed(inbox.record.id);
      span.setAttributes({ 'webhook.status': 'processed' });
      return { statusCode: 200, payload: { received: true } };
    } catch (error) {
      markWebhookFailed(inbox.record.id, String(error));
      span.setAttributes({ 'webhook.status': 'failed' });
      span.end(error);
      onFailure(error);
      return { statusCode: 500 };
    } finally {
      releaseWebhookClaim(inbox.record.id);
    }
  });
}

function isProcessedStripeInvoiceDelivery(provider: 'stripe' | 'nowpayments', rawBody: string): boolean {
  if (provider !== 'stripe') return false;
  try {
    const event = JSON.parse(rawBody) as Stripe.Event;
    if (event.type !== 'invoice.paid' && event.type !== 'invoice.payment_failed') return false;
    const invoice = event.data?.object as Stripe.Invoice | undefined;
    return !!invoice && !!invoiceSubscriptionId(invoice);
  } catch {
    return false;
  }
}

function sendWebhookDeliveryResult(request: FastifyRequest, reply: FastifyReply, result: WebhookDeliveryResult) {
  if (result.statusCode === 500) return sendBillingError(request, reply, 500, 'webhook processing failed');
  return reply.code(result.statusCode).send(result.payload);
}

export const billingWebhookRoutes: FastifyPluginAsyncTypebox<{ stripeClient?: () => Stripe }> = async (server, options) => {
  server.post('/v1/stripe/webhook', { schema: getRouteContract('POST', '/v1/stripe/webhook') }, async (request, reply) => {
    const signature = webhookSignatureHeader(request.headers['stripe-signature']);
    const rawBody = webhookRawBody(request.body);
    if (!signature || !rawBody) return sendBillingError(request, reply, 400, 'missing signature or body');
    if (!config.stripeSecretKey || !config.stripeWebhookSecret) return sendBillingError(request, reply, 503, 'Stripe webhook is not configured');

    let event: Stripe.Event;
    try {
      event = await constructStripeWebhookEvent(rawBody, signature);
    } catch (error) {
      log.warn('Stripe webhook signature verification failed', { error: String(error) });
      return sendBillingError(request, reply, 400, 'invalid webhook signature');
    }

    const result = await processWebhookDelivery('stripe', event.id, rawBody, () => processStripeEvent(event, options.stripeClient?.()), (error) => {
      log.error('Stripe webhook failed', { eventType: event.type, error: String(error) });
    });
    return sendWebhookDeliveryResult(request, reply, result);
  });

  server.post('/v1/nowpayments/webhook', { schema: getRouteContract('POST', '/v1/nowpayments/webhook') }, async (request, reply) => {
    const signature = webhookSignatureHeader(request.headers['x-nowpayments-sig']);
    const rawBody = webhookRawBody(request.body);
    if (!signature || !rawBody) return sendBillingError(request, reply, 400, 'missing signature or body');
    if (!config.nowpaymentsIpnSecret && !config.nowpaymentsIpnSecretPrevious) return sendBillingError(request, reply, 503, 'NOWPayments IPN is not configured');
    if (!verifyNowPaymentsEvent(rawBody, signature)) {
      log.warn('NOWPayments IPN signature verification failed');
      return sendBillingError(request, reply, 400, 'invalid webhook signature');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return sendBillingError(request, reply, 400, 'invalid webhook body');
    }
    if (typeof payload !== 'object' || payload === null || typeof (payload as { payment_status?: unknown }).payment_status !== 'string') {
      return sendBillingError(request, reply, 400, 'invalid IPN payload');
    }
    const payment = payload as Parameters<typeof processNowPaymentsEvent>[0]['payment'];
    const paymentId = payment.payment_id === undefined ? payment.order_id ?? 'unknown' : String(payment.payment_id);
    const eventId = `nowpayments:${paymentId}:${payment.payment_status}:${payment.updated_at ?? payment.created_at ?? 'unknown'}`;
    const result = await processWebhookDelivery('nowpayments', eventId, rawBody, () => processNowPaymentsEvent({ id: eventId, payment }), (error) => {
      log.error('NOWPayments IPN failed', { error: String(error) });
    });
    return sendWebhookDeliveryResult(request, reply, result);
  });
};

export const billingRoutes: FastifyPluginAsyncTypebox<{
  stripeClient?: () => Stripe;
  stripeWebhookHealth?: (forceRefresh: boolean) => Promise<StripeWebhookHealth>;
  billingRevenue?: BillingRevenueReader;
}> = async (server, options) => {
  const callStripe = <T>(request: (client: Stripe) => Promise<T>): Promise<T> => options.stripeClient
    ? request(options.stripeClient())
    : stripeRequest(request);
  server.get('/v1/billing/usage.csv', { schema: { hide: true }, preHandler: fastifyRequireSession }, (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    const rows = getDecryptQuotaJournal(userId);
    const headers = ['job_id', 'admitted_at', 'reservation_state', 'bundle_id', 'version', 'source', 'job_status', 'execution_path'];
    const csv = [headers, ...rows.map((row) => [row.jobId, new Date(row.admittedAt).toISOString(), row.state, row.bundleId ?? '', row.versionLabel ?? '', row.source ?? '', row.status ?? 'pruned', row.executionPath ?? ''])]
      .map((values) => values.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','))
      .join('\r\n');
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="dkrypt-usage.csv"').send(`${csv}\r\n`);
  });

  server.get('/v1/billing/invoices', { schema: { hide: true }, preHandler: fastifyRequireSession }, async (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    const invoices: Array<{ id: string; provider: 'stripe' | 'nowpayments'; planId: string; status: string; createdAt: string; amountMinor: number; currency: string; invoiceUrl?: string; paymentId?: string }> = [];
    const warnings: string[] = [];
    const customerId = getBillingCustomerId(userId);
    if (stripeEnabled && customerId) {
      try {
        const result = await callStripe((client) => client.invoices.list({ customer: customerId, limit: 100 }));
        for (const invoice of result.data) {
          const subscriptionId = invoiceSubscriptionId(invoice);
          const subscription = subscriptionId ? getBillingSubscription(userId, subscriptionId) : undefined;
          invoices.push({
            id: invoice.id,
            provider: 'stripe',
            planId: subscription?.planId ?? 'unknown',
            status: invoice.status ?? 'unknown',
            createdAt: new Date(invoice.created * 1000).toISOString(),
            amountMinor: invoice.amount_paid || invoice.total,
            currency: invoice.currency.toUpperCase(),
            invoiceUrl: invoice.invoice_pdf ?? invoice.hosted_invoice_url ?? undefined,
          });
        }
      } catch {
        warnings.push('Stripe invoice history is temporarily unavailable');
      }
    }
    for (const checkout of listCryptoCheckouts().filter((entry) => entry.userId === userId)) {
      invoices.push({
        id: checkout.checkoutId,
        provider: 'nowpayments',
        planId: checkout.planId,
        status: checkout.status,
        createdAt: checkout.createdAt,
        amountMinor: Math.round(checkout.amount * 100),
        currency: checkout.currency.toUpperCase(),
        paymentId: checkout.providerPaymentId,
      });
    }
    invoices.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    return reply.send({ invoices: invoices.slice(0, 100), warnings });
  });

  server.get('/v1/billing', { schema: getRouteContract('GET', '/v1/billing'), preHandler: fastifyRequireSession }, async (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    const profile = getAuthProfile(userId);
    const entitlement = getBillingEntitlements(userId);
    const quota = getDecryptQuotaUsage(userId, entitlement.dailyDecryptLimit);
    const sampleDays = 7;
    const recentQuotaAdmissions = getDecryptQuotaJournal(userId, 10_000).filter((entry) => entry.admittedAt > Date.now() - sampleDays * 86_400_000);
    const averagePerDay = recentQuotaAdmissions.length / sampleDays;
    const crypto = await getNowPaymentsProviderStatus();
    const minimumResults = crypto.enabled && crypto.ready
      ? await Promise.allSettled(crypto.supportedAssets.map((asset) => getNowPaymentsMinimumFiat(asset)))
      : [];
    const minimumByAsset = Object.fromEntries(minimumResults.flatMap((result, index) => result.status === 'fulfilled' ? [[crypto.supportedAssets[index], result.value]] : []));
    return reply.send({
      enabled: stripeEnabled || crypto.enabled,
      provider: entitlement.provider ?? 'stripe',
      environment: stripeEnvironment,
      managedPayments: true,
      missingConfiguration: stripeEnabled ? [] : stripeMissingConfiguration,
      providers: {
        stripe: { enabled: stripeEnabled, environment: stripeEnvironment, managedPayments: true, missingConfiguration: stripeMissingConfiguration },
        crypto: { provider: 'nowpayments', enabled: crypto.enabled, ready: crypto.enabled && crypto.ready, environment: crypto.environment, settlementCurrency: crypto.settlementCurrency, assets: crypto.supportedAssets, minimumByAsset },
      },
      plans: listPlans(userId),
      currentPlan: getPlan(entitlement.planId),
      customerId: getBillingCustomerId(userId),
      customerEmail: profile?.email,
      legacyBilling: hasLegacyBillingRecord(userId),
      entitlement,
      quota,
      usageForecast: {
        sampleDays,
        jobsInSample: recentQuotaAdmissions.length,
        averagePerDay,
        daysUntilAllowanceUsed: quota.limit !== null && quota.remaining !== null && averagePerDay > 0 ? quota.remaining / averagePerDay : null,
      },
    });
  });

  const billingIdempotencyKeyPattern = /^[A-Za-z0-9._~-]{1,200}$/;

  function getBillingIdempotencyKey(request: FastifyRequest, reply: FastifyReply, userId: string, operation: string): string | undefined {
    const header = request.headers['idempotency-key'];
    const key = Array.isArray(header) ? header[0] ?? '' : header ?? '';
    if (!billingIdempotencyKeyPattern.test(key)) {
      sendBillingError(request, reply, 400, 'Idempotency-Key must be 1-200 URL-safe characters');
      return undefined;
    }
    return `dkrypt-${operation}-${createHash('sha256').update(`${operation}:${userId}:${key}`).digest('hex')}`;
  }

  function createIntegrationIdentifier(idempotencyKey: string): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const suffix = Array.from(createHash('sha256').update(idempotencyKey).digest().subarray(0, 8), (byte) => alphabet[byte % alphabet.length]).join('');
    return `dkrypt_${suffix}`;
  }

  server.post<BillingCheckoutRoute>('/v1/billing/checkout', { schema: getRouteContract('POST', '/v1/billing/checkout'), preHandler: fastifyRequireSession }, async (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    if (getBillingEntitlements(userId).provider === 'gift') return sendBillingError(request, reply, 409, 'gift access is active until it expires; a paid plan can be started afterward', 'gift_access_active');
    const target = getPurchasablePlan(request.body.planId, userId);
    if (!target) return sendBillingError(request, reply, 400, 'unknown plan');
    const provider = request.body.provider ?? 'stripe';
    const idempotencyKey = getBillingIdempotencyKey(request, reply, userId, `checkout-${provider}`);
    if (!idempotencyKey) return;
    if (!acquireBillingCheckoutLock(userId)) return sendBillingError(request, reply, 409, 'another checkout is already in progress for this account');
    const existingCryptoCheckout = provider === 'crypto' ? findCryptoCheckout(userId, idempotencyKey) : undefined;
    const existingStripeAttempt = provider === 'stripe' ? findStripeCheckoutIdempotencyAttempt(userId, idempotencyKey) : undefined;
    if (!existingCryptoCheckout && !existingStripeAttempt && areNewBillingCheckoutsPaused()) {
      releaseBillingCheckoutLock(userId);
      return sendBillingError(request, reply, 503, 'New checkouts are temporarily paused by an administrator', 'billing_checkouts_paused');
    }
    if (provider === 'crypto') {
      try {
        const requestedAsset = request.body.cryptoAsset?.trim().toUpperCase() || config.nowpaymentsDefaultAsset;
        if (existingCryptoCheckout && (existingCryptoCheckout.planId !== target.id || (existingCryptoCheckout.asset?.toUpperCase() ?? requestedAsset) !== requestedAsset)) {
          return sendBillingError(request, reply, 409, 'Idempotency-Key was already used with a different checkout request', 'idempotency_conflict');
        }
        const result = await createCryptoCheckout({ userId, planId: target.id, idempotencyKey, asset: request.body.cryptoAsset });
        return reply.code(result.reused ? 200 : 201).send({ url: result.checkout.checkoutUrl, provider: 'nowpayments', checkoutId: result.checkout.checkoutId, status: result.checkout.status });
      } catch (error) {
        if (error instanceof CryptoBillingError) return sendBillingError(request, reply, error.statusCode, error.message);
        log.error('crypto checkout route failed', { userId, planId: target.id, error: String(error) });
        return sendBillingError(request, reply, 502, 'could not start crypto checkout');
      } finally {
        releaseBillingCheckoutLock(userId);
      }
    }
    try {
      if (!requireStripeBilling(request, reply)) return;
      const profile = getAuthProfile(userId);
      const customerId = getBillingCustomerId(userId);
      const parameters = {
        mode: 'subscription',
        line_items: [{ price: target.priceId, quantity: 1 }],
        customer: customerId,
        customer_email: customerId ? undefined : profile?.email,
        client_reference_id: userId,
        metadata: { dkrypt_user_id: userId, plan_id: target.id },
        subscription_data: { metadata: { dkrypt_user_id: userId, plan_id: target.id } },
        success_url: `${config.publicBaseUrl}/?tab=billing&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${config.publicBaseUrl}/?tab=billing&checkout=cancelled`,
        billing_address_collection: 'required',
        managed_payments: { enabled: true },
        integration_identifier: createIntegrationIdentifier(idempotencyKey),
      } satisfies Stripe.Checkout.SessionCreateParams;
      const requestFingerprint = createHash('sha256').update(JSON.stringify({ provider, planId: target.id })).digest('hex');
      const parametersFingerprint = createHash('sha256').update(JSON.stringify(parameters)).digest('hex');
      if (existingStripeAttempt && existingStripeAttempt.requestFingerprint !== requestFingerprint) {
        return sendBillingError(request, reply, 409, 'Idempotency-Key was already used with a different checkout request', 'idempotency_conflict');
      }
      if (existingStripeAttempt && !existingStripeAttempt.sessionId && existingStripeAttempt.parametersFingerprint !== parametersFingerprint) {
        return sendBillingError(request, reply, 409, 'Idempotency-Key was already used with a different checkout request', 'idempotency_conflict');
      }
      if (!existingStripeAttempt && hasActiveBillingSubscription(userId)) return sendBillingError(request, reply, 409, 'this account already has a subscription');
      if (!existingStripeAttempt) {
        recordStripeCheckoutIdempotencyAttempt({ userId, idempotencyKey, requestFingerprint, parametersFingerprint, createdAt: Date.now() });
      }
      const session = existingStripeAttempt?.sessionId
        ? await callStripe((client) => client.checkout.sessions.retrieve(existingStripeAttempt.sessionId!))
        : await callStripe((client) => client.checkout.sessions.create(parameters, { idempotencyKey }));
      if (!existingStripeAttempt?.sessionId && session.id) {
        recordStripeCheckoutIdempotencyAttempt({ userId, idempotencyKey, requestFingerprint, parametersFingerprint, createdAt: Date.now(), sessionId: session.id });
      }
      if (!session.url) {
        const statusCode = existingStripeAttempt?.sessionId ? 409 : 502;
        return sendBillingError(request, reply, statusCode, 'Stripe did not return an active checkout URL', existingStripeAttempt?.sessionId ? 'checkout_session_unavailable' : undefined);
      }
      return reply.send({ url: session.url });
    } catch (error) {
      log.error('Stripe checkout session failed', { userId, planId: target.id, error: String(error) });
      return sendBillingError(request, reply, 502, 'could not start checkout');
    } finally {
      releaseBillingCheckoutLock(userId);
    }
  });

  server.post('/v1/billing/portal', { schema: getRouteContract('POST', '/v1/billing/portal'), preHandler: fastifyRequireSession }, async (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    const entitlement = getBillingEntitlements(userId);
    if (entitlement.provider === 'nowpayments') return sendBillingError(request, reply, 409, 'crypto subscriptions are managed in dkrypt');
    const customerId = getBillingCustomerId(userId);
    if (!customerId) return sendBillingError(request, reply, 404, 'no Stripe customer exists for this account');
    if (!requireStripeBilling(request, reply)) return;

    try {
      const portal = await callStripe((client) => client.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${config.publicBaseUrl}/?tab=billing`,
      }));
      return reply.send({ url: portal.url });
    } catch (error) {
      log.error('Stripe portal session failed', { userId, error: String(error) });
      return sendBillingError(request, reply, 502, 'could not open the billing portal');
    }
  });

  server.post<BillingCancelRoute>('/v1/billing/cancel', { schema: getRouteContract('POST', '/v1/billing/cancel'), preHandler: fastifyRequireSession }, async (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    const idempotencyKey = getBillingIdempotencyKey(request, reply, userId, 'cancel');
    if (!idempotencyKey) return;
    const entitlement = getBillingEntitlements(userId);
    if (!entitlement.subscriptionId) return sendBillingError(request, reply, 404, 'no active subscription exists for this account');
    const subscription = getBillingSubscription(userId, entitlement.subscriptionId);
    if (!subscription) return sendBillingError(request, reply, 404, 'subscription does not belong to this account');
    if (subscription.provider === 'nowpayments') {
      if (subscription.status === 'cancelled') return reply.send({ success: true, status: 'cancelled', provider: 'nowpayments', idempotencyKey });
      try {
        await cancelCryptoSubscription(userId, subscription);
        return reply.send({ success: true, status: 'cancelled', provider: 'nowpayments', idempotencyKey });
      } catch (error) {
        if (error instanceof CryptoBillingError) return sendBillingError(request, reply, error.statusCode, error.message);
        return sendBillingError(request, reply, 502, 'could not cancel the crypto subscription');
      }
    }
    if (!requireStripeBilling(request, reply)) return;
    if (subscription.scheduledChangeAction === 'cancel') return reply.send({ success: true, status: subscription.status, cancelAtPeriodEnd: true, provider: 'stripe', idempotencyKey });
    try {
      const updated = await callStripe((client) => client.subscriptions.update(subscription.subscriptionId, { cancel_at_period_end: true }));
      persistStripeSubscription(updated, new Date().toISOString(), userId);
      recordAudit(userId, 'billing.cancel', subscription.subscriptionId, 'Stripe cancellation scheduled');
      return reply.send({ success: true, status: updated.status, cancelAtPeriodEnd: true, provider: 'stripe', idempotencyKey });
    } catch (error) {
      log.error('Stripe subscription cancellation failed', { userId, subscriptionId: subscription.subscriptionId, error: String(error) });
      return sendBillingError(request, reply, 502, 'could not cancel the subscription');
    }
  });

  const requireBillingManager = fastifyRequirePermission(PermissionFlag.manageBilling);

  server.get('/v1/billing/access-codes', { schema: getRouteContract('GET', '/v1/billing/access-codes'), preHandler: requireBillingManager }, (_request, reply) => {
    const now = Date.now();
    const accessCodes = listBillingAccessCodes().map((accessCode) => ({
      ...accessCode,
      status: accessCode.revokedAt ? 'revoked' : accessCode.redeemedAt ? Date.parse(accessCode.expiresAt ?? '') <= now ? 'expired' : 'redeemed' : Date.parse(accessCode.redeemBy) <= now ? 'expired' : 'available',
    }));
    return reply.send({ accessCodes });
  });

  server.post<BillingAccessCodeCreateRoute>('/v1/billing/access-codes', { schema: getRouteContract('POST', '/v1/billing/access-codes'), preHandler: requireBillingManager }, (request, reply) => {
    const actor = getFastifySession(request)!.sub;
    const created = createBillingAccessCode({ ...request.body, createdBy: actor });
    if (!created) return sendBillingError(request, reply, 400, 'choose an available plan and valid access and redemption durations');
    recordAudit(actor, 'billing.access_code.create', created.accessCode.id, `created ${created.accessCode.planId} access for ${created.accessCode.durationDays} days`);
    return reply.code(201).send({
      code: created.code,
      accessCode: { ...created.accessCode, status: 'available' },
    });
  });

  server.post<BillingAccessCodeRedeemRoute>('/v1/billing/access-codes/redeem', { schema: getRouteContract('POST', '/v1/billing/access-codes/redeem'), preHandler: fastifyRequireSession }, (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    const result = redeemBillingAccessCode(request.body.code, userId);
    if ('error' in result) {
      if (result.error === 'already_has_access') return sendBillingError(request, reply, 409, 'this account already has active billing access', 'billing_access_exists');
      return sendBillingError(request, reply, 400, 'this access code is invalid, expired, already redeemed, or revoked', 'access_code_unavailable');
    }
    recordAudit(userId, 'billing.access_code.redeem', result.accessCode.id, `redeemed ${result.accessCode.planId} access`);
    return reply.send({ planId: result.accessCode.planId, expiresAt: result.accessCode.expiresAt });
  });

  server.post<BillingAccessCodeRevokeRoute>('/v1/billing/access-codes/:id/revoke', { schema: getRouteContract('POST', '/v1/billing/access-codes/:id/revoke'), preHandler: requireBillingManager }, (request, reply) => {
    const actor = getFastifySession(request)!.sub;
    const revoked = revokeBillingAccessCode(request.params.id);
    if (!revoked) return sendBillingError(request, reply, 404, 'access code was not found or has already been revoked');
    recordAudit(actor, 'billing.access_code.revoke', revoked.id, 'revoked access code');
    const now = Date.now();
    const status = revoked.redeemedAt && Date.parse(revoked.expiresAt ?? '') <= now ? 'expired' : 'revoked';
    const { codeHash: _codeHash, ...safeRecord } = revoked;
    return reply.send({ ...safeRecord, status });
  });

  const readRevenue = options.billingRevenue ?? (options.stripeClient
    ? createBillingRevenueReader({
      stripeConfigured: true,
      runStripe: (operation) => operation(options.stripeClient!()),
    })
    : getBillingRevenueSummary);

  server.get<BillingRevenueRoute>('/v1/billing/revenue', {
    schema: getRouteContract('GET', '/v1/billing/revenue'),
    preHandler: requireBillingManager,
  }, async (request, reply) => {
    return reply.send(await readRevenue(request.query.refresh === 'true'));
  });

  server.put<BillingCheckoutControlRoute>('/v1/billing/checkouts', {
    schema: getRouteContract('PUT', '/v1/billing/checkouts'),
    attachValidation: true,
    preHandler: requireBillingManager,
  }, (request, reply) => {
    if (request.validationError) return sendBillingError(request, reply, 400, 'checkout control request is malformed');
    const paused = setNewBillingCheckoutsPaused(request.body.paused, getFastifySession(request)!.sub);
    return reply.send({ paused });
  });

  server.get<BillingProviderStatusRoute>('/v1/billing/provider-status', { schema: getRouteContract('GET', '/v1/billing/provider-status'), preHandler: requireBillingManager }, async (request, reply) => {
    const forceRefresh = request.query.refresh === 'true';
    const stripeWebhook = await (options.stripeWebhookHealth ?? ((refresh) => inspectStripeWebhookHealth(config.stripeSecretKey ? options.stripeClient?.() : undefined, undefined, refresh)))(forceRefresh);
    return reply.send({ checkoutsPaused: areNewBillingCheckoutsPaused(), stripe: { enabled: stripeEnabled, environment: stripeEnvironment, missingConfiguration: stripeMissingConfiguration, newCatalogMissingConfiguration: stripeNewCatalogMissingConfiguration, webhook: stripeWebhook }, crypto: await getNowPaymentsProviderStatus() });
  });

  server.post('/v1/billing/stripe-webhook/sync', { schema: getRouteContract('POST', '/v1/billing/stripe-webhook/sync'), preHandler: requireBillingManager }, async (request, reply) => {
    const actor = getFastifySession(request)!.sub;
    const endpointUrl = new URL('/v1/stripe/webhook', config.publicBaseUrl).toString();
    if (!options.stripeClient && !config.stripeSecretKey) return sendBillingError(request, reply, 503, 'Stripe API key is not configured', 'stripe_not_configured');

    try {
      const webhook = await syncStripeWebhookEvents(options.stripeClient?.());
      if (webhook.state !== 'ready') {
        recordAudit(actor, 'billing.webhook.sync', endpointUrl, `required events updated but endpoint verification returned ${webhook.state}`);
        return sendBillingError(request, reply, 502, 'Stripe webhook events could not be verified after synchronization', 'stripe_webhook_sync_failed');
      }
      recordAudit(actor, 'billing.webhook.sync', endpointUrl, 'required events synchronized on the existing endpoint; signing secret unchanged');
      return reply.send({ webhook });
    } catch (error) {
      if (error instanceof StripeWebhookEndpointNotFoundError) {
        recordAudit(actor, 'billing.webhook.sync', endpointUrl, 'no enabled matching endpoint found; no changes made');
        return sendBillingError(request, reply, 409, 'No enabled Stripe webhook endpoint exists for dkrypt; no endpoint was created.', 'stripe_webhook_endpoint_missing');
      }
      log.error('Stripe webhook event synchronization failed', { error: String(error) });
      recordAudit(actor, 'billing.webhook.sync', endpointUrl, 'event synchronization failed');
      return sendBillingError(request, reply, 502, 'could not synchronize Stripe webhook events', 'stripe_webhook_sync_failed');
    }
  });

  server.get<BillingSubscriptionsRoute>('/v1/billing/subscriptions', { schema: getRouteContract('GET', '/v1/billing/subscriptions'), preHandler: fastifyRequirePermission(PermissionFlag.viewBilling, PermissionFlag.manageBilling) }, (request, reply) => {
    const { q: query, provider, status, planId, from, to, wallet, invoice, limit: requestedLimit, cursor, offset: requestedOffset } = request.query;
    const limit = Math.min(Math.max(requestedLimit ?? 50, 1), 100);
    const offset = cursor ? 0 : Math.max(requestedOffset ?? 0, 0);
    const subscriptionOrder = new Map(
      listBillingSubscriptions().map((subscription, index) => [`${subscription.provider}:${subscription.subscriptionId}`, index]),
    );
    const subscriptions = listManagerBillingSubscriptions({ query, provider, status: status === 'needs_attention' ? undefined : status, planId, from, to, wallet, invoice })
      .filter((subscription) => status !== 'needs_attention' || ['past_due', 'unpaid'].includes(String(subscription.status).toLowerCase()));
    const page = paginateCursor(subscriptions, {
      cursor,
      offset,
      limit,
      keyOf: (subscription) => [
        subscriptionOrder.get(`${String(subscription.provider)}:${String(subscription.subscriptionId)}`) ?? Number.MAX_SAFE_INTEGER,
        typeof subscription.provider === 'string' ? subscription.provider : '',
        typeof subscription.subscriptionId === 'string' ? subscription.subscriptionId : '',
      ],
      order: 'asc',
    });
    return reply.send({ subscriptions: page.items, total: subscriptions.length, nextCursor: page.nextCursor });
  });

  server.get<BillingWebhookInboxRoute>('/v1/billing/webhooks/inbox', { schema: getRouteContract('GET', '/v1/billing/webhooks/inbox'), preHandler: requireBillingManager }, (request, reply) => {
    const { status, provider, limit: requestedLimit, cursor, offset: requestedOffset } = request.query;
    const filter = { status: status === 'needs_attention' ? undefined : status, provider };
    const limit = Math.min(Math.max(requestedLimit ?? 50, 1), 200);
    const offset = cursor ? decodeCursor(cursor) : Math.max(requestedOffset ?? 0, 0);
    const attentionStatuses = ['failed', 'received'] as const;
    const total = status === 'needs_attention'
      ? attentionStatuses.reduce((sum, attentionStatus) => sum + countWebhookInbox({ provider, status: attentionStatus }), 0)
      : countWebhookInbox(filter);
    const records = status === 'needs_attention'
      ? attentionStatuses.flatMap((attentionStatus) => listWebhookInbox({ provider, status: attentionStatus }, { limit: offset + limit, offset: 0 }))
        .sort((left, right) => right.receivedAt - left.receivedAt || right.id.localeCompare(left.id))
        .slice(offset, offset + limit)
      : listWebhookInbox(filter, { limit, offset });
    const page = records.map(({ rawBody, ...record }) => ({
      ...record,
      rawBodyBytes: Buffer.byteLength(rawBody),
      replayableProcessed: record.status === 'processed' && isProcessedStripeInvoiceDelivery(record.provider, rawBody),
    }));
    return reply.send({ inbox: page, total, nextCursor: nextCursor(offset, page.length, total) });
  });

  server.post<BillingWebhookQuarantineRoute>('/v1/billing/webhooks/inbox/:id/quarantine', { schema: getRouteContract('POST', '/v1/billing/webhooks/inbox/:id/quarantine'), preHandler: requireBillingManager }, (request, reply) => {
    const current = getWebhookInboxRecord(request.params.id);
    if (!current) return sendBillingError(request, reply, 404, 'webhook inbox record not found');
    const reason = request.body.reason?.trim() || 'quarantined by manager';
    const record = quarantineWebhook(current.id, reason);
    if (!record) return sendBillingError(request, reply, 409, 'processed or in-flight webhooks cannot be quarantined');
    recordAudit(getFastifySession(request)!.sub, 'billing.webhook.quarantine', current.eventId, `${current.provider}: ${reason}`);
    return reply.send({ record: record ? { ...record, rawBody: undefined } : undefined });
  });

  server.post<BillingWebhookInboxParamsRoute>('/v1/billing/webhooks/inbox/:id/replay', { schema: getRouteContract('POST', '/v1/billing/webhooks/inbox/:id/replay'), preHandler: requireBillingManager }, async (request, reply) => {
    const current = getWebhookInboxRecord(request.params.id);
    if (!current) return sendBillingError(request, reply, 404, 'webhook inbox record not found');
    const replayingProcessedInvoice = current.status === 'processed' && isProcessedStripeInvoiceDelivery(current.provider, current.rawBody);
    if (current.status === 'processed' && !replayingProcessedInvoice) return reply.send({ replayed: false, duplicate: true, status: current.status });
    if (createHash('sha256').update(current.rawBody).digest('hex') !== current.rawBodySha256) return sendBillingError(request, reply, 409, 'stored webhook body failed its integrity check');
    if (!claimWebhook(current.id, { allowQuarantined: true, allowProcessed: replayingProcessedInvoice })) return sendBillingError(request, reply, 409, 'webhook is already being processed');
    try {
      const payload = JSON.parse(current.rawBody) as Record<string, unknown>;
      if (current.provider === 'stripe') {
        if (typeof payload.id !== 'string' || typeof payload.type !== 'string' || typeof payload.data !== 'object' || payload.data === null) throw new Error('stored Stripe event is malformed');
        await processStripeEvent(payload as unknown as Stripe.Event, options.stripeClient?.());
      } else {
        if (typeof payload.payment_status !== 'string') throw new Error('stored NOWPayments event is malformed');
        await processNowPaymentsEvent({ id: current.eventId, payment: payload as Parameters<typeof processNowPaymentsEvent>[0]['payment'] });
      }
      markWebhookProcessed(current.id);
      const replayDetail = replayingProcessedInvoice ? `${current.provider}: previously processed subscription invoice` : current.provider;
      recordAudit(getFastifySession(request)!.sub, 'billing.webhook.replay', current.eventId, replayDetail);
      return reply.send({ replayed: true, status: 'processed' });
    } catch (error) {
      markWebhookFailed(current.id, String(error));
      return sendBillingError(request, reply, 500, 'webhook replay failed');
    } finally {
      releaseWebhookClaim(current.id);
    }
  });

  server.post<BillingSubscriptionRoute>('/v1/billing/subscription', { schema: getRouteContract('POST', '/v1/billing/subscription'), preHandler: fastifyRequireSession }, async (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    const target = getPurchasablePlan(request.body.planId, userId);
    if (!target) return sendBillingError(request, reply, 400, 'unknown plan');
    if (!requireStripeBilling(request, reply)) return;

    const entitlement = getBillingEntitlements(userId);
    if (!entitlement.subscriptionId) return sendBillingError(request, reply, 409, 'complete checkout before changing plans');
    const subscription = getBillingSubscription(userId, entitlement.subscriptionId);
    if (!subscription) return sendBillingError(request, reply, 403, 'subscription does not belong to this account');
    if (subscription.provider !== 'stripe') return sendBillingError(request, reply, 409, 'crypto plan changes require cancellation and a new checkout');
    const current = getPlan(subscription.planId);
    if (current?.legacy && request.body.acknowledgeLegacyLoss !== true) return sendBillingError(request, reply, 409, 'confirm that switching will permanently end your legacy plan', 'legacy_plan_confirmation_required');

    try {
      const stripeSubscription = await callStripe((client) => client.subscriptions.retrieve(subscription.subscriptionId));
      const item = stripeSubscription.items.data.find((candidate) => candidate.id === subscription.subscriptionItemId) ?? stripeSubscription.items.data[0];
      if (!item) return sendBillingError(request, reply, 502, 'subscription has no billable item');
      const updated = await callStripe((client) => client.subscriptions.update(subscription.subscriptionId, {
        items: [{ id: item.id, price: target.priceId, quantity: item.quantity ?? 1 }],
        proration_behavior: current && target.amount > current.amount ? 'always_invoice' : 'create_prorations',
        payment_behavior: 'error_if_incomplete',
      }));
      persistStripeSubscription(updated, new Date().toISOString(), userId);
      return reply.send({
        success: true,
        status: updated.status,
        priceId: typeof updated.items.data[0]?.price === 'string' ? updated.items.data[0].price : updated.items.data[0]?.price.id ?? null,
      });
    } catch (error) {
      log.error('Stripe subscription update failed', { userId, planId: target.id, error: String(error) });
      if (typeof error === 'object' && error !== null && (error as { statusCode?: unknown }).statusCode === 402) {
        return sendBillingError(request, reply, 402, 'payment confirmation is required; use Manage billing to complete the change');
      }
      return sendBillingError(request, reply, 502, 'subscription update failed; your existing plan was not changed');
    }
  });
};
