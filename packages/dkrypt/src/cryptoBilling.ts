import { createHash, randomUUID } from 'node:crypto';
import { trackBackgroundWork } from '#backgroundWork.js';
import { config, cryptoBillingEnabled, nowpaymentsConfigured } from '#config.js';
import {
  findCryptoCheckout,
  listCryptoCheckouts,
  getBillingSubscriptionById,
  getBillingSubscriptionsForUser,
  getPlan,
  getCryptoCheckout,
  isBillingSubscriptionActive,
  hasProcessedBillingEvent,
  filterBillingSubscriptions,
  listBillingChargesForSubscription,
  listBillingEntitlementHistory,
  listBillingSubscriptions,
  recordBillingEvent,
  upsertBillingCharge,
  upsertBillingSubscription,
  upsertCryptoCheckout,
  type BillingCharge,
  type BillingCheckout,
  type BillingSubscription,
  type PlanId,
} from '#billing.js';
import {
  checkoutFromResponse,
  getNowPaymentsProviderStatus,
  getNowPaymentsMinimumFiat,
  isSupportedNowPaymentsPayment,
  NowPaymentsApiError,
  NowPaymentsClient,
  subscriptionFromPayment,
  verifyNowPaymentsWebhookWithRotation,
  type NowPaymentsEvent,
  type NowPaymentsPayment,
} from '#nowpayments.js';
import { getAuthProfile } from '#identity.js';
import { log } from '#logger.js';
import { EMBED_COLOR, notify } from '#notify.js';
import { recordAudit } from '#store/state.js';
import { runKeyedSerial } from '#util/keyedSerial.js';

const RENEWAL_GRACE_MS = config.cryptoDunningGraceHours * 60 * 60 * 1000;
const pendingPaymentEvents = new Map<string, { count: number; latestTimestamp?: number }>();

export class CryptoBillingError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'CryptoBillingError';
  }
}

export interface CryptoCheckoutResult {
  checkout: BillingCheckout;
  reused: boolean;
}

export async function createCryptoCheckout(input: {
  userId: string;
  planId: Exclude<PlanId, 'viewer'>;
  idempotencyKey: string;
  asset?: string;
  preserveResultId?: string;
  resumeRequest?: boolean;
}): Promise<CryptoCheckoutResult> {
  const existing = findCryptoCheckout(input.userId, input.idempotencyKey);
  if (existing) return { checkout: existing, reused: true };
  const activeSubscriptions = getBillingSubscriptionsForUser(input.userId).filter((subscription) => isBillingSubscriptionActive(subscription));
  if (activeSubscriptions.some((subscription) => subscription.provider !== 'nowpayments' || subscription.status !== 'past_due' || subscription.planId !== input.planId)) {
    throw new CryptoBillingError('this account already has a subscription', 409);
  }
  if (!cryptoBillingEnabled) throw new CryptoBillingError('crypto billing is not enabled', 503);

  const plan = getPlan(input.planId);
  if (!plan) throw new CryptoBillingError('unknown plan', 400);

  const asset = input.asset?.trim().toUpperCase() || config.nowpaymentsDefaultAsset;
  if (!config.nowpaymentsSupportedAssets.includes(asset)) throw new CryptoBillingError('unsupported crypto payment currency', 400);

  const providerStatus = await getNowPaymentsProviderStatus();
  if (!providerStatus.ready) throw new CryptoBillingError(`crypto billing is not ready: ${providerStatus.issues.join(', ')}`, 503);
  try {
    const minimum = await getNowPaymentsMinimumFiat(asset, plan.currency, true);
    if (plan.amount < minimum) throw new CryptoBillingError('crypto checkout is unavailable at this plan price for the selected currency', 409);
  } catch (error) {
    if (error instanceof CryptoBillingError) throw error;
    throw new CryptoBillingError('could not verify the crypto payment minimum', 503);
  }

  const orderId = `dkrypt_${randomUUID()}`;
  const client = new NowPaymentsClient();
  try {
    const response = await client.createInvoice({
      amount: plan.amount,
      currency: plan.currency,
      payCurrency: asset,
      orderId,
      orderDescription: `dkrypt ${plan.name} plan`,
      ipnCallbackUrl: `${config.publicBaseUrl}/v1/nowpayments/webhook`,
      successUrl: `${config.publicBaseUrl}/?tab=billing&crypto_checkout=success${input.preserveResultId ? `&preserveResult=${encodeURIComponent(input.preserveResultId)}` : ''}${input.resumeRequest ? '&resumeRequest=1' : ''}`,
      cancelUrl: `${config.publicBaseUrl}/?tab=billing&crypto_checkout=cancelled${input.preserveResultId ? `&preserveResult=${encodeURIComponent(input.preserveResultId)}` : ''}${input.resumeRequest ? '&resumeRequest=1' : ''}`,
    });
    const checkout = checkoutFromResponse(response, {
      checkoutId: orderId,
      orderId,
      userId: input.userId,
      planId: plan.id,
      amount: plan.amount,
      currency: plan.currency,
      idempotencyKey: input.idempotencyKey,
      asset,
    });
    upsertCryptoCheckout(checkout);
    recordAudit(input.userId, 'billing.checkout', checkout.checkoutId, `nowpayments ${plan.id}`);
    return { checkout, reused: false };
  } catch (error) {
    log.error('NOWPayments checkout failed', { userId: input.userId, planId: plan.id, error: String(error) });
    if (error instanceof NowPaymentsApiError) throw new CryptoBillingError('could not start crypto checkout', 502);
    throw error;
  }
}

