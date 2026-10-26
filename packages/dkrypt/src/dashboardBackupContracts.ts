import { Type, type Static, type TSchema } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';
import type { Readable } from 'node:stream';
import { bundleIdSchema, deviceTransportSchema, identifierSchema } from '#apiCommonContracts.js';

const JsonObject = Type.Object({}, { additionalProperties: true });
const UserMfa = Type.Object({
  enabled: Type.Boolean(),
  secretCiphertext: Type.Optional(Type.String()),
  pendingSecretCiphertext: Type.Optional(Type.String()),
  recoveryCodeHashes: Type.Optional(Type.Array(Type.String())),
  updatedAt: Type.Optional(Type.Number()),
}, { additionalProperties: true });
const AllowedUser = Type.Object({
  username: identifierSchema,
  roleIds: Type.Array(identifierSchema),
  addedAt: Type.Number(),
  sessionVersion: Type.Optional(Type.Number()),
  lastActiveAt: Type.Optional(Type.Number()),
  priority: Type.Optional(Type.Number()),
  discordPerkRoleIds: Type.Optional(Type.Array(identifierSchema)),
  mfa: Type.Optional(UserMfa),
}, { additionalProperties: true });
const Role = Type.Object({
  id: identifierSchema,
  name: Type.String(),
  color: Type.String(),
  permissions: Type.String(),
  position: Type.Number(),
  isDefault: Type.Boolean(),
  createdAt: Type.Optional(Type.Number()),
  updatedAt: Type.Optional(Type.Number()),
}, { additionalProperties: true });
const ApiKey = Type.Object({
  id: identifierSchema,
  name: Type.String(),
  ownerId: identifierSchema,
  status: Type.Union([Type.Literal('pending'), Type.Literal('approved'), Type.Literal('denied')]),
  createdAt: Type.Number(),
  hash: Type.Optional(Type.String()),
  approvedAt: Type.Optional(Type.Number()),
  lastUsedAt: Type.Optional(Type.Number()),
  expiresAt: Type.Optional(Type.Number()),
  allowedBundleIds: Type.Optional(Type.Array(bundleIdSchema)),
  dailyLimit: Type.Optional(Type.Number()),
  maxConcurrent: Type.Optional(Type.Number()),
  allowTestFlight: Type.Optional(Type.Boolean()),
  priority: Type.Optional(Type.Number()),
}, { additionalProperties: true });
const Watch = Type.Object({
  id: identifierSchema,
  bundleId: bundleIdSchema,
  enabled: Type.Boolean(),
}, { additionalProperties: true });
const backupDeviceProperties = {
  id: identifierSchema,
  name: Type.String(),
  enabled: Type.Boolean(),
  transport: deviceTransportSchema,
};
const BackupDeviceWithHost = Type.Object({
  ...backupDeviceProperties,
  host: Type.String(),
  udid: Type.Optional(Type.String()),
}, { additionalProperties: true });
const BackupDeviceWithUdid = Type.Object({
  ...backupDeviceProperties,
  host: Type.Optional(Type.String()),
  udid: Type.String(),
}, { additionalProperties: true });
const Device = Type.Union([BackupDeviceWithHost, BackupDeviceWithUdid]);
const jobHistoryProperties = {
  id: identifierSchema,
  bundleId: bundleIdSchema,
  status: Type.Union([Type.Literal('done'), Type.Literal('failed')]),
  finishedAt: Type.Number(),
};
const JobHistory = Type.Object(jobHistoryProperties, { additionalProperties: true });
const BackupAuditLogEntry = Type.Object({
  id: identifierSchema,
  ts: Type.Number(),
  actor: Type.String(),
  action: Type.String(),
  target: Type.String(),
}, { additionalProperties: true });
const Passkey = Type.Object({
  id: Type.String(),
  userId: identifierSchema,
  publicKey: Type.String(),
  counter: Type.Integer({ minimum: 0 }),
  transports: Type.Optional(Type.Array(Type.String())),
  name: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  lastUsedAt: Type.Optional(Type.Number()),
}, { additionalProperties: true });
const BillingSnapshot = Type.Object({
  customers: Type.Array(JsonObject),
  subscriptions: Type.Array(JsonObject),
  cryptoCheckouts: Type.Optional(Type.Array(JsonObject)),
  cryptoCharges: Type.Optional(Type.Array(JsonObject)),
  processedEvents: Type.Optional(Type.Array(JsonObject)),
  entitlementHistory: Type.Optional(Type.Array(JsonObject)),
  stripeCheckoutIdempotency: Type.Optional(Type.Array(JsonObject)),
}, { additionalProperties: true });
const AuthIdentity = Type.Object({
  provider: Type.Union([Type.Literal('github'), Type.Literal('discord')]),
  providerId: Type.String(),
  username: Type.String(),
  displayName: Type.String(),
  email: Type.Optional(Type.String()),
  avatarUrl: Type.Optional(Type.String()),
  source: Type.Union([Type.Literal('oauth'), Type.Literal('discord_connection')]),
  updatedAt: Type.String(),
}, { additionalProperties: true });
const AuthProfile = Type.Object({
  userId: Type.String(),
  provider: Type.Union([Type.Literal('github'), Type.Literal('discord')]),
  providerId: Type.String(),
  username: Type.String(),
  displayName: Type.String(),
  email: Type.Optional(Type.String()),
  avatarUrl: Type.Optional(Type.String()),
  customDisplayName: Type.Optional(Type.String()),
  identities: Type.Optional(Type.Array(AuthIdentity)),
  aliases: Type.Optional(Type.Array(Type.String())),
  updatedAt: Type.String(),
}, { additionalProperties: true });
const IdentitySnapshot = Type.Object({ profiles: Type.Array(AuthProfile) }, { additionalProperties: true });
const TestFlightSubscriptionDevice = Type.Object({
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
const TestFlightSubscription = Type.Object({
  id: identifierSchema,
  url: Type.String(),
  inviteCode: Type.String(),
  requestedBy: Type.String(),
  status: Type.Union([Type.Literal('pending'), Type.Literal('approved'), Type.Literal('denied'), Type.Literal('withdrawn')]),
  appId: Type.Optional(Type.Number()),
  bundleId: Type.Optional(bundleIdSchema),
  displayName: Type.Optional(Type.String()),
  iconUrl: Type.Optional(Type.String()),
  sellerName: Type.Optional(Type.String()),
  category: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  approvedAt: Type.Optional(Type.Number()),
  approvedBy: Type.Optional(Type.String()),
  deniedAt: Type.Optional(Type.Number()),
  deniedBy: Type.Optional(Type.String()),
  withdrawnAt: Type.Optional(Type.Number()),
  withdrawnBy: Type.Optional(Type.String()),
  devices: Type.Array(TestFlightSubscriptionDevice),
  devicePolicy: Type.Literal('all-enabled'),
}, { additionalProperties: true });

const commonBackupProperties = {
  exportedAt: Type.Optional(Type.Number()),
  allowedUsers: Type.Array(AllowedUser),
  roles: Type.Array(Role),
  apiKeys: Type.Array(ApiKey),
  settings: JsonObject,
  watches: Type.Array(Watch),
  devices: Type.Array(Device),
  jobHistory: Type.Array(JobHistory),
  lastSchedulerRunAt: Type.Optional(Type.Number()),
  userPrefs: JsonObject,
  auditLog: Type.Array(BackupAuditLogEntry),
  schedulerRunHistory: Type.Array(JsonObject),
  rootSessionVersion: Type.Number(),
  apiKeyUsage: JsonObject,
  apiKeyBundleUsage: Type.Optional(JsonObject),
  deviceActivity: Type.Optional(Type.Array(JsonObject)),
  rootMfa: Type.Optional(UserMfa),
  passkeys: Type.Optional(Type.Array(Passkey)),
};

const BackupV4Fields = {
  billing: BillingSnapshot,
  identities: IdentitySnapshot,
};
const BackupV6Fields = {
  ...BackupV4Fields,
  testFlightSubscriptions: Type.Array(TestFlightSubscription),
};
const BackupV7Fields = {
  ...BackupV6Fields,
};
const BackupV8Fields = {
  ...BackupV7Fields,
};
const BackupV9Fields = {
  ...BackupV8Fields,
};
const BackupV10Fields = {
  ...BackupV9Fields,
  decryptQuotaLedger: Type.Array(Type.Object({ jobId: identifierSchema, ownerId: identifierSchema, admittedAt: Type.Number(), state: Type.Union([Type.Literal('reserved'), Type.Literal('consumed')]) }, { additionalProperties: false })),
};
const BackupV11Fields = {
  ...BackupV6Fields,
  decryptQuotaLedger: Type.Array(Type.Object({ jobId: identifierSchema, ownerId: identifierSchema, admittedAt: Type.Number(), state: Type.Union([Type.Literal('reserved'), Type.Literal('consumed')]) }, { additionalProperties: false })),
};

const optionalVersionedProperties = {
  testFlightSubscriptions: Type.Optional(Type.Array(TestFlightSubscription)),
  billing: Type.Optional(JsonObject),
  identities: Type.Optional(JsonObject),
  decryptQuotaLedger: Type.Optional(Type.Array(JsonObject)),
  apiKeyRequestHistory: Type.Optional(Type.Record(Type.String(), Type.Array(JsonObject))),
};

function backupVersionSchema<const Version extends 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12>(version: Version, requiredVersionedProperties: Record<string, TSchema> = {}) {
  return Type.Object({
    backupVersion: Type.Literal(version),
    ...commonBackupProperties,
    ...optionalVersionedProperties,
    ...requiredVersionedProperties,
  }, { additionalProperties: true });
}

const BackupV3 = backupVersionSchema(3, {});
const BackupV4 = backupVersionSchema(4, BackupV4Fields);
const BackupV5 = backupVersionSchema(5, BackupV4Fields);
const BackupV6 = backupVersionSchema(6, BackupV6Fields);
const BackupV7 = backupVersionSchema(7, BackupV7Fields);
const BackupV8 = backupVersionSchema(8, BackupV8Fields);
const BackupV9 = backupVersionSchema(9, BackupV9Fields);
const BackupV10 = backupVersionSchema(10, BackupV10Fields);
const BackupV11 = backupVersionSchema(11, BackupV11Fields);
const BackupV12 = backupVersionSchema(12, { ...BackupV11Fields, apiKeyRequestHistory: Type.Record(Type.String(), Type.Array(JsonObject)) });

export const backupImportBodySchema = Type.Union([BackupV3, BackupV4, BackupV5, BackupV6, BackupV7, BackupV8, BackupV9, BackupV10, BackupV11, BackupV12]);

export const backupExportResponseSchema = Type.Object({
  ...BackupV12.properties,
  exportedAt: Type.Number(),
}, { additionalProperties: true });

export const backupScheduleResponseSchema = Type.Object({
  enabled: Type.Boolean(),
  cron: Type.String(),
  retentionCount: Type.Integer({ minimum: 1, maximum: 90 }),
}, { additionalProperties: true });

export const backupSchedulePatchSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  cron: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  retentionCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })),
}, { additionalProperties: false });

