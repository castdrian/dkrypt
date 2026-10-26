import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';
import { bundleIdSchema, identifierSchema, paginationQueryProperties } from '#apiCommonContracts.js';

export const dashboardApiKeyResponseSchema = Type.Object({
  id: identifierSchema,
  name: Type.String(),
  ownerId: identifierSchema,
  ownerDisplayName: Type.Optional(Type.String()),
  ownerUsername: Type.Optional(Type.String()),
  status: Type.Union([Type.Literal('pending'), Type.Literal('approved'), Type.Literal('denied')]),
  createdAt: Type.Number(),
  approvedAt: Type.Optional(Type.Number()),
  lastUsedAt: Type.Optional(Type.Number()),
  expiresAt: Type.Optional(Type.Number()),
  hasUnrevealedSecret: Type.Optional(Type.Boolean()),
  lastUsedIp: Type.Optional(Type.String()),
  allowedBundleIds: Type.Optional(Type.Array(bundleIdSchema)),
  dailyLimit: Type.Optional(Type.Number()),
  maxConcurrent: Type.Optional(Type.Number()),
  allowTestFlight: Type.Optional(Type.Boolean()),
  priority: Type.Optional(Type.Number()),
  previousKeyValidUntil: Type.Optional(Type.Number()),
}, { additionalProperties: true });

export const dashboardApiKeyCollectionResponseSchema = Type.Object({
  keys: Type.Array(dashboardApiKeyResponseSchema),
}, { additionalProperties: true });

export const dashboardApiKeyPageResponseSchema = Type.Object({
  keys: Type.Array(dashboardApiKeyResponseSchema),
  total: Type.Integer({ minimum: 0 }),
  nextCursor: Type.Optional(Type.String()),
}, { additionalProperties: true });

export const dashboardApiKeyUsageResponseSchema = Type.Object({
  usage: Type.Array(Type.Object({ date: Type.String(), count: Type.Integer({ minimum: 0 }) })),
}, { additionalProperties: true });

export const dashboardApiKeyBundleUsageResponseSchema = Type.Object({
  bundles: Type.Array(Type.Object({ bundleId: bundleIdSchema, count: Type.Integer({ minimum: 0 }) })),
}, { additionalProperties: true });

export const dashboardApiKeyOutcomeResponseSchema = Type.Object({
  outcomes: Type.Array(Type.Object({
    route: Type.String(),
    success: Type.Integer({ minimum: 0 }),
    clientError: Type.Integer({ minimum: 0 }),
    serverError: Type.Integer({ minimum: 0 }),
    lastAt: Type.Number(),
    latencyCount: Type.Optional(Type.Integer({ minimum: 0 })),
    averageLatencyMs: Type.Optional(Type.Number({ minimum: 0 })),
    maxLatencyMs: Type.Optional(Type.Number({ minimum: 0 })),
  })),
}, { additionalProperties: true });

export const dashboardApiKeyRequestsQuerySchema = Type.Object({
  limit: Type.Optional(Type.String()),
}, { additionalProperties: true });