export async function cancelCryptoSubscription(userId: string, subscription: BillingSubscription): Promise<void> {
  if (subscription.provider !== 'nowpayments') throw new CryptoBillingError('this subscription is not managed by NOWPayments', 409);
  const now = new Date().toISOString();
  upsertBillingSubscription({
    ...subscription,
    status: 'cancelled',
    nextBilledAt: undefined,
    scheduledChangeAction: undefined,
    scheduledChangeAt: undefined,
    occurredAt: now,
    updatedAt: now,
  });
  recordAudit(userId, 'billing.cancel', subscription.subscriptionId, 'NOWPayments renewal stopped');
  await notify('cryptoBillingSuccess', {
    title: 'Crypto renewal stopped',
    description: `Your ${subscription.planId} crypto renewal has been stopped.`,
    color: EMBED_COLOR.ok,
  });
}

export async function processNowPaymentsEvent(event: NowPaymentsEvent, client = new NowPaymentsClient()): Promise<void> {
  if (!event.id) return;
  const checkout = findCheckoutForPayment(event.payment);
  const paymentKey = checkout?.checkoutId ?? String(event.payment.payment_id ?? event.payment.invoice_id ?? event.payment.order_id ?? event.id);
  const releaseObservation = observePaymentEvent(paymentKey, event.payment);
  try {
    await runKeyedSerial(`nowpayments:${paymentKey}`, () => processNowPaymentsEventLocked(event, client, paymentKey));
  } finally {
    releaseObservation();
  }
}

