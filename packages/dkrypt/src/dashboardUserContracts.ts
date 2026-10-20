import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';
import { identifierSchema } from '#apiCommonContracts.js';

const userActivitySchema = Type.Object({
  manualJobs: Type.Integer({ minimum: 0 }),
  completedJobs: Type.Integer({ minimum: 0 }),
  failedJobs: Type.Integer({ minimum: 0 }),
  lastJobAt: Type.Optional(Type.Number()),
  apiKeys: Type.Integer({ minimum: 0 }),
  apiRequests30d: Type.Integer({ minimum: 0 }),
}, { additionalProperties: true });

const userBillingEntitlementsSchema = Type.Object({
  planId: Type.Union([
    Type.Literal('regular'),
    Type.Literal('priority'),
    Type.Literal('api'),
    Type.Literal('priority_api'),
  ]),
  decrypt: Type.Boolean(),
  api: Type.Boolean(),
  priority: Type.Number(),
}, { additionalProperties: false });

export const dashboardUserDirectoryResponseSchema = Type.Object({
  users: Type.Array(Type.Object({
    username: identifierSchema,
    accountUsername: Type.Optional(Type.String()),
    displayName: Type.String(),
    avatarUrl: Type.Optional(Type.String()),
    roleIds: Type.Array(identifierSchema),
    billingEntitlements: Type.Optional(userBillingEntitlementsSchema),
    addedAt: Type.Number(),
    lastActiveAt: Type.Optional(Type.Number()),
    priority: Type.Optional(Type.Number()),
    activity: Type.Optional(userActivitySchema),
  }, { additionalProperties: true })),
}, { additionalProperties: true });

export const dashboardAllowedUserResponseSchema = Type.Object({
  username: identifierSchema,
  roleIds: Type.Array(identifierSchema),
  addedAt: Type.Number(),
  sessionVersion: Type.Optional(Type.Number()),
  lastActiveAt: Type.Optional(Type.Number()),
  priority: Type.Optional(Type.Number()),
}, { additionalProperties: true });

export const dashboardUserParamsSchema = Type.Object({ username: identifierSchema }, { additionalProperties: true });

export const dashboardUserCreateBodySchema = Type.Object({
  username: Type.String({ minLength: 1, maxLength: 200 }),
  roleIds: Type.Array(identifierSchema, { maxItems: 500 }),
}, { additionalProperties: true });

export const dashboardUserUpdateBodySchema = Type.Object({
  roleIds: Type.Array(identifierSchema, { maxItems: 500 }),
  priority: Type.Optional(Type.Number()),
}, { additionalProperties: true });

export const dashboardUserOkResponseSchema = Type.Object({ ok: Type.Boolean() }, { additionalProperties: true });

export type DashboardUserListRoute = {
  Reply: { 200: Static<typeof dashboardUserDirectoryResponseSchema>; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope };
};

export type DashboardUserCreateRoute = {
  Body: Static<typeof dashboardUserCreateBodySchema>;
  Reply: { 201: Static<typeof dashboardAllowedUserResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope };
};

export type DashboardUserUpdateRoute = {
  Params: Static<typeof dashboardUserParamsSchema>;
  Body: Static<typeof dashboardUserUpdateBodySchema>;
  Reply: { 200: Static<typeof dashboardAllowedUserResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope };
};

export type DashboardUserDeleteRoute = {
  Params: Static<typeof dashboardUserParamsSchema>;
  Reply: { 200: Static<typeof dashboardUserOkResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope };
};
