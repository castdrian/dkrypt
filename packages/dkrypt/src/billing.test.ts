import { describe, expect, test } from 'bun:test';
import {
  type BillingSnapshot,
  type BillingSubscription,
  canCreateApiKeyImmediately,
  createBillingAccessCode,
  exportBillingSnapshot,
  findStripeCheckoutIdempotencyAttempt,
  getBillingCustomerId,
  getBillingEntitlements,
  getPlan,
  hasLegacyBillingRecord,
  isBillingSnapshot,
  listPlans,
  listBillingAccessCodes,
  recordStripeCheckoutIdempotencyAttempt,
  redeemBillingAccessCode,
  revokeBillingAccessCode,
  replaceBillingSnapshot,
  resolveBillingEntitlements,
  upsertBillingSubscription,
} from '#billing.js';
import { dashboardEvents } from '#events.js';
import { PermissionFlag } from '#permissions.js';

function subscription(planId: BillingSubscription['planId'], status = 'active'): BillingSubscription {
  return {
    provider: 'stripe',
    subscriptionId: `sub_${planId}`,
    customerId: 'ctm_test',
    userId: 'github:1',
    status,
    planId,
    priceId: `pri_${planId}`,
    productId: `pro_${planId}`,
    occurredAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
  };
}

describe('resolveBillingEntitlements', () => {
  test('keeps users without a subscription viewer-only', () => {
    expect(resolveBillingEntitlements([])).toEqual({
      planId: 'viewer',
      decrypt: false,
      api: false,
      priority: 0,
    });
  });

  test('grants decrypts without API access on the regular plan', () => {
    expect(resolveBillingEntitlements([subscription('regular')])).toMatchObject({
      planId: 'regular',
      decrypt: true,
      api: false,
      priority: 0,
    });
  });

  test('grants API access on the API plan', () => {
    expect(resolveBillingEntitlements([subscription('api')])).toMatchObject({
      planId: 'api',
      decrypt: true,
      api: true,
      priority: 0,
    });
  });

  test('combines API and priority capabilities across subscriptions', () => {
    expect(resolveBillingEntitlements([subscription('api'), subscription('priority')])).toMatchObject({
      decrypt: true,
      api: true,
      priority: 5,
    });
  });

  test('revokes paid capabilities after cancellation', () => {
    expect(resolveBillingEntitlements([subscription('priority_api', 'canceled')])).toMatchObject({
      planId: 'viewer',
      decrypt: false,
      api: false,
      priority: 0,
    });
  });

  test('keeps legacy provider subscriptions from granting Stripe entitlements', () => {
    expect(resolveBillingEntitlements([{ ...subscription('priority'), provider: 'legacy' }])).toMatchObject({
      planId: 'viewer',
      decrypt: false,
      api: false,
      priority: 0,
    });
  });

  test('keeps old priority API benefits while defining the new daily ladder', () => {
    expect(resolveBillingEntitlements([subscription('priority_api')])).toMatchObject({
      planId: 'priority_api',
      decrypt: true,
      api: true,
      priority: 5,
      legacy: true,
    });
    expect(resolveBillingEntitlements([subscription('access')])).toMatchObject({ dailyDecryptLimit: 2, apiRatePerMinute: undefined });
    expect(resolveBillingEntitlements([subscription('standard')])).toMatchObject({ dailyDecryptLimit: 10 });
    expect(resolveBillingEntitlements([subscription('plus')])).toMatchObject({ dailyDecryptLimit: 25 });
    expect(resolveBillingEntitlements([subscription('developer')])).toMatchObject({ dailyDecryptLimit: 50, apiRatePerMinute: 30 });
    expect(resolveBillingEntitlements([subscription('unlimited')])).toMatchObject({ dailyDecryptLimit: undefined, apiRatePerMinute: 60 });
    expect(resolveBillingEntitlements([subscription('unlimited_priority')])).toMatchObject({ dailyDecryptLimit: undefined, apiRatePerMinute: 120, priority: 5 });
    expect(getPlan('priority_api')?.amount).toBe(20);
    expect(getPlan('access')?.amount).toBe(2.5);
    expect(listPlans().some((plan) => plan.id === 'priority_api')).toBe(true);
  });
});

