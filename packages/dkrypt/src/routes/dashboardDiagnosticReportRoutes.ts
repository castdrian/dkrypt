import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { DiagnosticReportInboxRoute, DiagnosticReportListRoute, DiagnosticReportPreviewRoute, DiagnosticReportSubmitRoute } from '#dashboardDiagnosticReportContracts.js';
import { diagnosticReportListResponseSchema, diagnosticReportPreviewBodySchema, diagnosticReportPreviewResponseSchema, diagnosticReportRecordSchema, diagnosticReportSubmitBodySchema } from '#dashboardDiagnosticReportContracts.js';
import { getAuthProfile } from '#identity.js';
import { config } from '#config.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import { DEFAULT_PROJECT_ID } from '#store/state.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';
import { createDiagnosticReportRepository, type DiagnosticReportRecord, type DiagnosticReportRepository } from '#store/diagnosticReportRepository.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

const REPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const sensitiveValuePattern = /(?:https?:\/\/\S+|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[0-9a-f]{8}-[0-9a-f-]{27,}\b|\b[0-9a-f]{40}\b|\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b|\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+|\b[\w-]*(?:token|secret|password|cookie|credential|api[-_ ]?key)\s*[:=]\s*[^\s,;]+)/gi;

interface DiagnosticReportServices {
  repository: DiagnosticReportRepository;
}

let defaultRepository: DiagnosticReportRepository | undefined;

function getDefaultRepository(): DiagnosticReportRepository {
  defaultRepository ??= createDiagnosticReportRepository(openStateCollectionDatabase({
    stateDir: config.stateDir,
    filename: config.stateDatabaseFile,
    busyTimeoutMs: config.stateDbBusyTimeoutMs,
  }, ['diagnostic_reports']));
  return defaultRepository;
}

function sanitizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(sensitiveValuePattern, (match) => match.includes(':') && isIP(match) !== 6 ? match : '[redacted]').trim().slice(0, 5000);
}

function signature(userId: string, category: string, summary: string, details: string, expiresAt: number): string {
  const payload = [userId, category, summary, details, expiresAt].join('\n');
  return createHmac('sha256', config.sessionSigningSecret).update(payload).digest('hex');
}

function tokenMatches(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function visibleReport(report: DiagnosticReportRecord): Omit<DiagnosticReportRecord, 'userId' | 'projectId'> {
  const { userId: _userId, projectId: _projectId, ...visible } = report;
  return visible;
}

export function createDashboardDiagnosticReportRoutes(overrides: Partial<Omit<DiagnosticReportServices, 'repository'>> & { repository?: DiagnosticReportRepository } = {}): FastifyPluginAsyncTypebox {
  return async (server) => {
    server.addHook('preHandler', fastifyRequireSession);
    server.addHook('preHandler', recordFastifyDashboardActivity);

    const repository = overrides.repository ?? getDefaultRepository();
    const prune = () => repository.pruneExpired(Date.now());
    let cleanupTimer: ReturnType<typeof setInterval> | undefined;
    server.addHook('onReady', async () => {
      prune();
      cleanupTimer = setInterval(prune, 60 * 60 * 1000);
      cleanupTimer.unref();
    });
    server.addHook('onClose', async () => {
      if (cleanupTimer) clearInterval(cleanupTimer);
    });

    server.post<DiagnosticReportPreviewRoute>('/v1/dashboard/diagnostic-reports/preview', {
      schema: { hide: true, body: diagnosticReportPreviewBodySchema, response: { 200: diagnosticReportPreviewResponseSchema } },
    }, (request, reply) => {
      const session = getFastifySession(request)!;
      const summary = sanitizeText(request.body.summary).slice(0, 200);
      const details = sanitizeText(request.body.details);
      if (!summary || !details) {
        reply.code(400);
        return createHttpErrorEnvelope(request.id, 400, 'add a short summary and details before previewing');
      }
      const expiresAt = Date.now() + PREVIEW_TTL_MS;
      return {
        category: request.body.category,
        summary,
        details,
        expiresAt,
        previewToken: `${expiresAt}.${signature(session.sub, request.body.category, summary, details, expiresAt)}`,
      };
    });

    server.post<DiagnosticReportSubmitRoute>('/v1/dashboard/diagnostic-reports', {
      schema: { hide: true, body: diagnosticReportSubmitBodySchema, response: { 201: diagnosticReportRecordSchema } },
    }, (request, reply) => {
      const session = getFastifySession(request)!;
      const projectId = DEFAULT_PROJECT_ID;
      const summary = sanitizeText(request.body.summary).slice(0, 200);
      const details = sanitizeText(request.body.details);
      const [expiryText, suppliedSignature] = request.body.previewToken.split('.', 2);
      const expiresAt = Number(expiryText);
      const expected = signature(session.sub, request.body.category, summary, details, expiresAt);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || !suppliedSignature || !tokenMatches(suppliedSignature, expected)) {
        reply.code(400);
        return createHttpErrorEnvelope(request.id, 400, 'preview again before submitting this report');
      }
      prune();
      const createdAt = Date.now();
      const report: DiagnosticReportRecord = {
        id: randomUUID(),
        userId: session.sub,
        projectId,
        category: request.body.category,
        summary,
        details,
        createdAt,
        expiresAt: createdAt + REPORT_RETENTION_MS,
        status: 'received',
      };
      repository.create(report);
      reply.code(201);
      return visibleReport(report);
    });

    server.get<DiagnosticReportListRoute>('/v1/dashboard/diagnostic-reports', {
      schema: { hide: true, response: { 200: diagnosticReportListResponseSchema } },
    }, (request) => {
      const session = getFastifySession(request)!;
      prune();
      return { reports: repository.listByUser(session.sub, 50).map(visibleReport) };
    });

    server.get<DiagnosticReportInboxRoute>('/v1/dashboard/diagnostic-reports/inbox', {
      schema: { hide: true, response: { 200: diagnosticReportListResponseSchema } },
      preHandler: fastifyRequirePermission(PermissionFlag.viewDiagnosticReports),
    }, () => {
      prune();
      return { reports: repository.listRecent(300).map((report) => ({ ...visibleReport(report), userId: report.userId, userDisplayName: getAuthProfile(report.userId)?.displayName ?? report.userId })) };
    });
  };
}

export const dashboardDiagnosticReportRoutes = createDashboardDiagnosticReportRoutes();
