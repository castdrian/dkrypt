import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope, DashboardJobSummary } from '#contracts.js';
import { bundleIdSchema, identifierSchema, paginationQuerySchema } from '#apiCommonContracts.js';

const additionalProperties = { additionalProperties: true } as const;
const JsonObject = Type.Object({}, additionalProperties);

export const testFlightAppIdSchema = Type.Union([
  Type.String({ minLength: 1, maxLength: 32, pattern: '^\\d+$' }),
  Type.Integer({ minimum: 1 }),
]);
export const testFlightBuildInputSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  cfBundleShortVersion: Type.String({ minLength: 1, maxLength: 64 }),
  cfBundleVersion: Type.String({ minLength: 1, maxLength: 64 }),
  bundleId: bundleIdSchema,
  whatsNew: Type.Optional(Type.String({ maxLength: 5000 })),
  releaseDate: Type.Optional(Type.String({ maxLength: 64 })),
  expiration: Type.Optional(Type.String({ maxLength: 64 })),
  fileSize: Type.Optional(Type.Number({ minimum: 0 })),
}, additionalProperties);
export const dashboardTestFlightAppParamsSchema = Type.Object({
  appId: Type.String({ minLength: 1, maxLength: 32, pattern: '^\\d+$' }),
}, additionalProperties);
export const dashboardTestFlightTrainsQuerySchema = Type.Object({ deviceId: Type.Optional(identifierSchema) }, additionalProperties);
export const dashboardTestFlightBuildsQuerySchema = Type.Object({
  trainVersion: Type.String({ minLength: 1, maxLength: 64 }),
  deviceId: Type.Optional(identifierSchema),
}, additionalProperties);
export const dashboardTestFlightTrainResponseSchema = Type.Object({
  trainVersion: Type.String(),
  buildCount: Type.Integer({ minimum: 0 }),
}, additionalProperties);
export const dashboardTestFlightBuildResponseSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  cfBundleShortVersion: Type.String(),
  cfBundleVersion: Type.String(),
  bundleId: bundleIdSchema,
  whatsNew: Type.Optional(Type.String()),
  releaseDate: Type.Optional(Type.String()),
  expiration: Type.Optional(Type.String()),
  fileSize: Type.Optional(Type.Number({ minimum: 0 })),
}, additionalProperties);
export const dashboardTestFlightTrainsResponseSchema = Type.Object({
  trains: Type.Array(dashboardTestFlightTrainResponseSchema),
}, additionalProperties);
export const dashboardTestFlightBuildsResponseSchema = Type.Object({
  builds: Type.Array(dashboardTestFlightBuildResponseSchema),
}, additionalProperties);
export const dashboardTestFlightDiagnosticsResponseSchema = Type.Object({
  bridge: Type.Object({
    bridgeVersion: Type.Optional(Type.String()),
    capabilities: Type.Optional(Type.Array(Type.String())),
    hasInstaller: Type.Optional(Type.Boolean()),
    hasCatalogManager: Type.Optional(Type.Boolean()),
    backgroundTaskActive: Type.Optional(Type.Boolean()),
    backgroundTimeRemaining: Type.Optional(Type.Number()),
  }, additionalProperties),
  install: Type.Optional(JsonObject),
  recentLog: Type.Optional(Type.Array(Type.String())),
}, additionalProperties);
export const dashboardTestFlightDecryptBodySchema = Type.Object({
  bundleId: bundleIdSchema,
  appId: testFlightAppIdSchema,
  build: testFlightBuildInputSchema,
  deviceId: Type.Optional(identifierSchema),
  preferPrimary: Type.Optional(Type.Boolean()),
  projectId: Type.Optional(identifierSchema),
}, additionalProperties);

export type DashboardTestFlightTrain = Static<typeof dashboardTestFlightTrainResponseSchema>;
export type DashboardTestFlightBuild = Static<typeof dashboardTestFlightBuildResponseSchema>;
export type DashboardTestFlightDiagnostics = Static<typeof dashboardTestFlightDiagnosticsResponseSchema>;
export type DashboardTestFlightDecryptBody = Static<typeof dashboardTestFlightDecryptBodySchema>;