describe('billing provider cutover', () => {
  test('normalizes and retains old provider records for reconciliation', () => {
    const userId = `legacy-${crypto.randomUUID()}`;
    const snapshot = {
      customers: [{ customerId: `cus_legacy_${crypto.randomUUID()}`, email: 'legacy@example.com', userId, updatedAt: '2026-07-23T00:00:00.000Z' }],
      subscriptions: [{
        subscriptionId: `sub_legacy_${crypto.randomUUID()}`,
        customerId: 'cus_legacy_missing',
        userId,
        status: 'active',
        planId: 'priority',
        priceId: 'price_legacy_priority',
        productId: 'prod_legacy_priority',
        occurredAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:00.000Z',
      }],
    };

    expect(isBillingSnapshot(snapshot)).toBe(true);
    replaceBillingSnapshot(snapshot as unknown as BillingSnapshot);
    expect(exportBillingSnapshot()).toMatchObject({ customers: [{ provider: 'legacy' }], subscriptions: [{ provider: 'legacy' }] });
    expect(hasLegacyBillingRecord(userId)).toBe(true);
    expect(getBillingCustomerId(userId)).toBeUndefined();
    expect(getBillingEntitlements(userId).planId).toBe('viewer');
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
  });
});

describe('prepaid billing access codes', () => {
  test('grants one fixed access period, stores only a hash, and rejects reuse', () => {
    const previousSnapshot = exportBillingSnapshot();
    const userId = `gift-user-${crypto.randomUUID()}`;
    const now = Date.parse('2026-10-25T12:00:00.000Z');

    try {
      replaceBillingSnapshot({ customers: [], subscriptions: [] });
      const created = createBillingAccessCode({ planId: 'standard', durationDays: 30, redeemWithinDays: 14, createdBy: 'manager', now });
      expect(created).toBeDefined();
      expect(created?.code).toMatch(/^DKR-(?:[A-F0-9]{4}-){7}[A-F0-9]{4}$/);
      expect(exportBillingSnapshot().accessCodes?.[0]?.codeHash).not.toContain(created?.code);
      expect(listBillingAccessCodes()[0]).not.toHaveProperty('codeHash');

      const redeemed = redeemBillingAccessCode(`  ${created!.code.toLowerCase()}  `, userId, now + 1000);
      expect(redeemed).toMatchObject({ accessCode: { planId: 'standard', redeemedBy: userId, durationDays: 30 } });
      expect(getBillingEntitlements(userId)).toMatchObject({ planId: 'standard', provider: 'gift', status: 'active', api: false });
      expect(getBillingEntitlements(userId).expiresAt).toBe(new Date(now + 1000 + 30 * 24 * 60 * 60 * 1000).toISOString());
      expect(redeemBillingAccessCode(created!.code, `other-${userId}`, now + 2000)).toEqual({ error: 'invalid_or_expired' });
      expect(redeemBillingAccessCode(created!.code, userId, now + 2000)).toEqual({ error: 'already_has_access' });
    } finally {
      replaceBillingSnapshot(previousSnapshot);
    }
  });

  test('expires unused codes, revokes active access, and rejects legacy plans', () => {
    const previousSnapshot = exportBillingSnapshot();
    const userId = `gift-expiry-${crypto.randomUUID()}`;
    const now = Date.parse('2026-10-25T12:00:00.000Z');

    try {
      replaceBillingSnapshot({ customers: [], subscriptions: [] });
      const expired = createBillingAccessCode({ planId: 'access', durationDays: 10, redeemWithinDays: 1, now });
      const active = createBillingAccessCode({ planId: 'unlimited_priority', durationDays: 7, redeemWithinDays: 10, now });
      expect(createBillingAccessCode({ planId: 'priority_api', durationDays: 7, redeemWithinDays: 10, now })).toBeUndefined();
      expect(redeemBillingAccessCode(expired!.code, userId, now + 24 * 60 * 60 * 1000)).toEqual({ error: 'invalid_or_expired' });
      expect(redeemBillingAccessCode(active!.code, userId, now + 1000)).toHaveProperty('accessCode');
      expect(revokeBillingAccessCode(active!.accessCode.id, now + 2000)).toMatchObject({ revokedAt: new Date(now + 2000).toISOString() });
      expect(getBillingEntitlements(userId)).toMatchObject({ planId: 'viewer', decrypt: false, api: false });
      expect(listBillingAccessCodes().find((code) => code.id === active!.accessCode.id)).toHaveProperty('revokedAt');
    } finally {
      replaceBillingSnapshot(previousSnapshot);
    }
  });

  test('accepts pre-feature billing backups without an access-code collection', () => {
    expect(isBillingSnapshot({ customers: [], subscriptions: [] })).toBe(true);
    expect(exportBillingSnapshot().accessCodes).toBeDefined();
  });
});