async function processNowPaymentsEventLocked(event: NowPaymentsEvent, client: NowPaymentsClient, paymentKey: string): Promise<void> {
  if (!event.id || hasProcessedBillingEvent(event.id, 'nowpayments')) return;
  const checkout = findCheckoutForPayment(event.payment);
  const payment = await reconcilePaymentEvent(event.payment, checkout, client);
  const occurredAt = eventDate(event.payment.updated_at ?? event.payment.created_at);
  if (payment && (isOlderPaymentEvent(payment, findCheckoutForPayment(payment)) || isSupersededByPendingPaymentEvent(paymentKey, payment))) {
    recordBillingEvent({ provider: 'nowpayments', eventId: event.id, occurredAt, processedAt: new Date().toISOString() });
    recordAudit('nowpayments', 'billing.webhook', event.id, `ignored stale ${event.payment.payment_status ?? 'unknown'} event`);
    return;
  }
  if (!payment) {
    recordBillingEvent({ provider: 'nowpayments', eventId: event.id, occurredAt, processedAt: new Date().toISOString() });
    recordAudit('nowpayments', 'billing.webhook', event.id, `ignored stale ${event.payment.payment_status ?? 'unknown'} event`);
    return;
  }
  const paymentOccurredAt = eventDate(payment.updated_at ?? payment.created_at);
  try {
    const status = payment.payment_status?.toLowerCase();
    if (status === 'finished') await processPaymentFinished(payment, paymentOccurredAt);
    else if (status === 'failed' || status === 'expired' || status === 'refunded') processPaymentFailed(payment, paymentOccurredAt);
    else processPaymentPending(payment);
    recordBillingEvent({ provider: 'nowpayments', eventId: event.id, occurredAt, processedAt: new Date().toISOString() });
    recordAudit('nowpayments', 'billing.webhook', event.id, status ?? 'unknown');
  } catch (error) {
    log.error('NOWPayments webhook processing failed', { eventId: event.id, status: payment.payment_status, error: String(error) });
    throw error;
  }
}

function observePaymentEvent(paymentKey: string, payment: NowPaymentsPayment): () => void {
  const observation = pendingPaymentEvents.get(paymentKey) ?? { count: 0 };
  const timestamp = paymentTimestamp(payment);
  if (timestamp !== undefined && (observation.latestTimestamp === undefined || timestamp > observation.latestTimestamp)) {
    observation.latestTimestamp = timestamp;
  }
  observation.count += 1;
  pendingPaymentEvents.set(paymentKey, observation);
  return () => {
    observation.count -= 1;
    if (observation.count === 0 && pendingPaymentEvents.get(paymentKey) === observation) pendingPaymentEvents.delete(paymentKey);
  };
}

function isSupersededByPendingPaymentEvent(paymentKey: string, payment: NowPaymentsPayment): boolean {
  const latestTimestamp = pendingPaymentEvents.get(paymentKey)?.latestTimestamp;
  if (latestTimestamp === undefined) return false;
  const incomingTimestamp = paymentTimestamp(payment);
  return incomingTimestamp === undefined || incomingTimestamp < latestTimestamp;
}

export function verifyNowPaymentsEvent(rawBody: Buffer | string, signature: string, previousSignature = ''): boolean {
  try {
    const payload = JSON.parse(rawBody.toString('utf8')) as unknown;
    return verifyNowPaymentsWebhookWithRotation(payload, signature, previousSignature);
  } catch {
    return false;
  }
}

export async function reconcileCryptoBilling(): Promise<void> {
  if (!nowpaymentsConfigured) return;
  const providerStatus = await getNowPaymentsProviderStatus();
  if (!providerStatus.ready) return;
  const now = Date.now();
  const client = new NowPaymentsClient();

  for (const checkout of listPendingCheckouts()) {
    if (!checkout.providerPaymentId) continue;
    try {
      const payment = await client.getPaymentStatus(checkout.providerPaymentId);
      if (payment.payment_status === 'finished' || payment.payment_status === 'failed' || payment.payment_status === 'expired') {
        await processNowPaymentsEvent({ id: paymentEventId(payment), payment }, client);
      }
    } catch (error) {
      log.warn('NOWPayments checkout reconciliation failed', { checkoutId: checkout.checkoutId, error: String(error) });
    }
  }

  for (const subscription of listBillingSubscriptions().filter((item) => item.provider === 'nowpayments' && item.userId)) {
    if (subscription.status === 'cancelled') continue;
    if (subscription.graceUntil && Date.parse(subscription.graceUntil) <= now) {
      await markSubscriptionCancelled(subscription, 'renewal grace period expired');
      continue;
    }
    if (subscription.nextBilledAt && Date.parse(subscription.nextBilledAt) <= now && subscription.status === 'active') {
      await markSubscriptionPastDue(subscription, 'crypto renewal is due; a new payment is required');
    }
  }
}

