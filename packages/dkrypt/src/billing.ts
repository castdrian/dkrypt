import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { openStateCollectionDatabase, writeStateMirror, type StateCollectionReplacement } from '#store/sqlite.js';
import { billingSnapshotReplacements, createBillingRepository, type BillingSubscriptionFilter } from '#store/billingRepository.js';
import { config } from '#config.js';
import { hasPermission, PermissionFlag } from '#permissions.js';
import { emitBillingChanged } from '#events.js';

let billingEntitlementChangeHandler: ((userId: string) => void) | undefined;

export function setBillingEntitlementChangeHandler(handler: ((userId: string) => void) | undefined): void {
  billingEntitlementChangeHandler = handler;
}

export type BillingProvider = 'stripe' | 'nowpayments' | 'legacy';
export type PlanId = 'viewer' | 'regular' | 'priority' | 'api' | 'priority_api' | 'access' | 'standard' | 'plus' | 'developer' | 'unlimited' | 'unlimited_priority';
export type BillingChargeStatus = 'pending' | 'succeeded' | 'failed' | 'refunded';
export type BillingCheckoutStatus = 'pending' | 'completed' | 'expired' | 'cancelled';
export type BillingTaxStatus = 'not_required' | 'pending' | 'recorded' | 'failed';

export interface BillingTaxAddress {
  country: string;
  state?: string;
  postalCode: string;
  city?: string;
  line1?: string;
  line2?: string;
}

export interface BillingCustomer {
  provider: BillingProvider;
  customerId: string;
  email: string;
  userId?: string;
  updatedAt: string;
}

export interface BillingSubscription {
  provider: BillingProvider;
  subscriptionId: string;
  customerId: string;
  userId?: string;
  status: string;
  planId: Exclude<PlanId, 'viewer'>;
  priceId: string;
  productId: string;
  subscriptionItemId?: string;
  checkoutId?: string;
  externalCustomerId?: string;
  currency?: string;
  amount?: number;
  interval?: string;
  walletAddress?: string;
  chain?: string;
  asset?: string;
  providerPaymentId?: string;
  nextBilledAt?: string;
  scheduledChangeAction?: string;
  scheduledChangeAt?: string;
  lastChargeAt?: string;
  lastChargeId?: string;
  lastChargeStatus?: BillingChargeStatus;
  lastChargeTxHash?: string;
  failureReason?: string;
  graceUntil?: string;
  paused?: boolean;
  pauseResumesAt?: string;
  flagged?: boolean;
  taxAddress?: BillingTaxAddress;
  taxStatus?: BillingTaxStatus;
  taxTransactionId?: string;
  occurredAt: string;
  updatedAt: string;
}

export interface BillingCheckout {
  provider: 'nowpayments' | 'legacy';
  checkoutId: string;
  providerCheckoutId?: string;
  providerPaymentId?: string;
  orderId?: string;
  userId: string;
  idempotencyKey: string;
  planId: Exclude<PlanId, 'viewer'>;
  amount: number;
  currency: string;
  status: BillingCheckoutStatus;
  checkoutUrl: string;
  asset?: string;
  providerOccurredAt?: string;
  providerStatus?: string;
  taxAddress?: BillingTaxAddress;
  taxCalculationId?: string;
  taxStatus?: BillingTaxStatus;
  createdAt: string;
  updatedAt: string;
}

export interface BillingCharge {
  provider: 'nowpayments' | 'legacy';
  chargeId: string;
  subscriptionId: string;
  userId: string;
  status: BillingChargeStatus;
  amount: number;
  currency: string;
  tokenAmount?: string;
  asset?: string;
  chain?: string;
  txHash?: string;
  chargeNonce?: number;
  taxTransactionId?: string;
  failureReason?: string;
  retryAt?: string;
  occurredAt: string;
  updatedAt: string;
}

export interface BillingEventRecord {
  provider: 'nowpayments' | 'legacy';
  eventId: string;
  occurredAt: string;
  processedAt: string;
}

export interface BillingEntitlementEvent {
  id: string;
  userId?: string;
  subscriptionId: string;
  provider: BillingProvider;
  planId: Exclude<PlanId, 'viewer'>;
  kind: 'grant' | 'renewal' | 'pause' | 'resume' | 'failure' | 'cancellation' | 'revocation';
  status: string;
  at: string;
  detail?: string;
}

export interface StripeCheckoutIdempotencyAttempt {
  userId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  parametersFingerprint: string;
  createdAt: number;
  sessionId?: string;
}

export interface BillingSnapshot {
  customers: BillingCustomer[];
  subscriptions: BillingSubscription[];
  cryptoCheckouts: BillingCheckout[];
  cryptoCharges: BillingCharge[];
  processedEvents: BillingEventRecord[];
  entitlementHistory?: BillingEntitlementEvent[];
  stripeCheckoutIdempotency?: StripeCheckoutIdempotencyAttempt[];
  accessCodes?: BillingAccessCode[];
}

export interface BillingAccessCode {
  id: string;
  codeHash: string;
  prefix: string;
  planId: Exclude<PlanId, 'viewer'>;
  durationDays: number;
  redeemBy: string;
  createdBy?: string;
  createdAt: string;
  redeemedBy?: string;
  redeemedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
}

export const STRIPE_CHECKOUT_IDEMPOTENCY_TTL_MS = 23 * 60 * 60 * 1000;

export interface BillingEntitlements {
  planId: PlanId;
  decrypt: boolean;
  api: boolean;
  priority: number;
  provider?: BillingProvider | 'gift';
  status?: string;
  subscriptionId?: string;
  paused?: boolean;
  pauseResumesAt?: string;
  accessCodeId?: string;
  expiresAt?: string;
  nextBilledAt?: string;
  scheduledChangeAction?: string;
  scheduledChangeAt?: string;
  dailyDecryptLimit?: number;
  rollingDecryptLimit?: number;
  rollingDecryptWindowMs?: number;
  freeTier?: boolean;
  apiRatePerMinute?: number;
  legacy?: boolean;
}

