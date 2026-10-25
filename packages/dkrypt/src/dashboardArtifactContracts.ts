import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';
import { bundleIdSchema, identifierSchema, paginationQueryProperties, projectIdentifierSchema } from '#apiCommonContracts.js';

const additionalProperties = { additionalProperties: true } as const;

export const dashboardArtifactListQuerySchema = Type.Object({
  ...paginationQueryProperties,
  projectId: Type.Optional(projectIdentifierSchema),
  q: Type.Optional(Type.String({ maxLength: 200 })),
  channel: Type.Optional(Type.Union([Type.Literal('appstore'), Type.Literal('testflight')])),
  archived: Type.Optional(Type.Boolean()),
}, additionalProperties);

export const dashboardArtifactResponseSchema = Type.Object({
  id: identifierSchema,
  key: Type.String(),
  bundleId: bundleIdSchema,
  channel: Type.Union([Type.Literal('appstore'), Type.Literal('testflight')]),
  externalVersionId: Type.Optional(identifierSchema),
  testflightBuildId: Type.Optional(Type.Integer({ minimum: 1 })),
  versionLabel: Type.Optional(Type.String()),
  buildNumber: Type.Optional(Type.String()),
  fileSizeBytes: Type.Number({ minimum: 0 }),
  sha256: Type.String({ minLength: 64, maxLength: 64 }),
  createdAt: Type.String({ format: 'date-time' }),
  lastAccessedAt: Type.String({ format: 'date-time' }),
  accessCount: Type.Integer({ minimum: 0 }),
  pinnedAt: Type.Optional(Type.String({ format: 'date-time' })),
  archivedAt: Type.Optional(Type.String({ format: 'date-time' })),
  pinnedStateChangedAt: Type.Optional(Type.Number()),
  archivedStateChangedAt: Type.Optional(Type.Number()),
  sourceJobId: Type.Optional(identifierSchema),
  warnings: Type.Optional(Type.Array(Type.String())),
  fileUrl: Type.String(),
}, additionalProperties);

export const dashboardArtifactListResponseSchema = Type.Object({
  artifacts: Type.Array(dashboardArtifactResponseSchema),
  total: Type.Integer({ minimum: 0 }),
  totalBytes: Type.Number({ minimum: 0 }),
  maxBytes: Type.Number({ minimum: 0 }),
  nextCursor: Type.Optional(Type.String()),
}, additionalProperties);

