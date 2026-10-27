import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';
import { identifierSchema, paginationQueryProperties } from '#apiCommonContracts.js';

const auditActionSchema = Type.Union([
  Type.Literal('user.add'),
  Type.Literal('user.update'),
  Type.Literal('user.remove'),
  Type.Literal('state.import'),
  Type.Literal('settings.update'),
  Type.Literal('watch.add'),
  Type.Literal('watch.update'),
  Type.Literal('watch.remove'),
  Type.Literal('watch.import'),
  Type.Literal('watch.billing-owner-request'),
  Type.Literal('watch.billing-owner-accept'),
  Type.Literal('device.add'),
  Type.Literal('device.update'),
  Type.Literal('device.remove'),
  Type.Literal('role.add'),
  Type.Literal('role.update'),
  Type.Literal('role.remove'),
  Type.Literal('backup.schedule-update'),
  Type.Literal('backup.create'),
  Type.Literal('backup.drill'),
  Type.Literal('backup.delete'),
  Type.Literal('testflight-subscription.add'),
  Type.Literal('testflight-subscription.approve'),
  Type.Literal('testflight-subscription.deny'),
  Type.Literal('testflight-subscription.sync'),
  Type.Literal('testflight-subscription.remove'),
  Type.Literal('billing.checkout'),
  Type.Literal('billing.access_code.create'),
  Type.Literal('billing.access_code.redeem'),
  Type.Literal('billing.access_code.revoke'),
  Type.Literal('billing.activated'),
  Type.Literal('billing.charge'),
  Type.Literal('billing.charge-failed'),
  Type.Literal('billing.refund'),
  Type.Literal('billing.cancel'),
  Type.Literal('billing.pause'),
  Type.Literal('billing.resume'),
  Type.Literal('billing.webhook'),
  Type.Literal('billing.webhook.sync'),
  Type.Literal('billing.webhook.replay'),
  Type.Literal('billing.webhook.quarantine'),
  Type.Literal('billing.reconciliation.sync'),
  Type.Literal('billing.entitlement.refresh'),
  Type.Literal('billing.checkouts.pause'),
  Type.Literal('privacy.export'),
  Type.Literal('privacy.delete'),
  Type.Literal('auth.passkey.add'),
  Type.Literal('auth.passkey.remove'),
  Type.Literal('auth.passkey.login'),
  Type.Literal('auth.passkey.reauthenticate'),
  Type.Literal('auth.session.new_context'),
  Type.Literal('project.add'),
  Type.Literal('project.update'),
  Type.Literal('project.archive'),
  Type.Literal('project.restore'),
  Type.Literal('artifact.pin'),
  Type.Literal('artifact.unpin'),
  Type.Literal('artifact.archive'),
  Type.Literal('artifact.restore'),
  Type.Literal('incident.update'),
  Type.Literal('job.resolution-notice'),
  Type.Literal('integration.create'),
  Type.Literal('integration.rotate'),
  Type.Literal('integration.revoke'),
  Type.Literal('integration.billing-owner-request'),
  Type.Literal('integration.billing-owner-accept'),
  Type.Literal('auth.account.link'),
  Type.Literal('auth.account.merge'),
  Type.Literal('mcp.agent.connect'),
  Type.Literal('mcp.agent.revoke'),
  Type.Literal('mcp.decrypt.approve'),
  Type.Literal('mcp.decrypt.deny'),
  Type.Literal('billing.decrypt-credit.grant'),
  Type.Literal('billing.decrypt-credit.refund'),
]);

export const dashboardLogsQuerySchema = Type.Object({
  ...paginationQueryProperties,
  scope: Type.Optional(Type.String({ maxLength: 100 })),
  level: Type.Optional(Type.Union([Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')])),
  q: Type.Optional(Type.String({ maxLength: 100 })),
  regex: Type.Optional(Type.Literal('1')),
}, { additionalProperties: true });

export const dashboardAuditLogQuerySchema = Type.Object(paginationQueryProperties, { additionalProperties: true });

export const dashboardAuditLogExportQuerySchema = Type.Object({
  format: Type.Optional(Type.Union([
    Type.String({ description: 'Only csv selects CSV output; other values return JSON.' }),
    Type.Array(Type.String()),
  ])),
}, { additionalProperties: true });

export const dashboardAuditLogEntrySchema = Type.Object({
  id: identifierSchema,
  ts: Type.Number(),
  actor: Type.String(),
  actorDisplayName: Type.Optional(Type.String()),
  action: auditActionSchema,
  target: Type.String(),
  detail: Type.Optional(Type.String()),
}, { additionalProperties: true });

export const dashboardLogsResponseSchema = Type.Object({
  logs: Type.Array(Type.Object({
    id: identifierSchema,
    ts: Type.Number(),
    level: Type.Union([Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')]),
    scope: Type.String(),
    message: Type.String(),
    meta: Type.Optional(Type.Object({}, { additionalProperties: true })),
  }, { additionalProperties: true })),
  total: Type.Integer({ minimum: 0 }),
  nextCursor: Type.Optional(Type.String()),
}, { additionalProperties: true });

export const dashboardAuditLogResponseSchema = Type.Object({
  entries: Type.Array(dashboardAuditLogEntrySchema),
  total: Type.Integer({ minimum: 0 }),
  nextCursor: Type.Optional(Type.String()),
}, { additionalProperties: true });

export const dashboardAuditLogExportEntriesSchema = Type.Array(dashboardAuditLogEntrySchema);

export const dashboardAuditLogExportResponseSchema = {
  content: {
    'application/json': { schema: dashboardAuditLogExportEntriesSchema },
    'text/csv': { schema: Type.String() },
  },
};

export type DashboardLogsRoute = {
  Querystring: Static<typeof dashboardLogsQuerySchema>;
  Reply: { 200: Static<typeof dashboardLogsResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope };
};

export type DashboardAuditLogRoute = {
  Querystring: Static<typeof dashboardAuditLogQuerySchema>;
  Reply: { 200: Static<typeof dashboardAuditLogResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope };
};

export type DashboardAuditLogExportRoute = {
  Querystring: Static<typeof dashboardAuditLogExportQuerySchema>;
  Reply: { 200: Static<typeof dashboardAuditLogExportEntriesSchema> | string; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope };
};