export async function refreshCryptoBillingForUser(userId: string): Promise<boolean> {
  const ownedSubscriptions = getBillingSubscriptionsForUser(userId).filter((subscription) => subscription.provider === 'nowpayments');
  const subscriptionCheckoutIds = new Set(ownedSubscriptions.map((subscription) => subscription.checkoutId).filter((checkoutId): checkoutId is string => Boolean(checkoutId)));
  const checkouts = listCryptoCheckouts()
    .filter((checkout) => checkout.provider === 'nowpayments'
      && checkout.userId === userId
      && Boolean(checkout.providerPaymentId)
      && (checkout.status === 'pending' || subscriptionCheckoutIds.has(checkout.checkoutId)))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, 5);
  if (checkouts.length === 0) return false;
  const client = new NowPaymentsClient();
  for (const expectedCheckout of checkouts) {
    const payment = await client.getPaymentStatus(expectedCheckout.providerPaymentId!);
    const checkout = findCheckoutForPayment(payment);
    if (!checkout || checkout.userId !== userId || checkout.checkoutId !== expectedCheckout.checkoutId) throw new Error('NOWPayments payment does not match this account checkout');
    const revision = payment.updated_at ?? payment.created_at ?? payment.payment_status ?? 'unknown';
    const eventId = `self-refresh:${createHash('sha256').update(`${payment.payment_id}:${revision}`).digest('hex')}`;
    await processNowPaymentsEvent({ id: eventId, payment }, client);
  }
  return true;
}

let cryptoBillingTimer: NodeJS.Timeout | undefined;

export function startCryptoBillingPoller(): void {
  if (!nowpaymentsConfigured) return;
  const interval = Math.max(60, config.cryptoBillingPollIntervalSeconds) * 1000;
  cryptoBillingTimer ??= setInterval(() => {
    void trackBackgroundWork('crypto-billing-reconciliation', reconcileCryptoBilling)
      .catch((error: unknown) => log.warn('crypto billing poll failed', { error: String(error) }));
  }, interval).unref();
}

export function stopCryptoBillingPoller(): void {
  if (cryptoBillingTimer) clearInterval(cryptoBillingTimer);
  cryptoBillingTimer = undefined;
}

export function listManagerBillingSubscriptions(filters: { query?: string; provider?: string; status?: string; planId?: string; from?: string; to?: string; wallet?: string; invoice?: string } = {}): Array<Record<string, unknown>> {
  const subscriptions = filterBillingSubscriptions(filters);
  const profiles = new Map(
    [...new Set(subscriptions.map((subscription) => subscription.userId).filter((userId): userId is string => !!userId))].map((userId) => [userId, getAuthProfile(userId)]),
  );
  return subscriptions.map((subscription) => {
    const profile = subscription.userId ? profiles.get(subscription.userId) : undefined;
    return {
      user: subscription.userId
        ? {
            id: subscription.userId,
            displayName: profile?.displayName ?? subscription.userId,
            username: profile?.username,
            email: profile?.email,
          }
        : undefined,
      provider: subscription.provider,
      subscriptionId: subscription.subscriptionId,
      checkoutId: subscription.checkoutId,
      customerId: subscription.customerId,
      priceId: subscription.priceId,
      productId: subscription.productId,
      interval: subscription.interval,
      plan: { id: subscription.planId, name: getPlan(subscription.planId)?.name, amount: subscription.amount ?? getPlan(subscription.planId)?.amount, currency: subscription.currency ?? getPlan(subscription.planId)?.currency },
      status: subscription.status,
      nextBilledAt: isBillingSubscriptionActive(subscription) ? subscription.nextBilledAt : undefined,
      occurredAt: subscription.occurredAt,
      updatedAt: subscription.updatedAt,
      crypto: subscription.provider === 'nowpayments' ? { walletAddress: subscription.walletAddress, chain: subscription.chain, asset: subscription.asset } : undefined,
      tax: subscription.taxStatus
        ? { status: subscription.taxStatus, country: subscription.taxAddress?.country, postalCode: subscription.taxAddress?.postalCode, transactionId: subscription.taxTransactionId }
        : undefined,
      lastCharge: {
        id: subscription.lastChargeId,
        status: subscription.lastChargeStatus,
        at: subscription.lastChargeAt,
        txHash: subscription.lastChargeTxHash,
        failureReason: subscription.failureReason,
        graceUntil: subscription.graceUntil,
        attempts: listBillingChargesForSubscription(subscription.subscriptionId).slice(-10),
      },
      entitlementHistory: listBillingEntitlementHistory(subscription.subscriptionId),
    };
  });
}