const backupRestoreDrillCheckSchema = Type.Object({ label: Type.String(), ok: Type.Boolean(), detail: Type.String() }, { additionalProperties: true });

export const backupHistoryEntrySchema = Type.Object({
  id: identifierSchema,
  createdAt: Type.Number(),
  sizeBytes: Type.Number({ minimum: 0 }),
  filename: Type.String(),
  trigger: Type.Union([Type.Literal('scheduled'), Type.Literal('manual')]),
  databaseFilename: Type.Optional(Type.String()),
  manifestFilename: Type.Optional(Type.String()),
  schemaVersion: Type.Optional(Type.Integer({ minimum: 1 })),
  integrity: Type.Optional(Type.Union([Type.Literal('verified'), Type.Literal('failed'), Type.Literal('unavailable')])),
  encryptedManifest: Type.Optional(Type.Boolean()),
  restoreDrillStatus: Type.Union([Type.Literal('not_run'), Type.Literal('passed'), Type.Literal('failed')]),
  restoreDrillAt: Type.Optional(Type.Number()),
  restoreDrillChecks: Type.Optional(Type.Array(backupRestoreDrillCheckSchema)),
}, { additionalProperties: true });

export const backupHistoryResponseSchema = Type.Array(backupHistoryEntrySchema);

const backupCountsSchema = Type.Object({
  users: Type.Integer({ minimum: 0 }),
  roles: Type.Integer({ minimum: 0 }),
  apiKeys: Type.Integer({ minimum: 0 }),
  watches: Type.Integer({ minimum: 0 }),
  devices: Type.Integer({ minimum: 0 }),
  jobHistory: Type.Integer({ minimum: 0 }),
  auditLog: Type.Integer({ minimum: 0 }),
}, { additionalProperties: true });