describe('billing dashboard updates', () => {
  test('emits invalidation events for accepted subscription changes only', () => {
    const previousSnapshot = exportBillingSnapshot();
    const initial = subscription('regular');
    initial.subscriptionId = `sub_${crypto.randomUUID()}`;
    initial.occurredAt = '2026-07-23T00:00:00.000Z';
    initial.updatedAt = initial.occurredAt;
    const emitted: string[] = [];
    const onBillingChanged = () => emitted.push('changed');
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    dashboardEvents.on('billingChanged', onBillingChanged);

    try {
      expect(upsertBillingSubscription(initial)).toBe(true);
      expect(upsertBillingSubscription({
        ...initial,
        status: 'canceled',
        occurredAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-24T00:00:00.000Z',
      })).toBe(true);
      expect(upsertBillingSubscription({ ...initial, status: 'active' })).toBe(false);
      expect(emitted).toHaveLength(2);
    } finally {
      dashboardEvents.off('billingChanged', onBillingChanged);
      replaceBillingSnapshot(previousSnapshot);
    }
  });
});

describe('Stripe checkout idempotency persistence', () => {
  test('retains existing attempts across persisted billing snapshots', () => {
    const previousSnapshot = exportBillingSnapshot();
    const attempt = {
      userId: `checkout-user-${crypto.randomUUID()}`,
      idempotencyKey: `dkrypt-checkout-${crypto.randomUUID()}`,
      requestFingerprint: `fingerprint-${crypto.randomUUID()}`,
      parametersFingerprint: `parameters-${crypto.randomUUID()}`,
      createdAt: Date.now(),
    };

    try {
      recordStripeCheckoutIdempotencyAttempt(attempt);

      expect(findStripeCheckoutIdempotencyAttempt(attempt.userId, attempt.idempotencyKey)).toEqual(attempt);
      expect(exportBillingSnapshot().stripeCheckoutIdempotency).toContainEqual(attempt);
      expect(isBillingSnapshot(exportBillingSnapshot())).toBe(true);
    } finally {
      replaceBillingSnapshot(previousSnapshot);
    }
  });

  test('keeps every unexpired attempt when a busy period exceeds ten thousand checkouts', () => {
    const previousSnapshot = exportBillingSnapshot();
    const createdAt = Date.now();
    const retainedAttempts = Array.from({ length: 10_000 }, (_, index) => ({
      userId: `busy-checkout-user-${index}`,
      idempotencyKey: `busy-checkout-key-${index}`,
      requestFingerprint: `busy-checkout-request-${index}`,
      parametersFingerprint: `busy-checkout-parameters-${index}`,
      createdAt,
    }));
    const finalAttempt = {
      userId: 'busy-checkout-final-user',
      idempotencyKey: 'busy-checkout-final-key',
      requestFingerprint: 'busy-checkout-final-request',
      parametersFingerprint: 'busy-checkout-final-parameters',
      createdAt,
    };

    try {
      replaceBillingSnapshot({ ...previousSnapshot, stripeCheckoutIdempotency: retainedAttempts });
      recordStripeCheckoutIdempotencyAttempt(finalAttempt);

      expect(exportBillingSnapshot().stripeCheckoutIdempotency).toHaveLength(10_001);
      expect(findStripeCheckoutIdempotencyAttempt(retainedAttempts[0].userId, retainedAttempts[0].idempotencyKey)).toEqual(retainedAttempts[0]);
      expect(findStripeCheckoutIdempotencyAttempt(finalAttempt.userId, finalAttempt.idempotencyKey)).toEqual(finalAttempt);
    } finally {
      replaceBillingSnapshot(previousSnapshot);
    }
  });
});

describe('canCreateApiKeyImmediately', () => {
  test('auto-approves paid API plans and API-key approvers', () => {
    const viewer = resolveBillingEntitlements([]);
    const priority = resolveBillingEntitlements([subscription('priority')]);
    const api = resolveBillingEntitlements([subscription('api')]);

    expect(canCreateApiKeyImmediately(0n, viewer)).toBe(false);
    expect(canCreateApiKeyImmediately(0n, priority)).toBe(false);
    expect(canCreateApiKeyImmediately(0n, api)).toBe(true);
    expect(canCreateApiKeyImmediately(PermissionFlag.approveApiKeys, viewer)).toBe(true);
  });
});