async function processPaymentFinished(payment: NowPaymentsPayment, occurredAt: string): Promise<void> {
  const checkout = findCheckoutForPayment(payment);
  if (!checkout) return;
  if (checkout.status === 'completed') return;
  if (!isSupportedNowPaymentsPayment(payment)) {
    savePaymentCheckout(checkout, payment, 'expired');
    recordAudit(checkout.userId, 'billing.webhook', checkout.checkoutId, 'unsupported NOWPayments asset');
    return;
  }

  const paymentId = payment.payment_id === undefined ? checkout.checkoutId : String(payment.payment_id);
  const subscriptionId = `nowpayments:${paymentId}`;
  const existing = getBillingSubscriptionById(subscriptionId);
  if (existing && Date.parse(existing.occurredAt) >= Date.parse(occurredAt)) return;

  const localSubscription = subscriptionFromPayment(payment, {
    userId: checkout.userId,
    planId: checkout.planId,
    checkoutId: checkout.checkoutId,
    occurredAt,
  });
  deactivateOtherCryptoSubscriptions(checkout.userId, localSubscription.subscriptionId, occurredAt);
  const applied = upsertBillingSubscription(localSubscription);
  savePaymentCheckout(checkout, payment, 'completed');
  upsertBillingCharge(chargeFromPayment(payment, localSubscription, checkout.userId, 'succeeded', occurredAt));
  if (!applied) return;
  recordAudit(checkout.userId, 'billing.activated', localSubscription.subscriptionId, `nowpayments ${checkout.planId}`);
  await notify('cryptoBillingSuccess', {
    title: 'Crypto plan active',
    description: `Your ${checkout.planId} crypto plan is active for 30 days.`,
    color: EMBED_COLOR.ok,
  });
}

function processPaymentPending(payment: NowPaymentsPayment): void {
  const checkout = findCheckoutForPayment(payment);
  if (!checkout || checkout.status === 'completed') return;
  savePaymentCheckout(checkout, payment, 'pending');
}

function processPaymentFailed(payment: NowPaymentsPayment, occurredAt: string): void {
  const checkout = findCheckoutForPayment(payment);
  if (!checkout) return;
  const status = payment.payment_status?.toLowerCase();
  if (checkout.status === 'completed') {
    if (status !== 'refunded') return;
    const paymentId = payment.payment_id === undefined ? checkout.checkoutId : String(payment.payment_id);
    const subscription = getBillingSubscriptionById(`nowpayments:${paymentId}`);
    savePaymentCheckout(checkout, payment, 'completed');
    if (!subscription) return;
    upsertBillingCharge({
      ...chargeFromPayment(payment, subscription, checkout.userId, 'refunded', occurredAt),
      failureReason: 'payment refunded',
    });
    if (Date.parse(subscription.occurredAt) > Date.parse(occurredAt)) return;
    const revokedSubscription: BillingSubscription = {
      ...subscription,
      status: 'revoked',
      nextBilledAt: undefined,
      lastChargeAt: occurredAt,
      lastChargeStatus: 'refunded',
      failureReason: 'payment refunded',
      graceUntil: undefined,
      occurredAt,
      updatedAt: occurredAt,
    };
    const applied = upsertBillingSubscription(revokedSubscription);
    if (applied) recordAudit(checkout.userId, 'billing.refund', subscription.subscriptionId, 'payment refunded');
    return;
  }
  savePaymentCheckout(checkout, payment, payment.payment_status?.toLowerCase() === 'expired' ? 'expired' : 'cancelled');
}