interface PlanDefinition {
  id: Exclude<PlanId, 'viewer'>;
  name: string;
  description: string;
  amount: number;
  currency: 'EUR';
  priceId: string;
  decrypt: boolean;
  api: boolean;
  priority: number;
  legacy: boolean;
  dailyDecryptLimit?: number;
  apiRatePerMinute?: number;
}

const planDefinitions: readonly PlanDefinition[] = [
  {
    id: 'regular',
    name: 'Regular',
    description: 'Dashboard decrypt access with standard queue priority.',
    amount: 5,
    currency: 'EUR',
    priceId: config.stripeRegularPriceId,
    decrypt: true,
    api: false,
    priority: 0,
    legacy: true,
  },
  {
    id: 'priority',
    name: 'Priority',
    description: 'Dashboard decrypt access with high queue priority.',
    amount: 10,
    currency: 'EUR',
    priceId: config.stripePriorityPriceId,
    decrypt: true,
    api: false,
    priority: 5,
    legacy: true,
  },
  {
    id: 'api',
    name: 'API',
    description: 'Dashboard decrypts and decrypt API + IPA library access with standard priority.',
    amount: 15,
    currency: 'EUR',
    priceId: config.stripeApiPriceId,
    decrypt: true,
    api: true,
    priority: 0,
    legacy: true,
  },
  {
    id: 'priority_api',
    name: 'Priority API',
    description: 'Dashboard decrypts and decrypt API + IPA library access with high queue priority.',
    amount: 20,
    currency: 'EUR',
    priceId: config.stripePriorityApiPriceId,
    decrypt: true,
    api: true,
    priority: 5,
    legacy: true,
  },
  { id: 'access', name: 'Access', description: 'IPA Library and two new decrypts per day.', amount: 2.5, currency: 'EUR', priceId: config.stripeAccessPriceId, decrypt: true, api: false, priority: 0, legacy: false, dailyDecryptLimit: 2 },
  { id: 'standard', name: 'Standard', description: 'IPA Library and ten new decrypts per day.', amount: 5, currency: 'EUR', priceId: config.stripeStandardPriceId, decrypt: true, api: false, priority: 0, legacy: false, dailyDecryptLimit: 10 },
  { id: 'plus', name: 'Plus', description: 'IPA Library and 25 new decrypts per day.', amount: 10, currency: 'EUR', priceId: config.stripePlusPriceId, decrypt: true, api: false, priority: 0, legacy: false, dailyDecryptLimit: 25 },
  { id: 'developer', name: 'Developer', description: 'IPA Library, 50 new decrypts per day, and API access.', amount: 15, currency: 'EUR', priceId: config.stripeDeveloperPriceId, decrypt: true, api: true, priority: 0, legacy: false, dailyDecryptLimit: 50, apiRatePerMinute: 30 },
  { id: 'unlimited', name: 'Unlimited', description: 'IPA Library, unlimited new decrypts, and API access.', amount: 20, currency: 'EUR', priceId: config.stripeUnlimitedPriceId, decrypt: true, api: true, priority: 0, legacy: false, apiRatePerMinute: 60 },
  { id: 'unlimited_priority', name: 'Unlimited Priority', description: 'Unlimited new decrypts, API access, and higher queue priority.', amount: 30, currency: 'EUR', priceId: config.stripeUnlimitedPriorityPriceId, decrypt: true, api: true, priority: 5, legacy: false, apiRatePerMinute: 120 },
];

const billingPath = path.join(config.stateDir, 'billing.json');
const billingDatabase = openStateCollectionDatabase({ stateDir: config.stateDir, filename: config.stateDatabaseFile, busyTimeoutMs: config.stateDbBusyTimeoutMs }, ['billing_records', 'billing_events']);
const billingRepository = createBillingRepository(billingDatabase);
const stripeActiveStatuses = new Set(['active', 'trialing', 'past_due']);
const checkoutLocks = new Set<string>();
let loadedFromLegacyFile = false;

function emptySnapshot(): BillingSnapshot {
  return { customers: [], subscriptions: [], cryptoCheckouts: [], cryptoCharges: [], processedEvents: [], entitlementHistory: [], stripeCheckoutIdempotency: [], accessCodes: [] };
}

