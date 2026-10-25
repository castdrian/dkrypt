import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';
export const dashboardEventsQuerySchema = Type.Object({}, { additionalProperties: true });

export type DashboardEventsRoute = {
  Querystring: Static<typeof dashboardEventsQuerySchema>;
  Reply: {
    200: string;
    400: ApiErrorEnvelope;
    401: ApiErrorEnvelope;
    404: ApiErrorEnvelope;
    429: ApiErrorEnvelope;
    500: ApiErrorEnvelope;
  };
};
