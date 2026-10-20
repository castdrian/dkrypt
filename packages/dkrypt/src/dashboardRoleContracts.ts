import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';
import { identifierSchema } from '#apiCommonContracts.js';

export const dashboardRoleResponseSchema = Type.Object({
  id: identifierSchema,
  name: Type.String(),
  color: Type.String(),
  permissions: Type.String(),
  position: Type.Integer({ minimum: 0 }),
  isDefault: Type.Boolean(),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
}, { additionalProperties: true });

export const dashboardRolesResponseSchema = Type.Object({
  roles: Type.Array(dashboardRoleResponseSchema),
}, { additionalProperties: true });

export const dashboardRoleCreateBodySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  color: Type.String({ pattern: '^#[0-9a-fA-F]{6}$', maxLength: 7 }),
  permissions: Type.Optional(Type.String({ maxLength: 128 })),
}, { additionalProperties: true });

export const dashboardRoleUpdateBodySchema = Type.Object({
  name: Type.Optional(Type.String({ maxLength: 120 })),
  color: Type.Optional(Type.String({ pattern: '^#[0-9a-fA-F]{6}$', maxLength: 7 })),
  permissions: Type.Optional(Type.String({ maxLength: 128 })),
}, { additionalProperties: true });

export const dashboardRoleParamsSchema = Type.Object({ id: identifierSchema }, { additionalProperties: true });

export const dashboardRoleReorderBodySchema = Type.Object({
  roleIds: Type.Array(identifierSchema, { maxItems: 500 }),
}, { additionalProperties: true });

export const dashboardRoleOkResponseSchema = Type.Object({ ok: Type.Boolean() }, { additionalProperties: true });

export const dashboardRoleImpactBodySchema = Type.Object({ permissions: Type.String({ maxLength: 128 }) }, { additionalProperties: false });
export const dashboardRoleImpactResponseSchema = Type.Object({
  affectedCount: Type.Integer({ minimum: 0 }),
  members: Type.Array(Type.Object({ username: Type.String(), displayName: Type.Optional(Type.String()), beforePermissions: Type.String(), afterPermissions: Type.String() }), { maxItems: 100 }),
  truncated: Type.Boolean(),
  memberDetailsHidden: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export type DashboardRoleListRoute = {
  Reply: { 200: Static<typeof dashboardRolesResponseSchema>; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope };
};

export type DashboardRoleCreateRoute = {
  Body: Static<typeof dashboardRoleCreateBodySchema>;
  Reply: { 201: Static<typeof dashboardRoleResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope };
};

export type DashboardRoleUpdateRoute = {
  Params: Static<typeof dashboardRoleParamsSchema>;
  Body: Static<typeof dashboardRoleUpdateBodySchema>;
  Reply: { 200: Static<typeof dashboardRoleResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope };
};

export type DashboardRoleDeleteRoute = {
  Params: Static<typeof dashboardRoleParamsSchema>;
  Reply: { 200: Static<typeof dashboardRoleOkResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope };
};

export type DashboardRoleReorderRoute = {
  Body: Static<typeof dashboardRoleReorderBodySchema>;
  Reply: { 200: Static<typeof dashboardRolesResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope };
};

export type DashboardRoleImpactRoute = {
  Params: Static<typeof dashboardRoleParamsSchema>;
  Body: Static<typeof dashboardRoleImpactBodySchema>;
  Reply: { 200: Static<typeof dashboardRoleImpactResponseSchema>; 400: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope };
};