export const backupPreviewResponseSchema = Type.Object({
  exportedAt: Type.Optional(Type.Number()),
  incoming: backupCountsSchema,
  current: backupCountsSchema,
}, { additionalProperties: true });

export const backupDrillResponseSchema = Type.Object({
  ok: Type.Boolean(),
  restoreDrillStatus: Type.Union([Type.Literal('passed'), Type.Literal('failed')]),
  checkedAt: Type.Number(),
  checks: Type.Array(backupRestoreDrillCheckSchema),
  database: Type.Optional(JsonObject),
}, { additionalProperties: true });

export const backupSnapshotDrillResponseSchema = Type.Object({
  status: Type.Union([Type.Literal('passed'), Type.Literal('failed')]),
  checkedAt: Type.Number(),
  checks: Type.Array(backupRestoreDrillCheckSchema),
}, { additionalProperties: true });

export const backupHistoryParamsSchema = Type.Object({ id: identifierSchema }, { additionalProperties: true });
export const backupOkResponseSchema = Type.Object({ ok: Type.Boolean() }, { additionalProperties: true });

export type BackupSchedule = Static<typeof backupScheduleResponseSchema>;
export type BackupSchedulePatch = Static<typeof backupSchedulePatchSchema>;
export type BackupHistoryEntry = Static<typeof backupHistoryEntrySchema>;
export type BackupPreviewResponse = Static<typeof backupPreviewResponseSchema>;
export type BackupDrillResponse = Static<typeof backupDrillResponseSchema>;
export type BackupSnapshotDrillResponse = Static<typeof backupSnapshotDrillResponseSchema>;
export type BackupExportResponse = Static<typeof backupExportResponseSchema>;
export type BackupImportBody = Static<typeof backupImportBodySchema>;

