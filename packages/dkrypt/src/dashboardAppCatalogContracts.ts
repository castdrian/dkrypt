import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';
import { bundleIdSchema, identifierSchema } from '#apiCommonContracts.js';

const additionalProperties = { additionalProperties: true } as const;

export const dashboardAppSearchQuerySchema = Type.Object({
  q: Type.String({ minLength: 1, maxLength: 200 }),
  country: Type.Optional(Type.String({ minLength: 2, maxLength: 2, pattern: '^[A-Z]{2}$' })),
}, additionalProperties);
export const dashboardAppSearchResultSchema = Type.Object({
  bundleId: bundleIdSchema,
  trackId: Type.Integer({ minimum: 1 }),
  trackName: Type.String(),
  version: Type.String(),
  sellerName: Type.String(),
  artworkUrl: Type.String(),
  price: Type.Number(),
  category: Type.Optional(Type.String()),
  minimumOsVersion: Type.Optional(Type.String()),
  testflight: Type.Optional(Type.Object({
    appId: Type.Integer({ minimum: 1 }),
    devices: Type.Array(Type.Object({ id: identifierSchema, name: Type.String(), verifiedAt: Type.Optional(Type.Number()) }, additionalProperties)),
    lastVerifiedAt: Type.Number(),
  }, additionalProperties)),
}, additionalProperties);
export const dashboardAppSearchResponseSchema = Type.Object({ results: Type.Array(dashboardAppSearchResultSchema) }, additionalProperties);
export const dashboardAppStorefrontContextResponseSchema = Type.Object({
  accountCountry: Type.Optional(Type.String({ minLength: 2, maxLength: 2 })),
  countries: Type.Array(Type.Object({ code: Type.String({ minLength: 2, maxLength: 2 }), name: Type.String() }, additionalProperties)),
}, additionalProperties);
export const dashboardAppTrackLookupQuerySchema = Type.Object({
  trackId: Type.String(),
  country: Type.Optional(Type.String({ minLength: 2, maxLength: 2, pattern: '^[A-Z]{2}$' })),
});
export const dashboardAppTrackLookupResponseSchema = Type.Object({ bundleId: bundleIdSchema, trackName: Type.String(), trackId: Type.Integer({ minimum: 1 }) });
export const dashboardAppMetadataQuerySchema = Type.Object({
  bundleIds: Type.Optional(Type.String({ maxLength: 20_000 })),
}, additionalProperties);
export const dashboardAppCatalogEntrySchema = Type.Object({
  bundleId: bundleIdSchema,
  displayName: Type.String(),
  displayNameLanguage: Type.Optional(Type.Literal('en')),
  iconUrl: Type.Optional(Type.String()),
  trackId: Type.Optional(Type.Integer({ minimum: 1 })),
  sellerName: Type.Optional(Type.String()),
  category: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  screenshots: Type.Optional(Type.Array(Type.String())),
  releaseNotes: Type.Optional(Type.String()),
  price: Type.Optional(Type.Number()),
  metadataFetchedAt: Type.Optional(Type.Number()),
  updatedAt: Type.Number(),
}, additionalProperties);
export const dashboardAppMetadataResponseSchema = Type.Object({ entries: Type.Array(dashboardAppCatalogEntrySchema) }, additionalProperties);
export const dashboardAppCatalogStatsResponseSchema = Type.Object({
  entries: Type.Integer({ minimum: 0 }),
  icons: Type.Integer({ minimum: 0 }),
  oldestUpdatedAt: Type.Optional(Type.Number()),
  newestUpdatedAt: Type.Optional(Type.Number()),
}, additionalProperties);
export const dashboardAppMetadataRefreshBodySchema = Type.Object({
  bundleIds: Type.Array(Type.Unknown(), { minItems: 1 }),
}, additionalProperties);
export const dashboardAppVersionsParamsSchema = Type.Object({ bundleId: bundleIdSchema }, additionalProperties);
export const dashboardAppVersionsQuerySchema = Type.Object({
  force: Type.Optional(Type.Union([
    Type.String({ description: 'Only true forces a refresh; other values use the cached lookup.' }),
    Type.Array(Type.String()),
  ])),
}, additionalProperties);
export const dashboardAppVersionsResponseSchema = Type.Object({
  versions: Type.Array(Type.Object({
    externalVersionId: Type.Optional(identifierSchema),
    isLatest: Type.Boolean(),
    displayVersion: Type.Optional(Type.String()),
    bundleVersion: Type.Optional(Type.String()),
    releaseDate: Type.Optional(Type.String()),
    minimumOsVersion: Type.Optional(Type.String()),
    artifactId: Type.Optional(identifierSchema),
  }, additionalProperties)),
}, additionalProperties);
export const dashboardAppStorefrontsQuerySchema = Type.Object({
  trackId: Type.String({ minLength: 1, maxLength: 20 }),
  countries: Type.String({ minLength: 2, maxLength: 100 }),
});
export const dashboardAppStorefrontsResponseSchema = Type.Object({
  trackId: Type.Integer({ minimum: 1 }),
  checkedAt: Type.Number(),
  storefronts: Type.Array(Type.Object({
    countryCode: Type.String({ minLength: 2, maxLength: 2 }),
    countryName: Type.String(),
    status: Type.Union([Type.Literal('available'), Type.Literal('unavailable'), Type.Literal('unknown')]),
    price: Type.Optional(Type.Number()),
    formattedPrice: Type.Optional(Type.String()),
    currency: Type.Optional(Type.String()),
  }, additionalProperties), { maxItems: 25 }),
}, additionalProperties);