export const dashboardApiKeyRequestsResponseSchema = Type.Object({
  requests: Type.Array(Type.Object({
    at: Type.Number(),
    method: Type.String(),
    route: Type.String(),
    status: Type.Integer({ minimum: 100, maximum: 599 }),
    durationMs: Type.Optional(Type.Number({ minimum: 0 })),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export const dashboardApiKeySecretResponseSchema = Type.Object({
  id: identifierSchema,
  name: Type.String(),
  key: Type.String(),
  createdAt: Type.Number(),
  expiresAt: Type.Optional(Type.Number()),
}, { additionalProperties: true });

export const dashboardApiKeyRegenerateResponseSchema = Type.Object({
  ok: Type.Boolean(),
  key: Type.Optional(dashboardApiKeyResponseSchema),
}, { additionalProperties: true });

export const dashboardApiKeyOkResponseSchema = Type.Object({ ok: Type.Boolean() }, { additionalProperties: true });
export const dashboardApiKeyRevealResponseSchema = Type.Object({ key: Type.String() }, { additionalProperties: true });
export const dashboardApiKeyRevokedResponseSchema = Type.Object({ revoked: Type.Array(identifierSchema) }, { additionalProperties: true });
export const dashboardApiKeyExtendedResponseSchema = Type.Object({ extended: Type.Array(identifierSchema) }, { additionalProperties: true });
export const dashboardApiKeyUpdatedResponseSchema = Type.Object({ updated: Type.Array(identifierSchema) }, { additionalProperties: true });
export const dashboardApiKeyApprovedResponseSchema = Type.Object({ approved: Type.Array(identifierSchema) }, { additionalProperties: true });
export const dashboardApiKeyPriorityResponseSchema = Type.Object({ ok: Type.Boolean(), priority: Type.Number() }, { additionalProperties: true });
export const dashboardApiKeyConcurrencyResponseSchema = Type.Object({
  ok: Type.Boolean(),
  maxConcurrent: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
}, { additionalProperties: true });
export const dashboardApiKeyTestFlightResponseSchema = Type.Object({ ok: Type.Boolean(), allowTestFlight: Type.Boolean() }, { additionalProperties: true });

export const dashboardApiKeyParamsSchema = Type.Object({ id: identifierSchema }, { additionalProperties: true });

export const dashboardApiKeyCreateBodySchema = Type.Object({
  name: Type.String({ minLength: 1, pattern: '\\S' }),
  expiresInDays: Type.Optional(Type.Unknown({ description: 'Only 1, 7, 30, or 90 are applied; other values are ignored.' })),
  allowedBundleIds: Type.Optional(Type.Unknown({ description: 'Valid bundle IDs are retained, up to 25; invalid values are ignored.' })),
  dailyLimit: Type.Optional(Type.Unknown({ description: 'Finite numbers are rounded and clamped to 1–10000; other values are ignored.' })),
  allowTestFlight: Type.Optional(Type.Unknown({ description: 'Boolean values are applied; other values are ignored.' })),
}, { additionalProperties: true });

export const dashboardApiKeyGraceBodySchema = Type.Object({
  graceMinutes: Type.Optional(Type.Unknown({ description: 'Positive finite numbers are used; other values default to immediate rotation.' })),
}, { additionalProperties: true });

export const dashboardApiKeyBulkIdsBodySchema = Type.Object({
  ids: Type.Array(identifierSchema, { maxItems: 100 }),
}, { additionalProperties: true });

export const dashboardApiKeyBulkExpiryBodySchema = Type.Object({
  ids: Type.Array(identifierSchema, { maxItems: 100 }),
  days: Type.Integer({ minimum: 1, maximum: 3650 }),
}, { additionalProperties: true });

export const dashboardApiKeyBulkDailyLimitBodySchema = Type.Object({
  ids: Type.Array(identifierSchema, { maxItems: 100 }),
  dailyLimit: Type.Union([Type.Number(), Type.Null()]),
}, { additionalProperties: true });

export const dashboardApiKeyBulkScopeBodySchema = Type.Object({
  ids: Type.Array(identifierSchema, { maxItems: 100 }),
  allowedBundleIds: Type.Union([Type.Array(bundleIdSchema, { maxItems: 25 }), Type.Null()]),
}, { additionalProperties: true });

export const dashboardApiKeyPriorityBodySchema = Type.Object({ priority: Type.Number() }, { additionalProperties: true });

export const dashboardApiKeyConcurrencyBodySchema = Type.Object({
  maxConcurrent: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
}, { additionalProperties: true });

export const dashboardApiKeyTestFlightBodySchema = Type.Object({ allowTestFlight: Type.Boolean() }, { additionalProperties: true });

export const dashboardApiKeyListQuerySchema = Type.Object({
  ...paginationQueryProperties,
  search: Type.Optional(Type.String({ maxLength: 200 })),
}, { additionalProperties: true });

export const dashboardApiKeyUsageQuerySchema = Type.Object({ days: Type.Optional(Type.String()) }, { additionalProperties: true });
export const dashboardApiKeyUsageLimitQuerySchema = Type.Object({ limit: Type.Optional(Type.String()) }, { additionalProperties: true });

type ApiKeyErrorReplies = {
  400: ApiErrorEnvelope;
  401: ApiErrorEnvelope;
  403: ApiErrorEnvelope;
  404: ApiErrorEnvelope;
};

type ApiKeyReply<Status extends number, Success> = {
  Reply: ApiKeyErrorReplies & Record<Status, Success>;
};

export type DashboardApiKeyListRoute = ApiKeyReply<200, Static<typeof dashboardApiKeyCollectionResponseSchema>>;
export type DashboardApiKeyCreateRequestRoute = { Body: Static<typeof dashboardApiKeyCreateBodySchema> } & ApiKeyReply<201, Static<typeof dashboardApiKeyResponseSchema>>;
export type DashboardApiKeyCreateRoute = { Body: Static<typeof dashboardApiKeyCreateBodySchema> } & ApiKeyReply<201, Static<typeof dashboardApiKeySecretResponseSchema>>;
export type DashboardApiKeyIdRoute = { Params: Static<typeof dashboardApiKeyParamsSchema> } & ApiKeyReply<200, Static<typeof dashboardApiKeyOkResponseSchema>>;
export type DashboardApiKeyRevealRoute = { Params: Static<typeof dashboardApiKeyParamsSchema> } & ApiKeyReply<200, Static<typeof dashboardApiKeyRevealResponseSchema>>;
export type DashboardApiKeyRegenerateRoute = {
  Params: Static<typeof dashboardApiKeyParamsSchema>;
  Body: Static<typeof dashboardApiKeyGraceBodySchema>;
} & ApiKeyReply<200, Static<typeof dashboardApiKeyRegenerateResponseSchema>>;
export type DashboardApiKeyBulkRevokeRoute = { Body: Static<typeof dashboardApiKeyBulkIdsBodySchema> } & ApiKeyReply<200, Static<typeof dashboardApiKeyRevokedResponseSchema>>;
export type DashboardApiKeyBulkApproveRoute = { Body: Static<typeof dashboardApiKeyBulkIdsBodySchema> } & ApiKeyReply<200, Static<typeof dashboardApiKeyApprovedResponseSchema>>;
export type DashboardApiKeyBulkExpiryRoute = { Body: Static<typeof dashboardApiKeyBulkExpiryBodySchema> } & ApiKeyReply<200, Static<typeof dashboardApiKeyExtendedResponseSchema>>;
export type DashboardApiKeyBulkDailyLimitRoute = { Body: Static<typeof dashboardApiKeyBulkDailyLimitBodySchema> } & ApiKeyReply<200, Static<typeof dashboardApiKeyUpdatedResponseSchema>>;
export type DashboardApiKeyBulkScopeRoute = { Body: Static<typeof dashboardApiKeyBulkScopeBodySchema> } & ApiKeyReply<200, Static<typeof dashboardApiKeyUpdatedResponseSchema>>;
export type DashboardApiKeyUsageRoute = {
  Params: Static<typeof dashboardApiKeyParamsSchema>;
  Querystring: Static<typeof dashboardApiKeyUsageQuerySchema>;
} & ApiKeyReply<200, Static<typeof dashboardApiKeyUsageResponseSchema>>;
export type DashboardApiKeyBundleUsageRoute = {
  Params: Static<typeof dashboardApiKeyParamsSchema>;
  Querystring: Static<typeof dashboardApiKeyUsageLimitQuerySchema>;
} & ApiKeyReply<200, Static<typeof dashboardApiKeyBundleUsageResponseSchema>>;
export type DashboardApiKeyOutcomeRoute = {
  Params: Static<typeof dashboardApiKeyParamsSchema>;
  Querystring: Static<typeof dashboardApiKeyUsageLimitQuerySchema>;
} & ApiKeyReply<200, Static<typeof dashboardApiKeyOutcomeResponseSchema>>;
export type DashboardApiKeyRequestsRoute = {
  Params: Static<typeof dashboardApiKeyParamsSchema>;
  Querystring: Static<typeof dashboardApiKeyRequestsQuerySchema>;
} & ApiKeyReply<200, Static<typeof dashboardApiKeyRequestsResponseSchema>>;
export type DashboardApiKeyPageRoute = {
  Querystring: Static<typeof dashboardApiKeyListQuerySchema>;
} & ApiKeyReply<200, Static<typeof dashboardApiKeyPageResponseSchema>>;
export type DashboardApiKeyPriorityRoute = {
  Params: Static<typeof dashboardApiKeyParamsSchema>;
  Body: Static<typeof dashboardApiKeyPriorityBodySchema>;
} & ApiKeyReply<200, Static<typeof dashboardApiKeyPriorityResponseSchema>>;
export type DashboardApiKeyConcurrencyRoute = {
  Params: Static<typeof dashboardApiKeyParamsSchema>;
  Body: Static<typeof dashboardApiKeyConcurrencyBodySchema>;
} & ApiKeyReply<200, Static<typeof dashboardApiKeyConcurrencyResponseSchema>>;
export type DashboardApiKeyTestFlightRoute = {
  Params: Static<typeof dashboardApiKeyParamsSchema>;
  Body: Static<typeof dashboardApiKeyTestFlightBodySchema>;
} & ApiKeyReply<200, Static<typeof dashboardApiKeyTestFlightResponseSchema>>;
