import { Type, type Static, type TSchema } from '@sinclair/typebox';
import type { FastifySchema } from 'fastify';
import { bundleIdSchema as BundleId, deviceTransportSchema, identifierSchema, paginationQuerySchema } from '#apiCommonContracts.js';
import { jobFailureClassSchema as JobFailureClass } from '#util/failureCategory.js';
import {
  authConnectionParamsSchema,
  authConnectionBodySchema,
  authIdentifierParamsSchema,
  authLoginBodySchema,
  authOAuthCallbackQuerySchema,
  authPasskeyPayloadSchema,
  authPrivacyDeleteBodySchema,
  authProfileBodySchema,
  authReauthenticateBodySchema,
  authTokenBodySchema,
} from '#authContracts.js';
import {
  billingAccessCodeCreateBodySchema,
  billingAccessCodeParamsSchema,
  billingAccessCodeRedeemBodySchema,
  billingCheckoutBodySchema,
  billingCheckoutControlBodySchema,
  billingIdempotencyKeyHeadersSchema,
  billingPauseBodySchema,
  billingProviderStatusQuerySchema,
  billingReconciliationParamsSchema,
  billingReconciliationQuerySchema,
  billingReconciliationSyncBodySchema,
  billingRevenueQuerySchema,
  billingSubscriptionBodySchema,
  billingSubscriptionPreviewBodySchema,
  billingSubscriptionsQuerySchema,
  billingWebhookInboxParamsSchema,
  billingWebhookInboxQuerySchema,
  billingWebhookQuarantineBodySchema,
} from '#billingContracts.js';
import {
  dashboardOkResponseSchema,
  pushKeyResponseSchema,
  pushSubscriptionBodySchema,
  pushUnsubscribeBodySchema,
  userPrefsPatchBodySchema,
  userPrefsResponseSchema,
} from '#dashboardAccountContracts.js';
import {
  notificationListQuerySchema,
  notificationPageResponseSchema,
  notificationReadBodySchema,
  notificationReadResponseSchema,
} from '#dashboardNotificationContracts.js';
import { dashboardDeviceActivityQuerySchema, dashboardDeviceHistoryQuerySchema, dashboardDeviceParamsSchema } from '#dashboardDeviceContracts.js';
import {
  deviceConnectionInputSchema as DeviceConnectionInput,
  deviceDiscoveryResponseSchema as DeviceDiscoveryResponse,
  devicePatchInputSchema as DevicePatchInput,
  deviceRecordInputSchema as DeviceRecordInput,
  deviceSetupResponseSchema as DeviceSetupResponse,
  deviceSetupOperationResponseSchema as DeviceSetupOperationResponse,
  deviceSetupOperationListResponseSchema as DeviceSetupOperationListResponse,
} from '#dashboardDeviceManagementContracts.js';
import {
  deviceBridgeActionBodySchema as DeviceBridgeActionInput,
  deviceBridgeActionResponseSchema as DeviceBridgeActionResponse,
  deviceForceQuerySchema,
  deviceHealthResponseSchema as DeviceHealthResponse,
  deviceInventoryResponseSchema as DeviceInventoryResponse,
  devicePreflightResponseSchema as DevicePreflightResponse,
  deviceRecoveryResponseSchema as DeviceRecoveryResponse,
  deviceRecoveryListResponseSchema as DeviceRecoveryListResponse,
} from '#dashboardDeviceOperationContracts.js';
import { dashboardDoctorResponseSchema, dashboardSyntheticResponseSchema } from '#dashboardDiagnosticsContracts.js';
import { deploymentReadyBodySchema, deploymentReadyResponseSchema } from '#internalDeploymentContracts.js';
import { dashboardOverviewQuerySchema, dashboardOverviewResponseSchema } from '#dashboardOverviewContracts.js';
import {
  dashboardAppCatalogStatsResponseSchema as AppCatalogStatsResponse,
  dashboardAppMetadataQuerySchema,
  dashboardAppMetadataRefreshBodySchema,
  dashboardAppMetadataResponseSchema as AppMetadataResponse,
  dashboardAppStorefrontsQuerySchema,
  dashboardAppStorefrontsResponseSchema,
  dashboardAppSearchQuerySchema,
  dashboardAppSearchResponseSchema as SearchResponse,
  dashboardAppTrackLookupQuerySchema,
  dashboardAppTrackLookupResponseSchema,
  dashboardAppVersionsParamsSchema,
  dashboardAppVersionsQuerySchema,
  dashboardAppVersionsResponseSchema,
} from '#dashboardAppCatalogContracts.js';
import {
  dashboardArtifactArchiveBodySchema,
  dashboardArtifactArchiveResponseSchema,
  dashboardArtifactBulkArchiveBodySchema,
  dashboardArtifactBulkArchiveResponseSchema,
  dashboardArtifactBulkPinBodySchema,
  dashboardArtifactBulkPinResponseSchema,
  dashboardArtifactContentsQuerySchema,
  dashboardArtifactContentsResponseSchema,
  dashboardArtifactListQuerySchema,
  dashboardArtifactListResponseSchema,
  dashboardArtifactPinBodySchema,
  dashboardArtifactPinResponseSchema,
  dashboardArtifactParamsSchema,
} from '#dashboardArtifactContracts.js';
import {
  dashboardDeviceResponseSchema as DeviceResponse,
  bridgeHeartbeatsSchema,
  deviceTransportStateSchema as DeviceTransportState,
  dashboardSettingsResponseSchema as DashboardSettingsResponse,
} from '#dashboardModelsContracts.js';
import {
  dashboardAuditLogExportQuerySchema,
  dashboardAuditLogExportResponseSchema,
  dashboardAuditLogQuerySchema,
  dashboardAuditLogResponseSchema,
  dashboardLogsQuerySchema,
  dashboardLogsResponseSchema,
} from '#dashboardObservabilityContracts.js';
import {
  dashboardJobActionResponseSchema,
  dashboardJobBundleParamsSchema,
  dashboardJobBundleStatsResponseSchema,
  dashboardJobBulkPreviewBodySchema,
  dashboardJobBulkPreviewResponseSchema,
  dashboardJobDailyVolumeResponseSchema,
  dashboardJobDiagnosticResponseSchema,
  dashboardJobDiffQuerySchema,
  dashboardJobDiffResponseSchema,
  dashboardJobEtaResponseSchema,
  dashboardJobExportQuerySchema,
  dashboardJobExportResponseSchema,
  dashboardJobHistoryPageSchema,
  dashboardJobListQuerySchema,
  dashboardManualDecryptBodySchema,
  dashboardManualDecryptPreflightBodySchema,
  dashboardManualDecryptPreflightResponseSchema,
  dashboardJobParamsSchema,
  dashboardJobProjectQuerySchema,
  dashboardJobReorderBodySchema,
  dashboardJobResolutionNoticeResponseSchema,
  dashboardJobRetryBodySchema,
  dashboardJobSloResponseSchema,
  dashboardJobTimelineEventSchema,
  dashboardJobVolumeQuerySchema,
} from '#dashboardJobContracts.js';
import {
  dashboardTestFlightAppParamsSchema,
  dashboardTestFlightBuildsQuerySchema,
  dashboardTestFlightBuildsResponseSchema as TestFlightBuildsResponse,
  dashboardTestFlightDecryptBodySchema,
  dashboardTestFlightDiagnosticsResponseSchema as TestFlightDiagnosticsResponse,
  dashboardTestFlightTrainsQuerySchema,
  dashboardTestFlightTrainsResponseSchema as TestFlightTrainsResponse,
  testFlightCatalogBundleParamsSchema,
  testFlightCatalogQuerySchema,
  testFlightCatalogResponseSchema,
  testFlightDeviceUnsubscribeResponseSchema,
  testFlightInviteBodySchema,
  testFlightSubscriptionConflictResponseSchema,
  testFlightSubscriptionMutationResponseSchema,
  testFlightSubscriptionPageSchema,
  testFlightSubscriptionParamsSchema,
  testFlightAppIdSchema as TestFlightAppId,
  testFlightBuildInputSchema as TestFlightBuildInput,
} from '#dashboardTestFlightContracts.js';
import {
  backupDrillResponseSchema,
  backupExportResponseSchema,
  backupHistoryEntrySchema,
  backupHistoryParamsSchema,
  backupHistoryResponseSchema,
  backupImportBodySchema,
  backupOkResponseSchema,
  backupPreviewResponseSchema,
  backupSchedulePatchSchema,
  backupScheduleResponseSchema,
  backupSnapshotDrillResponseSchema,
} from '#dashboardBackupContracts.js';
import {
  dashboardArtifactStorageResponseSchema as ArtifactStorageResponse,
  dashboardArtifactRetentionPreviewResponseSchema as ArtifactQuotaRetentionPreviewResponse,
  dashboardArtifactRetentionQuerySchema,
  dashboardSettingsCronQuerySchema,
  dashboardSettingsPatchBodySchema,
  dashboardSettingsRetentionPreviewResponseSchema as RetentionPreviewResponse,
  dashboardSettingsRetentionQuerySchema,
  dashboardSettingsWebhookTestBodySchema,
  dashboardWebhookTestResponseSchema as TestWebhookResponse,
} from '#dashboardSettingsContracts.js';
import {
  dashboardRoleCreateBodySchema,
  dashboardRoleOkResponseSchema,
  dashboardRoleParamsSchema,
  dashboardRoleReorderBodySchema,
  dashboardRoleResponseSchema as RoleResponse,
  dashboardRolesResponseSchema as RolesResponse,
  dashboardRoleUpdateBodySchema,
} from '#dashboardRoleContracts.js';
import {
  dashboardDiscordGuildsResponseSchema,
  dashboardDiscordGuildsUpdateBodySchema,
  dashboardDiscordGuildsUpdateResponseSchema,
  dashboardDiscordOkResponseSchema,
  dashboardDiscordPerkCreateBodySchema,
  dashboardDiscordPerkParamsSchema,
  dashboardDiscordPerkSchema,
  dashboardDiscordPerksResponseSchema,
  dashboardDiscordRolesQuerySchema,
  dashboardDiscordRolesResponseSchema,
  dashboardDiscordStatusResponseSchema,
} from '#dashboardDiscordContracts.js';
import { dashboardEventsQuerySchema } from '#dashboardEventsContracts.js';
import {
  dashboardApiKeyBulkDailyLimitBodySchema,
  dashboardApiKeyBulkExpiryBodySchema,
  dashboardApiKeyBulkIdsBodySchema,
  dashboardApiKeyBulkScopeBodySchema,
  dashboardApiKeyCollectionResponseSchema,
  dashboardApiKeyConcurrencyBodySchema,
  dashboardApiKeyConcurrencyResponseSchema,
  dashboardApiKeyCreateBodySchema,
  dashboardApiKeyExtendedResponseSchema,
  dashboardApiKeyListQuerySchema,
  dashboardApiKeyOkResponseSchema,
  dashboardApiKeyOutcomeResponseSchema,
  dashboardApiKeyRequestsQuerySchema,
  dashboardApiKeyRequestsResponseSchema,
  dashboardApiKeyPageResponseSchema,
  dashboardApiKeyParamsSchema,
  dashboardApiKeyPriorityBodySchema,
  dashboardApiKeyPriorityResponseSchema,
  dashboardApiKeyRegenerateResponseSchema,
  dashboardApiKeyResponseSchema,
  dashboardApiKeyRevokedResponseSchema,
  dashboardApiKeySecretResponseSchema,
  dashboardApiKeyTestFlightBodySchema,
  dashboardApiKeyTestFlightResponseSchema,
  dashboardApiKeyUsageQuerySchema,
  dashboardApiKeyUsageResponseSchema,
  dashboardApiKeyUsageLimitQuerySchema,
  dashboardApiKeyBundleUsageResponseSchema,
  dashboardApiKeyUpdatedResponseSchema,
  dashboardApiKeyApprovedResponseSchema,
  dashboardApiKeyRevealResponseSchema,
  dashboardApiKeyGraceBodySchema,
} from '#dashboardApiKeyContracts.js';
import {
  dashboardAllowedUserResponseSchema as AllowedUserResponse,
  dashboardUserCreateBodySchema,
  dashboardUserDirectoryResponseSchema as UserDirectoryResponse,
  dashboardUserOkResponseSchema,
  dashboardUserParamsSchema,
  dashboardUserUpdateBodySchema,
} from '#dashboardUserContracts.js';