export type DashboardAppSearchQuery = Static<typeof dashboardAppSearchQuerySchema>;
export type DashboardAppSearchResponse = Static<typeof dashboardAppSearchResponseSchema>;
export type DashboardAppStorefrontContextResponse = Static<typeof dashboardAppStorefrontContextResponseSchema>;
export type DashboardAppMetadataQuery = Static<typeof dashboardAppMetadataQuerySchema>;
export type DashboardAppMetadataResponse = Static<typeof dashboardAppMetadataResponseSchema>;
export type DashboardAppCatalogStatsResponse = Static<typeof dashboardAppCatalogStatsResponseSchema>;
export type DashboardAppMetadataRefreshBody = Static<typeof dashboardAppMetadataRefreshBodySchema>;
export type DashboardAppVersionsResponse = Static<typeof dashboardAppVersionsResponseSchema>;
export type DashboardAppStorefrontsRoute = {
  Querystring: Static<typeof dashboardAppStorefrontsQuerySchema>;
  Reply: { 200: Static<typeof dashboardAppStorefrontsResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 502: ApiErrorEnvelope };
};

type CommonRouteErrors = { 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 500: ApiErrorEnvelope };

export type DashboardAppSearchRoute = {
  Querystring: DashboardAppSearchQuery;
  Reply: { 200: DashboardAppSearchResponse; 502: ApiErrorEnvelope } & CommonRouteErrors;
};
export type DashboardAppStorefrontContextRoute = {
  Reply: { 200: DashboardAppStorefrontContextResponse } & Pick<CommonRouteErrors, 401 | 500>;
};

export type DashboardAppTrackLookupRoute = {
  Querystring: Static<typeof dashboardAppTrackLookupQuerySchema>;
  Reply: { 200: Static<typeof dashboardAppTrackLookupResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 502: ApiErrorEnvelope };
};

export type DashboardAppMetadataRoute = {
  Querystring: DashboardAppMetadataQuery;
  Reply: { 200: DashboardAppMetadataResponse } & CommonRouteErrors;
};

export type DashboardAppCatalogStatsRoute = {
  Reply: { 200: DashboardAppCatalogStatsResponse; 401: ApiErrorEnvelope } & Pick<CommonRouteErrors, 403 | 500>;
};

export type DashboardAppMetadataRefreshRoute = {
  Body: DashboardAppMetadataRefreshBody;
  Reply: { 200: DashboardAppMetadataResponse } & CommonRouteErrors;
};

export type DashboardAppVersionsRoute = {
  Params: Static<typeof dashboardAppVersionsParamsSchema>;
  Querystring: Static<typeof dashboardAppVersionsQuerySchema>;
  Reply: { 200: DashboardAppVersionsResponse; 502: ApiErrorEnvelope } & CommonRouteErrors;
};
