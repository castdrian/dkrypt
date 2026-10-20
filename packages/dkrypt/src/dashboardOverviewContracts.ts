import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';
import { bundleIdSchema as BundleId, identifierSchema, projectIdentifierSchema } from '#apiCommonContracts.js';
import { jobFailureClassSchema as JobFailureClass } from '#util/failureCategory.js';
import {
  dashboardDeviceResponseSchema,
  dashboardDiskUsageSchema,
  dashboardMaintenanceStatusSchema,
  dashboardSchedulerRunEntrySchema,
  dashboardWatchResponseSchema,
  schedulerSettingsResponseSchema,
} from '#dashboardModelsContracts.js';

const Identifier = identifierSchema;
export const dashboardOverviewQuerySchema = Type.Object({ projectId: Type.Optional(projectIdentifierSchema) }, { additionalProperties: true });

export const dashboardOverviewResponseSchema = Type.Object({
  projectId: Identifier,
  schedulerEnabled: Type.Boolean(),
  settings: schedulerSettingsResponseSchema,
  watches: Type.Array(dashboardWatchResponseSchema),
  devices: Type.Array(dashboardDeviceResponseSchema),
  lastSchedulerRunAt: Type.Optional(Type.Number()),
  schedulerRunHistory: Type.Array(dashboardSchedulerRunEntrySchema),
  disk: Type.Optional(dashboardDiskUsageSchema),
  isPaidPlan: Type.Boolean(),
  maintenance: dashboardMaintenanceStatusSchema,
  activeJobs: Type.Array(Type.Object({
    id: Identifier,
    correlationId: Identifier,
    bundleId: BundleId,
    source: Type.Union([Type.Literal('manual'), Type.Literal('scheduler')]),
    status: Type.Union([Type.Literal('queued'), Type.Literal('running')]),
    progress: Type.String(),
    versionLabel: Type.Optional(Type.String()),
    deviceId: Type.Optional(Identifier),
    preferredDeviceId: Type.Optional(Identifier),
    transport: Type.Optional(Type.Union([Type.Literal('wifi'), Type.Literal('usb')])),
    testflight: Type.Optional(Type.Object({
      appId: Type.Number(),
      buildId: Type.Number(),
      version: Type.Optional(Type.String()),
      buildNumber: Type.Optional(Type.String()),
    }, { additionalProperties: true })),
    queuedBy: Type.Optional(Type.String()),
    queuedByDisplayName: Type.Optional(Type.String()),
    priority: Type.Number(),
    createdAt: Type.Number(),
    queue: Type.Optional(Type.Object({
      position: Type.Number(),
      total: Type.Number(),
      predictedStartMs: Type.Optional(Type.Number({ minimum: 0 })),
      predictedCompletionMs: Type.Optional(Type.Number({ minimum: 0 })),
    }, { additionalProperties: true })),
    attempt: Type.Optional(Type.Number()),
    retryCount: Type.Optional(Type.Number()),
    deadlineAt: Type.Optional(Type.Number()),
    deadlineExceeded: Type.Optional(Type.Boolean()),
    failureClass: Type.Optional(JobFailureClass),
    warnings: Type.Optional(Type.Array(Type.String())),
    queueReason: Type.Optional(Type.String()),
  }, { additionalProperties: true })),
}, { additionalProperties: true });

export type DashboardOverviewRoute = {
  Querystring: Static<typeof dashboardOverviewQuerySchema>;
  Reply: {
    200: Static<typeof dashboardOverviewResponseSchema>;
    400: ApiErrorEnvelope;
    401: ApiErrorEnvelope;
    404: ApiErrorEnvelope;
  };
};
