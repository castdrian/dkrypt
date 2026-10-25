import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';

export const dashboardIncidentQuerySchema = Type.Object({
  since: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });

export const dashboardIncidentEventSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 240 }),
  at: Type.Number({ minimum: 0 }),
  kind: Type.Union([Type.Literal('device'), Type.Literal('job'), Type.Literal('watch'), Type.Literal('deployment')]),
  title: Type.String({ maxLength: 240 }),
  detail: Type.Optional(Type.String({ maxLength: 1000 })),
  jobId: Type.Optional(Type.String({ maxLength: 200 })),
  watchId: Type.Optional(Type.String({ maxLength: 200 })),
  deviceId: Type.Optional(Type.String({ maxLength: 200 })),
  deploymentId: Type.Optional(Type.String({ maxLength: 200 })),
  correlationId: Type.Optional(Type.String({ maxLength: 200 })),
}, { additionalProperties: false });

export const dashboardIncidentResponseSchema = Type.Object({
  events: Type.Array(dashboardIncidentEventSchema, { maxItems: 200 }),
  truncated: Type.Boolean(),
}, { additionalProperties: false });

export type DashboardIncidentRoute = {
  Querystring: Static<typeof dashboardIncidentQuerySchema>;
  Reply: { 200: Static<typeof dashboardIncidentResponseSchema>; 403: ApiErrorEnvelope };
};