const VersionSelector = Type.String({ minLength: 1, maxLength: 64, pattern: '^v?\\d+(?:\\.\\d+)*(?:_\\d+)?$' });
const Identifier = identifierSchema;
const JsonObject = Type.Object({}, { additionalProperties: true });
const JsonResponse = Type.Union([JsonObject, Type.Array(Type.Unknown()), Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
export const ErrorEnvelope = Type.Object(
  {
    error: Type.String(),
    code: Type.String(),
    message: Type.String(),
    requestId: Type.String(),
    retryable: Type.Boolean(),
    remediation: Type.Optional(JsonObject),
  },
  { additionalProperties: true },
);
const PublicStatusState = Type.Union([
  Type.Literal('operational'),
  Type.Literal('degraded'),
  Type.Literal('maintenance'),
  Type.Literal('not_configured'),
  Type.Literal('unknown'),
]);
const PublicStatusResponse = Type.Object({
  status: Type.Union([Type.Literal('operational'), Type.Literal('degraded'), Type.Literal('maintenance')]),
  checkedAt: Type.String(),
  deployment: Type.Object({ ref: Type.String() }),
  components: Type.Object({
    service: Type.Object({ state: PublicStatusState }),
    automation: Type.Object({ state: PublicStatusState }),
  }),
});
const PaginationQuery = paginationQuerySchema;
const ProviderEnvironment = Type.Union([Type.Literal('test'), Type.Literal('live')]);
const JobStatus = Type.Union([Type.Literal('queued'), Type.Literal('running'), Type.Literal('done'), Type.Literal('failed')]);
const DeviceSubsystemState = Type.Union([Type.Literal('ready'), Type.Literal('idle'), Type.Literal('degraded'), Type.Literal('offline'), Type.Literal('unsupported'), Type.Literal('unknown')]);
export const JobSummaryResponse = object({
  id: Identifier,
  correlationId: Identifier,
  bundleId: BundleId,
  externalVersionId: Type.Optional(Identifier),
  testflight: Type.Optional(object({ appId: Type.Number(), buildId: Type.Number(), version: Type.Optional(Type.String()), buildNumber: Type.Optional(Type.String()) })),
  versionLabel: Type.Optional(Type.String()),
  minimumOsVersion: Type.Optional(Type.String()),
  source: Type.Union([Type.Literal('manual'), Type.Literal('scheduler')]),
  channel: Type.Union([Type.Literal('appstore'), Type.Literal('testflight')]),
  queuedBy: Type.Optional(Type.String()),
  priority: Type.Number(),
  deviceId: Type.Optional(Identifier),
  preferredDeviceId: Type.Optional(Identifier),
  transport: Type.Optional(deviceTransportSchema),
  executionPath: Type.Optional(Type.Union([Type.Literal('appstore_offline'), Type.Literal('device'), Type.Literal('device_fallback')])),
  offlineAttemptedAt: Type.Optional(Type.Number()),
  offlineAttemptDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
  offlineDeviceFallbackStartedAt: Type.Optional(Type.Number()),
  deviceFallbackDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
  offlineFailureReason: Type.Optional(Type.String()),
  offlineCompatibility: Type.Optional(Type.Object({ supported: Type.Boolean(), licenseFormat: Type.Union([Type.Literal('sinf'), Type.Literal('supf'), Type.Literal('unknown')]), architectures: Type.Array(Type.String()), reason: Type.Optional(Type.String()) }, { additionalProperties: false })),
  attempt: Type.Optional(Type.Number()),
  retryCount: Type.Optional(Type.Number()),
  deadlineAt: Type.Optional(Type.String()),
  deadlineExceeded: Type.Optional(Type.Boolean()),
  failureClass: Type.Optional(JobFailureClass),
  status: JobStatus,
  progress: Type.String(),
  warnings: Type.Optional(Type.Array(Type.String())),
  error: Type.Optional(Type.String()),
  artifactId: Type.Optional(Identifier),
  artifactUrl: Type.Optional(Type.String()),
  cacheHit: Type.Optional(Type.Boolean()),
  sizeBytes: Type.Optional(Type.Number()),
  sha256: Type.Optional(Type.String()),
  createdAt: Type.String(),
  startedAt: Type.Optional(Type.String()),
  finishedAt: Type.Optional(Type.String()),
  queue: Type.Optional(object({
    position: Type.Number(),
    total: Type.Number(),
    predictedStartMs: Type.Optional(Type.Number({ minimum: 0 })),
    predictedCompletionMs: Type.Optional(Type.Number({ minimum: 0 })),
  })),
  queueReason: Type.Optional(Type.String()),
  statusUrl: Type.String(),
});
const PageCursor = Type.Optional(Type.String());
const HealthResponse = object({
  ok: Type.Boolean(),
  serviceReady: Type.Boolean(),
  deployment: object({ id: Type.String(), ref: Type.String() }),
  database: object({ path: Type.String(), schemaVersion: Type.Integer(), integrity: Type.Literal('ok') }),
  bridge: object({ state: Type.Union([Type.Literal('ready'), Type.Literal('offline')]), transport: Type.String(), deviceCount: Type.Integer(), capabilities: Type.Array(Type.String()) }),
  device: object({
    reachable: Type.Boolean(),
    bridgeReachable: Type.Boolean(),
    transport: Type.Optional(deviceTransportSchema),
    transportState: DeviceTransportState,
    capabilities: Type.Array(Type.String()),
    lastSeenAt: Type.Optional(Type.Number()),
    recoveryState: Type.Union([Type.Literal('stable'), Type.Literal('recovering'), Type.Literal('degraded'), Type.Literal('offline')]),
    readiness: Type.String(),
    subsystems: Type.Optional(object({
      usb: DeviceSubsystemState,
      mux: DeviceSubsystemState,
      agent: DeviceSubsystemState,
      appStore: DeviceSubsystemState,
      testFlight: DeviceSubsystemState,
      sshTunnel: DeviceSubsystemState,
      storage: DeviceSubsystemState,
      battery: DeviceSubsystemState,
      thermal: DeviceSubsystemState,
    })),
    bridgeHeartbeats: Type.Optional(bridgeHeartbeatsSchema),
  }),
});
const BillingProviderResponse = object({
  enabled: Type.Boolean(),
  environment: ProviderEnvironment,
  configured: Type.Optional(Type.Boolean()),
  ready: Type.Optional(Type.Boolean()),
  managedPayments: Type.Optional(Type.Boolean()),
  provider: Type.Optional(Type.Literal('nowpayments')),
  settlementCurrency: Type.Optional(Type.String()),
  assets: Type.Optional(Type.Array(Type.String())),
  minimumByAsset: Type.Optional(Type.Record(Type.String(), Type.Number())),
  missingConfiguration: Type.Optional(Type.Array(Type.String())),
  issues: Type.Optional(Type.Array(Type.String())),
});
const BillingResponse = object({
  enabled: Type.Boolean(),
  provider: Type.Union([Type.Literal('stripe'), Type.Literal('nowpayments'), Type.Literal('legacy'), Type.Literal('gift')]),
  environment: ProviderEnvironment,
  managedPayments: Type.Boolean(),
  missingConfiguration: Type.Array(Type.String()),
  providers: object({ stripe: BillingProviderResponse, crypto: BillingProviderResponse }),
  plans: Type.Array(object({ id: Identifier, name: Type.String(), description: Type.String(), amount: Type.Number(), currency: Type.String(), priceId: Type.String(), api: Type.Boolean(), priority: Type.Number(), legacy: Type.Boolean(), dailyDecryptLimit: Type.Optional(Type.Number()), apiRatePerMinute: Type.Optional(Type.Number()) })),
  currentPlan: Type.Optional(object({ id: Identifier, name: Type.String(), description: Type.String(), amount: Type.Number(), currency: Type.String(), api: Type.Boolean(), priority: Type.Number(), legacy: Type.Boolean(), dailyDecryptLimit: Type.Optional(Type.Number()), apiRatePerMinute: Type.Optional(Type.Number()) })),
  customerId: Type.Optional(Type.String()),
  customerEmail: Type.Optional(Type.String()),
  paymentMethod: Type.Optional(object({
    state: Type.Union([Type.Literal('ready'), Type.Literal('expiring'), Type.Literal('expired'), Type.Literal('needs_update'), Type.Literal('unavailable')]),
    brand: Type.Optional(Type.String()),
    last4: Type.Optional(Type.String()),
    expMonth: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
    expYear: Type.Optional(Type.Integer({ minimum: 2000 })),
    expiresBeforeNextBilling: Type.Optional(Type.Boolean()),
    nextBilledAt: Type.Optional(Type.String({ format: 'date-time' })),
  })),
  legacyBilling: Type.Boolean(),
  entitlement: JsonObject,
  quota: object({ limit: Type.Union([Type.Number(), Type.Null()]), used: Type.Number(), remaining: Type.Union([Type.Number(), Type.Null()]), nextAvailableAt: Type.Optional(Type.Number()), legacy: Type.Optional(Type.Boolean()), apiRatePerMinute: Type.Optional(Type.Number()) }),
  decryptCredits: object({
    available: Type.Integer({ minimum: 0 }),
    grants: Type.Array(object({ id: Identifier, remaining: Type.Integer({ minimum: 0 }), expiresAt: Type.Optional(Type.Number()), source: Type.String() })),
    purchaseEnabled: Type.Boolean(),
    purchaseQuantity: Type.Integer({ minimum: 1 }),
    purchasePriceMinor: Type.Optional(Type.Integer({ minimum: 1 })),
    purchaseCurrency: Type.Optional(Type.String({ minLength: 3, maxLength: 3 })),
  }),
  apiRateUsage: Type.Optional(object({ limit: Type.Integer({ minimum: 1 }), used: Type.Integer({ minimum: 0 }), remaining: Type.Integer({ minimum: 0 }), resetAt: Type.Number() })),
  usageForecast: object({ sampleDays: Type.Integer({ minimum: 1 }), jobsInSample: Type.Integer({ minimum: 0 }), averagePerDay: Type.Number({ minimum: 0 }), daysUntilAllowanceUsed: Type.Union([Type.Number(), Type.Null()]) }),
});
const BillingSubscriptionPage = object({ subscriptions: Type.Array(JsonObject), total: Type.Integer({ minimum: 0 }), nextCursor: PageCursor });
const ApiJobWaitQuery = object({ timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })) });
const ApiJobStatusBatchBody = object({ ids: Type.Array(Identifier, { minItems: 1, maxItems: 100, uniqueItems: true }) });
const ApiJobStatusBatchResponse = object({ jobs: Type.Array(object({ id: Identifier, state: Type.Union([Type.Literal('found'), Type.Literal('not_found')]), job: Type.Optional(JobSummaryResponse) })) });
const BillingRevenueCurrencyTotal = object({ currency: Type.String({ minLength: 3, maxLength: 3 }), gross: Type.Number({ minimum: 0 }), refunded: Type.Number({ minimum: 0 }), net: Type.Number({ minimum: 0 }) });
const BillingRevenueProviderSummary = object({ state: Type.Union([Type.Literal('ready'), Type.Literal('unavailable'), Type.Literal('not_configured')]), totals: Type.Array(BillingRevenueCurrencyTotal), paymentCount: Type.Integer({ minimum: 0 }) });
const BillingRevenueTrend = object({ month: Type.String({ pattern: '^\\d{4}-\\d{2}$' }), currency: Type.String({ minLength: 3, maxLength: 3 }), gross: Type.Number({ minimum: 0 }), refunded: Type.Number({ minimum: 0 }), net: Type.Number({ minimum: 0 }), paymentCount: Type.Integer({ minimum: 0 }), providers: object({ stripe: Type.Number({ minimum: 0 }), nowpayments: Type.Number({ minimum: 0 }) }) });
const BillingRevenueResponse = object({ updatedAt: Type.String({ format: 'date-time' }), complete: Type.Boolean(), totals: Type.Array(BillingRevenueCurrencyTotal), trend: Type.Array(BillingRevenueTrend), retention: object({ activeAccounts: Type.Integer({ minimum: 0 }), paymentIssues: Type.Integer({ minimum: 0 }), cancellationsUpdatedLast30Days: Type.Integer({ minimum: 0 }), recentCancellationRatePercent: Type.Number({ minimum: 0, maximum: 100 }) }), providers: object({ stripe: BillingRevenueProviderSummary, nowpayments: BillingRevenueProviderSummary }), warnings: Type.Array(Type.String()) });
const BillingReconciliationEntry = object({
  subscriptionId: Type.String({ minLength: 1, maxLength: 200 }),
  userId: Type.Optional(Type.String({ maxLength: 200 })),
  displayName: Type.Optional(Type.String({ maxLength: 200 })),
  local: object({ planId: Type.String({ maxLength: 100 }), status: Type.String({ maxLength: 64 }), updatedAt: Type.String({ format: 'date-time' }) }),
  stripe: object({ state: Type.Union([Type.Literal('ready'), Type.Literal('unavailable')]), planId: Type.Optional(Type.String({ maxLength: 100 })), status: Type.Optional(Type.String({ maxLength: 64 })), priceId: Type.Optional(Type.String({ maxLength: 200 })) }),
  entitlement: Type.Optional(object({ planId: Type.String({ maxLength: 100 }), provider: Type.String({ maxLength: 32 }), status: Type.String({ maxLength: 64 }) })),
  discrepancies: Type.Array(Type.Union([Type.Literal('provider_unavailable'), Type.Literal('unrecognized_price'), Type.Literal('plan_mismatch'), Type.Literal('status_mismatch'), Type.Literal('entitlement_mismatch'), Type.Literal('refund_protected')])),
  syncAllowed: Type.Boolean(),
});
const BillingReconciliationResponse = object({ checkedAt: Type.String({ format: 'date-time' }), entries: Type.Array(BillingReconciliationEntry), total: Type.Integer({ minimum: 0 }), nextCursor: PageCursor });
const BillingReconciliationSyncResponse = object({ subscriptionId: Type.String({ minLength: 1, maxLength: 200 }), status: Type.String({ maxLength: 64 }), planId: Type.String({ maxLength: 100 }), updatedAt: Type.String({ format: 'date-time' }), entitlement: object({ planId: Type.String({ maxLength: 100 }), provider: Type.String({ maxLength: 32 }), status: Type.String({ maxLength: 64 }) }) });
const BillingAccessCodeResponse = object({
  id: Identifier,
  prefix: Type.String(),
  planId: Identifier,
  durationDays: Type.Integer({ minimum: 1, maximum: 3650 }),
  redeemBy: Type.String({ format: 'date-time' }),
  createdBy: Type.Optional(Type.String()),
  createdAt: Type.String({ format: 'date-time' }),
  redeemedBy: Type.Optional(Type.String()),
  redeemedAt: Type.Optional(Type.String({ format: 'date-time' })),
  expiresAt: Type.Optional(Type.String({ format: 'date-time' })),
  revokedAt: Type.Optional(Type.String({ format: 'date-time' })),
  status: Type.Union([Type.Literal('available'), Type.Literal('redeemed'), Type.Literal('expired'), Type.Literal('revoked')]),
});
const BillingAccessCodeListResponse = object({ accessCodes: Type.Array(BillingAccessCodeResponse) });
const BillingAccessCodeCreateResponse = object({ code: Type.String(), accessCode: BillingAccessCodeResponse });
const BillingAccessCodeRedeemResponse = object({ planId: Identifier, expiresAt: Type.String({ format: 'date-time' }) });
const ArtifactPage = object({ artifacts: Type.Array(JsonObject), total: Type.Integer({ minimum: 0 }), totalBytes: Type.Number(), maxBytes: Type.Number(), nextCursor: PageCursor });
const DeviceListResponse = object({ devices: Type.Array(DeviceResponse) });
const DeviceDisableImpactResponse = object({ deviceId: Identifier, queuedJobCount: Type.Integer({ minimum: 0 }), runningJobCount: Type.Integer({ minimum: 0 }) });
export const JobTimelineResponse = object({
  id: Identifier,
  correlationId: Identifier,
  bundleId: BundleId,
  status: JobStatus,
  testflight: Type.Optional(Type.Object({
    appId: Type.Number(),
    build: Type.Object({ id: Type.Number(), cfBundleShortVersion: Type.String(), cfBundleVersion: Type.String(), bundleId: BundleId }, { additionalProperties: true }),
  }, { additionalProperties: true })),
  executionStage: Type.Optional(Type.Union([
    Type.Literal('preparing'),
    Type.Literal('installing'),
    Type.Literal('decrypting'),
    Type.Literal('offline_download'),
    Type.Literal('offline_decrypting'),
    Type.Literal('finalizing'),
  ])),
  executionPath: Type.Optional(Type.Union([Type.Literal('appstore_offline'), Type.Literal('device'), Type.Literal('device_fallback')])),
  offlineAttemptedAt: Type.Optional(Type.Number()),
  offlineAttemptDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
  offlineDeviceFallbackStartedAt: Type.Optional(Type.Number()),
  deviceFallbackDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
  offlineFailureReason: Type.Optional(Type.String()),
  quotaReceipt: Type.Optional(Type.Object({ state: Type.Union([Type.Literal('reserved'), Type.Literal('consumed')]), admittedAt: Type.Number() }, { additionalProperties: false })),
  offlineCompatibility: Type.Optional(Type.Object({ supported: Type.Boolean(), licenseFormat: Type.Union([Type.Literal('sinf'), Type.Literal('supf'), Type.Literal('unknown')]), architectures: Type.Array(Type.String()), reason: Type.Optional(Type.String()) }, { additionalProperties: false })),
  shutdownRecoveryAt: Type.Optional(Type.Number()),
  versionLabel: Type.Optional(Type.String()),
  deviceId: Type.Optional(Identifier),
  transport: Type.Optional(deviceTransportSchema),
  sizeBytes: Type.Optional(Type.Number()),
  warnings: Type.Optional(Type.Array(Type.String())),
  queueReason: Type.Optional(Type.String()),
  ipaMetadata: Type.Optional(JsonObject),
  ipaInfoPlist: Type.Optional(JsonObject),
  events: Type.Array(dashboardJobTimelineEventSchema),
  dependencies: Type.Optional(Type.Array(Type.Object({
    id: Type.String(),
    label: Type.String(),
    state: Type.Union([Type.Literal('ready'), Type.Literal('active'), Type.Literal('waiting'), Type.Literal('failed'), Type.Literal('blocked'), Type.Literal('not_applicable'), Type.Literal('unknown')]),
    detail: Type.String(),
  }, { additionalProperties: false }))),
  guidance: Type.Optional(JsonObject),
});
export type ApiErrorEnvelope = Static<typeof ErrorEnvelope>;
export type DashboardDeviceResponse = Static<typeof DeviceResponse>;
export type DashboardDeviceListResponse = Static<typeof DeviceListResponse>;
export type DashboardDeviceHealthHistoryResponse = Static<typeof DeviceHealthHistoryResponse>;
export type DashboardDeviceActivityResponse = Static<typeof DeviceActivityResponse>;
export type DashboardDeviceBatteryHistoryResponse = Static<typeof DeviceBatteryHistoryResponse>;
export type DashboardDeviceTemperatureHistoryResponse = Static<typeof DeviceTemperatureHistoryResponse>;
export type DashboardDeviceStorageHistoryResponse = Static<typeof DeviceStorageHistoryResponse>;
export type DashboardJobSummary = Static<typeof JobSummaryResponse>;
export type DashboardJobTimeline = Static<typeof JobTimelineResponse>;
export type DashboardJobHistoryPage = Static<typeof dashboardJobHistoryPageSchema>;
const AuthMfaResponse = object({ enabled: Type.Boolean(), recoveryCodesRemaining: Type.Integer({ minimum: 0 }) });
const AuthSessionResponse = object({
  loggedIn: Type.Boolean(),
  sub: Type.Optional(Identifier),
  username: Type.Optional(Type.String()),
  displayName: Type.Optional(Type.String()),
  avatarUrl: Type.Optional(Type.String()),
  identities: Type.Array(JsonObject),
  linkedProviders: Type.Array(Type.String()),
  permissions: Type.Optional(Type.String()),
  expiresAt: Type.Optional(Type.Integer()),
  githubOauthEnabled: Type.Boolean(),
  discordOauthEnabled: Type.Boolean(),
  deployment: object({ ref: Type.String() }),
  publicBaseUrl: Type.String(),
  mfa: Type.Optional(object({ ...AuthMfaResponse.properties, required: Type.Boolean() })),
});
const AuthSessionListResponse = Type.Array(
  object({
    id: Identifier,
    sub: Identifier,
    createdAt: Type.Integer(),
    lastSeenAt: Type.Integer(),
    userAgent: Type.Optional(Type.String()),
    ip: Type.Optional(Type.String()),
    risk: Type.Optional(Type.Literal('new_context')),
    current: Type.Boolean(),
  }),
);
const StripeWebhookHealthResponse = object({
  state: Type.Union([
    Type.Literal('ready'),
    Type.Literal('missing_endpoint'),
    Type.Literal('missing_events'),
    Type.Literal('unavailable'),
    Type.Literal('not_configured'),
  ]),
  endpointUrl: Type.String(),
  requiredEvents: Type.Array(Type.String()),
  missingEvents: Type.Array(Type.String()),
  checkedAt: Type.Optional(Type.String()),
});
const BillingProviderStatusResponse = object({
  checkoutsPaused: Type.Boolean(),
  stripe: object({
    enabled: Type.Boolean(),
    environment: ProviderEnvironment,
    missingConfiguration: Type.Array(Type.String()),
    newCatalogMissingConfiguration: Type.Array(Type.String()),
    webhook: StripeWebhookHealthResponse,
  }),
  crypto: object({
    enabled: Type.Boolean(),
    configured: Type.Boolean(),
    ready: Type.Boolean(),
    environment: ProviderEnvironment,
    settlementType: Type.String(),
    settlementCurrency: Type.String(),
    supportedChains: Type.Array(Type.String()),
    supportedAssets: Type.Array(Type.String()),
    missingConfiguration: Type.Array(Type.String()),
    issues: Type.Array(Type.String()),
    checkedAt: Type.Optional(Type.String()),
  }),
});
const BillingCheckoutControlResponse = object({ paused: Type.Boolean() });
const WebhookInboxRecordResponse = object({
  id: Identifier,
  provider: Type.Union([Type.Literal('stripe'), Type.Literal('nowpayments')]),
  eventId: Type.String(),
  status: Type.Union([Type.Literal('received'), Type.Literal('processed'), Type.Literal('failed'), Type.Literal('quarantined')]),
  rawBodySha256: Type.String(),
  rawBodyBytes: Type.Integer({ minimum: 0 }),
  receivedAt: Type.Number(),
  processedAt: Type.Optional(Type.Number()),
  attempts: Type.Integer({ minimum: 0 }),
  lastError: Type.Optional(Type.String()),
  replayableProcessed: Type.Boolean(),
});
const WebhookInboxPage = object({ inbox: Type.Array(WebhookInboxRecordResponse), total: Type.Integer({ minimum: 0 }), nextCursor: PageCursor });
const DeviceHealthHistoryResponse = object({
  buckets: Type.Array(object({ hourStart: Type.Number(), reachablePercent: Type.Union([Type.Number(), Type.Null()]), transitions: Type.Integer({ minimum: 0 }) })),
  uptimePercent: Type.Union([Type.Number(), Type.Null()]),
});
const DeviceActivityResponse = object({
  activity: Type.Array(object({
    id: Identifier,
    ts: Type.Number(),
    deviceId: Identifier,
    kind: Type.Union([Type.Literal('health'), Type.Literal('bridge'), Type.Literal('job')]),
    message: Type.String(),
    bundleId: Type.Optional(BundleId),
  })),
  total: Type.Integer({ minimum: 0 }),
  nextCursor: PageCursor,
});
const DeviceBatteryHistoryResponse = object({ buckets: Type.Array(object({ hourStart: Type.Number(), batteryPercent: Type.Union([Type.Number(), Type.Null()]) })) });
const DeviceTemperatureHistoryResponse = object({ buckets: Type.Array(object({ hourStart: Type.Number(), batteryTemperatureC: Type.Union([Type.Number(), Type.Null()]) })) });
const DeviceStorageHistoryResponse = object({ buckets: Type.Array(object({ hourStart: Type.Number(), storageUsedPercent: Type.Union([Type.Number(), Type.Null()]) })) });
const JobEtaResponse = dashboardJobEtaResponseSchema;
const JobSloResponse = object({ targetMs: Type.Number(), historicalP95Ms: Type.Union([Type.Number(), Type.Null()]), jobs: Type.Array(JsonObject) });
const DailyVolumeResponse = object({ days: Type.Array(object({ date: Type.String(), count: Type.Integer({ minimum: 0 }) })) });
const ArtifactSummaryResponse = object({
  id: Identifier,
  bundleId: BundleId,
  channel: Type.Union([Type.Literal('appstore'), Type.Literal('testflight')]),
  externalVersionId: Type.Optional(Identifier),
  testflightBuildId: Type.Optional(Type.Integer({ minimum: 1 })),
  versionLabel: Type.Optional(Type.String()),
  buildNumber: Type.Optional(Type.String()),
  sizeBytes: Type.Number({ minimum: 0 }),
  sha256: Type.String({ minLength: 64, maxLength: 64 }),
  createdAt: Type.String(),
  lastAccessedAt: Type.String(),
  accessCount: Type.Integer({ minimum: 0 }),
  fileUrl: Type.String(),
});
const ApiArtifactPage = object({
  artifacts: Type.Array(ArtifactSummaryResponse),
  total: Type.Integer({ minimum: 0 }),
  totalBytes: Type.Number({ minimum: 0 }),
  maxBytes: Type.Number({ minimum: 0 }),
  nextCursor: PageCursor,
});
const DecryptJobResponse = object({
  ...JobSummaryResponse.properties,
  selector: Type.Optional(Type.String()),
  resolvedVersion: Type.Optional(Type.String()),
  artifact: Type.Optional(ArtifactSummaryResponse),
});
const DecryptTargetResponse = object({
  resolveOnly: Type.Literal(true),
  bundleId: BundleId,
  selector: Type.Optional(Type.String()),
  channel: Type.Union([Type.Literal('appstore'), Type.Literal('testflight')]),
  resolvedVersion: Type.String(),
  isTestFlight: Type.Boolean(),
  build: Type.Optional(Type.String()),
  cacheHit: Type.Boolean(),
  artifact: Type.Optional(ArtifactSummaryResponse),
});
const UrlResponse = object({ url: Type.String() });
const BillingCheckoutResponse = object({
  url: Type.String(),
  provider: Type.Optional(Type.Union([Type.Literal('stripe'), Type.Literal('nowpayments')])),
  checkoutId: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
});
const BillingCancelResponse = object({
  success: Type.Boolean(),
  status: Type.String(),
  provider: Type.Union([Type.Literal('stripe'), Type.Literal('nowpayments')]),
  idempotencyKey: Type.Optional(Type.String()),
  cancelAtPeriodEnd: Type.Optional(Type.Boolean()),
  pauseResumesAt: Type.Optional(Type.String({ format: 'date-time' })),
});
const BillingSubscriptionUpdateResponse = object({ success: Type.Boolean(), status: Type.String(), priceId: Type.Union([Type.String(), Type.Null()]) });
const BillingSubscriptionPreviewResponse = object({
  planId: Identifier,
  currentPlanId: Identifier,
  currency: Type.String({ minLength: 3, maxLength: 3 }),
  chargeTiming: Type.Union([Type.Literal('now'), Type.Literal('next_invoice')]),
  amountDueMinor: Type.Number(),
  totalMinor: Type.Number(),
  prorationBehavior: Type.Union([Type.Literal('always_invoice'), Type.Literal('create_prorations')]),
  prorationDate: Type.Integer({ minimum: 1 }),
  nextBilledAt: Type.Optional(Type.String({ format: 'date-time' })),
});
const BillingEntitlementHistoryResponse = object({ events: Type.Array(object({ id: Type.String(), provider: Type.String(), planId: Type.String(), kind: Type.String(), status: Type.String(), at: Type.String({ format: 'date-time' }) })) });
const BillingRefreshResponse = object({
  refreshedAt: Type.String({ format: 'date-time' }),
  providerCheck: Type.Union([Type.Literal('succeeded'), Type.Literal('unavailable'), Type.Literal('not_needed')]),
  entitlement: JsonObject,
  message: Type.String(),
});
const OkResponse = dashboardOkResponseSchema;
const AuthTokenResponse = object({ ok: Type.Boolean(), expiresAt: Type.Optional(Type.Integer()) });
const AuthLoginResponse = object({ ok: Type.Boolean() });
const AuthRevokeOthersResponse = object({ ok: Type.Boolean(), revoked: Type.Integer({ minimum: 0 }) });
const PasskeySummaryResponse = object({
  id: Identifier,
  userId: Identifier,
  counter: Type.Integer({ minimum: 0 }),
  transports: Type.Optional(Type.Array(Type.String())),
  name: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  lastUsedAt: Type.Optional(Type.Number()),
});
const PasskeyListResponse = object({ passkeys: Type.Array(PasskeySummaryResponse) });
const PasskeyOptionsResponse = object({
  challenge: Type.String(),
  rp: Type.Optional(JsonObject),
  user: Type.Optional(JsonObject),
  rpId: Type.Optional(Type.String()),
  userVerification: Type.Optional(Type.String()),
  timeout: Type.Optional(Type.Number({ minimum: 0 })),
  allowCredentials: Type.Optional(Type.Array(JsonObject)),
  excludeCredentials: Type.Optional(Type.Array(JsonObject)),
  pubKeyCredParams: Type.Optional(Type.Array(JsonObject)),
  attestation: Type.Optional(Type.String()),
  authenticatorSelection: Type.Optional(JsonObject),
});
const PasskeyMutationResponse = object({ passkey: Type.Optional(PasskeySummaryResponse) });
const AuthProfileResponse = object({ username: Type.String(), displayName: Type.String(), linkedProviders: Type.Array(Type.String()) });
const AuthConnectionResponse = object({ identities: Type.Array(JsonObject), linkedProviders: Type.Array(Type.String()) });
const InsightsAppResponse = Type.Object({
  bundleId: BundleId,
  totalRuns: Type.Integer({ minimum: 0 }),
  doneCount: Type.Integer({ minimum: 0 }),
  failedCount: Type.Integer({ minimum: 0 }),
  successRate: Type.Number({ minimum: 0, maximum: 1 }),
  totalSizeBytes: Type.Number({ minimum: 0 }),
  avgDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
}, { additionalProperties: true });
const InsightsDeviceResponse = Type.Object({
  deviceId: Identifier,
  deviceName: Type.String(),
  removed: Type.Boolean(),
  totalRuns: Type.Integer({ minimum: 0 }),
  doneCount: Type.Integer({ minimum: 0 }),
  failedCount: Type.Integer({ minimum: 0 }),
  successRate: Type.Number({ minimum: 0, maximum: 1 }),
  totalSizeBytes: Type.Number({ minimum: 0 }),
  avgDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
}, { additionalProperties: true });
const InsightsAnomalyResponse = Type.Object({
  jobId: Identifier,
  bundleId: BundleId,
  versionLabel: Type.Optional(Type.String()),
  finishedAt: Type.Number(),
  kind: Type.Union([Type.Literal('duration'), Type.Literal('size'), Type.Literal('duration-and-size')]),
  durationMs: Type.Optional(Type.Number({ minimum: 0 })),
  baselineDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
  durationRatio: Type.Optional(Type.Number({ minimum: 0 })),
  sizeBytes: Type.Optional(Type.Number({ minimum: 0 })),
  baselineSizeBytes: Type.Optional(Type.Number({ minimum: 0 })),
  sizeRatio: Type.Optional(Type.Number({ minimum: 0 })),
}, { additionalProperties: true });
const InsightsResponse = Type.Object({
  totalRuns: Type.Integer({ minimum: 0 }),
  doneCount: Type.Integer({ minimum: 0 }),
  failedCount: Type.Integer({ minimum: 0 }),
  successRate: Type.Number({ minimum: 0, maximum: 1 }),
  totalSizeBytes: Type.Number({ minimum: 0 }),
  manualCount: Type.Integer({ minimum: 0 }),
  systemCount: Type.Integer({ minimum: 0 }),
  topApps: Type.Array(InsightsAppResponse),
  trend: Type.Array(Type.Object({ date: Type.String(), count: Type.Integer({ minimum: 0 }) }, { additionalProperties: true })),
  failureBreakdown: Type.Array(Type.Object({ category: Type.String(), count: Type.Integer({ minimum: 0 }) }, { additionalProperties: true })),
  byDevice: Type.Array(InsightsDeviceResponse),
  anomalies: Type.Array(InsightsAnomalyResponse),
  executionPath: Type.Object({
    serverAttempts: Type.Integer({ minimum: 0 }),
    serverCompleted: Type.Integer({ minimum: 0 }),
    deviceFallbacks: Type.Integer({ minimum: 0 }),
    fallbackCompleted: Type.Integer({ minimum: 0 }),
    fallbackFailed: Type.Integer({ minimum: 0 }),
    averageServerAttemptMs: Type.Optional(Type.Number({ minimum: 0 })),
    averageDeviceFallbackMs: Type.Optional(Type.Number({ minimum: 0 })),
  }),
}, { additionalProperties: true });
export const dashboardInsightsQuerySchema = Type.Object({
  topApps: Type.Optional(Type.String()),
  trendDays: Type.Optional(Type.String()),
}, { additionalProperties: true });
export type DashboardInsightsResponse = Static<typeof InsightsResponse>;
export type DashboardInsightsRoute = {
  Querystring: Static<typeof dashboardInsightsQuerySchema>;
  Reply: {
    200: Static<typeof InsightsResponse>;
    400: ApiErrorEnvelope;
    401: ApiErrorEnvelope;
    404: ApiErrorEnvelope;
  };
};
const FailurePatternsResponse = Type.Object({
  patterns: Type.Array(Type.Object({
    message: Type.String({ maxLength: 180 }),
    count: Type.Integer({ minimum: 0 }),
    firstSeen: Type.Number(),
    lastSeen: Type.Number(),
    bundleIds: Type.Array(BundleId),
  }, { additionalProperties: true })),
}, { additionalProperties: true });
const StorageForecastResponse = Type.Object({
  freeBytes: Type.Number({ minimum: 0 }),
  bytesPerDay: Type.Number({ minimum: 0 }),
  daysRemaining: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  sampleCount: Type.Integer({ minimum: 0 }),
}, { additionalProperties: true });
export const dashboardFailurePatternsQuerySchema = Type.Object({
}, { additionalProperties: true });
export const dashboardStorageForecastQuerySchema = Type.Object({
}, { additionalProperties: true });
export type DashboardFailurePatternsRoute = {
  Querystring: Static<typeof dashboardFailurePatternsQuerySchema>;
  Reply: {
    200: Static<typeof FailurePatternsResponse>;
    400: ApiErrorEnvelope;
    401: ApiErrorEnvelope;
    403: ApiErrorEnvelope;
    404: ApiErrorEnvelope;
  };
};
export type DashboardStorageForecastRoute = {
  Querystring: Static<typeof dashboardStorageForecastQuerySchema>;
  Reply: {
    200: Static<typeof StorageForecastResponse>;
    400: ApiErrorEnvelope;
    401: ApiErrorEnvelope;
    403: ApiErrorEnvelope;
    404: ApiErrorEnvelope;
    503: ApiErrorEnvelope;
  };
};
const WebhookDeliveryPageResponse = Type.Object({
  deliveries: Type.Array(Type.Object({
    id: Identifier,
    ts: Type.Number(),
    kind: Type.Union([Type.Literal('automation'), Type.Literal('scheduler'), Type.Literal('job')]),
    event: Type.String(),
    targetHost: Type.String(),
    ok: Type.Boolean(),
    status: Type.Optional(Type.Number()),
    error: Type.Optional(Type.String()),
    durationMs: Type.Number({ minimum: 0 }),
  }, { additionalProperties: true })),
}, { additionalProperties: true });
export const dashboardWebhookDeliveriesQuerySchema = Type.Object({
  limit: Type.Optional(Type.String()),
}, { additionalProperties: true });
export type DashboardWebhookDeliveriesRoute = {
  Querystring: Static<typeof dashboardWebhookDeliveriesQuerySchema>;
  Reply: { 200: Static<typeof WebhookDeliveryPageResponse>; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope };
};
const SupportBundleResponse = Type.Object({
  generatedAt: Type.String({ format: 'date-time' }),
  deployment: Type.Object({ id: Type.String(), ref: Type.String(), node: Type.String() }, { additionalProperties: true }),
  database: Type.Object({ path: Type.String(), schemaVersion: Type.Integer({ minimum: 0 }), integrity: Type.Literal('ok') }, { additionalProperties: true }),
  latestBackup: Type.Object({ ok: Type.Boolean(), detail: Type.String() }, { additionalProperties: true }),
  disk: Type.Optional(Type.Object({
    totalBytes: Type.Number({ minimum: 0 }),
    freeBytes: Type.Number({ minimum: 0 }),
    usedBytes: Type.Number({ minimum: 0 }),
    usedPercent: Type.Number({ minimum: 0, maximum: 1 }),
  }, { additionalProperties: true })),
  catalog: Type.Object({
    entries: Type.Integer({ minimum: 0 }),
    icons: Type.Integer({ minimum: 0 }),
    oldestUpdatedAt: Type.Optional(Type.Number()),
    newestUpdatedAt: Type.Optional(Type.Number()),
  }, { additionalProperties: true }),
  devices: Type.Array(Type.Object({ id: Identifier, name: Type.String(), enabled: Type.Boolean(), isPrimary: Type.Optional(Type.Boolean()) }, { additionalProperties: true })),
  logs: Type.Array(Type.Object({
    id: Identifier,
    ts: Type.Number(),
    level: Type.Union([Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')]),
    scope: Type.String(),
    message: Type.String(),
    meta: Type.Optional(JsonObject),
  }, { additionalProperties: true })),
  jobs: Type.Array(Type.Object({
    id: Identifier,
    correlationId: Type.Optional(Type.String()),
    bundleId: BundleId,
    status: Type.Union([Type.Literal('done'), Type.Literal('failed')]),
    source: Type.Union([Type.Literal('manual'), Type.Literal('scheduler')]),
    versionLabel: Type.Optional(Type.String()),
    createdAt: Type.Number(),
    startedAt: Type.Optional(Type.Number()),
    finishedAt: Type.Number(),
    sizeBytes: Type.Optional(Type.Number({ minimum: 0 })),
    error: Type.Optional(Type.String()),
    queueReason: Type.Optional(Type.String()),
    deadlineAt: Type.Optional(Type.Number()),
    deadlineExceeded: Type.Optional(Type.Boolean()),
    failureClass: Type.Optional(JobFailureClass),
    deviceId: Type.Optional(Type.String()),
    transport: Type.Optional(deviceTransportSchema),
    attempt: Type.Optional(Type.Integer({ minimum: 1 })),
    retryCount: Type.Optional(Type.Integer({ minimum: 0 })),
    timeline: Type.Optional(Type.Array(Type.Object({
      at: Type.Number(),
      label: Type.String(),
      status: JobStatus,
      durationMs: Type.Optional(Type.Number({ minimum: 0 })),
    }, { additionalProperties: false }))),
  }, { additionalProperties: false })),
  transportTimeline: Type.Array(Type.Object({
    id: Identifier,
    at: Type.Number(),
    level: Type.Union([Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')]),
    message: Type.String(),
    deviceId: Type.Optional(Type.String()),
    transport: Type.Optional(Type.String()),
    operation: Type.Optional(Type.String()),
    correlationId: Type.Optional(Type.String()),
  }, { additionalProperties: true })),
  correlationIds: Type.Array(Type.String({ minLength: 1 })),
}, { additionalProperties: true });
export const dashboardSupportBundleQuerySchema = Type.Object({
}, { additionalProperties: true });
export type DashboardSupportBundleRoute = {
  Querystring: Static<typeof dashboardSupportBundleQuerySchema>;
  Reply: {
    200: Static<typeof SupportBundleResponse>;
    400: ApiErrorEnvelope;
    401: ApiErrorEnvelope;
    403: ApiErrorEnvelope;
    404: ApiErrorEnvelope;
  };
};
const WebhookReceiptResponse = object({ received: Type.Boolean(), duplicate: Type.Optional(Type.Boolean()), quarantined: Type.Optional(Type.Boolean()), inProgress: Type.Optional(Type.Boolean()) });
const BinaryFileResponse = { content: { 'application/octet-stream': { schema: Type.String({ format: 'binary' }) } } };
const EventStreamResponse = { content: { 'text/event-stream': { schema: Type.String() } } };
const PrometheusResponse = { content: { 'text/plain': { schema: Type.String() } } };
const WebhookReplayResponse = object({ replayed: Type.Boolean(), duplicate: Type.Optional(Type.Boolean()), status: Type.String() });
const WebhookQuarantineResponse = object({ record: Type.Optional(JsonObject) });
function object(properties: Record<string, TSchema>): TSchema {
  return Type.Object(properties, { additionalProperties: true });
}

const IdempotencyKeyHeaders = object({
  'idempotency-key': Type.Optional(Type.String({ minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9._:-]+$' })),
});
const contracts = new Map<string, FastifySchema>();

function register(method: string, path: string, schema: FastifySchema): void {
  const key = `${method} ${path}`;
  const previous = contracts.get(key);
  const customResponses = schema.response as Record<string, unknown> | undefined;
  const previousResponses = previous?.response as Record<string, unknown> | undefined;
  const inheritedResponses = { ...(previousResponses ?? {}) };
  if (inheritedResponses[200] === JsonResponse && customResponses) delete inheritedResponses[200];
  contracts.set(key, {
    ...previous,
    tags: schema.tags ?? previous?.tags ?? [path.startsWith('/v1/dashboard') ? 'dashboard' : 'public'],
    summary: schema.summary ?? previous?.summary ?? `${method} ${path}`,
    ...schema,
    response: {
      ...inheritedResponses,
      ...(customResponses ? {} : { 200: JsonResponse }),
      400: ErrorEnvelope,
      401: ErrorEnvelope,
      403: ErrorEnvelope,
      404: ErrorEnvelope,
      409: ErrorEnvelope,
      429: ErrorEnvelope,
      500: ErrorEnvelope,
      503: ErrorEnvelope,
      ...customResponses,
    },
  });
}

type ContractMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

const bodylessPostContracts = new Set([
  '/v1/auth/mfa/setup',
  '/v1/auth/refresh',
  '/v1/auth/logout',
  '/v1/auth/logout-everywhere',
  '/v1/auth/sessions/revoke-others',
  '/v1/dashboard/push/test',
  '/v1/dashboard/email/test',
  '/v1/dashboard/backup/history',
  '/v1/dashboard/backup/history/:id/drill',
  '/v1/dashboard/keys/:id/reveal',
  '/v1/dashboard/keys/:id/approve',
  '/v1/dashboard/keys/:id/deny',
  '/v1/dashboard/devices/setup-operations/:id/resume',
]);

function registerGenericContract(method: ContractMethod, path: string): void {
  const parameterNames = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  const schema: FastifySchema = {};
  if (parameterNames.length > 0) {
    schema.params = Type.Object(Object.fromEntries(parameterNames.map((name) => [name, Identifier])), { additionalProperties: false });
  }
  if (method === 'GET') {
    schema.querystring = JsonObject;
  } else if (method !== 'DELETE' && !(method === 'POST' && bodylessPostContracts.has(path))) {
    schema.body = path.endsWith('/webhook') ? Type.Any() : JsonObject;
  }
  if (path.endsWith('/webhook')) {
    schema.headers = object({
      'stripe-signature': Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      'x-nowpayments-sig': Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    });
  }
  register(method, path, schema);
}

register('GET', '/v1/status', {
  tags: ['public'],
  summary: 'Public service status',
  response: { 200: PublicStatusResponse },
});

register('GET', '/v1/decrypt', {
  querystring: object({ bundleId: BundleId, externalVersionId: Type.Optional(Identifier), version: Type.Optional(VersionSelector) }),
});

register('POST', '/v1/testflight/decrypt', {
  body: object({ bundleId: BundleId, appId: TestFlightAppId, build: TestFlightBuildInput }),
});

register('POST', '/v1/billing/checkout', {
  headers: billingIdempotencyKeyHeadersSchema,
  body: billingCheckoutBodySchema,
});
register('GET', '/v1/billing/access-codes', {});
register('POST', '/v1/billing/access-codes', { body: billingAccessCodeCreateBodySchema });
register('POST', '/v1/billing/access-codes/redeem', { body: billingAccessCodeRedeemBodySchema });
register('POST', '/v1/billing/access-codes/:id/revoke', { params: billingAccessCodeParamsSchema });

register('POST', '/v1/billing/cancel', { headers: billingIdempotencyKeyHeadersSchema });
register('POST', '/v1/billing/pause', { headers: billingIdempotencyKeyHeadersSchema, body: billingPauseBodySchema });
register('POST', '/v1/billing/resume', { headers: billingIdempotencyKeyHeadersSchema });
register('POST', '/v1/billing/refresh', {});
register('GET', '/v1/billing/entitlement-history', {});
register('POST', '/v1/billing/subscription/preview', { body: billingSubscriptionPreviewBodySchema });
register('GET', '/v1/billing', {});
register('POST', '/v1/billing/portal', {});
register('GET', '/v1/billing/provider-status', { querystring: billingProviderStatusQuerySchema });
register('GET', '/v1/billing/reconciliation', { querystring: billingReconciliationQuerySchema });
register('POST', '/v1/billing/reconciliation/:id/sync', { params: billingReconciliationParamsSchema, body: billingReconciliationSyncBodySchema });
register('POST', '/v1/billing/stripe-webhook/sync', {});
register('PUT', '/v1/billing/checkouts', { body: billingCheckoutControlBodySchema });
register('GET', '/v1/billing/subscriptions', {
  querystring: billingSubscriptionsQuerySchema,
});

register('POST', '/v1/auth/login', { body: authLoginBodySchema });
register('POST', '/v1/auth/mfa/confirm', { body: authTokenBodySchema });
register('POST', '/v1/auth/mfa/verify', { body: authTokenBodySchema });
register('POST', '/v1/auth/mfa/disable', { body: authTokenBodySchema });
register('POST', '/v1/auth/mfa/recovery-codes', { body: authTokenBodySchema });
register('POST', '/v1/auth/reauthenticate', { body: authReauthenticateBodySchema });
register('POST', '/v1/auth/privacy/delete', { body: authPrivacyDeleteBodySchema });
register('GET', '/v1/auth/passkeys', {});
register('POST', '/v1/auth/passkeys/options', {});
register('POST', '/v1/auth/passkeys/verify', { body: authPasskeyPayloadSchema });
register('POST', '/v1/auth/passkeys/reauth/options', {});
register('POST', '/v1/auth/passkeys/reauth/verify', { body: authPasskeyPayloadSchema });
register('POST', '/v1/auth/passkeys/register/options', {});
register('POST', '/v1/auth/passkeys/register', { body: authPasskeyPayloadSchema });
register('DELETE', '/v1/auth/passkeys/:id', { params: authIdentifierParamsSchema });
register('GET', '/v1/artifacts', { querystring: object({ ...PaginationQuery.properties, q: Type.Optional(Type.String({ maxLength: 200 })), channel: Type.Optional(Type.Union([Type.Literal('appstore'), Type.Literal('testflight')])) }) });

register('POST', '/v1/dashboard/decrypt', {
  body: dashboardManualDecryptBodySchema,
});

register('POST', '/v1/dashboard/decrypt/preflight', {
  body: dashboardManualDecryptPreflightBodySchema,
});

register('POST', '/v1/dashboard/testflight/decrypt', {
  body: object({ bundleId: BundleId, appId: TestFlightAppId, build: TestFlightBuildInput, deviceId: Type.Optional(Identifier), preferPrimary: Type.Optional(Type.Boolean()) }),
});

register('GET', '/v1/jobs/:id', { params: object({ id: Identifier }) });
register('GET', '/v1/artifacts/:id', { params: object({ id: Identifier }) });
register('GET', '/v1/artifacts/:id/file', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/jobs/:id/status', { params: dashboardJobParamsSchema });
register('GET', '/v1/dashboard/jobs/:id/timeline', { params: dashboardJobParamsSchema });
register('GET', '/v1/dashboard/jobs/:id/diagnostic', { params: dashboardJobParamsSchema });
register('POST', '/v1/dashboard/jobs/:id/cancel', { params: object({ id: Identifier }) });
register('POST', '/v1/dashboard/jobs/:id/prioritize', { params: object({ id: Identifier }) });
register('POST', '/v1/dashboard/jobs/:id/pause', { params: dashboardJobParamsSchema });
register('POST', '/v1/dashboard/jobs/:id/resume', { params: dashboardJobParamsSchema });
register('POST', '/v1/dashboard/jobs/:id/retry', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/notifications', { querystring: notificationListQuerySchema });
register('GET', '/v1/dashboard/jobs', { querystring: dashboardJobListQuerySchema });
register('GET', '/v1/dashboard/artifacts', { querystring: dashboardArtifactListQuerySchema });
register('PUT', '/v1/dashboard/artifacts/:id/pin', { params: object({ id: Identifier }), body: object({ pinned: Type.Boolean() }) });
register('POST', '/v1/dashboard/artifacts/bulk-pin', { body: dashboardArtifactBulkPinBodySchema });
register('PUT', '/v1/dashboard/artifacts/:id/archive', { params: dashboardArtifactParamsSchema, body: dashboardArtifactArchiveBodySchema });
register('POST', '/v1/dashboard/artifacts/bulk-archive', { body: dashboardArtifactBulkArchiveBodySchema });
register('GET', '/v1/dashboard/artifacts/retention-preview', { querystring: object({ maxBytes: Type.Integer({ minimum: 1 }) }) });
register('GET', '/v1/dashboard/logs', { querystring: dashboardLogsQuerySchema });
register('GET', '/v1/dashboard/audit-log', { querystring: dashboardAuditLogQuerySchema });
register('GET', '/v1/dashboard/keys/all', { querystring: object({ ...PaginationQuery.properties, search: Type.Optional(Type.String({ maxLength: 200 })) }) });
register('GET', '/v1/dashboard/webhooks', { querystring: dashboardWebhookDeliveriesQuerySchema });
register('GET', '/v1/dashboard/testflight/subscriptions', { querystring: PaginationQuery });
register('POST', '/v1/dashboard/testflight/subscriptions', { body: object({ url: Type.String({ minLength: 1, maxLength: 500 }) }) });
register('POST', '/v1/dashboard/testflight/subscriptions/:id/approve', { params: object({ id: Identifier }) });
register('POST', '/v1/dashboard/testflight/subscriptions/:id/deny', { params: object({ id: Identifier }) });
register('POST', '/v1/dashboard/testflight/subscriptions/:id/sync', { params: object({ id: Identifier }) });
register('POST', '/v1/dashboard/testflight/subscriptions/:id/unsubscribe', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/testflight/catalog', { querystring: object({ refresh: Type.Optional(Type.Literal('true')) }) });

register('GET', '/v1/testflight/:appId/trains', { params: object({ appId: Type.String({ minLength: 1, maxLength: 32, pattern: '^\\d+$' }) }), querystring: object({}) });
register('GET', '/v1/testflight/:appId/builds', { params: object({ appId: Type.String({ minLength: 1, maxLength: 32, pattern: '^\\d+$' }) }), querystring: object({ trainVersion: Type.String({ minLength: 1, maxLength: 64 }) }) });

register('POST', '/v1/dashboard/devices/setup', { body: DeviceConnectionInput });
register('POST', '/v1/dashboard/devices', { body: DeviceRecordInput });
register('PATCH', '/v1/dashboard/devices/:id', { params: object({ id: Identifier }), body: DevicePatchInput });
register('DELETE', '/v1/dashboard/devices/:id', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/devices/:id/health', { params: object({ id: Identifier }), querystring: deviceForceQuerySchema });
register('GET', '/v1/dashboard/devices/:id/preflight', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/devices/:id/inventory', { params: object({ id: Identifier }) });
register('PUT', '/v1/dashboard/devices/:id/dark-mode', { params: object({ id: Identifier }), body: object({ enabled: Type.Boolean() }) });
register('POST', '/v1/dashboard/devices/:id/bridge-action', { params: object({ id: Identifier }), body: DeviceBridgeActionInput });
register('POST', '/v1/dashboard/devices/:id/recover', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/devices/:id/recoveries', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/devices/:id/recoveries/:operationId', { params: object({ id: Identifier, operationId: Identifier }) });

register('POST', '/v1/billing/webhooks/inbox/:id/replay', { params: billingWebhookInboxParamsSchema });
register('POST', '/v1/billing/webhooks/inbox/:id/quarantine', { params: billingWebhookInboxParamsSchema, body: billingWebhookQuarantineBodySchema });
register('GET', '/v1/billing/webhooks/inbox', { querystring: billingWebhookInboxQuerySchema });

const remainingContracts: Array<[ContractMethod, string]> = [
  ['GET', '/v1/auth/session'],
  ['GET', '/v1/auth/mfa'],
  ['POST', '/v1/auth/mfa/setup'],
  ['GET', '/v1/auth/privacy/export'],
  ['PATCH', '/v1/auth/profile'],
  ['DELETE', '/v1/auth/connections/:provider'],
  ['POST', '/v1/auth/refresh'],
  ['POST', '/v1/auth/logout'],
  ['POST', '/v1/auth/logout-everywhere'],
  ['GET', '/v1/auth/sessions'],
  ['DELETE', '/v1/auth/sessions/:id'],
  ['POST', '/v1/auth/sessions/revoke-others'],
  ['GET', '/v1/auth/github/login'],
  ['GET', '/v1/auth/github/connect'],
  ['GET', '/v1/auth/github/callback'],
  ['GET', '/v1/auth/discord/login'],
  ['GET', '/v1/auth/discord/connect'],
  ['GET', '/v1/auth/discord/callback'],
  ['POST', '/v1/billing/subscription'],
  ['POST', '/v1/nowpayments/webhook'],
  ['POST', '/v1/stripe/webhook'],
  ['GET', '/v1/dashboard/overview'],
  ['GET', '/v1/dashboard/doctor'],
  ['POST', '/v1/internal/deployment/ready'],
  ['GET', '/v1/dashboard/synthetic'],
  ['POST', '/v1/dashboard/notifications/read'],
  ['GET', '/v1/dashboard/events'],
  ['GET', '/v1/dashboard/artifacts/:id/file'],
  ['GET', '/v1/dashboard/artifacts/retention-preview'],
  ['GET', '/v1/dashboard/jobs/export'],
  ['GET', '/v1/dashboard/jobs/eta/:bundleId'],
  ['POST', '/v1/dashboard/jobs/bulk-preview'],
  ['GET', '/v1/dashboard/jobs/slo'],
  ['GET', '/v1/dashboard/jobs/stats/:bundleId'],
  ['GET', '/v1/dashboard/jobs/volume'],
  ['GET', '/v1/dashboard/jobs/diff'],
  ['GET', '/v1/dashboard/insights'],
  ['GET', '/v1/dashboard/failure-patterns'],
  ['GET', '/v1/dashboard/storage-forecast'],
  ['GET', '/v1/dashboard/support-bundle'],
  ['GET', '/v1/dashboard/search'],
  ['POST', '/v1/dashboard/testflight/catalog/:bundleId/unsubscribe'],
  ['GET', '/v1/dashboard/apps/metadata'],
  ['GET', '/v1/dashboard/apps/cache'],
  ['POST', '/v1/dashboard/apps/metadata/refresh'],
  ['GET', '/v1/dashboard/apps/storefronts'],
  ['GET', '/v1/dashboard/versions/:bundleId'],
  ['GET', '/v1/dashboard/devices/discover'],
  ['GET', '/v1/dashboard/testflight/:appId/trains'],
  ['GET', '/v1/dashboard/testflight/diagnostics'],
  ['GET', '/v1/dashboard/testflight/:appId/builds'],
  ['POST', '/v1/dashboard/jobs/reorder'],
  ['GET', '/v1/dashboard/keys/mine'],
  ['POST', '/v1/dashboard/keys/request'],
  ['POST', '/v1/dashboard/keys/create'],
  ['POST', '/v1/dashboard/keys/:id/reveal'],
  ['POST', '/v1/dashboard/keys/:id/regenerate'],
  ['DELETE', '/v1/dashboard/keys/:id'],
  ['POST', '/v1/dashboard/keys/bulk-revoke'],
  ['POST', '/v1/dashboard/keys/bulk-extend-expiry'],
  ['POST', '/v1/dashboard/keys/bulk-set-daily-limit'],
  ['POST', '/v1/dashboard/keys/bulk-set-scope'],
  ['GET', '/v1/dashboard/keys/:id/usage'],
  ['GET', '/v1/dashboard/keys/:id/bundle-usage'],
  ['GET', '/v1/dashboard/keys/:id/outcomes'],
  ['GET', '/v1/dashboard/keys/:id/requests'],
  ['GET', '/v1/dashboard/keys/pending'],
  ['POST', '/v1/dashboard/keys/:id/approve'],
  ['POST', '/v1/dashboard/keys/bulk-approve'],
  ['PATCH', '/v1/dashboard/keys/:id/priority'],
  ['PATCH', '/v1/dashboard/keys/:id/max-concurrent'],
  ['PATCH', '/v1/dashboard/keys/:id/allow-testflight'],
  ['POST', '/v1/dashboard/keys/:id/deny'],
  ['GET', '/v1/dashboard/settings'],
  ['PUT', '/v1/dashboard/settings'],
  ['GET', '/v1/dashboard/settings/job-history-retention/preview'],
  ['GET', '/v1/dashboard/settings/validate-cron'],
  ['POST', '/v1/dashboard/settings/test-webhook'],
  ['GET', '/v1/dashboard/users'],
  ['GET', '/v1/dashboard/audit-log/export'],
  ['GET', '/v1/dashboard/roles'],
  ['POST', '/v1/dashboard/roles'],
  ['PATCH', '/v1/dashboard/roles/:id'],
  ['DELETE', '/v1/dashboard/roles/:id'],
  ['POST', '/v1/dashboard/roles/reorder'],
  ['GET', '/v1/dashboard/discord/status'],
  ['GET', '/v1/dashboard/discord/guilds'],
  ['POST', '/v1/dashboard/discord/guilds'],
  ['GET', '/v1/dashboard/discord/roles'],
  ['GET', '/v1/dashboard/discord/perks'],
  ['POST', '/v1/dashboard/discord/perks'],
  ['DELETE', '/v1/dashboard/discord/perks/:id'],
  ['POST', '/v1/dashboard/users'],
  ['PATCH', '/v1/dashboard/users/:username'],
  ['DELETE', '/v1/dashboard/users/:username'],
  ['GET', '/v1/dashboard/backup/export'],
  ['POST', '/v1/dashboard/backup/import'],
  ['POST', '/v1/dashboard/backup/preview'],
  ['POST', '/v1/dashboard/backup/drill'],
  ['GET', '/v1/dashboard/backup/schedule'],
  ['POST', '/v1/dashboard/backup/schedule'],
  ['GET', '/v1/dashboard/backup/history'],
  ['POST', '/v1/dashboard/backup/history'],
  ['GET', '/v1/dashboard/backup/history/:id/download'],
  ['POST', '/v1/dashboard/backup/history/:id/drill'],
  ['DELETE', '/v1/dashboard/backup/history/:id'],
  ['GET', '/v1/dashboard/me/prefs'],
  ['GET', '/v1/dashboard/push/public-key'],
  ['POST', '/v1/dashboard/push/subscribe'],
  ['POST', '/v1/dashboard/push/unsubscribe'],
  ['POST', '/v1/dashboard/push/test'],
  ['POST', '/v1/dashboard/email/test'],
  ['PUT', '/v1/dashboard/me/prefs'],
  ['GET', '/v1/health'],
  ['GET', '/v1/metrics'],
];

for (const [method, path] of remainingContracts) registerGenericContract(method, path);

register('PATCH', '/v1/auth/profile', { body: authProfileBodySchema });
register('DELETE', '/v1/auth/connections/:provider', { params: authConnectionParamsSchema, body: authConnectionBodySchema });
register('GET', '/v1/auth/github/callback', { querystring: authOAuthCallbackQuerySchema });
register('GET', '/v1/auth/discord/callback', { querystring: authOAuthCallbackQuerySchema });
register('POST', '/v1/dashboard/notifications/read', { body: notificationReadBodySchema });
register('POST', '/v1/dashboard/jobs/bulk-preview', { body: dashboardJobBulkPreviewBodySchema });
register('POST', '/v1/dashboard/jobs/reorder', { body: object({ ids: Type.Array(Identifier, { maxItems: 100 }) }) });
register('POST', '/v1/stripe/webhook', { headers: object({ 'stripe-signature': Type.String({ minLength: 1, maxLength: 200 }) }), body: Type.Any() });
register('POST', '/v1/nowpayments/webhook', { headers: object({ 'x-nowpayments-sig': Type.String({ minLength: 1, maxLength: 500 }) }), body: Type.Any() });

register('GET', '/v1/health', { response: { 200: HealthResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 429: ErrorEnvelope } });
register('GET', '/v1/billing', { response: { 200: BillingResponse } });
register('GET', '/v1/billing/access-codes', { response: { 200: BillingAccessCodeListResponse, 401: ErrorEnvelope, 403: ErrorEnvelope } });
register('POST', '/v1/billing/access-codes', { response: { 201: BillingAccessCodeCreateResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope } });
register('POST', '/v1/billing/access-codes/redeem', { response: { 200: BillingAccessCodeRedeemResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 409: ErrorEnvelope } });
register('POST', '/v1/billing/access-codes/:id/revoke', { response: { 200: BillingAccessCodeResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope } });
register('GET', '/v1/billing/subscriptions', { response: { 200: BillingSubscriptionPage } });
register('GET', '/v1/billing/revenue', { querystring: billingRevenueQuerySchema, response: { 200: BillingRevenueResponse, 401: ErrorEnvelope, 403: ErrorEnvelope } });
register('GET', '/v1/billing/reconciliation', { querystring: billingReconciliationQuerySchema, response: { 200: BillingReconciliationResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 503: ErrorEnvelope } });
register('POST', '/v1/billing/reconciliation/:id/sync', { params: billingReconciliationParamsSchema, body: billingReconciliationSyncBodySchema, response: { 200: BillingReconciliationSyncResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope, 502: ErrorEnvelope, 503: ErrorEnvelope } });
register('GET', '/v1/dashboard/overview', { querystring: dashboardOverviewQuerySchema, response: { 200: dashboardOverviewResponseSchema } });
register('GET', '/v1/dashboard/jobs', { response: { 200: dashboardJobHistoryPageSchema, 404: ErrorEnvelope } });
register('GET', '/v1/dashboard/artifacts', { response: { 200: ArtifactPage } });
register('GET', '/v1/dashboard/devices', { response: { 200: DeviceListResponse, 401: ErrorEnvelope, 403: ErrorEnvelope } });
register('GET', '/v1/dashboard/devices/:id/health', { params: object({ id: Identifier }), querystring: deviceForceQuerySchema, response: { 200: DeviceHealthResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 502: ErrorEnvelope, 503: ErrorEnvelope } });
register('GET', '/v1/dashboard/devices/:id/preflight', { params: object({ id: Identifier }), response: { 200: DevicePreflightResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 502: ErrorEnvelope } });
register('GET', '/v1/dashboard/devices/:id/inventory', { params: object({ id: Identifier }), response: { 200: DeviceInventoryResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 502: ErrorEnvelope } });
register('PUT', '/v1/dashboard/devices/:id/dark-mode', { params: object({ id: Identifier }), body: object({ enabled: Type.Boolean() }), response: { 200: DeviceHealthResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 502: ErrorEnvelope } });
register('POST', '/v1/dashboard/devices/:id/bridge-action', { params: object({ id: Identifier }), body: DeviceBridgeActionInput, response: { 200: DeviceBridgeActionResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 502: ErrorEnvelope } });
register('POST', '/v1/dashboard/devices/:id/recover', { params: object({ id: Identifier }), response: { 200: DeviceRecoveryResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 502: ErrorEnvelope } });
register('GET', '/v1/dashboard/devices/:id/recoveries', { params: object({ id: Identifier }), response: { 200: DeviceRecoveryListResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope } });
register('GET', '/v1/dashboard/devices/:id/recoveries/:operationId', { params: object({ id: Identifier, operationId: Identifier }), response: { 200: DeviceRecoveryResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope } });
register('GET', '/v1/dashboard/jobs/:id/status', { params: dashboardJobParamsSchema, response: { 200: JobSummaryResponse, 404: ErrorEnvelope } });
register('GET', '/v1/dashboard/jobs/:id/timeline', { params: dashboardJobParamsSchema, response: { 200: JobTimelineResponse, 404: ErrorEnvelope } });
register('GET', '/v1/dashboard/testflight/catalog', { querystring: testFlightCatalogQuerySchema, response: { 200: testFlightCatalogResponseSchema } });
register('GET', '/v1/auth/session', { response: { 200: AuthSessionResponse } });
register('GET', '/v1/auth/mfa', { response: { 200: AuthMfaResponse } });
register('POST', '/v1/auth/mfa/setup', { response: { 200: object({ secret: Type.String(), otpauthUrl: Type.String() }) } });
register('POST', '/v1/auth/mfa/confirm', { response: { 200: object({ enabled: Type.Boolean(), recoveryCodes: Type.Array(Type.String()) }) } });
register('POST', '/v1/auth/mfa/disable', { response: { 200: object({ enabled: Type.Boolean(), recoveryCodesRemaining: Type.Integer({ minimum: 0 }) }) } });
register('POST', '/v1/auth/mfa/recovery-codes', { response: { 200: object({ recoveryCodes: Type.Array(Type.String()) }) } });
register('POST', '/v1/auth/mfa/verify', { response: { 200: AuthTokenResponse } });
register('POST', '/v1/auth/reauthenticate', { response: { 200: AuthTokenResponse } });
register('GET', '/v1/auth/sessions', { response: { 200: AuthSessionListResponse } });
register('DELETE', '/v1/auth/sessions/:id', { params: object({ id: Identifier }), response: { 200: OkResponse } });
register('POST', '/v1/auth/sessions/revoke-others', { response: { 200: AuthRevokeOthersResponse } });
register('GET', '/v1/billing/provider-status', { response: { 200: BillingProviderStatusResponse } });
register('POST', '/v1/billing/stripe-webhook/sync', { response: { 200: object({ webhook: StripeWebhookHealthResponse }), 401: ErrorEnvelope, 403: ErrorEnvelope, 409: ErrorEnvelope, 502: ErrorEnvelope, 503: ErrorEnvelope } });
register('PUT', '/v1/billing/checkouts', { response: { 200: BillingCheckoutControlResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 503: ErrorEnvelope } });
register('GET', '/v1/billing/webhooks/inbox', { response: { 200: WebhookInboxPage } });
register('GET', '/v1/dashboard/doctor', { response: { 200: dashboardDoctorResponseSchema } });
register('POST', '/v1/internal/deployment/ready', { body: deploymentReadyBodySchema, response: { 200: deploymentReadyResponseSchema, 401: ErrorEnvelope, 403: ErrorEnvelope } });
register('GET', '/v1/dashboard/synthetic', { response: { 200: dashboardSyntheticResponseSchema } });
register('GET', '/v1/dashboard/notifications', { response: { 200: notificationPageResponseSchema } });
register('GET', '/v1/dashboard/devices/discover', { response: { 200: DeviceDiscoveryResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 502: ErrorEnvelope } });
register('GET', '/v1/dashboard/devices/:id/health-history', { params: dashboardDeviceParamsSchema, querystring: dashboardDeviceHistoryQuerySchema, response: { 200: DeviceHealthHistoryResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope } });
register('GET', '/v1/dashboard/devices/:id/activity', { params: dashboardDeviceParamsSchema, querystring: dashboardDeviceActivityQuerySchema, response: { 200: DeviceActivityResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope } });
register('GET', '/v1/dashboard/devices/:id/battery-history', { params: dashboardDeviceParamsSchema, querystring: dashboardDeviceHistoryQuerySchema, response: { 200: DeviceBatteryHistoryResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope } });
register('GET', '/v1/dashboard/devices/:id/temperature-history', { params: dashboardDeviceParamsSchema, querystring: dashboardDeviceHistoryQuerySchema, response: { 200: DeviceTemperatureHistoryResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope } });
register('GET', '/v1/dashboard/devices/:id/storage-history', { params: dashboardDeviceParamsSchema, querystring: dashboardDeviceHistoryQuerySchema, response: { 200: DeviceStorageHistoryResponse, 401: ErrorEnvelope, 403: ErrorEnvelope } });
register('GET', '/v1/dashboard/jobs/eta/:bundleId', { params: object({ bundleId: BundleId }), response: { 200: JobEtaResponse } });
register('GET', '/v1/dashboard/jobs/slo', { response: { 200: JobSloResponse } });
register('GET', '/v1/dashboard/jobs/volume', { response: { 200: DailyVolumeResponse } });
register('GET', '/v1/dashboard/webhooks', { response: { 200: WebhookDeliveryPageResponse, 401: ErrorEnvelope, 403: ErrorEnvelope } });
register('GET', '/v1/auth/privacy/export', { response: { 200: Type.String() } });
register('POST', '/v1/auth/privacy/delete', { response: { 200: OkResponse } });
register('PATCH', '/v1/auth/profile', { response: { 200: AuthProfileResponse } });
register('DELETE', '/v1/auth/connections/:provider', {
  params: object({ provider: Type.Union([Type.Literal('github'), Type.Literal('discord')]) }),
  body: authConnectionBodySchema,
  response: { 200: AuthConnectionResponse },
});
register('POST', '/v1/auth/refresh', { response: { 200: AuthTokenResponse } });
register('POST', '/v1/auth/login', { response: { 200: AuthLoginResponse } });
register('POST', '/v1/auth/logout', { response: { 200: OkResponse } });
register('POST', '/v1/auth/logout-everywhere', { response: { 200: OkResponse } });
register('GET', '/v1/auth/passkeys', { response: { 200: PasskeyListResponse } });
register('POST', '/v1/auth/passkeys/register/options', { response: { 200: PasskeyOptionsResponse } });
register('POST', '/v1/auth/passkeys/register', { response: { 201: PasskeyMutationResponse } });
register('DELETE', '/v1/auth/passkeys/:id', { params: object({ id: Identifier }), response: { 200: OkResponse } });
register('POST', '/v1/auth/passkeys/options', { response: { 200: PasskeyOptionsResponse } });
register('POST', '/v1/auth/passkeys/verify', { response: { 200: AuthTokenResponse } });
register('POST', '/v1/auth/passkeys/reauth/options', { response: { 200: PasskeyOptionsResponse } });
register('POST', '/v1/auth/passkeys/reauth/verify', { response: { 200: AuthTokenResponse } });
register('POST', '/v1/billing/checkout', {
  headers: billingIdempotencyKeyHeadersSchema,
  body: billingCheckoutBodySchema,
  response: { 200: BillingCheckoutResponse, 201: BillingCheckoutResponse, 503: ErrorEnvelope },
});
register('POST', '/v1/billing/portal', { response: { 200: UrlResponse } });
register('POST', '/v1/billing/cancel', { headers: billingIdempotencyKeyHeadersSchema, response: { 200: BillingCancelResponse } });
register('POST', '/v1/billing/pause', { headers: billingIdempotencyKeyHeadersSchema, body: billingPauseBodySchema, response: { 200: BillingCancelResponse, 400: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope, 503: ErrorEnvelope } });
register('POST', '/v1/billing/resume', { headers: billingIdempotencyKeyHeadersSchema, response: { 200: BillingCancelResponse, 400: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope, 503: ErrorEnvelope } });
register('POST', '/v1/billing/refresh', { response: { 200: BillingRefreshResponse, 429: ErrorEnvelope, 503: ErrorEnvelope } });
register('GET', '/v1/billing/entitlement-history', { response: { 200: BillingEntitlementHistoryResponse } });
register('POST', '/v1/billing/subscription/preview', { body: billingSubscriptionPreviewBodySchema, response: { 200: BillingSubscriptionPreviewResponse, 400: ErrorEnvelope, 403: ErrorEnvelope, 409: ErrorEnvelope, 502: ErrorEnvelope, 503: ErrorEnvelope } });
register('POST', '/v1/billing/subscription', { body: billingSubscriptionBodySchema, response: { 200: BillingSubscriptionUpdateResponse } });
register('GET', '/v1/dashboard/settings', { response: { 200: DashboardSettingsResponse, 401: ErrorEnvelope, 403: ErrorEnvelope } });
register('PUT', '/v1/dashboard/settings', {
  body: dashboardSettingsPatchBodySchema,
  response: { 200: DashboardSettingsResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('GET', '/v1/dashboard/users', { response: { 200: UserDirectoryResponse, 401: ErrorEnvelope, 403: ErrorEnvelope } });
register('GET', '/v1/dashboard/audit-log', { querystring: dashboardAuditLogQuerySchema, response: { 200: dashboardAuditLogResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope } });
register('GET', '/v1/dashboard/roles', { response: { 200: RolesResponse, 401: ErrorEnvelope, 403: ErrorEnvelope } });
register('POST', '/v1/dashboard/roles', {
  body: dashboardRoleCreateBodySchema,
  response: { 201: RoleResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('PATCH', '/v1/dashboard/roles/:id', {
  params: dashboardRoleParamsSchema,
  body: dashboardRoleUpdateBodySchema,
  response: { 200: RoleResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope },
});
register('POST', '/v1/dashboard/roles/reorder', {
  body: dashboardRoleReorderBodySchema,
  response: { 200: RolesResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('POST', '/v1/dashboard/users', {
  body: dashboardUserCreateBodySchema,
  response: { 201: AllowedUserResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('PATCH', '/v1/dashboard/users/:username', {
  params: dashboardUserParamsSchema,
  body: dashboardUserUpdateBodySchema,
  response: { 200: AllowedUserResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope },
});
register('DELETE', '/v1/dashboard/users/:username', {
  params: dashboardUserParamsSchema,
  response: { 200: dashboardUserOkResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope },
});
register('GET', '/v1/dashboard/keys/mine', { response: { 200: dashboardApiKeyCollectionResponseSchema } });
register('POST', '/v1/dashboard/keys/request', { body: dashboardApiKeyCreateBodySchema, response: { 201: dashboardApiKeyResponseSchema } });
register('POST', '/v1/dashboard/keys/create', { body: dashboardApiKeyCreateBodySchema, response: { 201: dashboardApiKeySecretResponseSchema } });
register('POST', '/v1/dashboard/keys/:id/reveal', { params: dashboardApiKeyParamsSchema, response: { 200: dashboardApiKeyRevealResponseSchema } });
register('POST', '/v1/dashboard/keys/:id/regenerate', { params: dashboardApiKeyParamsSchema, body: dashboardApiKeyGraceBodySchema, response: { 200: dashboardApiKeyRegenerateResponseSchema } });
register('DELETE', '/v1/dashboard/keys/:id', { params: dashboardApiKeyParamsSchema, response: { 200: dashboardApiKeyOkResponseSchema } });
register('GET', '/v1/dashboard/keys/pending', { response: { 200: dashboardApiKeyCollectionResponseSchema } });
register('GET', '/v1/dashboard/keys/all', { querystring: dashboardApiKeyListQuerySchema, response: { 200: dashboardApiKeyPageResponseSchema } });
register('GET', '/v1/dashboard/keys/:id/usage', { params: dashboardApiKeyParamsSchema, querystring: dashboardApiKeyUsageQuerySchema, response: { 200: dashboardApiKeyUsageResponseSchema } });
register('GET', '/v1/dashboard/keys/:id/bundle-usage', { params: dashboardApiKeyParamsSchema, querystring: dashboardApiKeyUsageLimitQuerySchema, response: { 200: dashboardApiKeyBundleUsageResponseSchema } });
register('GET', '/v1/dashboard/keys/:id/outcomes', { params: dashboardApiKeyParamsSchema, querystring: dashboardApiKeyUsageLimitQuerySchema, response: { 200: dashboardApiKeyOutcomeResponseSchema } });
register('GET', '/v1/dashboard/keys/:id/requests', { params: dashboardApiKeyParamsSchema, querystring: dashboardApiKeyRequestsQuerySchema, response: { 200: dashboardApiKeyRequestsResponseSchema } });
register('POST', '/v1/dashboard/keys/:id/approve', { params: dashboardApiKeyParamsSchema, response: { 200: dashboardApiKeyOkResponseSchema } });
register('POST', '/v1/dashboard/keys/:id/deny', { params: dashboardApiKeyParamsSchema, response: { 200: dashboardApiKeyOkResponseSchema } });
register('GET', '/v1/dashboard/backup/schedule', { response: { 200: backupScheduleResponseSchema } });
register('POST', '/v1/dashboard/backup/schedule', { body: backupSchedulePatchSchema, response: { 200: backupScheduleResponseSchema } });
register('GET', '/v1/dashboard/backup/history', { response: { 200: backupHistoryResponseSchema } });
register('POST', '/v1/dashboard/backup/history', { response: { 200: backupHistoryEntrySchema } });
register('POST', '/v1/dashboard/backup/import', { response: { 200: OkResponse } });
register('POST', '/v1/dashboard/backup/preview', { response: { 200: backupPreviewResponseSchema } });
register('POST', '/v1/dashboard/backup/drill', { response: { 200: backupDrillResponseSchema } });
register('DELETE', '/v1/dashboard/backup/history/:id', { params: backupHistoryParamsSchema, response: { 200: backupOkResponseSchema } });
register('POST', '/v1/decrypts', {
  headers: IdempotencyKeyHeaders,
  body: object({
    bundleId: BundleId,
    version: Type.Optional(VersionSelector),
    channel: Type.Optional(Type.Union([Type.Literal('appstore'), Type.Literal('testflight')])),
    resolveOnly: Type.Optional(Type.Boolean()),
  }),
  response: { 200: Type.Union([DecryptJobResponse, DecryptTargetResponse]), 202: DecryptJobResponse, 400: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope, 410: ErrorEnvelope, 429: ErrorEnvelope, 502: ErrorEnvelope },
});
register('GET', '/v1/artifacts', {
  querystring: object({ ...PaginationQuery.properties, q: Type.Optional(Type.String({ maxLength: 200 })), channel: Type.Optional(Type.Union([Type.Literal('appstore'), Type.Literal('testflight')])) }),
  response: { 200: ApiArtifactPage },
});
register('GET', '/v1/artifacts/:id', { params: object({ id: Identifier }), response: { 200: ArtifactSummaryResponse } });
register('GET', '/v1/jobs/:id', { params: object({ id: Identifier }), response: { 200: JobSummaryResponse } });
register('GET', '/v1/jobs/:id/wait', {
  params: object({ id: Identifier }),
  querystring: ApiJobWaitQuery,
  response: { 200: JobSummaryResponse, 202: JobSummaryResponse, 404: ErrorEnvelope },
});
register('GET', '/v1/jobs/:id/events', { params: object({ id: Identifier }), querystring: ApiJobWaitQuery, response: { 404: ErrorEnvelope } });
register('POST', '/v1/jobs/status', {
  body: ApiJobStatusBatchBody,
  response: { 200: ApiJobStatusBatchResponse, 400: ErrorEnvelope, 401: ErrorEnvelope },
});
register('GET', '/v1/testflight/:appId/trains', {
  params: object({ appId: Type.String({ minLength: 1, maxLength: 32, pattern: '^\\d+$' }) }),
  querystring: object({}),
  response: { 200: TestFlightTrainsResponse, 502: ErrorEnvelope },
});
register('GET', '/v1/testflight/:appId/builds', {
  params: object({ appId: Type.String({ minLength: 1, maxLength: 32, pattern: '^\\d+$' }) }),
  querystring: object({ trainVersion: Type.String({ minLength: 1, maxLength: 64 }) }),
  response: { 200: TestFlightBuildsResponse, 502: ErrorEnvelope },
});
register('POST', '/v1/testflight/decrypt', {
  headers: IdempotencyKeyHeaders,
  body: object({ bundleId: BundleId, appId: TestFlightAppId, build: TestFlightBuildInput }),
  response: { 202: JobSummaryResponse, 409: ErrorEnvelope, 410: ErrorEnvelope },
});
register('GET', '/v1/dashboard/artifacts', {
  querystring: dashboardArtifactListQuerySchema,
  response: { 200: dashboardArtifactListResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 500: ErrorEnvelope },
});
register('PUT', '/v1/dashboard/artifacts/:id/pin', {
  params: dashboardArtifactParamsSchema,
  body: dashboardArtifactPinBodySchema,
  response: { 200: dashboardArtifactPinResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 500: ErrorEnvelope },
});
register('POST', '/v1/dashboard/artifacts/bulk-pin', {
  body: dashboardArtifactBulkPinBodySchema,
  response: { 200: dashboardArtifactBulkPinResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 500: ErrorEnvelope },
});
register('PUT', '/v1/dashboard/artifacts/:id/archive', {
  params: dashboardArtifactParamsSchema,
  body: dashboardArtifactArchiveBodySchema,
  response: { 200: dashboardArtifactArchiveResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 500: ErrorEnvelope },
});
register('POST', '/v1/dashboard/artifacts/bulk-archive', {
  body: dashboardArtifactBulkArchiveBodySchema,
  response: { 200: dashboardArtifactBulkArchiveResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 500: ErrorEnvelope },
});
register('GET', '/v1/dashboard/artifacts/retention-preview', {
  querystring: dashboardArtifactRetentionQuerySchema,
  response: { 200: ArtifactQuotaRetentionPreviewResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('GET', '/v1/dashboard/settings/artifact-storage', {
  response: { 200: ArtifactStorageResponse, 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('GET', '/v1/dashboard/testflight/:appId/trains', {
  params: dashboardTestFlightAppParamsSchema,
  querystring: dashboardTestFlightTrainsQuerySchema,
  response: { 200: TestFlightTrainsResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 429: ErrorEnvelope, 500: ErrorEnvelope, 502: ErrorEnvelope, 503: ErrorEnvelope },
});
register('GET', '/v1/dashboard/testflight/:appId/builds', {
  params: dashboardTestFlightAppParamsSchema,
  querystring: dashboardTestFlightBuildsQuerySchema,
  response: { 200: TestFlightBuildsResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 429: ErrorEnvelope, 500: ErrorEnvelope, 502: ErrorEnvelope, 503: ErrorEnvelope },
});
register('POST', '/v1/dashboard/testflight/decrypt', {
  body: dashboardTestFlightDecryptBodySchema,
  response: { 202: JobSummaryResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope, 429: ErrorEnvelope, 500: ErrorEnvelope, 503: ErrorEnvelope },
});
register('GET', '/v1/dashboard/search', {
  querystring: dashboardAppSearchQuerySchema,
  response: { 200: SearchResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 500: ErrorEnvelope, 502: ErrorEnvelope },
});
register('GET', '/v1/dashboard/apps/lookup-track', {
  querystring: dashboardAppTrackLookupQuerySchema,
  response: { 200: dashboardAppTrackLookupResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 502: ErrorEnvelope },
});
register('GET', '/v1/dashboard/testflight/subscriptions', {
  querystring: PaginationQuery,
  response: { 200: testFlightSubscriptionPageSchema },
});
register('POST', '/v1/dashboard/testflight/subscriptions', {
  body: testFlightInviteBodySchema,
  response: {
    200: testFlightSubscriptionMutationResponseSchema,
    201: testFlightSubscriptionMutationResponseSchema,
    202: testFlightSubscriptionMutationResponseSchema,
    409: testFlightSubscriptionConflictResponseSchema,
  },
});
register('POST', '/v1/dashboard/testflight/subscriptions/:id/approve', {
  params: testFlightSubscriptionParamsSchema,
  response: { 202: testFlightSubscriptionMutationResponseSchema },
});
register('POST', '/v1/dashboard/testflight/subscriptions/:id/deny', {
  params: testFlightSubscriptionParamsSchema,
  response: { 200: testFlightSubscriptionMutationResponseSchema },
});
register('POST', '/v1/dashboard/testflight/subscriptions/:id/sync', {
  params: testFlightSubscriptionParamsSchema,
  response: { 202: testFlightSubscriptionMutationResponseSchema },
});
register('POST', '/v1/dashboard/testflight/subscriptions/:id/unsubscribe', {
  params: testFlightSubscriptionParamsSchema,
  response: { 202: testFlightSubscriptionMutationResponseSchema },
});
register('POST', '/v1/dashboard/testflight/catalog/:bundleId/unsubscribe', {
  params: testFlightCatalogBundleParamsSchema,
  response: { 200: testFlightDeviceUnsubscribeResponseSchema },
});
register('POST', '/v1/dashboard/decrypt/preflight', {
  body: dashboardManualDecryptPreflightBodySchema,
  response: { 200: dashboardManualDecryptPreflightResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope, 429: ErrorEnvelope, 500: ErrorEnvelope, 503: ErrorEnvelope },
});
register('GET', '/v1/dashboard/versions/:bundleId', {
  params: dashboardAppVersionsParamsSchema,
  querystring: dashboardAppVersionsQuerySchema,
  response: { 200: dashboardAppVersionsResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 502: ErrorEnvelope },
});
register('POST', '/v1/dashboard/devices/setup', {
  body: DeviceConnectionInput,
  response: { 201: DeviceSetupResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 502: ErrorEnvelope },
});
register('POST', '/v1/dashboard/devices/setup-operations', {
  body: DeviceConnectionInput,
  response: { 202: DeviceSetupOperationResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('GET', '/v1/dashboard/devices/setup-operations', {
  response: { 200: DeviceSetupOperationListResponse, 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('GET', '/v1/dashboard/devices/setup-operations/:id', {
  params: object({ id: Identifier }),
  response: { 200: DeviceSetupOperationResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope },
});
register('POST', '/v1/dashboard/devices/setup-operations/:id/resume', {
  params: object({ id: Identifier }),
  response: { 202: DeviceSetupOperationResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope },
});
register('POST', '/v1/dashboard/devices', {
  body: DeviceRecordInput,
  response: { 201: DeviceResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('PATCH', '/v1/dashboard/devices/:id', {
  params: object({ id: Identifier }),
  body: DevicePatchInput,
  response: { 200: DeviceResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope },
});
register('GET', '/v1/dashboard/devices/:id/disable-impact', {
  params: object({ id: Identifier }),
  response: { 200: DeviceDisableImpactResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope },
});
register('POST', '/v1/dashboard/devices/:id/drain', {
  params: object({ id: Identifier }),
  response: { 200: DeviceResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope },
});
register('GET', '/v1/dashboard/jobs/export', {
  querystring: dashboardJobExportQuerySchema,
  response: { 200: dashboardJobExportResponseSchema },
});
register('POST', '/v1/dashboard/jobs/bulk-preview', {
  body: dashboardJobBulkPreviewBodySchema,
  response: { 200: dashboardJobBulkPreviewResponseSchema },
});
register('GET', '/v1/dashboard/jobs/eta/:bundleId', {
  params: dashboardJobBundleParamsSchema,
  querystring: dashboardJobProjectQuerySchema,
  response: { 200: dashboardJobEtaResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 404: ErrorEnvelope, 500: ErrorEnvelope },
});
register('GET', '/v1/dashboard/jobs/stats/:bundleId', {
  params: object({ bundleId: BundleId }),
  querystring: dashboardJobProjectQuerySchema,
  response: { 200: dashboardJobBundleStatsResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 404: ErrorEnvelope, 429: ErrorEnvelope, 500: ErrorEnvelope },
});
register('GET', '/v1/dashboard/jobs/volume', {
  querystring: dashboardJobVolumeQuerySchema,
  response: { 200: dashboardJobDailyVolumeResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 404: ErrorEnvelope, 429: ErrorEnvelope, 500: ErrorEnvelope },
});
register('GET', '/v1/dashboard/jobs/slo', {
  querystring: dashboardJobProjectQuerySchema,
  response: { 200: dashboardJobSloResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 429: ErrorEnvelope, 500: ErrorEnvelope },
});
register('GET', '/v1/dashboard/jobs/diff', {
  querystring: dashboardJobDiffQuerySchema,
  response: { 200: dashboardJobDiffResponseSchema },
});
register('GET', '/v1/dashboard/insights', {
  querystring: dashboardInsightsQuerySchema,
  response: { 200: InsightsResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 404: ErrorEnvelope },
});
register('GET', '/v1/dashboard/failure-patterns', { querystring: dashboardFailurePatternsQuerySchema, response: { 200: FailurePatternsResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope } });
register('GET', '/v1/dashboard/storage-forecast', { querystring: dashboardStorageForecastQuerySchema, response: { 200: StorageForecastResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 503: ErrorEnvelope } });
register('GET', '/v1/dashboard/apps/metadata', {
  querystring: dashboardAppMetadataQuerySchema,
  response: { 200: AppMetadataResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 500: ErrorEnvelope },
});
register('GET', '/v1/dashboard/apps/cache', {
  response: { 200: AppCatalogStatsResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 500: ErrorEnvelope },
});
register('POST', '/v1/dashboard/apps/metadata/refresh', {
  body: dashboardAppMetadataRefreshBodySchema,
  response: { 200: AppMetadataResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 500: ErrorEnvelope },
});
register('GET', '/v1/dashboard/apps/storefronts', {
  querystring: dashboardAppStorefrontsQuerySchema,
  response: { 200: dashboardAppStorefrontsResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 502: ErrorEnvelope },
});
register('GET', '/v1/dashboard/settings/job-history-retention/preview', {
  querystring: dashboardSettingsRetentionQuerySchema,
  response: { 200: RetentionPreviewResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('GET', '/v1/dashboard/settings/validate-cron', {
  querystring: dashboardSettingsCronQuerySchema,
  response: { 200: object({ valid: Type.Boolean() }), 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('POST', '/v1/dashboard/settings/test-webhook', {
  body: dashboardSettingsWebhookTestBodySchema,
  response: { 200: TestWebhookResponse, 400: Type.Union([TestWebhookResponse, ErrorEnvelope]), 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('POST', '/v1/dashboard/notifications/read', {
  body: notificationReadBodySchema,
  response: { 200: notificationReadResponseSchema },
});
register('POST', '/v1/dashboard/jobs/:id/cancel', {
  params: dashboardJobParamsSchema,
  response: { 200: dashboardJobActionResponseSchema, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope, 500: ErrorEnvelope },
});
register('POST', '/v1/dashboard/jobs/:id/prioritize', {
  params: dashboardJobParamsSchema,
  response: { 200: dashboardJobActionResponseSchema, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope, 500: ErrorEnvelope },
});
register('POST', '/v1/dashboard/jobs/:id/pause', {
  params: dashboardJobParamsSchema,
  response: { 200: dashboardJobActionResponseSchema, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope, 500: ErrorEnvelope },
});
register('POST', '/v1/dashboard/jobs/:id/resume', {
  params: dashboardJobParamsSchema,
  response: { 200: dashboardJobActionResponseSchema, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope, 500: ErrorEnvelope },
});
register('POST', '/v1/dashboard/jobs/:id/retry', {
  params: dashboardJobParamsSchema,
  body: dashboardJobRetryBodySchema,
  response: { 202: JobSummaryResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope, 500: ErrorEnvelope, 503: ErrorEnvelope },
});
register('GET', '/v1/dashboard/jobs/:id/resolution-notice', {
  params: dashboardJobParamsSchema,
  response: { 200: dashboardJobResolutionNoticeResponseSchema, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope },
});
register('POST', '/v1/dashboard/jobs/:id/resolution-notice', {
  params: dashboardJobParamsSchema,
  response: { 200: dashboardJobResolutionNoticeResponseSchema, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope, 500: ErrorEnvelope },
});
register('POST', '/v1/dashboard/jobs/reorder', {
  body: dashboardJobReorderBodySchema,
  response: { 200: dashboardJobActionResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 500: ErrorEnvelope },
});
register('GET', '/v1/dashboard/logs', {
  querystring: dashboardLogsQuerySchema,
  response: { 200: dashboardLogsResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope },
});
register('GET', '/v1/dashboard/webhooks', {
  querystring: dashboardWebhookDeliveriesQuerySchema,
  response: { 200: WebhookDeliveryPageResponse, 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('GET', '/v1/dashboard/events', {
  querystring: dashboardEventsQuerySchema,
  response: { 200: EventStreamResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 404: ErrorEnvelope, 429: ErrorEnvelope, 500: ErrorEnvelope },
});
register('GET', '/v1/dashboard/jobs/:id/diagnostic', {
  params: dashboardJobParamsSchema,
  response: { 200: dashboardJobDiagnosticResponseSchema, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 500: ErrorEnvelope },
});
register('GET', '/v1/dashboard/support-bundle', {
  querystring: dashboardSupportBundleQuerySchema,
  response: { 200: SupportBundleResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope },
});
register('GET', '/v1/dashboard/audit-log/export', {
  querystring: dashboardAuditLogExportQuerySchema,
  response: { 200: dashboardAuditLogExportResponseSchema, 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('GET', '/v1/dashboard/backup/export', {
  response: { 200: backupExportResponseSchema },
});
register('GET', '/v1/dashboard/backup/history/:id/download', {
  params: object({ id: Identifier }),
  response: { 200: BinaryFileResponse },
});
register('POST', '/v1/dashboard/backup/history/:id/drill', {
  params: backupHistoryParamsSchema,
  response: { 200: backupSnapshotDrillResponseSchema },
});
register('POST', '/v1/dashboard/backup/import', {
  body: backupImportBodySchema,
  response: { 200: backupOkResponseSchema },
});
register('POST', '/v1/dashboard/backup/preview', {
  body: backupImportBodySchema,
  response: { 200: backupPreviewResponseSchema },
});
register('POST', '/v1/dashboard/backup/drill', {
  body: backupImportBodySchema,
  response: { 200: backupDrillResponseSchema },
});
register('DELETE', '/v1/dashboard/backup/history/:id', {
  params: backupHistoryParamsSchema,
  response: { 200: backupOkResponseSchema },
});
register('GET', '/v1/dashboard/discord/status', {
  response: { 200: dashboardDiscordStatusResponseSchema, 401: ErrorEnvelope, 403: ErrorEnvelope, 429: ErrorEnvelope, 500: ErrorEnvelope },
});
register('GET', '/v1/dashboard/discord/guilds', {
  response: { 200: dashboardDiscordGuildsResponseSchema, 401: ErrorEnvelope, 403: ErrorEnvelope, 429: ErrorEnvelope, 500: ErrorEnvelope },
});
register('POST', '/v1/dashboard/discord/guilds', {
  body: dashboardDiscordGuildsUpdateBodySchema,
  response: { 200: dashboardDiscordGuildsUpdateResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 429: ErrorEnvelope, 500: ErrorEnvelope },
});
register('GET', '/v1/dashboard/discord/roles', {
  querystring: dashboardDiscordRolesQuerySchema,
  response: { 200: dashboardDiscordRolesResponseSchema, 401: ErrorEnvelope, 403: ErrorEnvelope, 429: ErrorEnvelope, 500: ErrorEnvelope },
});
register('GET', '/v1/dashboard/discord/perks', {
  response: { 200: dashboardDiscordPerksResponseSchema, 401: ErrorEnvelope, 403: ErrorEnvelope, 429: ErrorEnvelope, 500: ErrorEnvelope },
});
register('POST', '/v1/dashboard/discord/perks', {
  body: dashboardDiscordPerkCreateBodySchema,
  response: { 201: dashboardDiscordPerkSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 429: ErrorEnvelope, 500: ErrorEnvelope },
});
register('DELETE', '/v1/dashboard/discord/perks/:id', {
  params: dashboardDiscordPerkParamsSchema,
  response: { 200: dashboardDiscordOkResponseSchema, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 429: ErrorEnvelope, 500: ErrorEnvelope },
});
register('POST', '/v1/dashboard/keys/bulk-revoke', {
  body: dashboardApiKeyBulkIdsBodySchema,
  response: { 200: dashboardApiKeyRevokedResponseSchema },
});
register('POST', '/v1/dashboard/keys/bulk-extend-expiry', {
  body: dashboardApiKeyBulkExpiryBodySchema,
  response: { 200: dashboardApiKeyExtendedResponseSchema },
});
register('POST', '/v1/dashboard/keys/bulk-set-daily-limit', {
  body: dashboardApiKeyBulkDailyLimitBodySchema,
  response: { 200: dashboardApiKeyUpdatedResponseSchema },
});
register('POST', '/v1/dashboard/keys/bulk-set-scope', {
  body: dashboardApiKeyBulkScopeBodySchema,
  response: { 200: dashboardApiKeyUpdatedResponseSchema },
});
register('POST', '/v1/dashboard/keys/bulk-approve', {
  body: dashboardApiKeyBulkIdsBodySchema,
  response: { 200: dashboardApiKeyApprovedResponseSchema },
});
register('PATCH', '/v1/dashboard/keys/:id/priority', {
  params: dashboardApiKeyParamsSchema,
  body: dashboardApiKeyPriorityBodySchema,
  response: { 200: dashboardApiKeyPriorityResponseSchema },
});
register('PATCH', '/v1/dashboard/keys/:id/max-concurrent', {
  params: dashboardApiKeyParamsSchema,
  body: dashboardApiKeyConcurrencyBodySchema,
  response: { 200: dashboardApiKeyConcurrencyResponseSchema },
});
register('PATCH', '/v1/dashboard/keys/:id/allow-testflight', {
  params: dashboardApiKeyParamsSchema,
  body: dashboardApiKeyTestFlightBodySchema,
  response: { 200: dashboardApiKeyTestFlightResponseSchema },
});
register('GET', '/v1/dashboard/me/prefs', {
  response: { 200: userPrefsResponseSchema },
});
register('PUT', '/v1/dashboard/me/prefs', {
  body: userPrefsPatchBodySchema,
  response: { 200: userPrefsResponseSchema, 400: ErrorEnvelope },
});
register('GET', '/v1/dashboard/push/public-key', {
  response: { 200: pushKeyResponseSchema },
});
register('POST', '/v1/dashboard/push/subscribe', {
  body: pushSubscriptionBodySchema,
  response: { 200: OkResponse },
});
register('POST', '/v1/dashboard/push/unsubscribe', {
  body: pushUnsubscribeBodySchema,
  response: { 200: OkResponse },
});
register('POST', '/v1/dashboard/push/test', {
  response: { 200: OkResponse },
});
register('POST', '/v1/dashboard/email/test', {
  response: { 200: OkResponse },
});
register('GET', '/v1/dashboard/testflight/diagnostics', {
  response: { 200: TestFlightDiagnosticsResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 429: ErrorEnvelope, 500: ErrorEnvelope, 502: ErrorEnvelope },
});
register('POST', '/v1/stripe/webhook', {
  headers: object({ 'stripe-signature': Type.String({ minLength: 1, maxLength: 200 }) }),
  body: Type.Any(),
  response: { 200: WebhookReceiptResponse },
});
register('POST', '/v1/nowpayments/webhook', {
  headers: object({ 'x-nowpayments-sig': Type.String({ minLength: 1, maxLength: 500 }) }),
  body: Type.Any(),
  response: { 200: WebhookReceiptResponse },
});
register('GET', '/v1/metrics', {
  response: { 200: PrometheusResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 429: ErrorEnvelope },
});
register('GET', '/v1/decrypt', {
  headers: IdempotencyKeyHeaders,
  querystring: object({ bundleId: BundleId, externalVersionId: Type.Optional(Identifier), version: Type.Optional(VersionSelector) }),
  response: {
    200: BinaryFileResponse,
    202: JobSummaryResponse,
    409: Type.Union([JobSummaryResponse, ErrorEnvelope]),
    410: ErrorEnvelope,
    500: Type.Union([JobSummaryResponse, ErrorEnvelope]),
  },
});
register('POST', '/v1/dashboard/decrypt', {
  body: dashboardManualDecryptBodySchema,
  response: { 202: JobSummaryResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope, 429: ErrorEnvelope, 500: ErrorEnvelope, 503: ErrorEnvelope },
});
register('GET', '/v1/artifacts/:id/file', {
  params: object({ id: Identifier }),
  response: { 200: BinaryFileResponse },
});
register('GET', '/v1/dashboard/artifacts/:id/file', {
  params: object({ id: Identifier }),
  response: { 200: BinaryFileResponse },
});
register('GET', '/v1/dashboard/artifacts/:id/contents', {
  params: dashboardArtifactParamsSchema,
  querystring: dashboardArtifactContentsQuerySchema,
  response: { 200: dashboardArtifactContentsResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope },
});
register('DELETE', '/v1/dashboard/devices/:id', {
  params: object({ id: Identifier }),
  response: { 200: OkResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope },
});
register('DELETE', '/v1/dashboard/roles/:id', {
  params: dashboardRoleParamsSchema,
  response: { 200: dashboardRoleOkResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope },
});
register('POST', '/v1/billing/webhooks/inbox/:id/replay', {
  params: billingWebhookInboxParamsSchema,
  response: { 200: WebhookReplayResponse },
});
register('POST', '/v1/billing/webhooks/inbox/:id/quarantine', {
  params: billingWebhookInboxParamsSchema,
  body: billingWebhookQuarantineBodySchema,
  response: { 200: WebhookQuarantineResponse },
});
for (const provider of ['github', 'discord'] as const) {
  register('GET', `/v1/auth/${provider}/login`, { response: { 302: Type.String() } });
  register('GET', `/v1/auth/${provider}/connect`, { response: { 302: Type.String() } });
  register('GET', `/v1/auth/${provider}/callback`, { response: { 302: Type.String() } });
}

export function getRouteContract(method: string, path: string): FastifySchema | undefined {
  const key = `${method} ${path}`;
  const current = contracts.get(key);
  if (current) return current;
  throw new Error(`missing route contract for ${key}`);
}

export function getRouteContracts(): ReadonlyMap<string, FastifySchema> {
  return contracts;
}
