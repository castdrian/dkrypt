import { Type, type Static } from '@sinclair/typebox';

export const billingIdempotencyKeyHeadersSchema = Type.Object(
  { 'idempotency-key': Type.Optional(Type.String({ minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9._~-]+$' })) },
  { additionalProperties: true },
);

export const billingCheckoutBodySchema = Type.Object(
  {
    planId: Type.String({ minLength: 1, maxLength: 200 }),
    provider: Type.Optional(Type.Union([Type.Literal('stripe'), Type.Literal('crypto')])),
    cryptoAsset: Type.Optional(Type.String({ minLength: 2, maxLength: 32 })),
  },
  { additionalProperties: true },
);

export const billingCheckoutControlBodySchema = Type.Object(
  { paused: Type.Boolean() },
  { additionalProperties: false },
);

export const billingAccessCodeCreateBodySchema = Type.Object({
  planId: Type.String({ minLength: 1, maxLength: 64 }),
  durationDays: Type.Integer({ minimum: 1, maximum: 3650 }),
  redeemWithinDays: Type.Integer({ minimum: 1, maximum: 365 }),
}, { additionalProperties: false });

export const billingAccessCodeRedeemBodySchema = Type.Object({
  code: Type.String({ minLength: 8, maxLength: 128 }),
}, { additionalProperties: false });

export const billingAccessCodeParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128 }),
}, { additionalProperties: false });

export const billingSubscriptionsQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    q: Type.Optional(Type.String({ maxLength: 200 })),
    provider: Type.Optional(Type.String({ maxLength: 32 })),
    status: Type.Optional(Type.String({ maxLength: 32 })),
    planId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    from: Type.Optional(Type.String({ maxLength: 64 })),
    to: Type.Optional(Type.String({ maxLength: 64 })),
    wallet: Type.Optional(Type.String({ maxLength: 200 })),
    invoice: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: true },
);

export const billingProviderStatusQuerySchema = Type.Object(
  { refresh: Type.Optional(Type.Literal('true')) },
  { additionalProperties: true },
);

export const billingRevenueQuerySchema = Type.Object(
  { refresh: Type.Optional(Type.Literal('true')) },
  { additionalProperties: true },
);

export const billingReconciliationQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
}, { additionalProperties: true });

export const billingReconciliationParamsSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: true });

export const billingReconciliationSyncBodySchema = Type.Object({
  expectedUpdatedAt: Type.String({ format: 'date-time' }),
  expectedStripeStatus: Type.String({ minLength: 1, maxLength: 64 }),
  expectedStripePriceId: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });

export const billingWebhookInboxQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    status: Type.Optional(Type.Union([Type.Literal('received'), Type.Literal('processed'), Type.Literal('failed'), Type.Literal('quarantined'), Type.Literal('needs_attention')])),
    provider: Type.Optional(Type.Union([Type.Literal('stripe'), Type.Literal('nowpayments')])),
  },
  { additionalProperties: true },
);

export const billingWebhookInboxParamsSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: true });
export const billingWebhookQuarantineBodySchema = Type.Object({ reason: Type.Optional(Type.String({ maxLength: 500 })) }, { additionalProperties: true });
export const billingSubscriptionPreviewBodySchema = Type.Object({ planId: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false });
export const billingSubscriptionBodySchema = Type.Object({ planId: Type.String({ minLength: 1, maxLength: 200 }), acknowledgeLegacyLoss: Type.Optional(Type.Boolean()), prorationDate: Type.Optional(Type.Integer({ minimum: 1 })), expectedCurrentPlanId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }, { additionalProperties: true });
export const billingPauseBodySchema = Type.Object({ resumeAt: Type.String({ format: 'date-time' }) }, { additionalProperties: false });

export type BillingCheckoutRoute = {
  Headers: Static<typeof billingIdempotencyKeyHeadersSchema>;
  Body: Static<typeof billingCheckoutBodySchema>;
};

export type BillingCheckoutControlRoute = {
  Body: Static<typeof billingCheckoutControlBodySchema>;
};

export type BillingAccessCodeCreateRoute = {
  Body: Static<typeof billingAccessCodeCreateBodySchema>;
};

export type BillingAccessCodeRedeemRoute = {
  Body: Static<typeof billingAccessCodeRedeemBodySchema>;
};

export type BillingAccessCodeRevokeRoute = {
  Params: Static<typeof billingAccessCodeParamsSchema>;
};

export type BillingCancelRoute = {
  Headers: Static<typeof billingIdempotencyKeyHeadersSchema>;
};

export type BillingSubscriptionsRoute = {
  Querystring: Static<typeof billingSubscriptionsQuerySchema>;
};

export type BillingProviderStatusRoute = {
  Querystring: Static<typeof billingProviderStatusQuerySchema>;
};

export type BillingRevenueRoute = {
  Querystring: Static<typeof billingRevenueQuerySchema>;
};

export type BillingReconciliationRoute = {
  Querystring: Static<typeof billingReconciliationQuerySchema>;
};

export type BillingReconciliationSyncRoute = {
  Params: Static<typeof billingReconciliationParamsSchema>;
  Body: Static<typeof billingReconciliationSyncBodySchema>;
};

export type BillingWebhookInboxRoute = {
  Querystring: Static<typeof billingWebhookInboxQuerySchema>;
};

export type BillingWebhookInboxParamsRoute = {
  Params: Static<typeof billingWebhookInboxParamsSchema>;
};

export type BillingWebhookQuarantineRoute = BillingWebhookInboxParamsRoute & {
  Body: Static<typeof billingWebhookQuarantineBodySchema>;
};

export type BillingSubscriptionRoute = {
  Body: Static<typeof billingSubscriptionBodySchema>;
};

export type BillingSubscriptionPreviewRoute = {
  Body: Static<typeof billingSubscriptionPreviewBodySchema>;
};

export type BillingPauseRoute = BillingCancelRoute & {
  Body: Static<typeof billingPauseBodySchema>;
};
