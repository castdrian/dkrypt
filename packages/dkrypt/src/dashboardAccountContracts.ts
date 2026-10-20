import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';

const homeModuleSchema = Type.Union([
  Type.Literal('artifacts'),
  Type.Literal('activeJobs'),
  Type.Literal('jobHistory'),
]);

const homeLayoutSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 40, pattern: '^[a-zA-Z0-9_-]+$' }),
  name: Type.String({ minLength: 1, maxLength: 40 }),
  order: Type.Array(homeModuleSchema, { minItems: 3, maxItems: 3, uniqueItems: true }),
  hidden: Type.Array(homeModuleSchema, { maxItems: 3, uniqueItems: true }),
  collapsed: Type.Array(homeModuleSchema, { maxItems: 3, uniqueItems: true }),
});

const homeViewModesSchema = Type.Object({
  artifacts: Type.Optional(Type.Union([Type.Literal('list'), Type.Literal('cards')])),
  jobHistory: Type.Optional(Type.Union([Type.Literal('list'), Type.Literal('cards')])),
  devices: Type.Optional(Type.Union([Type.Literal('list'), Type.Literal('cards')])),
});

const navigationIdSchema = Type.Union([
  Type.Literal('home'),
  Type.Literal('billing'),
  Type.Literal('keys'),
  Type.Literal('logs'),
  Type.Literal('insights'),
  Type.Literal('docs'),
  Type.Literal('settings'),
]);

const artifactColumnSchema = Type.Union([
  Type.Literal('app'),
  Type.Literal('bundleId'),
  Type.Literal('version'),
  Type.Literal('source'),
  Type.Literal('size'),
  Type.Literal('created'),
]);

const artifactLibraryPreferencesSchema = Type.Object({
  groupByApp: Type.Boolean(),
  columns: Type.Array(artifactColumnSchema, { minItems: 1, maxItems: 6, uniqueItems: true }),
});

const userPrefsProperties = {
  artifactFilenameTemplate: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  shortcutBindings: Type.Optional(Type.Record(Type.String(), Type.String({ minLength: 1, maxLength: 8 }), { maxProperties: 12 })),
  formattingLocale: Type.Optional(Type.Union([Type.Literal('system'), Type.Literal('en'), Type.Literal('de')])),
  interfaceLanguage: Type.Optional(Type.Union([Type.Literal('system'), Type.Literal('en'), Type.Literal('de')])),
  theme: Type.Optional(Type.Union([Type.Literal('dark'), Type.Literal('light'), Type.Literal('auto')])),
  density: Type.Optional(Type.Union([Type.Literal('comfortable'), Type.Literal('compact')])),
  sidebarWidth: Type.Optional(Type.Integer({ minimum: 200, maximum: 360 })),
  sidebarCollapsed: Type.Optional(Type.Boolean()),
  homeLayouts: Type.Optional(Type.Array(homeLayoutSchema, { minItems: 1, maxItems: 10 })),
  activeHomeLayoutId: Type.Optional(Type.String({ minLength: 1, maxLength: 40, pattern: '^[a-zA-Z0-9_-]+$' })),
  viewModes: Type.Optional(homeViewModesSchema),
  settingsMode: Type.Optional(Type.Union([Type.Literal('basic'), Type.Literal('advanced')])),
  displayTimeZone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  appFavorites: Type.Optional(Type.Array(Type.Object({
    bundleId: Type.String({ minLength: 1, maxLength: 200 }),
    trackName: Type.String({ minLength: 1, maxLength: 120 }),
  }, { additionalProperties: false }), { maxItems: 50 })),
  navigationOrder: Type.Optional(Type.Array(navigationIdSchema, { minItems: 7, maxItems: 7, uniqueItems: true })),
  pinnedNavigation: Type.Optional(Type.Array(navigationIdSchema, { maxItems: 7, uniqueItems: true })),
  artifactLibrary: Type.Optional(artifactLibraryPreferencesSchema),
  largeTargets: Type.Optional(Type.Boolean()),
  accent: Type.Optional(Type.String()),
  highContrast: Type.Optional(Type.Boolean()),
  sound: Type.Optional(Type.Boolean()),
  pushOnSuccess: Type.Optional(Type.Boolean()),
  pushOnFailure: Type.Optional(Type.Boolean()),
  pushOnAlerts: Type.Optional(Type.Boolean()),
  pushOnKeyExpiry: Type.Optional(Type.Boolean()),
  emailOnSuccess: Type.Optional(Type.Boolean()),
  emailOnFailure: Type.Optional(Type.Boolean()),
  emailOnAlerts: Type.Optional(Type.Boolean()),
  emailOnKeyExpiry: Type.Optional(Type.Boolean()),
  notifyEmail: Type.Optional(Type.String()),
  preferPrimaryDevice: Type.Optional(Type.Boolean()),
};

export const userPrefsResponseSchema = Type.Object({ ...userPrefsProperties, accountEmail: Type.Optional(Type.String()) }, { additionalProperties: true });
export const userPrefsPatchBodySchema = Type.Object(userPrefsProperties, { additionalProperties: true });

export const pushSubscriptionBodySchema = Type.Object({
  endpoint: Type.String({ minLength: 1, maxLength: 2000 }),
  keys: Type.Object({ p256dh: Type.String({ minLength: 1 }), auth: Type.String({ minLength: 1 }) }, { additionalProperties: true }),
}, { additionalProperties: true });

export const pushUnsubscribeBodySchema = Type.Object({ endpoint: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: true });
export const pushKeyResponseSchema = Type.Object({ publicKey: Type.String() });
export const dashboardOkResponseSchema = Type.Object({ ok: Type.Boolean() });

type DashboardOkReply = { 200: Static<typeof dashboardOkResponseSchema> };

export type DashboardPrefsGetRoute = { Reply: { 200: Static<typeof userPrefsResponseSchema> } };
export type DashboardPrefsUpdateRoute = { Body: Static<typeof userPrefsPatchBodySchema>; Reply: { 200: Static<typeof userPrefsResponseSchema>; 400: ApiErrorEnvelope } };
export type DashboardPushPublicKeyRoute = { Reply: { 200: Static<typeof pushKeyResponseSchema> } };
export type DashboardPushSubscribeRoute = { Body: Static<typeof pushSubscriptionBodySchema>; Reply: DashboardOkReply };
export type DashboardPushUnsubscribeRoute = { Body: Static<typeof pushUnsubscribeBodySchema>; Reply: DashboardOkReply };
export type DashboardPushTestRoute = { Reply: DashboardOkReply };
export type DashboardEmailTestRoute = { Reply: DashboardOkReply & { 400: { error: string; code: string; message: string; requestId: string; retryable: boolean } } };