function savePaymentCheckout(checkout: BillingCheckout, payment: NowPaymentsPayment, status: BillingCheckout['status']): void {
  const providerTimestamp = paymentTimestamp(payment);
  upsertCryptoCheckout({
    ...checkout,
    providerPaymentId: payment.payment_id === undefined ? checkout.providerPaymentId : String(payment.payment_id),
    status,
    providerOccurredAt: providerTimestamp === undefined ? checkout.providerOccurredAt : new Date(providerTimestamp).toISOString(),
    providerStatus: payment.payment_status?.toLowerCase(),
    updatedAt: new Date().toISOString(),
  });
}

function findCheckoutForPayment(payment: NowPaymentsPayment): BillingCheckout | undefined {
  const reference = payment.order_id;
  if (reference) {
    const byOrder = getCryptoCheckout(reference);
    if (byOrder?.provider === 'nowpayments') return byOrder;
  }
  const invoiceId = payment.invoice_id === undefined ? undefined : String(payment.invoice_id);
  if (!invoiceId) return undefined;
  return listCryptoCheckouts().find((checkout) => checkout.provider === 'nowpayments' && checkout.providerCheckoutId === invoiceId);
}

function listPendingCheckouts(): BillingCheckout[] {
  return listCryptoCheckouts().filter((checkout) => checkout.provider === 'nowpayments' && checkout.status === 'pending');
}

async function reconcilePaymentEvent(
  payment: NowPaymentsPayment,
  checkout: BillingCheckout | undefined,
  client: NowPaymentsClient,
): Promise<NowPaymentsPayment | undefined> {
  if (!checkout) return payment;
  const incomingTimestamp = paymentTimestamp(payment);
  const currentProviderTimestamp = checkout.providerOccurredAt;
  if (!currentProviderTimestamp) {
    if (checkout.status !== 'cancelled' && checkout.status !== 'expired') return payment;
    return fetchLatestPayment(payment, checkout, client);
  }
  const currentTimestamp = Date.parse(currentProviderTimestamp);
  if (incomingTimestamp === undefined || incomingTimestamp < currentTimestamp) return undefined;
  if (incomingTimestamp > currentTimestamp || payment.payment_status?.toLowerCase() === checkout.providerStatus?.toLowerCase()) return payment;

  return fetchLatestPayment(payment, checkout, client, currentTimestamp);
}

async function fetchLatestPayment(
  payment: NowPaymentsPayment,
  checkout: BillingCheckout,
  client: NowPaymentsClient,
  currentTimestamp?: number,
): Promise<NowPaymentsPayment | undefined> {
  const paymentId = payment.payment_id === undefined ? checkout.providerPaymentId : String(payment.payment_id);
  if (!paymentId) return undefined;
  const latest = await client.getPaymentStatus(paymentId);
  const latestTimestamp = paymentTimestamp(latest);
  if (currentTimestamp !== undefined && (latestTimestamp === undefined || latestTimestamp < currentTimestamp)) return undefined;
  return {
    ...payment,
    ...latest,
    payment_id: latest.payment_id ?? payment.payment_id,
    order_id: latest.order_id ?? payment.order_id,
    invoice_id: latest.invoice_id ?? payment.invoice_id,
  };
}