export const dashboardArtifactParamsSchema = Type.Object({ id: identifierSchema }, additionalProperties);
export const dashboardArtifactDetailQuerySchema = Type.Object({ projectId: Type.Optional(projectIdentifierSchema) }, additionalProperties);
export const dashboardArtifactContentsQuerySchema = Type.Object({
  projectId: Type.Optional(projectIdentifierSchema),
  q: Type.Optional(Type.String({ maxLength: 200 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
}, additionalProperties);
export const dashboardArtifactContentsResponseSchema = Type.Object({
  entries: Type.Array(Type.Object({ path: Type.String(), compressedSize: Type.Integer({ minimum: 0 }), uncompressedSize: Type.Integer({ minimum: 0 }), crc32: Type.Integer({ minimum: 0 }) }, additionalProperties)),
  total: Type.Integer({ minimum: 0 }),
  nextOffset: Type.Optional(Type.Integer({ minimum: 0 })),
}, additionalProperties);

export const dashboardArtifactPinBodySchema = Type.Object({ pinned: Type.Boolean() }, additionalProperties);

export const dashboardArtifactPinResponseSchema = Type.Object({
  ok: Type.Boolean(),
  changed: Type.Boolean(),
  artifactId: identifierSchema,
  pinned: Type.Boolean(),
  pinnedAt: Type.Optional(Type.String({ format: 'date-time' })),
  pinnedStateChangedAt: Type.Optional(Type.Number()),
  previousPinnedAt: Type.Optional(Type.Number()),
}, additionalProperties);

export const dashboardArtifactBulkPinBodySchema = Type.Object({
  ids: Type.Array(identifierSchema, { minItems: 1, maxItems: 100, uniqueItems: true }),
  pinned: Type.Boolean(),
}, additionalProperties);

export const dashboardArtifactBulkPinResponseSchema = Type.Object({
  ok: Type.Boolean(),
  pinned: Type.Boolean(),
  changedIds: Type.Array(identifierSchema),
  artifacts: Type.Array(Type.Object({
    artifactId: identifierSchema,
    pinned: Type.Boolean(),
    pinnedAt: Type.Optional(Type.String({ format: 'date-time' })),
    pinnedStateChangedAt: Type.Optional(Type.Number()),
    previousPinnedAt: Type.Optional(Type.Number()),
  }, additionalProperties)),
}, additionalProperties);

export const dashboardArtifactArchiveBodySchema = Type.Object({ archived: Type.Boolean() }, additionalProperties);

export const dashboardArtifactArchiveResponseSchema = Type.Object({
  ok: Type.Boolean(),
  changed: Type.Boolean(),
  artifactId: identifierSchema,
  archived: Type.Boolean(),
  archivedAt: Type.Optional(Type.String({ format: 'date-time' })),
  archivedStateChangedAt: Type.Optional(Type.Number()),
  previousArchivedAt: Type.Optional(Type.Number()),
}, additionalProperties);

export const dashboardArtifactBulkArchiveBodySchema = Type.Object({
  ids: Type.Array(identifierSchema, { minItems: 1, maxItems: 100, uniqueItems: true }),
  archived: Type.Boolean(),
}, additionalProperties);

const dashboardArtifactQuerySelectionSchema = Type.Object({
  projectId: projectIdentifierSchema,
  q: Type.Optional(Type.String({ maxLength: 200 })),
  channel: Type.Optional(Type.Union([Type.Literal('appstore'), Type.Literal('testflight')])),
  archived: Type.Boolean(),
}, additionalProperties);

export const dashboardArtifactBulkQueryPinBodySchema = Type.Object({
  filter: dashboardArtifactQuerySelectionSchema,
  pinned: Type.Boolean(),
}, additionalProperties);

export const dashboardArtifactBulkQueryArchiveBodySchema = Type.Object({
  filter: dashboardArtifactQuerySelectionSchema,
  archived: Type.Boolean(),
}, additionalProperties);

export const dashboardArtifactZipBodySchema = Type.Object({
  ids: Type.Array(identifierSchema, { minItems: 1, maxItems: 100, uniqueItems: true }),
}, additionalProperties);

export const dashboardArtifactCompareBodySchema = Type.Object({
  ids: Type.Array(identifierSchema, { minItems: 2, maxItems: 2, uniqueItems: true }),
  projectId: projectIdentifierSchema,
}, additionalProperties);

export const dashboardArtifactCompareResponseSchema = Type.Object({
  before: Type.Object({ id: identifierSchema, bundleId: bundleIdSchema, versionLabel: Type.Optional(Type.String()), fileSizeBytes: Type.Number() }, additionalProperties),
  after: Type.Object({ id: identifierSchema, bundleId: bundleIdSchema, versionLabel: Type.Optional(Type.String()), fileSizeBytes: Type.Number() }, additionalProperties),
  counts: Type.Object({ added: Type.Integer(), removed: Type.Integer(), changed: Type.Integer(), unchanged: Type.Integer() }, additionalProperties),
  added: Type.Array(Type.String(), { maxItems: 200 }),
  removed: Type.Array(Type.String(), { maxItems: 200 }),
  changed: Type.Array(Type.Object({ path: Type.String(), beforeBytes: Type.Number(), afterBytes: Type.Number() }, additionalProperties), { maxItems: 200 }),
  truncated: Type.Boolean(),
}, additionalProperties);

export const dashboardArtifactBulkArchiveResponseSchema = Type.Object({
  ok: Type.Boolean(),
  archived: Type.Boolean(),
  changedIds: Type.Array(identifierSchema),
  artifacts: Type.Array(Type.Object({
    artifactId: identifierSchema,
    archived: Type.Boolean(),
    archivedAt: Type.Optional(Type.String({ format: 'date-time' })),
    archivedStateChangedAt: Type.Optional(Type.Number()),
    previousArchivedAt: Type.Optional(Type.Number()),
  }, additionalProperties)),
}, additionalProperties);

export const dashboardArtifactUndoBodySchema = Type.Object({
  changes: Type.Array(Type.Object({
    id: identifierSchema,
    kind: Type.Union([Type.Literal('pin'), Type.Literal('archive')]),
    expectedStateChangedAt: Type.Number({ minimum: 0 }),
    expectedCurrentState: Type.Boolean(),
    restoreAt: Type.Optional(Type.Number({ minimum: 0 })),
  }), { minItems: 1, maxItems: 5000 }),
}, additionalProperties);

export const dashboardArtifactUndoResponseSchema = Type.Object({
  undoneIds: Type.Array(identifierSchema),
  conflictIds: Type.Array(identifierSchema),
}, additionalProperties);

export type DashboardArtifactListRoute = {
  Querystring: Static<typeof dashboardArtifactListQuerySchema>;
  Reply: { 200: Static<typeof dashboardArtifactListResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardArtifactDetailRoute = {
  Params: Static<typeof dashboardArtifactParamsSchema>;
  Querystring: Static<typeof dashboardArtifactDetailQuerySchema>;
  Reply: { 200: Static<typeof dashboardArtifactResponseSchema>; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope };
};

export type DashboardArtifactContentsRoute = {
  Params: Static<typeof dashboardArtifactParamsSchema>;
  Querystring: Static<typeof dashboardArtifactContentsQuerySchema>;
  Reply: { 200: Static<typeof dashboardArtifactContentsResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope };
};

export type DashboardArtifactPinRoute = {
  Params: Static<typeof dashboardArtifactParamsSchema>;
  Body: Static<typeof dashboardArtifactPinBodySchema>;
  Reply: { 200: Static<typeof dashboardArtifactPinResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardArtifactBulkPinRoute = {
  Body: Static<typeof dashboardArtifactBulkPinBodySchema>;
  Reply: { 200: Static<typeof dashboardArtifactBulkPinResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardArtifactArchiveRoute = {
  Params: Static<typeof dashboardArtifactParamsSchema>;
  Body: Static<typeof dashboardArtifactArchiveBodySchema>;
  Reply: { 200: Static<typeof dashboardArtifactArchiveResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardArtifactBulkArchiveRoute = {
  Body: Static<typeof dashboardArtifactBulkArchiveBodySchema>;
  Reply: { 200: Static<typeof dashboardArtifactBulkArchiveResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardArtifactBulkQueryPinRoute = {
  Body: Static<typeof dashboardArtifactBulkQueryPinBodySchema>;
  Reply: { 200: Static<typeof dashboardArtifactBulkPinResponseSchema>; 400: ApiErrorEnvelope; 404: ApiErrorEnvelope; 413: ApiErrorEnvelope };
};

export type DashboardArtifactBulkQueryArchiveRoute = {
  Body: Static<typeof dashboardArtifactBulkQueryArchiveBodySchema>;
  Reply: { 200: Static<typeof dashboardArtifactBulkArchiveResponseSchema>; 400: ApiErrorEnvelope; 404: ApiErrorEnvelope; 413: ApiErrorEnvelope };
};

export type DashboardArtifactCompareRoute = {
  Body: Static<typeof dashboardArtifactCompareBodySchema>;
  Reply: { 200: Static<typeof dashboardArtifactCompareResponseSchema>; 400: ApiErrorEnvelope; 404: ApiErrorEnvelope };
};

export type DashboardArtifactUndoRoute = {
  Body: Static<typeof dashboardArtifactUndoBodySchema>;
  Reply: { 200: Static<typeof dashboardArtifactUndoResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardArtifactFileRoute = {
  Params: Static<typeof dashboardArtifactParamsSchema>;
  Reply: { 200: unknown; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};