const testFlightSubscriptionDeviceSchema = Type.Object({
  deviceId: identifierSchema,
  status: Type.Union([
    Type.Literal('pending'),
    Type.Literal('syncing'),
    Type.Literal('active'),
    Type.Literal('unavailable'),
    Type.Literal('unsupported'),
    Type.Literal('error'),
    Type.Literal('unsubscribed'),
  ]),
  appleMembership: Type.Optional(Type.Union([Type.Literal('accepted'), Type.Literal('pending'), Type.Literal('unknown')])),
  lastVerifiedAt: Type.Optional(Type.Number()),
  lastSyncedAt: Type.Optional(Type.Number()),
  lastError: Type.Optional(Type.String()),
}, { additionalProperties: true });

export const testFlightSubscriptionResponseSchema = Type.Object({
  id: identifierSchema,
  url: Type.String(),
  inviteCode: Type.String(),
  requestedBy: identifierSchema,
  requestedByDisplayName: Type.Optional(Type.String()),
  status: Type.Union([Type.Literal('pending'), Type.Literal('approved'), Type.Literal('denied'), Type.Literal('withdrawn')]),
  appId: Type.Optional(Type.Integer({ minimum: 1 })),
  bundleId: Type.Optional(bundleIdSchema),
  displayName: Type.Optional(Type.String()),
  iconUrl: Type.Optional(Type.String()),
  sellerName: Type.Optional(Type.String()),
  category: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  approvedAt: Type.Optional(Type.Number()),
  approvedBy: Type.Optional(identifierSchema),
  deniedAt: Type.Optional(Type.Number()),
  deniedBy: Type.Optional(identifierSchema),
  withdrawnAt: Type.Optional(Type.Number()),
  withdrawnBy: Type.Optional(identifierSchema),
  devices: Type.Array(testFlightSubscriptionDeviceSchema),
  devicePolicy: Type.Literal('all-enabled'),
}, { additionalProperties: true });

export const testFlightSubscriptionPageSchema = Type.Object({
  subscriptions: Type.Array(testFlightSubscriptionResponseSchema),
  total: Type.Integer({ minimum: 0 }),
  nextCursor: Type.Optional(Type.String()),
}, { additionalProperties: true });

export const testFlightSubscriptionMutationResponseSchema = Type.Object({ subscription: testFlightSubscriptionResponseSchema }, { additionalProperties: true });

export const testFlightSubscriptionConflictResponseSchema = Type.Object({
  error: Type.String(),
  code: Type.String(),
  message: Type.String(),
  requestId: Type.String(),
  retryable: Type.Boolean(),
  remediation: Type.Optional(Type.Object({}, { additionalProperties: true })),
  alreadySubscribed: Type.Optional(Type.Boolean()),
  subscription: Type.Optional(testFlightSubscriptionResponseSchema),
}, { additionalProperties: true });

export const testFlightCatalogAppResponseSchema = Type.Object({
  appId: Type.Integer({ minimum: 1 }),
  bundleId: bundleIdSchema,
  displayName: Type.String(),
  iconUrl: Type.Optional(Type.String()),
  sellerName: Type.Optional(Type.String()),
  category: Type.Optional(Type.String()),
  devices: Type.Array(Type.Object({ id: identifierSchema, name: Type.String(), verifiedAt: Type.Optional(Type.Number()) }, { additionalProperties: true })),
  lastVerifiedAt: Type.Number(),
  deviceSource: Type.Literal(true),
}, { additionalProperties: true });

export const testFlightCatalogResponseSchema = Type.Object({
  apps: Type.Array(testFlightCatalogAppResponseSchema),
  fetchedAt: Type.Optional(Type.Number()),
  refreshing: Type.Boolean(),
}, { additionalProperties: true });

export const testFlightDeviceUnsubscribeResponseSchema = Type.Object({
  bundleId: bundleIdSchema,
  removedDeviceIds: Type.Array(identifierSchema),
  failures: Type.Array(Type.String()),
}, { additionalProperties: true });

export const testFlightCatalogQuerySchema = Type.Object({ refresh: Type.Optional(Type.Literal('true')) }, { additionalProperties: true });
export const testFlightInviteBodySchema = Type.Object({ url: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: true });
export const testFlightSubscriptionParamsSchema = Type.Object({ id: identifierSchema }, { additionalProperties: true });
export const testFlightCatalogBundleParamsSchema = Type.Object({ bundleId: bundleIdSchema }, { additionalProperties: true });