function isOlderPaymentEvent(payment: NowPaymentsPayment, checkout: BillingCheckout | undefined): boolean {
  if (!checkout) return false;
  const currentProviderTimestamp = checkout.providerOccurredAt;
  if (!currentProviderTimestamp) return false;
  const incomingTimestamp = paymentTimestamp(payment);
  return incomingTimestamp === undefined || incomingTimestamp < Date.parse(currentProviderTimestamp);
}

function deactivateOtherCryptoSubscriptions(userId: string, currentId: string, occurredAt: string): void {
  for (const subscription of getBillingSubscriptionsForUser(userId)) {
    if (subscription.provider !== 'nowpayments' || subscription.subscriptionId === currentId || subscription.status === 'cancelled') continue;
    upsertBillingSubscription({ ...subscription, status: 'cancelled', nextBilledAt: undefined, occurredAt, updatedAt: occurredAt });
  }
}

function chargeFromPayment(
  payment: NowPaymentsPayment,
  subscription: BillingSubscription,
  userId: string,
  status: BillingCharge['status'],
  occurredAt: string,
): BillingCharge {
  const paymentId = payment.payment_id === undefined ? subscription.providerPaymentId ?? subscription.subscriptionId : String(payment.payment_id);
  return {
    provider: 'nowpayments',
    chargeId: `nowpayments:${paymentId}`,
    subscriptionId: subscription.subscriptionId,
    userId,
    status,
    amount: numberValue(payment.price_amount) ?? subscription.amount ?? 0,
    currency: payment.price_currency?.toUpperCase() ?? subscription.currency ?? config.nowpaymentsPriceCurrency,
    tokenAmount: stringValue(payment.actually_paid ?? payment.pay_amount),
    asset: stringValue(payment.pay_currency)?.toUpperCase(),
    txHash: stringValue(payment.outcome_tx_hash ?? payment.payin_hash ?? payment.transaction_hash),
    occurredAt,
    updatedAt: occurredAt,
  };
}

async function markSubscriptionPastDue(subscription: BillingSubscription, reason: string): Promise<void> {
  const now = new Date().toISOString();
  const graceUntil = subscription.graceUntil && Date.parse(subscription.graceUntil) > Date.now()
    ? subscription.graceUntil
    : new Date(Date.now() + RENEWAL_GRACE_MS).toISOString();
  upsertBillingSubscription({ ...subscription, status: 'past_due', failureReason: reason, graceUntil, occurredAt: now, updatedAt: now });
  if (subscription.userId) {
    recordAudit(subscription.userId, 'billing.charge-failed', subscription.subscriptionId, reason);
    await notify('cryptoBillingFailure', {
      title: 'Crypto renewal required',
      description: `Your ${subscription.planId} plan needs a new crypto payment within the ${config.cryptoDunningGraceHours}-hour grace period.`,
      color: EMBED_COLOR.warn,
    });
  }
}

async function markSubscriptionCancelled(subscription: BillingSubscription, reason: string): Promise<void> {
  const now = new Date().toISOString();
  upsertBillingSubscription({ ...subscription, status: 'cancelled', nextBilledAt: undefined, failureReason: reason, occurredAt: now, updatedAt: now });
  if (subscription.userId) recordAudit(subscription.userId, 'billing.cancel', subscription.subscriptionId, reason);
}

function paymentEventId(payment: NowPaymentsPayment): string {
  const paymentId = payment.payment_id === undefined ? payment.order_id ?? 'unknown' : String(payment.payment_id);
  return `nowpayments:${paymentId}:${payment.payment_status ?? 'unknown'}:${payment.updated_at ?? payment.created_at ?? 'unknown'}`;
}

function eventDate(value: string | undefined): string {
  if (value && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}

function paymentTimestamp(payment: NowPaymentsPayment): number | undefined {
  const value = payment.updated_at ?? payment.created_at;
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : undefined;
  return parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
}