type BackupRouteErrors = {
  401: ApiErrorEnvelope;
  403: ApiErrorEnvelope;
  429: ApiErrorEnvelope;
  500: ApiErrorEnvelope;
};

export type DashboardBackupExportRoute = { Reply: { 200: BackupExportResponse } & BackupRouteErrors };

export type DashboardBackupImportRoute = {
  Body: BackupImportBody;
  Reply: { 200: { ok: boolean }; 400: ApiErrorEnvelope } & BackupRouteErrors;
};

export type DashboardBackupPreviewRoute = {
  Body: BackupImportBody;
  Reply: { 200: BackupPreviewResponse; 400: ApiErrorEnvelope } & BackupRouteErrors;
};

export type DashboardBackupDrillRoute = {
  Body: BackupImportBody;
  Reply: { 200: BackupDrillResponse; 400: ApiErrorEnvelope } & BackupRouteErrors;
};

export type DashboardBackupScheduleGetRoute = { Reply: { 200: BackupSchedule } & BackupRouteErrors };

export type DashboardBackupScheduleSetRoute = {
  Body: BackupSchedulePatch;
  Reply: { 200: BackupSchedule; 400: ApiErrorEnvelope } & BackupRouteErrors;
};

export type DashboardBackupHistoryGetRoute = { Reply: { 200: BackupHistoryEntry[] } & BackupRouteErrors };

export type DashboardBackupHistoryCreateRoute = {
  Reply: { 200: BackupHistoryEntry } & BackupRouteErrors;
};

export type DashboardBackupHistoryDownloadRoute = {
  Params: Static<typeof backupHistoryParamsSchema>;
  Reply: { 200: Readable; 404: ApiErrorEnvelope } & BackupRouteErrors;
};

export type DashboardBackupHistoryDrillRoute = {
  Params: Static<typeof backupHistoryParamsSchema>;
  Reply: { 200: BackupSnapshotDrillResponse; 404: ApiErrorEnvelope } & BackupRouteErrors;
};

export type DashboardBackupHistoryDeleteRoute = {
  Params: Static<typeof backupHistoryParamsSchema>;
  Reply: { 200: { ok: boolean }; 404: ApiErrorEnvelope } & BackupRouteErrors;
};