export type TestFlightSubscriptionResponse = Static<typeof testFlightSubscriptionResponseSchema>;
export type TestFlightSubscriptionPageResponse = Static<typeof testFlightSubscriptionPageSchema>;
export type TestFlightSubscriptionMutationResponse = Static<typeof testFlightSubscriptionMutationResponseSchema>;
export type TestFlightSubscriptionConflictResponse = Static<typeof testFlightSubscriptionConflictResponseSchema>;
export type TestFlightRouteErrorResponse = ApiErrorEnvelope & {
  alreadySubscribed?: boolean;
  subscription?: TestFlightSubscriptionResponse;
};
export type TestFlightCatalogResponse = Static<typeof testFlightCatalogResponseSchema>;
export type TestFlightDeviceUnsubscribeResponse = Static<typeof testFlightDeviceUnsubscribeResponseSchema>;
export type TestFlightInviteBody = Static<typeof testFlightInviteBodySchema>;

type CommonRouteErrors = {
  400: ApiErrorEnvelope;
  401: ApiErrorEnvelope;
  403: ApiErrorEnvelope;
  404: ApiErrorEnvelope;
  409: ApiErrorEnvelope;
  429: ApiErrorEnvelope;
  500: ApiErrorEnvelope;
  503: ApiErrorEnvelope;
};

type UpstreamRouteErrors = CommonRouteErrors & { 502: ApiErrorEnvelope };

export type DashboardTestFlightTrainsRoute = {
  Params: Static<typeof dashboardTestFlightAppParamsSchema>;
  Querystring: Static<typeof dashboardTestFlightTrainsQuerySchema>;
  Reply: { 200: Static<typeof dashboardTestFlightTrainsResponseSchema> } & UpstreamRouteErrors;
};

export type DashboardTestFlightBuildsRoute = {
  Params: Static<typeof dashboardTestFlightAppParamsSchema>;
  Querystring: Static<typeof dashboardTestFlightBuildsQuerySchema>;
  Reply: { 200: Static<typeof dashboardTestFlightBuildsResponseSchema> } & UpstreamRouteErrors;
};

export type DashboardTestFlightDiagnosticsRoute = {
  Reply: { 200: DashboardTestFlightDiagnostics } & UpstreamRouteErrors;
};

export type DashboardTestFlightDecryptRoute = {
  Body: DashboardTestFlightDecryptBody;
  Reply: { 202: DashboardJobSummary } & CommonRouteErrors;
};

export type DashboardTestFlightSubscriptionListRoute = {
  Querystring: Static<typeof paginationQuerySchema>;
  Reply: { 200: TestFlightSubscriptionPageResponse } & CommonRouteErrors;
};

export type DashboardTestFlightSubscriptionCreateRoute = {
  Body: TestFlightInviteBody;
  Reply: {
    200: TestFlightSubscriptionMutationResponse;
    201: TestFlightSubscriptionMutationResponse;
    202: TestFlightSubscriptionMutationResponse;
    400: ApiErrorEnvelope;
    401: ApiErrorEnvelope;
    403: ApiErrorEnvelope;
    409: TestFlightSubscriptionConflictResponse;
    422: ApiErrorEnvelope;
    429: ApiErrorEnvelope;
    500: ApiErrorEnvelope;
    503: ApiErrorEnvelope;
  };
};

export type DashboardTestFlightSubscriptionActionRoute = {
  Params: Static<typeof testFlightSubscriptionParamsSchema>;
  Reply: {
    200: TestFlightSubscriptionMutationResponse;
    202: TestFlightSubscriptionMutationResponse;
    401: ApiErrorEnvelope;
    403: ApiErrorEnvelope;
    404: ApiErrorEnvelope;
    409: ApiErrorEnvelope;
    429: ApiErrorEnvelope;
    500: ApiErrorEnvelope;
  };
};

export type DashboardTestFlightCatalogRoute = {
  Querystring: Static<typeof testFlightCatalogQuerySchema>;
  Reply: { 200: TestFlightCatalogResponse; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 429: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardTestFlightCatalogUnsubscribeRoute = {
  Params: Static<typeof testFlightCatalogBundleParamsSchema>;
  Reply: {
    200: TestFlightDeviceUnsubscribeResponse;
    400: ApiErrorEnvelope;
    401: ApiErrorEnvelope;
    403: ApiErrorEnvelope;
    409: ApiErrorEnvelope;
    422: ApiErrorEnvelope;
    429: ApiErrorEnvelope;
    500: ApiErrorEnvelope;
    503: ApiErrorEnvelope;
  };
};