function load(): BillingSnapshot {
  mkdirSync(config.stateDir, { recursive: true });
  const record = billingRepository.loadSnapshot();
  if (record !== undefined) {
    if (typeof record !== 'object' || record === null || (record as { kind?: unknown }).kind !== 'snapshot') throw new Error('billing database record is malformed');
    const snapshot = normalizeBillingSnapshot((record as { value?: unknown }).value);
    if (!snapshot) throw new Error('billing database snapshot is malformed');
    return snapshot;
  }
  if (!existsSync(billingPath)) return emptySnapshot();
  try {
    const snapshot = normalizeBillingSnapshot(JSON.parse(readFileSync(billingPath, 'utf8')));
    if (!snapshot) throw new Error('billing JSON snapshot is malformed');
    loadedFromLegacyFile = true;
    return snapshot;
  } catch (error) {
    throw new Error(`could not initialize billing state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const state = load();
if (loadedFromLegacyFile) persist();

export function billingSnapshotCollections(snapshot: BillingSnapshot): StateCollectionReplacement[] {
  return billingSnapshotReplacements(requireBillingSnapshot(snapshot));
}

function persist(): void {
  billingRepository.replaceSnapshot(requireBillingSnapshot(state));
  writeBillingSnapshotMirror();
}

function requireBillingSnapshot(value: unknown): BillingSnapshot {
  const normalized = normalizeBillingSnapshot(value);
  if (!normalized) throw new Error('billing snapshot is malformed');
  return normalized;
}

export function writeBillingSnapshotMirror(): void {
  writeStateMirror(billingPath, state);
}

export function closeBillingDatabase(): void {
  billingDatabase.close();
}

export function newBillingCatalogAvailableTo(userId?: string): boolean {
  if (config.billingCatalogRollout === 'all') return true;
  return config.billingCatalogRollout === 'canary' && userId !== undefined && config.billingCatalogCanaryUserIds.includes(userId);
}

export function listPlans(userId?: string) {
  const newCatalog = newBillingCatalogAvailableTo(userId);
  return planDefinitions
    .filter((plan) => plan.legacy !== newCatalog)
    .map(({ decrypt: _decrypt, ...plan }) => plan);
}

export function getPurchasablePlan(planId: string, userId?: string) {
  const plan = getPlan(planId);
  return plan && plan.legacy !== newBillingCatalogAvailableTo(userId) ? plan : undefined;
}

export function getPlan(planId: string) {
  return planDefinitions.find((plan) => plan.id === planId);
}

export function planForPrice(priceId: string): Exclude<PlanId, 'viewer'> | undefined {
  if (!priceId) return undefined;
  return planDefinitions.find((plan) => plan.priceId === priceId)?.id;
}

export function isBillingSubscriptionActive(subscription: BillingSubscription, now = Date.now()): boolean {
  if (subscription.provider === 'stripe') {
    if (subscription.paused && (!subscription.pauseResumesAt || Date.parse(subscription.pauseResumesAt) > now)) return false;
    return stripeActiveStatuses.has(subscription.status);
  }
  if (subscription.provider !== 'nowpayments') return false;
  if (subscription.status === 'active' && !subscription.flagged && !subscription.paused) return true;
  return subscription.status === 'past_due' && !!subscription.graceUntil && Date.parse(subscription.graceUntil) > now;
}

export function upsertBillingCustomer(customer: BillingCustomer): void {
  const existing = state.customers.find((item) => item.provider === customer.provider && item.customerId === customer.customerId);
  if (existing) Object.assign(existing, customer, { userId: customer.userId ?? existing.userId });
  else state.customers.push(customer);

  if (customer.userId) {
    for (const subscription of state.subscriptions) {
      if (subscription.provider === customer.provider && subscription.customerId === customer.customerId && !subscription.userId) subscription.userId = customer.userId;
    }
  }
  persist();
}

export function linkBillingCustomer(customerId: string, userId: string): void {
  const existing = state.customers.find((item) => item.provider === 'stripe' && item.customerId === customerId);
  if (existing) existing.userId = userId;
  else state.customers.push({ provider: 'stripe', customerId, email: '', userId, updatedAt: new Date().toISOString() });
  for (const subscription of state.subscriptions) {
    if (subscription.provider === 'stripe' && subscription.customerId === customerId && !subscription.userId) subscription.userId = userId;
  }
  persist();
}

export function upsertBillingSubscription(subscription: BillingSubscription): boolean {
  const existing = state.subscriptions.find((item) => item.provider === subscription.provider && item.subscriptionId === subscription.subscriptionId);
  if (existing && Date.parse(existing.occurredAt) > Date.parse(subscription.occurredAt)) return false;
  const previous = existing ? { ...existing } : undefined;
  const ownerId = subscription.userId ?? existing?.userId ?? state.customers.find((item) => item.provider === subscription.provider && item.customerId === subscription.customerId)?.userId;
  if (existing) Object.assign(existing, subscription, { userId: subscription.userId ?? existing.userId });
  else {
    const customer = state.customers.find((item) => item.provider === subscription.provider && item.customerId === subscription.customerId);
    state.subscriptions.push({ ...subscription, userId: subscription.userId ?? customer?.userId });
  }
  const kind = entitlementEventKind(previous, subscription);
  if (kind) {
    state.entitlementHistory = [
      ...(state.entitlementHistory ?? []),
      { id: `${subscription.subscriptionId}:${subscription.updatedAt}:${kind}`, userId: subscription.userId ?? previous?.userId, subscriptionId: subscription.subscriptionId, provider: subscription.provider, planId: subscription.planId, kind, status: subscription.status, at: subscription.updatedAt, detail: subscription.failureReason },
    ].slice(-5000);
  }
  persist();
  emitBillingChanged();
  if (ownerId) billingEntitlementChangeHandler?.(ownerId);
  return true;
}

export function getBillingCustomerId(userId: string): string | undefined {
  return billingRepository.findCustomerForUser('stripe', userId)?.customerId;
}

export function getBillingUserId(customerId: string): string | undefined {
  return billingRepository.findUserForCustomer('stripe', customerId);
}

export function getBillingSubscription(userId: string, subscriptionId: string): BillingSubscription | undefined {
  return billingRepository.findSubscription(userId, subscriptionId);
}

export function getBillingSubscriptionById(subscriptionId: string): BillingSubscription | undefined {
  return billingRepository.findSubscriptionById(subscriptionId);
}

export function getBillingSubscriptionIds(userId: string): string[] {
  return billingRepository.listSubscriptions({ userId })
    .filter((subscription) => isBillingSubscriptionActive(subscription))
    .map((subscription) => subscription.subscriptionId);
}

export function getBillingSubscriptionsForUser(userId: string): BillingSubscription[] {
  return billingRepository.listSubscriptions({ userId });
}

export function anonymizeBillingUser(userId: string): void {
  const replacement = `deleted+${createHash('sha256').update(userId).digest('hex').slice(0, 16)}@invalid`;
  let changed = false;
  for (const customer of state.customers) {
    if (customer.userId !== userId) continue;
    customer.userId = undefined;
    customer.email = replacement;
    changed = true;
  }
  for (const subscription of state.subscriptions) {
    if (subscription.userId !== userId) continue;
    subscription.userId = undefined;
    changed = true;
  }
  for (const checkout of state.cryptoCheckouts) {
    if (checkout.userId !== userId) continue;
    checkout.userId = 'deleted-user';
    changed = true;
  }
  for (const charge of state.cryptoCharges) {
    if (charge.userId !== userId) continue;
    charge.userId = 'deleted-user';
    changed = true;
  }
  for (const event of state.entitlementHistory ?? []) {
    if (event.userId !== userId) continue;
    event.userId = undefined;
    changed = true;
  }
  for (const accessCode of state.accessCodes ?? []) {
    if (accessCode.createdBy === userId) {
      accessCode.createdBy = undefined;
      changed = true;
    }
    if (accessCode.redeemedBy === userId) {
      accessCode.redeemedBy = undefined;
      changed = true;
    }
  }
  const retainedAttempts = (state.stripeCheckoutIdempotency ?? []).filter((attempt) => attempt.userId !== userId);
  if (retainedAttempts.length !== (state.stripeCheckoutIdempotency ?? []).length) {
    state.stripeCheckoutIdempotency = retainedAttempts;
    changed = true;
  }
  if (changed) persist();
}

export function listBillingSubscriptions(): BillingSubscription[] {
  return billingRepository.listSubscriptions();
}

export function filterBillingSubscriptions(filter: BillingSubscriptionFilter): BillingSubscription[] {
  return billingRepository.listSubscriptions(filter);
}

export function listBillingEntitlementHistory(subscriptionId?: string): BillingEntitlementEvent[] {
  return billingRepository.listEntitlementHistory(subscriptionId);
}

export function getBillingEntitlements(userId: string): BillingEntitlements {
  const subscriptionEntitlements = resolveBillingEntitlements(billingRepository.listSubscriptions({ userId }));
  if (subscriptionEntitlements.planId !== 'viewer' && !subscriptionEntitlements.paused) return subscriptionEntitlements;
  const accessCode = activeBillingAccessCode(userId);
  const plan = accessCode ? planDefinitions.find((definition) => definition.id === accessCode.planId) : undefined;
  if (accessCode && plan) return {
    planId: plan.id,
    decrypt: plan.decrypt,
    api: plan.api,
    priority: plan.priority,
    provider: 'gift',
    status: 'active',
    accessCodeId: accessCode.id,
    expiresAt: accessCode.expiresAt,
    dailyDecryptLimit: plan.dailyDecryptLimit,
    apiRatePerMinute: plan.apiRatePerMinute,
    legacy: plan.legacy,
  };
  if (userId.trim().toLowerCase() === 'root') return { planId: 'viewer', decrypt: true, api: true, priority: 0 };
  if (subscriptionEntitlements.paused) return {
    ...subscriptionEntitlements,
    planId: 'viewer',
    decrypt: true,
    api: false,
    priority: -5,
    freeTier: true,
    rollingDecryptLimit: 3,
    rollingDecryptWindowMs: 30 * 24 * 60 * 60 * 1000,
    dailyDecryptLimit: undefined,
    apiRatePerMinute: undefined,
    legacy: false,
  };
  if (!accessCode) return {
    ...subscriptionEntitlements,
    decrypt: true,
    priority: -5,
    freeTier: true,
    rollingDecryptLimit: 3,
    rollingDecryptWindowMs: 30 * 24 * 60 * 60 * 1000,
  };
  return subscriptionEntitlements;
}

export function createBillingAccessCode(input: { planId: string; durationDays: number; redeemWithinDays: number; createdBy?: string; now?: number }): { code: string; accessCode: BillingAccessCode } | undefined {
  const plan = planDefinitions.find((definition) => definition.id === input.planId);
  if (!plan || plan.legacy || !Number.isInteger(input.durationDays) || input.durationDays < 1 || input.durationDays > 3650 || !Number.isInteger(input.redeemWithinDays) || input.redeemWithinDays < 1 || input.redeemWithinDays > 365) return undefined;
  const code = formatBillingAccessCode(randomBytes(16).toString('hex'));
  const normalized = normalizeBillingAccessCode(code);
  const now = input.now ?? Date.now();
  const accessCode: BillingAccessCode = {
    id: `gift_${randomBytes(12).toString('hex')}`,
    codeHash: hashBillingAccessCode(normalized),
    prefix: `${code.slice(0, 12)}…`,
    planId: plan.id,
    durationDays: input.durationDays,
    redeemBy: new Date(now + input.redeemWithinDays * 24 * 60 * 60 * 1000).toISOString(),
    createdBy: input.createdBy,
    createdAt: new Date(now).toISOString(),
  };
  state.accessCodes ??= [];
  state.accessCodes.push(accessCode);
  persist();
  emitBillingChanged();
  return { code, accessCode: structuredClone(accessCode) };
}

export function listBillingAccessCodes(): Array<Omit<BillingAccessCode, 'codeHash'>> {
  return (state.accessCodes ?? []).map(({ codeHash: _codeHash, ...accessCode }) => structuredClone(accessCode));
}

export function revokeBillingAccessCode(id: string, now = Date.now()): BillingAccessCode | undefined {
  const accessCode = (state.accessCodes ?? []).find((candidate) => candidate.id === id);
  if (!accessCode || accessCode.revokedAt) return undefined;
  accessCode.revokedAt = new Date(now).toISOString();
  persist();
  emitBillingChanged();
  return structuredClone(accessCode);
}

export function redeemBillingAccessCode(inputCode: string, userId: string, now = Date.now()): { accessCode: BillingAccessCode } | { error: 'invalid_or_expired' | 'already_has_access' } {
  if (getBillingEntitlements(userId).planId !== 'viewer') return { error: 'already_has_access' };
  const normalized = normalizeBillingAccessCode(inputCode);
  const candidateHash = Buffer.from(hashBillingAccessCode(normalized), 'hex');
  let selected: BillingAccessCode | undefined;
  for (const accessCode of state.accessCodes ?? []) {
    const storedHash = Buffer.from(accessCode.codeHash, 'hex');
    const matches = storedHash.length === candidateHash.length && timingSafeEqual(storedHash, candidateHash);
    if (matches) selected = accessCode;
  }
  if (!selected || selected.redeemedAt || selected.revokedAt || Date.parse(selected.redeemBy) <= now) return { error: 'invalid_or_expired' };
  selected.redeemedBy = userId;
  selected.redeemedAt = new Date(now).toISOString();
  selected.expiresAt = new Date(now + selected.durationDays * 24 * 60 * 60 * 1000).toISOString();
  persist();
  emitBillingChanged();
  return { accessCode: structuredClone(selected) };
}

export function activeBillingAccessCode(userId: string, now = Date.now()): BillingAccessCode | undefined {
  return (state.accessCodes ?? []).find((accessCode) => accessCode.redeemedBy === userId && !accessCode.revokedAt && Date.parse(accessCode.expiresAt ?? '') > now);
}

function normalizeBillingAccessCode(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/^DKR-?/, '').replace(/[-\s]/g, '');
  return /^[A-F0-9]{32}$/.test(normalized) ? normalized : '';
}

function formatBillingAccessCode(value: string): string {
  const normalized = value.toUpperCase();
  return `DKR-${normalized.match(/.{1,4}/g)?.join('-') ?? normalized}`;
}

function hashBillingAccessCode(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hasActiveBillingSubscription(userId: string, now = Date.now()): boolean {
  return billingRepository.listSubscriptions({ userId }).some((subscription) => {
    if (isBillingSubscriptionActive(subscription, now)) return true;
    return subscription.provider === 'stripe'
      && subscription.paused === true
      && (!subscription.pauseResumesAt || Date.parse(subscription.pauseResumesAt) > now)
      && stripeActiveStatuses.has(subscription.status);
  });
}

export function acquireBillingCheckoutLock(userId: string): boolean {
  if (checkoutLocks.has(userId)) return false;
  checkoutLocks.add(userId);
  return true;
}

export function releaseBillingCheckoutLock(userId: string): void {
  checkoutLocks.delete(userId);
}

export function hasLegacyBillingRecord(userId: string): boolean {
  return (
    !!billingRepository.findCustomerForUser('legacy', userId) ||
    billingRepository.listSubscriptions({ provider: 'legacy', userId }).length > 0
  );
}

export function canCreateApiKeyImmediately(permissions: bigint, entitlements: BillingEntitlements): boolean {
  return hasPermission(permissions, PermissionFlag.approveApiKeys) || entitlements.api;
}

export function mergeBillingAccounts(targetUserId: string, sourceUserId: string): void {
  if (targetUserId === sourceUserId) return;
  let changed = false;
  for (const customer of state.customers) {
    if (customer.userId === sourceUserId) {
      customer.userId = targetUserId;
      changed = true;
    }
  }
  for (const subscription of state.subscriptions) {
    if (subscription.userId === sourceUserId) {
      subscription.userId = targetUserId;
      changed = true;
    }
  }
  for (const checkout of state.cryptoCheckouts) {
    if (checkout.userId === sourceUserId) {
      checkout.userId = targetUserId;
      changed = true;
    }
  }
  for (const charge of state.cryptoCharges) {
    if (charge.userId === sourceUserId) {
      charge.userId = targetUserId;
      changed = true;
    }
  }
  for (const attempt of state.stripeCheckoutIdempotency ?? []) {
    if (attempt.userId === sourceUserId) {
      attempt.userId = targetUserId;
      changed = true;
    }
  }
  for (const accessCode of state.accessCodes ?? []) {
    if (accessCode.redeemedBy === sourceUserId) {
      accessCode.redeemedBy = targetUserId;
      changed = true;
    }
    if (accessCode.createdBy === sourceUserId) {
      accessCode.createdBy = targetUserId;
      changed = true;
    }
  }
  if (changed) persist();
}

export function resolveBillingEntitlements(subscriptions: BillingSubscription[]): BillingEntitlements {
  const activeSubscriptions = subscriptions.filter((subscription) => isBillingSubscriptionActive(subscription));
  if (activeSubscriptions.length === 0) {
    const paused = subscriptions
      .filter((subscription) => subscription.provider === 'stripe' && subscription.paused && (!subscription.pauseResumesAt || Date.parse(subscription.pauseResumesAt) > Date.now()) && stripeActiveStatuses.has(subscription.status))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
    if (paused) return {
      planId: paused.planId,
      decrypt: false,
      api: false,
      priority: 0,
      provider: paused.provider,
      status: paused.status,
      subscriptionId: paused.subscriptionId,
      paused: true,
      pauseResumesAt: paused.pauseResumesAt,
    };
    return { planId: 'viewer', decrypt: false, api: false, priority: 0 };
  }

  const definitions = activeSubscriptions
    .map((subscription) => ({
      subscription,
      definition: planDefinitions.find((plan) => plan.id === subscription.planId),
    }))
    .filter((entry): entry is { subscription: BillingSubscription; definition: PlanDefinition } => !!entry.definition);

  const strongest = definitions.sort((a, b) => {
    const capabilityA = Number(a.definition.api) * 10 + a.definition.priority;
    const capabilityB = Number(b.definition.api) * 10 + b.definition.priority;
    return capabilityB - capabilityA;
  })[0];

  if (!strongest) return { planId: 'viewer', decrypt: false, api: false, priority: 0 };

  return {
    planId: strongest.definition.id,
    decrypt: definitions.some((entry) => entry.definition.decrypt),
    api: definitions.some((entry) => entry.definition.api),
    priority: Math.max(...definitions.map((entry) => entry.definition.priority)),
    provider: strongest.subscription.provider,
    status: strongest.subscription.status,
    subscriptionId: strongest.subscription.subscriptionId,
    paused: strongest.subscription.paused === true && !!strongest.subscription.pauseResumesAt && Date.parse(strongest.subscription.pauseResumesAt) > Date.now(),
    pauseResumesAt: strongest.subscription.pauseResumesAt,
    nextBilledAt: strongest.subscription.nextBilledAt,
    scheduledChangeAction: strongest.subscription.scheduledChangeAction,
    scheduledChangeAt: strongest.subscription.scheduledChangeAt,
    dailyDecryptLimit: strongest.definition.dailyDecryptLimit,
    apiRatePerMinute: strongest.definition.apiRatePerMinute,
    legacy: strongest.definition.legacy,
  };
}

export function findCryptoCheckout(userId: string, idempotencyKey: string): BillingCheckout | undefined {
  const checkout = billingRepository.findCheckoutByUserKey(userId, idempotencyKey);
  return checkout?.provider === 'nowpayments' ? checkout : undefined;
}

export function findStripeCheckoutIdempotencyAttempt(userId: string, idempotencyKey: string): StripeCheckoutIdempotencyAttempt | undefined {
  const attempt = state.stripeCheckoutIdempotency?.find((record) => record.userId === userId && record.idempotencyKey === idempotencyKey);
  const age = attempt ? Date.now() - attempt.createdAt : undefined;
  if (!attempt || age === undefined || age < 0 || age > STRIPE_CHECKOUT_IDEMPOTENCY_TTL_MS) return undefined;
  return structuredClone(attempt);
}

export function recordStripeCheckoutIdempotencyAttempt(attempt: StripeCheckoutIdempotencyAttempt): void {
  const now = Date.now();
  const records = (state.stripeCheckoutIdempotency ?? []).filter((record) => {
    const age = now - record.createdAt;
    return age >= 0 && age <= STRIPE_CHECKOUT_IDEMPOTENCY_TTL_MS;
  });
  const existingIndex = records.findIndex((record) => record.userId === attempt.userId && record.idempotencyKey === attempt.idempotencyKey);
  if (existingIndex >= 0) {
    const existing = records[existingIndex];
    if (existing.requestFingerprint !== attempt.requestFingerprint || existing.parametersFingerprint !== attempt.parametersFingerprint || existing.sessionId || !attempt.sessionId) return;
    records[existingIndex] = { ...existing, sessionId: attempt.sessionId };
  } else records.push(structuredClone(attempt));
  state.stripeCheckoutIdempotency = records;
  persist();
}

export function getCryptoCheckout(checkoutId: string): BillingCheckout | undefined {
  return billingRepository.findCheckout(checkoutId);
}

export function listCryptoCheckouts(): BillingCheckout[] {
  return billingRepository.listCheckouts();
}

export function upsertCryptoCheckout(checkout: BillingCheckout): void {
  const existing = state.cryptoCheckouts.find((item) => item.checkoutId === checkout.checkoutId);
  if (existing) {
    if (existing.status === 'completed' && checkout.status !== 'completed') return;
    if (existing.providerOccurredAt && checkout.providerOccurredAt && Date.parse(existing.providerOccurredAt) > Date.parse(checkout.providerOccurredAt)) return;
    if (checkout.status !== 'completed' && Date.parse(existing.updatedAt) > Date.parse(checkout.updatedAt)) return;
    Object.assign(existing, checkout);
  } else state.cryptoCheckouts.push(checkout);
  persist();
}

export function upsertBillingCharge(charge: BillingCharge): void {
  const existing = state.cryptoCharges.find((item) => item.chargeId === charge.chargeId);
  if (existing) {
    if (existing.status === 'refunded' && charge.status !== 'refunded') return;
    if (existing.status === 'succeeded' && charge.status !== 'succeeded' && charge.status !== 'refunded') return;
    if (existing.status !== 'pending' && Date.parse(existing.occurredAt) > Date.parse(charge.occurredAt)) return;
    Object.assign(existing, charge);
  } else state.cryptoCharges.push(charge);
  if (state.cryptoCharges.length > 5000) state.cryptoCharges.splice(0, state.cryptoCharges.length - 5000);
  persist();
}

export function getBillingCharge(chargeId: string): BillingCharge | undefined {
  return billingRepository.findCharge(chargeId);
}

export function getBillingChargeForNonce(subscriptionId: string, chargeNonce: number): BillingCharge | undefined {
  return billingRepository.findChargeForNonce(subscriptionId, chargeNonce);
}

export function listBillingCharges(): BillingCharge[] {
  return billingRepository.listCharges();
}

export function listBillingChargesForSubscription(subscriptionId: string): BillingCharge[] {
  return billingRepository.listChargesForSubscription(subscriptionId);
}

export function hasProcessedBillingEvent(eventId: string, provider?: BillingEventRecord['provider']): boolean {
  return billingRepository.hasProcessedEvent(provider, eventId);
}

export function recordBillingEvent(event: BillingEventRecord): void {
  if (!hasProcessedBillingEvent(event.eventId, event.provider)) state.processedEvents.push(event);
  if (state.processedEvents.length > 5000) state.processedEvents.splice(0, state.processedEvents.length - 5000);
  persist();
}

export function exportBillingSnapshot(): BillingSnapshot {
  return structuredClone(state);
}

export function isBillingSnapshot(value: unknown): value is BillingSnapshot {
  return normalizeBillingSnapshot(value) !== undefined;
}

export function replaceBillingSnapshot(snapshot: BillingSnapshot, options?: { persist?: boolean }): void;
export function replaceBillingSnapshot(snapshot: { customers: BillingCustomer[]; subscriptions: BillingSubscription[] }, options?: { persist?: boolean }): void;
export function replaceBillingSnapshot(snapshot: BillingSnapshot | { customers: BillingCustomer[]; subscriptions: BillingSubscription[] }, options: { persist?: boolean } = {}): void {
  const normalized = requireBillingSnapshot(snapshot);
  state.customers = normalized.customers;
  state.subscriptions = normalized.subscriptions;
  state.cryptoCheckouts = normalized.cryptoCheckouts;
  state.cryptoCharges = normalized.cryptoCharges;
  state.processedEvents = normalized.processedEvents;
  state.entitlementHistory = normalized.entitlementHistory ?? [];
  state.stripeCheckoutIdempotency = normalized.stripeCheckoutIdempotency ?? [];
  state.accessCodes = normalized.accessCodes ?? [];
  if (options.persist !== false) persist();
}

function entitlementEventKind(previous: BillingSubscription | undefined, next: BillingSubscription): BillingEntitlementEvent['kind'] | undefined {
  if (!previous) return 'grant';
  if (previous.paused !== next.paused) return next.paused ? 'pause' : 'resume';
  if (previous.status !== next.status) {
    if (next.status === 'cancelled' || next.status === 'canceled') return 'cancellation';
    if (next.status === 'past_due' || next.lastChargeStatus === 'failed') return 'failure';
    if (next.status === 'paused' || next.paused) return 'pause';
    if (next.status === 'active') return 'renewal';
    if (next.status === 'revoked') return 'revocation';
  }
  if (previous.lastChargeId !== next.lastChargeId && next.lastChargeStatus === 'succeeded') return 'renewal';
  return undefined;
}

function normalizeBillingSnapshot(value: unknown): BillingSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const snapshot = value as Record<string, unknown>;
  if (!Array.isArray(snapshot.customers) || !Array.isArray(snapshot.subscriptions)) return undefined;

  const customers: BillingCustomer[] = [];
  for (const customer of snapshot.customers) {
    if (typeof customer !== 'object' || customer === null) return undefined;
    const record = customer as Record<string, unknown>;
    const provider = billingProvider(record.provider);
    if (!provider || typeof record.customerId !== 'string' || typeof record.email !== 'string' || typeof record.updatedAt !== 'string') return undefined;
    customers.push({
      provider,
      customerId: record.customerId,
      email: record.email,
      userId: optionalString(record.userId),
      updatedAt: record.updatedAt,
    });
  }

  const subscriptions: BillingSubscription[] = [];
  for (const subscription of snapshot.subscriptions) {
    if (typeof subscription !== 'object' || subscription === null) return undefined;
    const record = subscription as Record<string, unknown>;
    const provider = billingProvider(record.provider);
    if (
      !provider ||
      typeof record.subscriptionId !== 'string' ||
      typeof record.customerId !== 'string' ||
      typeof record.status !== 'string' ||
      typeof record.planId !== 'string' ||
      !planDefinitions.some((plan) => plan.id === record.planId) ||
      typeof record.priceId !== 'string' ||
      typeof record.productId !== 'string' ||
      typeof record.occurredAt !== 'string' ||
      typeof record.updatedAt !== 'string'
    ) return undefined;
    subscriptions.push({
      provider,
      subscriptionId: record.subscriptionId,
      customerId: record.customerId,
      userId: optionalString(record.userId),
      status: record.status,
      planId: record.planId as Exclude<PlanId, 'viewer'>,
      priceId: record.priceId,
      productId: record.productId,
      subscriptionItemId: optionalString(record.subscriptionItemId),
      checkoutId: optionalString(record.checkoutId),
      externalCustomerId: optionalString(record.externalCustomerId),
      currency: optionalString(record.currency),
      amount: optionalNumber(record.amount),
      interval: optionalString(record.interval),
      walletAddress: optionalString(record.walletAddress),
      chain: optionalString(record.chain),
      asset: optionalString(record.asset),
      providerPaymentId: optionalString(record.providerPaymentId),
      nextBilledAt: optionalString(record.nextBilledAt),
      scheduledChangeAction: optionalString(record.scheduledChangeAction),
      scheduledChangeAt: optionalString(record.scheduledChangeAt),
      lastChargeAt: optionalString(record.lastChargeAt),
      lastChargeId: optionalString(record.lastChargeId),
      lastChargeStatus: billingChargeStatus(record.lastChargeStatus),
      lastChargeTxHash: optionalString(record.lastChargeTxHash),
      failureReason: optionalString(record.failureReason),
      graceUntil: optionalString(record.graceUntil),
      paused: optionalBoolean(record.paused),
      pauseResumesAt: optionalString(record.pauseResumesAt),
      flagged: optionalBoolean(record.flagged),
      taxAddress: taxAddress(record.taxAddress),
      taxStatus: billingTaxStatus(record.taxStatus),
      taxTransactionId: optionalString(record.taxTransactionId),
      occurredAt: record.occurredAt,
      updatedAt: record.updatedAt,
    });
  }

  return {
    customers,
    subscriptions,
    cryptoCheckouts: Array.isArray(snapshot.cryptoCheckouts) ? snapshot.cryptoCheckouts.map(normalizeRetiredBillingProvider).filter(isBillingCheckout).map((item) => structuredClone(item)) : [],
    cryptoCharges: Array.isArray(snapshot.cryptoCharges) ? snapshot.cryptoCharges.map(normalizeRetiredBillingProvider).filter(isBillingCharge).map((item) => structuredClone(item)) : [],
    processedEvents: Array.isArray(snapshot.processedEvents) ? snapshot.processedEvents.map(normalizeRetiredBillingProvider).filter(isBillingEvent).map((item) => structuredClone(item)) : [],
    entitlementHistory: Array.isArray(snapshot.entitlementHistory) ? snapshot.entitlementHistory.map(normalizeRetiredBillingProvider).filter(isEntitlementEvent).map((item) => structuredClone(item)) : [],
    stripeCheckoutIdempotency: Array.isArray(snapshot.stripeCheckoutIdempotency) ? snapshot.stripeCheckoutIdempotency.filter(isStripeCheckoutIdempotencyAttempt).map((item) => structuredClone(item)) : [],
    accessCodes: Array.isArray(snapshot.accessCodes) ? snapshot.accessCodes.filter(isBillingAccessCode).map((item) => structuredClone(item)) : [],
  };
}

function isBillingAccessCode(value: unknown): value is BillingAccessCode {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string'
    && typeof record.codeHash === 'string'
    && /^[a-f0-9]{64}$/.test(record.codeHash)
    && typeof record.prefix === 'string'
    && typeof record.planId === 'string'
    && planDefinitions.some((plan) => plan.id === record.planId)
    && typeof record.durationDays === 'number'
    && Number.isInteger(record.durationDays)
    && record.durationDays >= 1
    && record.durationDays <= 3650
    && typeof record.redeemBy === 'string'
    && Number.isFinite(Date.parse(record.redeemBy))
    && typeof record.createdAt === 'string'
    && Number.isFinite(Date.parse(record.createdAt))
    && (record.createdBy === undefined || typeof record.createdBy === 'string')
    && (record.redeemedBy === undefined || typeof record.redeemedBy === 'string')
    && (record.redeemedAt === undefined || (typeof record.redeemedAt === 'string' && Number.isFinite(Date.parse(record.redeemedAt))))
    && (record.expiresAt === undefined || (typeof record.expiresAt === 'string' && Number.isFinite(Date.parse(record.expiresAt))))
    && (record.revokedAt === undefined || (typeof record.revokedAt === 'string' && Number.isFinite(Date.parse(record.revokedAt))));
}

function isStripeCheckoutIdempotencyAttempt(value: unknown): value is StripeCheckoutIdempotencyAttempt {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.userId === 'string'
    && typeof record.idempotencyKey === 'string'
    && typeof record.requestFingerprint === 'string'
    && typeof record.parametersFingerprint === 'string'
    && typeof record.createdAt === 'number'
    && Number.isSafeInteger(record.createdAt)
    && (record.sessionId === undefined || typeof record.sessionId === 'string');
}

function normalizeRetiredBillingProvider(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return record.provider === 'exodus' ? { ...record, provider: 'legacy' } : value;
}

function billingProvider(value: unknown): BillingProvider | undefined {
  if (value === undefined || value === 'legacy') return 'legacy';
  if (value === 'exodus') return 'legacy';
  return value === 'stripe' || value === 'nowpayments' ? value : undefined;
}

function billingChargeStatus(value: unknown): BillingChargeStatus | undefined {
  return value === 'pending' || value === 'succeeded' || value === 'failed' || value === 'refunded' ? value : undefined;
}

function billingTaxStatus(value: unknown): BillingTaxStatus | undefined {
  return value === 'not_required' || value === 'pending' || value === 'recorded' || value === 'failed' ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function taxAddress(value: unknown): BillingTaxAddress | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.country !== 'string' || typeof record.postalCode !== 'string') return undefined;
  return {
    country: record.country,
    postalCode: record.postalCode,
    state: optionalString(record.state),
    city: optionalString(record.city),
    line1: optionalString(record.line1),
    line2: optionalString(record.line2),
  };
}

function isBillingCheckout(value: unknown): value is BillingCheckout {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.provider === 'nowpayments' || record.provider === 'legacy') &&
    typeof record.checkoutId === 'string' &&
    typeof record.userId === 'string' &&
    typeof record.idempotencyKey === 'string' &&
    typeof record.planId === 'string' &&
    planDefinitions.some((plan) => plan.id === record.planId) &&
    typeof record.amount === 'number' &&
    typeof record.currency === 'string' &&
    typeof record.status === 'string' &&
    ['pending', 'completed', 'expired', 'cancelled'].includes(record.status) &&
    typeof record.checkoutUrl === 'string' &&
    (record.providerOccurredAt === undefined || typeof record.providerOccurredAt === 'string') &&
    (record.providerStatus === undefined || typeof record.providerStatus === 'string') &&
    (record.taxStatus === undefined || billingTaxStatus(record.taxStatus) !== undefined) &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string'
  );
}

function isBillingCharge(value: unknown): value is BillingCharge {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.provider === 'nowpayments' || record.provider === 'legacy') &&
    typeof record.chargeId === 'string' &&
    typeof record.subscriptionId === 'string' &&
    typeof record.userId === 'string' &&
    billingChargeStatus(record.status) !== undefined &&
    typeof record.amount === 'number' &&
    typeof record.currency === 'string' &&
    typeof record.occurredAt === 'string' &&
    typeof record.updatedAt === 'string'
  );
}

function isBillingEvent(value: unknown): value is BillingEventRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (record.provider === 'nowpayments' || record.provider === 'legacy') && typeof record.eventId === 'string' && typeof record.occurredAt === 'string' && typeof record.processedAt === 'string';
}

function isEntitlementEvent(value: unknown): value is BillingEntitlementEvent {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.subscriptionId === 'string' && billingProvider(record.provider) !== undefined && typeof record.planId === 'string' && planDefinitions.some((plan) => plan.id === record.planId) && ['grant', 'renewal', 'pause', 'resume', 'failure', 'cancellation', 'revocation'].includes(String(record.kind)) && typeof record.status === 'string' && typeof record.at === 'string';
}
