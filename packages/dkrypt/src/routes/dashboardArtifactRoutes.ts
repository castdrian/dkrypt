import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ErrorEnvelope } from '#contracts.js';
import type { DashboardArtifactAnalysisRoute, DashboardArtifactArchiveRoute, DashboardArtifactAssetPreviewRoute, DashboardArtifactBulkArchiveRoute, DashboardArtifactBulkPinRoute, DashboardArtifactBulkQueryArchiveRoute, DashboardArtifactBulkQueryPinRoute, DashboardArtifactCompareRoute, DashboardArtifactContentsRoute, DashboardArtifactDetailRoute, DashboardArtifactFileRoute, DashboardArtifactListRoute, DashboardArtifactNoteRoute, DashboardArtifactNoteUpdateRoute, DashboardArtifactPinRoute, DashboardArtifactUndoRoute } from '#dashboardArtifactContracts.js';
import { dashboardArtifactAssetPreviewQuerySchema, dashboardArtifactBulkArchiveResponseSchema, dashboardArtifactBulkPinResponseSchema, dashboardArtifactBulkQueryArchiveBodySchema, dashboardArtifactBulkQueryPinBodySchema, dashboardArtifactCompareBodySchema, dashboardArtifactCompareResponseSchema, dashboardArtifactContentsQuerySchema, dashboardArtifactContentsResponseSchema, dashboardArtifactDetailQuerySchema, dashboardArtifactNoteBodySchema, dashboardArtifactNoteResponseSchema, dashboardArtifactParamsSchema, dashboardArtifactResponseSchema, dashboardArtifactUndoBodySchema, dashboardArtifactUndoResponseSchema, dashboardArtifactZipBodySchema, dashboardIpaAnalysisResponseSchema, dashboardIpaAnalysisUploadResponseSchema } from '#dashboardArtifactContracts.js';
import { artifactDownloadName, artifactFileAvailable, getArtifactById, listArtifacts, setArtifactArchived, setArtifactPinned, setArtifactsArchived, setArtifactsPinned, touchArtifact, undoArtifactStateChanges } from '#artifacts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { getRouteContract } from '#contracts.js';
import { streamFilePath } from '#jobs/http.js';
import { PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import { DEFAULT_PROJECT_ID, recordAudit } from '#store/state.js';
import { Response } from '#http.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';
import { streamArtifactZip } from '#artifactZip.js';
import type { ArtifactRecord } from '#artifactTypes.js';
import { compareIpaStructures, readIpaStructure } from '#ipaStructure.js';
import { analyzeIpaInIsolatedProcess, IpaInspectionCapacityError, readIpaAssetPreviewInIsolatedProcess } from '#jobs/ipaInspection.js';
import { formatArtifactFilename } from '#artifactFilename.js';
import { getUserPrefs, updateUserPrefs } from '#store/state.js';

const IPA_UPLOAD_CONTENT_TYPE = 'application/vnd.dkrypt.ipa';
const MAX_ANALYSIS_UPLOAD_BYTES = 256 * 1024 * 1024;
const MAX_PRIVATE_ARTIFACT_NOTES = 500;
let activeIpaAnalysisUploads = 0;

interface DashboardArtifactServices {
  artifactDownloadName: typeof artifactDownloadName;
  artifactFileAvailable: typeof artifactFileAvailable;
  getArtifactById: typeof getArtifactById;
  listArtifacts: typeof listArtifacts;
  setArtifactPinned: typeof setArtifactPinned;
  setArtifactsPinned: typeof setArtifactsPinned;
  setArtifactArchived: typeof setArtifactArchived;
  setArtifactsArchived: typeof setArtifactsArchived;
  undoArtifactStateChanges: typeof undoArtifactStateChanges;
  touchArtifact: typeof touchArtifact;
  recordAudit: typeof recordAudit;
  readIpaStructure: typeof readIpaStructure;
  analyzeIpa: typeof analyzeIpaInIsolatedProcess;
  previewIpaAsset: typeof readIpaAssetPreviewInIsolatedProcess;
}

const defaultServices: DashboardArtifactServices = {
  artifactDownloadName,
  artifactFileAvailable,
  getArtifactById,
  listArtifacts,
  setArtifactPinned,
  setArtifactsPinned,
  setArtifactArchived,
  setArtifactsArchived,
  undoArtifactStateChanges,
  touchArtifact,
  recordAudit,
  readIpaStructure,
  analyzeIpa: analyzeIpaInIsolatedProcess,
  previewIpaAsset: readIpaAssetPreviewInIsolatedProcess,
};

const canRequestDecrypt = fastifyRequirePermission(PermissionFlag.requestDecrypt);
const canManageStorage = fastifyRequirePermission(PermissionFlag.manageAutomation);

export function createDashboardArtifactRoutes(overrides: Partial<DashboardArtifactServices> = {}): FastifyPluginAsyncTypebox {
  const services = { ...defaultServices, ...overrides };
  const resolveMatchingArtifacts = (filter: { q?: string; channel?: 'appstore' | 'testflight'; archived: boolean }) => {
    const artifacts: ArtifactRecord[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 26; pageNumber += 1) {
      const page = services.listArtifacts({
        limit: 200,
        cursor,
        query: filter.q,
        channel: filter.channel,
        archived: filter.archived,
        projectIds: [DEFAULT_PROJECT_ID],
      });
      for (const artifact of page.artifacts) {
        if (!seen.has(artifact.id) && artifact.projectIds.includes(DEFAULT_PROJECT_ID) && services.artifactFileAvailable(artifact)) {
          artifacts.push(artifact);
          seen.add(artifact.id);
        }
      }
      if (artifacts.length > 5000) return { status: 'too-many' as const, artifacts };
      if (!page.nextCursor) return { status: 'ok' as const, artifacts };
      if (page.nextCursor === cursor) return { status: 'too-many' as const, artifacts };
      cursor = page.nextCursor;
    }
    return { status: 'too-many' as const, artifacts };
  };

  return async (server) => {
    server.addHook('preHandler', fastifyRequireSession);
    server.addHook('preHandler', recordFastifyDashboardActivity);
    if (!server.hasContentTypeParser(IPA_UPLOAD_CONTENT_TYPE)) {
      server.addContentTypeParser(IPA_UPLOAD_CONTENT_TYPE, (_request, payload, done) => done(null, payload));
    }

    server.get<DashboardArtifactListRoute>('/v1/dashboard/artifacts', {
      schema: getRouteContract('GET', '/v1/dashboard/artifacts'),
      preHandler: canRequestDecrypt,
    }, (request) => {
      const projectId = DEFAULT_PROJECT_ID;
      const cursor = request.query.cursor;
      const result = services.listArtifacts({
        offset: cursor ? 0 : request.query.offset ?? 0,
        limit: request.query.limit ?? 50,
        cursor,
        query: request.query.q,
        channel: request.query.channel,
        archived: request.query.archived ?? false,
        projectIds: [projectId],
      });
      return {
        ...result,
        artifacts: result.artifacts.map(({ projectIds: _projectIds, ...artifact }) => ({
          ...artifact,
          filePath: undefined,
          fileUrl: `/v1/dashboard/artifacts/${encodeURIComponent(artifact.id)}/file`,
          createdAt: new Date(artifact.createdAt).toISOString(),
          lastAccessedAt: new Date(artifact.lastAccessedAt).toISOString(),
          pinnedAt: artifact.pinnedAt === undefined ? undefined : new Date(artifact.pinnedAt).toISOString(),
          archivedAt: artifact.archivedAt === undefined ? undefined : new Date(artifact.archivedAt).toISOString(),
          pinnedStateChangedAt: artifact.pinnedStateChangedAt,
          archivedStateChangedAt: artifact.archivedStateChangedAt,
        })),
        nextCursor: result.nextCursor,
      };
    });

    server.get<DashboardArtifactDetailRoute>('/v1/dashboard/artifacts/:id', {
      schema: { hide: true, params: dashboardArtifactParamsSchema, querystring: dashboardArtifactDetailQuerySchema, response: { 200: dashboardArtifactResponseSchema, 404: ErrorEnvelope } },
      preHandler: canRequestDecrypt,
    }, (request, reply) => {
      const artifact = services.getArtifactById(request.params.id);
      const projectId = DEFAULT_PROJECT_ID;
      if (!artifact || !services.artifactFileAvailable(artifact) || !artifact.projectIds.includes(projectId)) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'artifact not found');
      }
      return {
        id: artifact.id,
        key: artifact.key,
        bundleId: artifact.bundleId,
        channel: artifact.channel,
        externalVersionId: artifact.externalVersionId,
        testflightBuildId: artifact.testflightBuildId,
        versionLabel: artifact.versionLabel,
        buildNumber: artifact.buildNumber,
        fileSizeBytes: artifact.fileSizeBytes,
        sha256: artifact.sha256,
        createdAt: new Date(artifact.createdAt).toISOString(),
        lastAccessedAt: new Date(artifact.lastAccessedAt).toISOString(),
        accessCount: artifact.accessCount,
        pinnedAt: artifact.pinnedAt === undefined ? undefined : new Date(artifact.pinnedAt).toISOString(),
        archivedAt: artifact.archivedAt === undefined ? undefined : new Date(artifact.archivedAt).toISOString(),
        pinnedStateChangedAt: artifact.pinnedStateChangedAt,
        archivedStateChangedAt: artifact.archivedStateChangedAt,
        sourceJobId: artifact.sourceJobId,
        warnings: artifact.warnings,
        fileUrl: `/v1/dashboard/artifacts/${encodeURIComponent(artifact.id)}/file`,
      };
    });

    server.get<DashboardArtifactContentsRoute>('/v1/dashboard/artifacts/:id/contents', {
      schema: { hide: true, params: dashboardArtifactParamsSchema, querystring: dashboardArtifactContentsQuerySchema, response: { 200: dashboardArtifactContentsResponseSchema, 400: ErrorEnvelope, 404: ErrorEnvelope } },
      preHandler: canRequestDecrypt,
    }, (request, reply) => {
      const artifact = services.getArtifactById(request.params.id);
      const projectId = DEFAULT_PROJECT_ID;
      if (!artifact || !services.artifactFileAvailable(artifact) || !artifact.projectIds.includes(projectId)) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'artifact not found');
      }
      try {
        const query = request.query.q?.trim().toLowerCase();
        const entries = services.readIpaStructure(artifact.filePath).filter((entry) => !query || entry.path.toLowerCase().includes(query));
        const offset = request.query.offset ?? 0;
        const limit = request.query.limit ?? 100;
        const page = entries.slice(offset, offset + limit);
        return { entries: page, total: entries.length, nextOffset: offset + page.length < entries.length ? offset + page.length : undefined };
      } catch {
        reply.code(400);
        return createHttpErrorEnvelope(request.id, 400, 'IPA package contents could not be read');
      }
    });

    server.get<DashboardArtifactAnalysisRoute>('/v1/dashboard/artifacts/:id/analysis', {
      schema: { hide: true, params: dashboardArtifactParamsSchema, response: { 200: dashboardIpaAnalysisResponseSchema, 400: ErrorEnvelope, 404: ErrorEnvelope, 429: ErrorEnvelope } },
      preHandler: canRequestDecrypt,
    }, async (request, reply) => {
      const artifact = services.getArtifactById(request.params.id);
      if (!artifact || !services.artifactFileAvailable(artifact) || !artifact.projectIds.includes(DEFAULT_PROJECT_ID)) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'artifact not found');
      }
      try {
        return { report: await services.analyzeIpa(artifact.filePath) };
      } catch (error) {
        if (error instanceof IpaInspectionCapacityError) {
          reply.header('Retry-After', String(error.retryAfterSeconds)).code(429);
          return createHttpErrorEnvelope(request.id, 429, error.message);
        }
        reply.code(400);
        return createHttpErrorEnvelope(request.id, 400, 'IPA analysis could not be completed');
      }
    });

    server.get<DashboardArtifactAssetPreviewRoute>('/v1/dashboard/artifacts/:id/asset-preview', {
      schema: { hide: true, params: dashboardArtifactParamsSchema, querystring: dashboardArtifactAssetPreviewQuerySchema, response: { 429: ErrorEnvelope } },
      preHandler: canRequestDecrypt,
    }, async (request, reply) => {
      const artifact = services.getArtifactById(request.params.id);
      if (!artifact || !services.artifactFileAvailable(artifact) || !artifact.projectIds.includes(DEFAULT_PROJECT_ID)) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'artifact not found');
      }
      try {
        const preview = await services.previewIpaAsset(artifact.filePath, request.query.path);
        return reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').type(preview.mimeType).send(preview.data);
      } catch (error) {
        if (error instanceof IpaInspectionCapacityError) {
          reply.header('Retry-After', String(error.retryAfterSeconds)).code(429);
          return createHttpErrorEnvelope(request.id, 429, error.message);
        }
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'IPA image asset is unavailable');
      }
    });

    server.get<DashboardArtifactNoteRoute>('/v1/dashboard/artifacts/:id/note', {
      schema: { hide: true, params: dashboardArtifactParamsSchema, response: { 200: dashboardArtifactNoteResponseSchema, 404: ErrorEnvelope } },
      preHandler: canRequestDecrypt,
    }, (request, reply) => {
      const artifact = services.getArtifactById(request.params.id);
      if (!artifact || !services.artifactFileAvailable(artifact) || !artifact.projectIds.includes(DEFAULT_PROJECT_ID)) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'artifact not found');
      }
      const userId = getFastifySession(request)!.sub;
      return { artifactId: artifact.id, note: getUserPrefs(userId).artifactNotes?.[artifact.id] ?? '' };
    });

    server.put<DashboardArtifactNoteUpdateRoute>('/v1/dashboard/artifacts/:id/note', {
      schema: { hide: true, params: dashboardArtifactParamsSchema, body: dashboardArtifactNoteBodySchema, response: { 200: dashboardArtifactNoteResponseSchema, 400: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope } },
      preHandler: canRequestDecrypt,
    }, (request, reply) => {
      const artifact = services.getArtifactById(request.params.id);
      if (!artifact || !services.artifactFileAvailable(artifact) || !artifact.projectIds.includes(DEFAULT_PROJECT_ID)) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'artifact not found');
      }
      const userId = getFastifySession(request)!.sub;
      const prefs = getUserPrefs(userId);
      const notes = { ...(prefs.artifactNotes ?? {}) };
      const note = request.body.note.trim();
      if (note) {
        if (notes[artifact.id] === undefined && Object.keys(notes).length >= MAX_PRIVATE_ARTIFACT_NOTES) {
          reply.code(409);
          return createHttpErrorEnvelope(request.id, 409, 'private artifact note limit reached');
        }
        notes[artifact.id] = note;
      } else {
        delete notes[artifact.id];
      }
      updateUserPrefs(userId, { artifactNotes: notes });
      return { artifactId: artifact.id, note };
    });

    server.post('/v1/dashboard/ipa-analysis', {
      bodyLimit: MAX_ANALYSIS_UPLOAD_BYTES,
      schema: { hide: true, response: { 200: dashboardIpaAnalysisUploadResponseSchema, 400: ErrorEnvelope, 413: ErrorEnvelope, 429: ErrorEnvelope } },
      preHandler: canRequestDecrypt,
    }, async (request, reply) => {
      const input = request.body as Readable | undefined;
      if (!input || typeof input.pipe !== 'function') {
        reply.code(400);
        return createHttpErrorEnvelope(request.id, 400, `upload the IPA as ${IPA_UPLOAD_CONTENT_TYPE}`);
      }
      if (activeIpaAnalysisUploads >= 1) {
        reply.header('Retry-After', '5').code(429);
        return createHttpErrorEnvelope(request.id, 429, 'An IPA upload is already being analyzed; retry shortly');
      }
      activeIpaAnalysisUploads += 1;
      let temporaryDirectory: string | undefined;
      let uploadedBytes = 0;
      const enforceLimit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          uploadedBytes += chunk.length;
          if (uploadedBytes > MAX_ANALYSIS_UPLOAD_BYTES) {
            const error = new Error('IPA upload exceeds the 256 MiB analysis limit') as Error & { statusCode?: number };
            error.statusCode = 413;
            callback(error);
            return;
          }
          callback(null, chunk);
        },
      });
      try {
        temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dkrypt-analysis-'));
        const ipaPath = path.join(temporaryDirectory, 'upload.ipa');
        await pipeline(input, enforceLimit, createWriteStream(ipaPath, { flags: 'wx', mode: 0o600 }));
        if (uploadedBytes === 0) {
          reply.code(400);
          return createHttpErrorEnvelope(request.id, 400, 'IPA upload is empty');
        }
        return await services.analyzeIpa(ipaPath);
      } catch (error) {
        if (error instanceof IpaInspectionCapacityError) {
          reply.header('Retry-After', String(error.retryAfterSeconds)).code(429);
          return createHttpErrorEnvelope(request.id, 429, error.message);
        }
        const status = (error as { statusCode?: number })?.statusCode === 413 ? 413 : 400;
        reply.code(status);
        return createHttpErrorEnvelope(request.id, status, status === 413 ? 'IPA upload exceeds the 256 MiB analysis limit' : 'IPA upload could not be analyzed');
      } finally {
        if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
        activeIpaAnalysisUploads -= 1;
      }
    });

    server.put<DashboardArtifactArchiveRoute>('/v1/dashboard/artifacts/:id/archive', {
      schema: getRouteContract('PUT', '/v1/dashboard/artifacts/:id/archive'),
      preHandler: canManageStorage,
    }, async (request, reply) => {
      const artifact = services.getArtifactById(request.params.id);
      const session = getFastifySession(request)!;
      const allowed = artifact?.projectIds.includes(DEFAULT_PROJECT_ID) ?? false;
      if (!artifact || !services.artifactFileAvailable(artifact) || !allowed) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'artifact not found');
      }
      const result = await services.setArtifactArchived(artifact.id, request.body.archived);
      if (!result.artifact) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'artifact not found');
      }
      if (result.changed) services.recordAudit(session.sub, request.body.archived ? 'artifact.archive' : 'artifact.restore', artifact.id);
      return {
        ok: true,
        changed: result.changed,
        artifactId: artifact.id,
        archived: result.artifact.archivedAt !== undefined,
        archivedAt: result.artifact.archivedAt === undefined ? undefined : new Date(result.artifact.archivedAt).toISOString(),
        archivedStateChangedAt: result.artifact.archivedStateChangedAt,
        previousArchivedAt: result.previousArchivedAt,
      };
    });

    server.post<DashboardArtifactBulkArchiveRoute>('/v1/dashboard/artifacts/bulk-archive', {
      schema: getRouteContract('POST', '/v1/dashboard/artifacts/bulk-archive'),
      preHandler: canManageStorage,
    }, async (request, reply) => {
      const session = getFastifySession(request)!;
      const artifacts = request.body.ids.map((id) => services.getArtifactById(id));
      const allAccessible = artifacts.every((artifact) => artifact
        && services.artifactFileAvailable(artifact)
        && artifact.projectIds.includes(DEFAULT_PROJECT_ID));
      if (!allAccessible) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'one or more artifacts were not found');
      }

      const result = await services.setArtifactsArchived(request.body.ids, request.body.archived);
      if (result.missingIds.length > 0) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'one or more artifacts were not found');
      }
      for (const id of result.changedIds) {
        services.recordAudit(session.sub, request.body.archived ? 'artifact.archive' : 'artifact.restore', id);
      }
      return {
        ok: true,
        archived: request.body.archived,
        changedIds: result.changedIds,
        artifacts: result.artifacts.map((artifact) => ({
          artifactId: artifact.id,
          archived: artifact.archivedAt !== undefined,
          archivedAt: artifact.archivedAt === undefined ? undefined : new Date(artifact.archivedAt).toISOString(),
          archivedStateChangedAt: artifact.archivedStateChangedAt,
          previousArchivedAt: result.previousArchivedAtById[artifact.id],
        })),
      };
    });

    server.post<DashboardArtifactBulkQueryPinRoute>('/v1/dashboard/artifacts/bulk-pin-query', {
      schema: { hide: true, body: dashboardArtifactBulkQueryPinBodySchema, response: { 200: dashboardArtifactBulkPinResponseSchema, 404: ErrorEnvelope } },
      preHandler: canManageStorage,
    }, async (request, reply) => {
      const session = getFastifySession(request)!;
      const resolved = resolveMatchingArtifacts(request.body.filter);
      if (resolved.status === 'too-many') return reply.code(413).send(createHttpErrorEnvelope(request.id, 413, 'select a narrower filter; query-wide actions are limited to 5,000 artifacts'));
      const ids = resolved.artifacts.map((artifact) => artifact.id);
      const result = await services.setArtifactsPinned(ids, request.body.pinned);
      if (result.missingIds.length > 0) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'one or more artifacts were not found'));
      const updatedArtifacts = result.artifacts.map((artifact) => ({
          artifactId: artifact.id,
          pinned: artifact.pinnedAt !== undefined,
          pinnedAt: artifact.pinnedAt === undefined ? undefined : new Date(artifact.pinnedAt).toISOString(),
          pinnedStateChangedAt: artifact.pinnedStateChangedAt,
          previousPinnedAt: result.previousPinnedAtById[artifact.id],
        }));
      if (result.changedIds.length > 0) services.recordAudit(session.sub, request.body.pinned ? 'artifact.pin' : 'artifact.unpin', 'query:all', `${result.changedIds.length} artifacts`);
      return { ok: true, pinned: request.body.pinned, changedIds: result.changedIds, artifacts: updatedArtifacts };
    });

    server.post<DashboardArtifactBulkQueryArchiveRoute>('/v1/dashboard/artifacts/bulk-archive-query', {
      schema: { hide: true, body: dashboardArtifactBulkQueryArchiveBodySchema, response: { 200: dashboardArtifactBulkArchiveResponseSchema, 404: ErrorEnvelope } },
      preHandler: canManageStorage,
    }, async (request, reply) => {
      const session = getFastifySession(request)!;
      const resolved = resolveMatchingArtifacts(request.body.filter);
      if (resolved.status === 'too-many') return reply.code(413).send(createHttpErrorEnvelope(request.id, 413, 'select a narrower filter; query-wide actions are limited to 5,000 artifacts'));
      const ids = resolved.artifacts.map((artifact) => artifact.id);
      const result = await services.setArtifactsArchived(ids, request.body.archived);
      if (result.missingIds.length > 0) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'one or more artifacts were not found'));
      const updatedArtifacts = result.artifacts.map((artifact) => ({
          artifactId: artifact.id,
          archived: artifact.archivedAt !== undefined,
          archivedAt: artifact.archivedAt === undefined ? undefined : new Date(artifact.archivedAt).toISOString(),
          archivedStateChangedAt: artifact.archivedStateChangedAt,
          previousArchivedAt: result.previousArchivedAtById[artifact.id],
        }));
      if (result.changedIds.length > 0) services.recordAudit(session.sub, request.body.archived ? 'artifact.archive' : 'artifact.restore', 'query:all', `${result.changedIds.length} artifacts`);
      return { ok: true, archived: request.body.archived, changedIds: result.changedIds, artifacts: updatedArtifacts };
    });

    server.put<DashboardArtifactPinRoute>('/v1/dashboard/artifacts/:id/pin', {
      schema: getRouteContract('PUT', '/v1/dashboard/artifacts/:id/pin'),
      preHandler: canManageStorage,
    }, async (request, reply) => {
      const artifact = services.getArtifactById(request.params.id);
      const session = getFastifySession(request)!;
      const allowed = artifact?.projectIds.includes(DEFAULT_PROJECT_ID) ?? false;
      if (!artifact || !services.artifactFileAvailable(artifact) || !allowed) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'artifact not found');
      }
      const result = await services.setArtifactPinned(artifact.id, request.body.pinned);
      if (!result.artifact) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'artifact not found');
      }
      if (result.changed) services.recordAudit(session.sub, request.body.pinned ? 'artifact.pin' : 'artifact.unpin', artifact.id);
      return {
        ok: true,
        changed: result.changed,
        artifactId: artifact.id,
        pinned: result.artifact.pinnedAt !== undefined,
        pinnedAt: result.artifact.pinnedAt === undefined ? undefined : new Date(result.artifact.pinnedAt).toISOString(),
        pinnedStateChangedAt: result.artifact.pinnedStateChangedAt,
        previousPinnedAt: result.previousPinnedAt,
      };
    });

    server.post<DashboardArtifactBulkPinRoute>('/v1/dashboard/artifacts/bulk-pin', {
      schema: getRouteContract('POST', '/v1/dashboard/artifacts/bulk-pin'),
      preHandler: canManageStorage,
    }, async (request, reply) => {
      const session = getFastifySession(request)!;
      const artifacts = request.body.ids.map((id) => services.getArtifactById(id));
      const allAccessible = artifacts.every((artifact) => artifact
        && services.artifactFileAvailable(artifact)
        && artifact.projectIds.includes(DEFAULT_PROJECT_ID));
      if (!allAccessible) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'one or more artifacts were not found');
      }

      const result = await services.setArtifactsPinned(request.body.ids, request.body.pinned);
      if (result.missingIds.length > 0) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'one or more artifacts were not found');
      }
      for (const id of result.changedIds) {
        services.recordAudit(session.sub, request.body.pinned ? 'artifact.pin' : 'artifact.unpin', id);
      }
      return {
        ok: true,
        pinned: request.body.pinned,
        changedIds: result.changedIds,
        artifacts: result.artifacts.map((artifact) => ({
          artifactId: artifact.id,
          pinned: artifact.pinnedAt !== undefined,
          pinnedAt: artifact.pinnedAt === undefined ? undefined : new Date(artifact.pinnedAt).toISOString(),
          pinnedStateChangedAt: artifact.pinnedStateChangedAt,
          previousPinnedAt: result.previousPinnedAtById[artifact.id],
        })),
      };
    });

    server.post<DashboardArtifactUndoRoute>('/v1/dashboard/artifacts/undo', {
      schema: { hide: true, body: dashboardArtifactUndoBodySchema, response: { 200: dashboardArtifactUndoResponseSchema, 400: ErrorEnvelope } },
      preHandler: canManageStorage,
    }, async (request, reply) => {
      const session = getFastifySession(request)!;
      const ids = request.body.changes.map((change) => change.id);
      if (new Set(ids).size !== ids.length) {
        return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'undo changes must use unique artifact IDs'));
      }
      const accessible = request.body.changes.every((change) => {
        const artifact = services.getArtifactById(change.id);
        return artifact
          && services.artifactFileAvailable(artifact)
          && artifact.projectIds.includes(DEFAULT_PROJECT_ID);
      });
      if (!accessible) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'one or more artifacts were not found'));
      const result = await services.undoArtifactStateChanges(request.body.changes);
      for (const id of result.undoneIds) {
        const change = request.body.changes.find((candidate) => candidate.id === id)!;
        const action = change.kind === 'pin'
          ? change.restoreAt === undefined ? 'artifact.unpin' : 'artifact.pin'
          : change.restoreAt === undefined ? 'artifact.restore' : 'artifact.archive';
        services.recordAudit(session.sub, action, id);
      }
      return result;
    });

    server.get<DashboardArtifactFileRoute>('/v1/dashboard/artifacts/:id/file', {
      schema: getRouteContract('GET', '/v1/dashboard/artifacts/:id/file'),
      preHandler: canRequestDecrypt,
    }, async (request, reply) => {
      const artifact = services.getArtifactById(request.params.id);
      const session = getFastifySession(request)!;
      const allowed = artifact?.projectIds.includes(DEFAULT_PROJECT_ID) ?? false;
      if (!artifact || !services.artifactFileAvailable(artifact) || !allowed) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'artifact not found');
      }
      await services.touchArtifact(artifact);
      const filename = formatArtifactFilename(getUserPrefs(session.sub).artifactFilenameTemplate, artifact);
      await streamFilePath(artifact.filePath, request.raw, new Response(reply), filename, artifact.fileSizeBytes, artifact.id);
      return;
    });

    server.post<{ Body: { ids: string[] } }>('/v1/dashboard/artifacts/export.zip', {
      schema: { hide: true, body: dashboardArtifactZipBodySchema },
      preHandler: canRequestDecrypt,
    }, async (request, reply) => {
      const artifacts = request.body.ids.map((id) => services.getArtifactById(id));
      const allowed = artifacts.every((artifact) => artifact
        && services.artifactFileAvailable(artifact)
        && artifact.projectIds.includes(DEFAULT_PROJECT_ID));
      if (!allowed) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'one or more artifacts were not found'));
      const entries = artifacts.map((artifact) => ({
        path: artifact!.filePath,
        name: services.artifactDownloadName(artifact!),
        size: artifact!.fileSizeBytes,
      }));
      const uniqueNames = new Set<string>();
      for (const entry of entries) {
        const filename = entry.name.replace(/[\\/\0]/g, '_');
        if (uniqueNames.has(filename)) return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'selected artifact filenames must be unique'));
        uniqueNames.add(filename);
      }
      for (const artifact of artifacts) await services.touchArtifact(artifact!);
      reply.type('application/zip').header('Content-Disposition', 'attachment; filename="dkrypt-artifacts.zip"');
      return reply.send(streamArtifactZip(entries));
    });

    server.post<DashboardArtifactCompareRoute>('/v1/dashboard/artifacts/compare', {
      schema: { hide: true, body: dashboardArtifactCompareBodySchema, response: { 200: dashboardArtifactCompareResponseSchema, 400: ErrorEnvelope, 404: ErrorEnvelope } },
      preHandler: canRequestDecrypt,
    }, (request, reply) => {
      const projectId = DEFAULT_PROJECT_ID;
      const beforeArtifact = services.getArtifactById(request.body.ids[0]!);
      const afterArtifact = services.getArtifactById(request.body.ids[1]!);
      const artifacts = [beforeArtifact, afterArtifact];
      if (artifacts.some((artifact) => !artifact || !artifact.projectIds.includes(projectId) || !services.artifactFileAvailable(artifact))) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'one or both artifacts were not found');
      }
      if (beforeArtifact!.bundleId !== afterArtifact!.bundleId) {
        reply.code(400);
        return createHttpErrorEnvelope(request.id, 400, 'artifacts must belong to the same app');
      }
      try {
        const diff = compareIpaStructures(readIpaStructure(beforeArtifact!.filePath), readIpaStructure(afterArtifact!.filePath));
        const added = diff.added.map((entry) => entry.path);
        const removed = diff.removed.map((entry) => entry.path);
        const changed = diff.changed.map((entry) => ({ path: entry.path, beforeBytes: entry.before.uncompressedSize, afterBytes: entry.after.uncompressedSize }));
        return {
          before: { id: beforeArtifact!.id, bundleId: beforeArtifact!.bundleId, versionLabel: beforeArtifact!.versionLabel, fileSizeBytes: beforeArtifact!.fileSizeBytes },
          after: { id: afterArtifact!.id, bundleId: afterArtifact!.bundleId, versionLabel: afterArtifact!.versionLabel, fileSizeBytes: afterArtifact!.fileSizeBytes },
          counts: diff.counts,
          added: added.slice(0, 200),
          removed: removed.slice(0, 200),
          changed: changed.slice(0, 200),
          truncated: diff.counts.added + diff.counts.removed + diff.counts.changed > added.length + removed.length + changed.length,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'IPA structure could not be read';
        reply.code(400);
        return createHttpErrorEnvelope(request.id, 400, message);
      }
    });
  };
}

export const dashboardArtifactRoutes = createDashboardArtifactRoutes();
