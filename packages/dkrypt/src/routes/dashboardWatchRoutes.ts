import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type {
  DashboardGitHubBudgetHistoryRoute,
  DashboardGitHubRateLimitRoute,
  DashboardGitHubReposRoute,
  DashboardGitHubWorkflowsRoute,
  DashboardWatchCalendarRoute,
  DashboardWatchCreateRoute,
  DashboardWatchDeleteRoute,
  DashboardWatchDispatchValidationRoute,
  DashboardWatchExportRoute,
  DashboardWatchHealthRoute,
  DashboardWatchImportRoute,
  DashboardWatchListRoute,
  DashboardWatchPreviewDraftRoute,
  DashboardWatchPreviewRoute,
  DashboardWatchSourcePreviewRoute,
  DashboardWatchTriggerRoute,
  DashboardWatchUpdateRoute,
  WatchPatchInput,
  WatchResponse,
} from '#dashboardWatchContracts.js';
import { projectIdentifierPattern } from '#apiCommonContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { canAccessProject } from '#dashboardJobPresentation.js';
import { getRouteContract } from '#contracts.js';
import { getAuthProfile } from '#identity.js';
import { emitJobsChanged } from '#events.js';
import { config } from '#config.js';
import { PermissionFlag } from '#permissions.js';
import { applyWatchSchedules, checkForTestFlightUpdate, checkForUpdate, triggerTickNow } from '#scheduler/index.js';
import { getGitHubRateLimitBudget, listDispatchRepos, listRepoWorkflows, validateDispatchTarget } from '#scheduler/github.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import {
  createWatch,
  DEFAULT_PROJECT_ID,
  deleteWatch,
  getEffectiveWatches,
  getGitHubBudgetTelemetry,
  getProject,
  getWatch,
  getWatchConfigIssues,
  getWatchHealthRollup,
  isWatchSchedulable,
  recordAudit,
  updateWatch,
  type AppWatch,
  type CreateWatchInput as WatchCreateInput,
  type DispatchTarget as WatchDispatchTarget,
} from '#store/state.js';
import { externalRequestRateLimiter, fastifyRateLimitPerUser } from '#util/rateLimit.js';
import { effectiveTimeZone, isValidTimeZone } from '#util/timezone.js';
import { isValidMaintenanceWindow, nextRunnableCronOccurrence } from '#util/maintenanceWindow.js';
import { findWatchConflicts } from '#watchConflicts.js';
import { deleteWatchDraft, getWatchRevision, listWatchDrafts, listWatchRevisions, saveWatchDraft } from '#store/watchWorkflowRepository.js';
import { sendHttpErrorEnvelope } from '#util/httpResponse.js';
import { validate as validateCronExpr } from 'node-cron';

const canViewScheduler = fastifyRequirePermission(PermissionFlag.viewAutomation, PermissionFlag.manageAutomation);
const canManageWatches = fastifyRequirePermission(PermissionFlag.manageAutomation);
const bundleIdPattern = /^[A-Za-z0-9.-]{3,200}$/;
const limitDispatchPreview = fastifyRateLimitPerUser(externalRequestRateLimiter, (request) => getFastifySession(request)?.sub ?? request.ip);

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  message: string,
  remediation?: Record<string, unknown>,
): void {
  sendHttpErrorEnvelope(reply, request.id, statusCode, message, remediation);
}

function githubFailureRemediation(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : '';
  const parsedStatus = Number(message.match(/\bHTTP\s+(\d{3})\b/)?.[1]);
  const upstreamStatus = Number.isInteger(parsedStatus) && parsedStatus >= 400 && parsedStatus <= 599 ? parsedStatus : undefined;
  let category = 'connection_or_request_failure';
  let action = 'Check GH_TOKEN permissions and GitHub API availability, then retry.';
  if (upstreamStatus === 401) {
    category = 'authentication';
    action = 'Refresh GH_TOKEN and verify it is authorized for GitHub API access.';
  } else if (upstreamStatus === 403) {
    category = 'permissions_or_rate_limit';
    action = 'Verify GH_TOKEN repository permissions and GitHub rate limits.';
  } else if (upstreamStatus === 404) {
    category = 'resource_not_found';
    action = 'Verify the repository exists and is visible to GH_TOKEN.';
  } else if (upstreamStatus === 429) {
    category = 'rate_limited';
    action = 'Wait for the GitHub rate limit to reset, then retry.';
  } else if (upstreamStatus !== undefined && upstreamStatus >= 500) {
    category = 'upstream_unavailable';
    action = 'Retry when the GitHub API is available.';
  }
  return { service: 'github', category, ...(upstreamStatus === undefined ? {} : { upstreamStatus }), action };
}

function validationFailed(request: FastifyRequest, reply: FastifyReply, message: string): boolean {
  if (!request.validationError) return false;
  sendError(request, reply, 400, message);
  return true;
}

function projectForRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  rawProjectId: unknown,
  requireActive = false,
): string | undefined {
  if (rawProjectId !== undefined && (typeof rawProjectId !== 'string' || !projectIdentifierPattern.test(rawProjectId))) {
    sendError(request, reply, 400, 'projectId must be a valid project identifier');
    return undefined;
  }
  const projectId = typeof rawProjectId === 'string' ? rawProjectId : DEFAULT_PROJECT_ID;
  const access = projectAccessState(request, projectId);
  if (access === 'missing' || access === 'inaccessible') {
    sendError(request, reply, 404, 'project not found');
    return undefined;
  }
  if (requireActive && access === 'archived') {
    sendError(request, reply, 409, 'project is archived');
    return undefined;
  }
  return projectId;
}

function projectAccessState(request: FastifyRequest, projectId: string): 'missing' | 'inaccessible' | 'archived' | 'available' {
  const project = getProject(projectId);
  if (!project) return 'missing';
  const session = getFastifySession(request);
  if (!session || !canAccessProject(session.sub, session.permissions, projectId)) return 'inaccessible';
  return project.archivedAt === undefined ? 'available' : 'archived';
}

function serializeWatch(watch: AppWatch): WatchResponse {
  const publicWatch = { ...watch };
  delete publicWatch.lastScheduledAt;
  return {
    ...publicWatch,
    timezone: effectiveTimeZone(watch.timezone),
    missedRunPolicy: watch.missedRunPolicy ?? 'skip',
    schedulable: isWatchSchedulable(watch),
    configIssues: getWatchConfigIssues(watch),
  };
}

function parseDispatchInputs(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const inputs = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => entry[0].trim().length > 0 && typeof entry[1] === 'string')
    .slice(0, 20);
  if (inputs.length === 0) return undefined;
  return Object.fromEntries(inputs.map(([key, item]) => [key.trim().slice(0, 100), item.trim().slice(0, 500)]));
}

function normalizedDispatchTargets(
  targets: unknown,
): (Omit<WatchDispatchTarget, 'mode'> & { mode: NonNullable<WatchDispatchTarget['mode']> })[] | undefined {
  if (!Array.isArray(targets)) return undefined;
  return targets
    .map((target) => {
      if (typeof target !== 'object' || target === null || Array.isArray(target)) return undefined;
      const value = target as Record<string, unknown>;
      const repo = typeof value.repo === 'string' ? value.repo.trim() : '';
      const ghWorkflowFile = typeof value.ghWorkflowFile === 'string' ? value.ghWorkflowFile.trim() : '';
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !ghWorkflowFile) return undefined;
      return {
        repo,
        ghWorkflowFile,
        mode: value.mode === 'workflow_dispatch' ? 'workflow_dispatch' as const : 'repository_dispatch' as const,
        ref: typeof value.ref === 'string' ? value.ref.trim() || undefined : undefined,
        inputs: parseDispatchInputs(value.inputs),
      };
    })
    .filter((target): target is Exclude<typeof target, undefined> => target !== undefined);
}

function parseWatchInput(body: unknown): WatchCreateInput | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  const bundleId = typeof value.bundleId === 'string' ? value.bundleId.trim() : '';
  if (!bundleId || !bundleIdPattern.test(bundleId)) return undefined;
  const dispatchTargets = Array.isArray(value.dispatchTargets) ? normalizedDispatchTargets(value.dispatchTargets) : undefined;
  const primary = dispatchTargets?.[0];
  const maintenanceWindow = value.maintenanceWindow === undefined || value.maintenanceWindow === null
    ? undefined
    : isValidMaintenanceWindow(value.maintenanceWindow) ? value.maintenanceWindow : null;
  if (maintenanceWindow === null) return undefined;
  return {
    projectId: typeof value.projectId === 'string' ? value.projectId : undefined,
    bundleId,
    repo: primary?.repo ?? (typeof value.repo === 'string' ? value.repo.trim() : ''),
    ghWorkflowFile: primary?.ghWorkflowFile ?? (typeof value.ghWorkflowFile === 'string' ? value.ghWorkflowFile.trim() : 'remote-ipa-update.yml'),
    dispatchTargets,
    pollCron: typeof value.pollCron === 'string' ? value.pollCron.trim() : '0 * * * *',
    timezone: typeof value.timezone === 'string' ? value.timezone.trim() : undefined,
    maintenanceWindow,
    missedRunPolicy: value.missedRunPolicy === 'runOnce' ? 'runOnce' : 'skip',
    enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
    webhookUrl: typeof value.webhookUrl === 'string' ? value.webhookUrl.trim() || undefined : undefined,
    testFlightPolicy: value.testFlightPolicy === 'latestNonExpired' || value.testFlightPolicy === 'train' ? value.testFlightPolicy : 'latest',
    testFlightTrain: typeof value.testFlightTrain === 'string' ? value.testFlightTrain.trim() || undefined : undefined,
  };
}

function parseWatchPatch(body: WatchPatchInput): Partial<WatchCreateInput> {
  const patch: Partial<WatchCreateInput> = {};
  if (typeof body.bundleId === 'string' && body.bundleId.trim()) patch.bundleId = body.bundleId.trim();
  if (typeof body.repo === 'string') patch.repo = body.repo.trim();
  if (typeof body.ghWorkflowFile === 'string') patch.ghWorkflowFile = body.ghWorkflowFile.trim();
  if (Array.isArray(body.dispatchTargets)) {
    patch.dispatchTargets = normalizedDispatchTargets(body.dispatchTargets) ?? [];
    if (patch.dispatchTargets[0]) {
      patch.repo = patch.dispatchTargets[0].repo;
      patch.ghWorkflowFile = patch.dispatchTargets[0].ghWorkflowFile;
    }
  }
  if (typeof body.pollCron === 'string') patch.pollCron = body.pollCron.trim();
  if (typeof body.timezone === 'string') patch.timezone = body.timezone.trim();
  if ('maintenanceWindow' in body) {
    patch.maintenanceWindow = body.maintenanceWindow === null ? undefined : body.maintenanceWindow;
  }
  if (body.missedRunPolicy === 'skip' || body.missedRunPolicy === 'runOnce') patch.missedRunPolicy = body.missedRunPolicy;
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.webhookUrl === 'string') patch.webhookUrl = body.webhookUrl.trim() || undefined;
  if (body.testFlightPolicy === 'latest' || body.testFlightPolicy === 'latestNonExpired' || body.testFlightPolicy === 'train') {
    patch.testFlightPolicy = body.testFlightPolicy;
  }
  if (typeof body.testFlightTrain === 'string') patch.testFlightTrain = body.testFlightTrain.trim() || undefined;
  if (typeof body.projectId === 'string') patch.projectId = body.projectId;
  return patch;
}

function visibleWatch(request: FastifyRequest<any>, reply: FastifyReply): AppWatch | undefined {
  const session = getFastifySession(request);
  const watch = getWatch((request.params as { id: string }).id);
  if (!watch || !session || !canAccessProject(session.sub, session.permissions, watch.projectId ?? DEFAULT_PROJECT_ID)) {
    sendError(request, reply, 404, 'watch not found');
    return undefined;
  }
  return watch;
}

export const dashboardWatchRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get('/v1/dashboard/watches/drafts', {
    schema: { hide: true, querystring: Type.Object({ projectId: Type.Optional(Type.String()) }) },
    preHandler: canManageWatches,
  }, (request, reply) => {
    const projectId = projectForRequest(request, reply, request.query.projectId, true);
    if (!projectId) return;
    return { drafts: listWatchDrafts(getFastifySession(request)!.sub, projectId) };
  });

  server.post('/v1/dashboard/watches/drafts', {
    schema: { hide: true, body: Type.Object({ id: Type.Optional(Type.String()), projectId: Type.String(), input: Type.Record(Type.String(), Type.Unknown()) }) },
    preHandler: canManageWatches,
  }, (request, reply) => {
    const projectId = projectForRequest(request, reply, request.body.projectId, true);
    if (!projectId) return;
    try {
      return saveWatchDraft(getFastifySession(request)!.sub, projectId, request.body.input, request.body.id);
    } catch {
      sendError(request, reply, 404, 'watch draft not found');
      return;
    }
  });

  server.delete('/v1/dashboard/watches/drafts/:id', {
    schema: { hide: true, params: Type.Object({ id: Type.String() }) },
    preHandler: canManageWatches,
  }, (request) => ({ deleted: deleteWatchDraft(request.params.id, getFastifySession(request)!.sub) }));

  server.post('/v1/dashboard/watches/conflicts', {
    schema: { hide: true, body: Type.Object({ watch: Type.Record(Type.String(), Type.Unknown()), excludeWatchId: Type.Optional(Type.String()) }) },
    preHandler: canManageWatches,
  }, (request, reply) => {
    const input = parseWatchInput(request.body.watch);
    if (!input) return sendError(request, reply, 400, 'watch input is malformed');
    const projectId = projectForRequest(request, reply, input.projectId, true);
    if (!projectId) return;
    return { conflicts: findWatchConflicts({ ...input, projectId }, request.body.excludeWatchId) };
  });

  server.get('/v1/dashboard/watches/:id/revisions', {
    schema: { hide: true, params: Type.Object({ id: Type.String() }), querystring: Type.Object({ projectId: Type.Optional(Type.String()) }) },
    preHandler: canManageWatches,
  }, (request, reply) => {
    const watch = getWatch(request.params.id);
    const projectId = watch?.projectId ?? request.query.projectId ?? DEFAULT_PROJECT_ID;
    const session = getFastifySession(request)!;
    if (!getProject(projectId) || !canAccessProject(session.sub, session.permissions, projectId) || (watch && request.query.projectId && request.query.projectId !== projectId)) return sendError(request, reply, 404, 'watch not found');
    const revisions = listWatchRevisions(request.params.id, projectId);
    if (!watch && revisions.length === 0) return sendError(request, reply, 404, 'watch revisions not found');
    return { revisions: revisions.map((revision) => ({ ...revision, actorDisplayName: getAuthProfile(revision.actor)?.displayName })) };
  });

  server.post('/v1/dashboard/watches/:id/revisions/:revisionId/restore', {
    schema: { hide: true, params: Type.Object({ id: Type.String(), revisionId: Type.String() }), body: Type.Object({ expectedUpdatedAt: Type.Number(), webhookUrl: Type.Optional(Type.String()), acknowledgeConflicts: Type.Optional(Type.Boolean()) }) },
    preHandler: canManageWatches,
  }, (request, reply) => {
    const watch = visibleWatch(request, reply);
    if (!watch) return;
    if (watch.updatedAt !== request.body.expectedUpdatedAt) return sendError(request, reply, 409, 'watch changed after this revision was selected');
    const revision = getWatchRevision(request.params.revisionId);
    if (!revision || revision.watchId !== watch.id || revision.projectId !== (watch.projectId ?? DEFAULT_PROJECT_ID)) return sendError(request, reply, 404, 'watch revision not found');
    if (revision.snapshot.webhookConfigured && !watch.webhookUrl && !request.body.webhookUrl) return sendError(request, reply, 409, 'enter the webhook URL before restoring this revision');
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, lastScheduledAt: _lastScheduledAt, webhookConfigured: _webhookConfigured, ...configuration } = revision.snapshot;
    const patch: Partial<WatchCreateInput> = { ...configuration, enabled: watch.enabled, webhookUrl: request.body.webhookUrl ?? watch.webhookUrl };
    if (findWatchConflicts(patch as WatchCreateInput, watch.id).length > 0 && request.body.acknowledgeConflicts !== true) return sendError(request, reply, 409, 'watch schedule conflicts require acknowledgement');
    const result = updateWatch(watch.id, patch, getFastifySession(request)!.sub, 'restored');
    if (!result.ok || !result.watch) return sendError(request, reply, 409, result.error ?? 'watch revision could not be restored');
    applyWatchSchedules();
    emitJobsChanged();
    return serializeWatch(result.watch);
  });

  server.get<DashboardGitHubRateLimitRoute>('/v1/dashboard/github/rate-limit', {
    schema: getRouteContract('GET', '/v1/dashboard/github/rate-limit'),
    preHandler: canManageWatches,
  }, async (request, reply) => {
    if (!config.ghToken) {
      sendError(request, reply, 409, 'GH_TOKEN is not configured');
      return;
    }
    try {
      const budget = await getGitHubRateLimitBudget(true);
      return budget ? { limit: budget.limit, remaining: budget.remaining, reset: Math.floor(budget.resetAt / 1000) } : {};
    } catch (error) {
      sendError(request, reply, 502, 'GitHub rate-limit lookup failed', githubFailureRemediation(error));
      return;
    }
  });

  server.get<DashboardWatchListRoute>('/v1/dashboard/watches', {
    schema: getRouteContract('GET', '/v1/dashboard/watches'),
    preHandler: canViewScheduler,
  }, (request) => {
    const session = getFastifySession(request)!;
    return {
      watches: getEffectiveWatches()
        .filter((watch) => canAccessProject(session.sub, session.permissions, watch.projectId ?? DEFAULT_PROJECT_ID))
        .map(serializeWatch),
    };
  });

  server.get<DashboardWatchExportRoute>('/v1/dashboard/watches/export', {
    schema: getRouteContract('GET', '/v1/dashboard/watches/export'),
    preHandler: canManageWatches,
  }, (request, reply) => {
    const session = getFastifySession(request)!;
    reply.header('Content-Disposition', 'attachment; filename="dkrypt-watches.json"');
    return {
      version: 1,
      watches: getEffectiveWatches()
        .filter((watch) => canAccessProject(session.sub, session.permissions, watch.projectId ?? DEFAULT_PROJECT_ID))
        .map((watch) => {
          const publicWatch = { ...watch };
          delete publicWatch.lastScheduledAt;
          publicWatch.missedRunPolicy = watch.missedRunPolicy ?? 'skip';
          return publicWatch;
        }),
    };
  });

  server.get<DashboardWatchHealthRoute>('/v1/dashboard/watches/health', {
    schema: getRouteContract('GET', '/v1/dashboard/watches/health'),
    preHandler: canViewScheduler,
  }, (request) => {
    const session = getFastifySession(request)!;
    const accessibleWatchIds = new Set(getEffectiveWatches()
      .filter((watch) => canAccessProject(session.sub, session.permissions, watch.projectId ?? DEFAULT_PROJECT_ID))
      .map((watch) => watch.id));
    return { watches: getWatchHealthRollup().filter((watch) => accessibleWatchIds.has(watch.watchId)) };
  });

  server.get<DashboardWatchCalendarRoute>('/v1/dashboard/watches/calendar', {
    schema: getRouteContract('GET', '/v1/dashboard/watches/calendar'),
    attachValidation: true,
    preHandler: canViewScheduler,
  }, (request, reply) => {
    if (validationFailed(request, reply, 'watch calendar query is malformed')) return;
    const projectId = projectForRequest(request, reply, request.query.projectId);
    if (!projectId) return;
    const hours = Math.min(Math.max(Number.parseInt(String(request.query.hours ?? '24'), 10) || 24, 1), 168);
    const requestedFromAt = Number.parseInt(String(request.query.fromAt ?? ''), 10);
    const now = Date.now();
    const fromAt = Number.isFinite(requestedFromAt) && Math.abs(requestedFromAt - now) <= 90 * 24 * 60 * 60 * 1000 ? requestedFromAt : now;
    const untilAt = fromAt + hours * 60 * 60 * 1000;
    const maxRuns = 200;
    const runs: { watchId: string; bundleId: string; at: number; deferred: boolean }[] = [];
    const pending = getEffectiveWatches()
      .filter((watch) => (watch.projectId ?? DEFAULT_PROJECT_ID) === projectId && isWatchSchedulable(watch))
      .flatMap((watch) => {
        const occurrence = nextRunnableCronOccurrence(watch.pollCron, effectiveTimeZone(watch.timezone), watch.maintenanceWindow, fromAt, untilAt);
        return occurrence === undefined ? [] : [{ watch, ...occurrence }];
      });
    while (pending.length > 0 && runs.length < maxRuns) {
      pending.sort((left, right) => left.at - right.at);
      const next = pending.shift()!;
      runs.push({ watchId: next.watch.id, bundleId: next.watch.bundleId, at: next.at, deferred: next.deferred });
      const following = nextRunnableCronOccurrence(next.watch.pollCron, effectiveTimeZone(next.watch.timezone), next.watch.maintenanceWindow, next.at, untilAt);
      if (following !== undefined) pending.push({ watch: next.watch, ...following });
    }
    return { fromAt, untilAt, runs, truncated: pending.length > 0 };
  });

  server.get<DashboardGitHubBudgetHistoryRoute>('/v1/dashboard/github/budget-history', {
    schema: getRouteContract('GET', '/v1/dashboard/github/budget-history'),
    attachValidation: true,
    preHandler: canManageWatches,
  }, (request, reply) => {
    if (validationFailed(request, reply, 'GitHub budget history query is malformed')) return;
    const projectId = projectForRequest(request, reply, request.query.projectId);
    if (!projectId) return;
    const limit = Math.min(Math.max(Number.parseInt(String(request.query.limit ?? '30'), 10) || 30, 1), 200);
    const watchIds = new Set(getEffectiveWatches()
      .filter((watch) => (watch.projectId ?? DEFAULT_PROJECT_ID) === projectId)
      .map((watch) => watch.id));
    return { entries: getGitHubBudgetTelemetry(200).filter((entry) => watchIds.has(entry.watchId)).slice(0, limit) };
  });

  server.get<DashboardGitHubReposRoute>('/v1/dashboard/github/repos', {
    schema: getRouteContract('GET', '/v1/dashboard/github/repos'),
    preHandler: canManageWatches,
  }, async (request, reply) => {
    if (!config.ghToken) {
      sendError(request, reply, 409, 'GH_TOKEN is not configured');
      return;
    }
    try {
      return { repos: await listDispatchRepos() };
    } catch (error) {
      sendError(request, reply, 502, 'GitHub repository lookup failed', githubFailureRemediation(error));
      return;
    }
  });

  server.get<DashboardGitHubWorkflowsRoute>('/v1/dashboard/github/workflows', {
    schema: getRouteContract('GET', '/v1/dashboard/github/workflows'),
    attachValidation: true,
    preHandler: canManageWatches,
  }, async (request, reply) => {
    if (validationFailed(request, reply, 'repo query must be owner/repo')) return;
    if (!config.ghToken) {
      sendError(request, reply, 409, 'GH_TOKEN is not configured');
      return;
    }
    try {
      return { workflows: await listRepoWorkflows(request.query.repo) };
    } catch (error) {
      sendError(request, reply, 502, 'GitHub workflow lookup failed', githubFailureRemediation(error));
      return;
    }
  });

  server.post<DashboardWatchCreateRoute>('/v1/dashboard/watches', {
    schema: getRouteContract('POST', '/v1/dashboard/watches'),
    attachValidation: true,
    preHandler: canManageWatches,
  }, (request, reply) => {
    if (validationFailed(request, reply, 'watch input is malformed')) return;
    const input = parseWatchInput(request.body);
    if (!input) {
      sendError(request, reply, 400, 'bundleId is required');
      return;
    }
    const projectId = projectForRequest(request, reply, input.projectId, true);
    if (!projectId) return;
    input.projectId = projectId;
    if (findWatchConflicts(input).length > 0 && request.body.acknowledgeConflicts !== true) {
      sendError(request, reply, 409, 'watch schedule overlaps another dispatch target; review conflicts and acknowledge before saving');
      return;
    }
    if (input.pollCron && !validateCronExpr(input.pollCron)) {
      sendError(request, reply, 400, 'pollCron is not a valid cron expression');
      return;
    }
    if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) {
      sendError(request, reply, 400, 'timezone must be a valid IANA timezone');
      return;
    }
    if (input.maintenanceWindow !== undefined && !isValidMaintenanceWindow(input.maintenanceWindow)) {
      sendError(request, reply, 400, 'maintenanceWindow must have different valid local start and end times');
      return;
    }
    if (input.testFlightPolicy === 'train' && !input.testFlightTrain) {
      sendError(request, reply, 400, 'testFlightTrain is required when testFlightPolicy is train');
      return;
    }
    const result = createWatch(input, getFastifySession(request)!.sub);
    if (!result.ok || !result.watch) {
      sendError(request, reply, 409, result.error ?? 'watch could not be created');
      return;
    }
    applyWatchSchedules();
    emitJobsChanged();
    reply.code(201);
    return serializeWatch(result.watch);
  });

  server.patch<DashboardWatchUpdateRoute>('/v1/dashboard/watches/:id', {
    schema: getRouteContract('PATCH', '/v1/dashboard/watches/:id'),
    attachValidation: true,
    preHandler: canManageWatches,
  }, (request, reply) => {
    if (validationFailed(request, reply, 'watch update is malformed')) return;
    const patch = parseWatchPatch(request.body);
    if (Object.hasOwn(request.body, 'projectId')) {
      const projectId = projectForRequest(request, reply, request.body.projectId, true);
      if (!projectId) return;
      patch.projectId = projectId;
    }
    if (patch.pollCron && !validateCronExpr(patch.pollCron)) {
      sendError(request, reply, 400, 'pollCron is not a valid cron expression');
      return;
    }
    if (patch.timezone !== undefined && !isValidTimeZone(patch.timezone)) {
      sendError(request, reply, 400, 'timezone must be a valid IANA timezone');
      return;
    }
    if (patch.maintenanceWindow !== undefined && !isValidMaintenanceWindow(patch.maintenanceWindow)) {
      sendError(request, reply, 400, 'maintenanceWindow must have different valid local start and end times');
      return;
    }
    const existingWatch = visibleWatch(request, reply);
    if (!existingWatch) return;
    if (request.body.expectedUpdatedAt !== undefined && request.body.expectedUpdatedAt !== existingWatch.updatedAt) {
      const { webhookUrl: _webhookUrl, ...current } = serializeWatch(existingWatch);
      sendError(request, reply, 409, 'watch changed after this action; review the current configuration before retrying', { current });
      return;
    }
    if (findWatchConflicts({ ...existingWatch, ...patch }, existingWatch.id).length > 0 && request.body.acknowledgeConflicts !== true) {
      sendError(request, reply, 409, 'watch schedule overlaps another dispatch target; review conflicts and acknowledge before saving');
      return;
    }
    if ((patch.testFlightPolicy ?? existingWatch.testFlightPolicy) === 'train' && !(patch.testFlightTrain ?? existingWatch.testFlightTrain)) {
      sendError(request, reply, 400, 'testFlightTrain is required when testFlightPolicy is train');
      return;
    }
    const result = updateWatch(request.params.id, patch, getFastifySession(request)!.sub);
    if (!result.ok || !result.watch) {
      sendError(request, reply, result.error === 'watch not found' ? 404 : 409, result.error ?? 'watch update was rejected');
      return;
    }
    applyWatchSchedules();
    emitJobsChanged();
    return serializeWatch(result.watch);
  });

  server.delete<DashboardWatchDeleteRoute>('/v1/dashboard/watches/:id', {
    schema: getRouteContract('DELETE', '/v1/dashboard/watches/:id'),
    preHandler: canManageWatches,
  }, (request, reply) => {
    if (!visibleWatch(request, reply)) return;
    if (!deleteWatch(request.params.id, getFastifySession(request)!.sub)) {
      sendError(request, reply, 404, 'watch not found');
      return;
    }
    applyWatchSchedules();
    emitJobsChanged();
    return { ok: true };
  });

  server.post<DashboardWatchImportRoute>('/v1/dashboard/watches/import', {
    schema: getRouteContract('POST', '/v1/dashboard/watches/import'),
    attachValidation: true,
    preHandler: canManageWatches,
  }, (request, reply) => {
    if (validationFailed(request, reply, 'watches must contain between 1 and 100 valid entries')) return;
    const imported: AppWatch[] = [];
    const skipped: string[] = [];
    for (const rawWatch of request.body.watches) {
      const input = parseWatchInput(rawWatch);
      if (!input || !validateCronExpr(input.pollCron) || (input.timezone !== undefined && !isValidTimeZone(input.timezone)) || (input.testFlightPolicy === 'train' && !input.testFlightTrain)) {
        skipped.push('invalid watch');
        continue;
      }
      const projectId = input.projectId ?? DEFAULT_PROJECT_ID;
      const session = getFastifySession(request)!;
      if (projectAccessState(request, projectId) !== 'available') {
        skipped.push(`${input.bundleId}: project is unavailable`);
        continue;
      }
      input.projectId = projectId;
      const result = createWatch({ ...input, enabled: false }, session.sub);
      if (result.watch) imported.push(result.watch);
      else skipped.push(result.error ?? 'could not import watch');
    }
    if (imported.length === 0) {
      sendError(request, reply, 400, skipped[0] ?? 'no watches were imported');
      return;
    }
    const session = getFastifySession(request)!;
    recordAudit(session.sub, 'watch.import', 'watches', `${imported.length} imported disabled`);
    applyWatchSchedules();
    emitJobsChanged();
    reply.code(201);
    return { watches: imported.map(serializeWatch), skipped };
  });

  server.post<DashboardWatchPreviewDraftRoute>('/v1/dashboard/watches/preview-dispatch-draft', {
    schema: getRouteContract('POST', '/v1/dashboard/watches/preview-dispatch-draft'),
    attachValidation: true,
    preHandler: [canManageWatches, limitDispatchPreview],
  }, async (request, reply) => {
    if (validationFailed(request, reply, 'bundleId and repo are required')) return;
    const { bundleId, repo } = request.body;
    if (!bundleIdPattern.test(bundleId) || !repo) {
      sendError(request, reply, 400, 'bundleId and repo are required');
      return;
    }
    const draft: AppWatch = {
      id: 'draft',
      bundleId,
      repo,
      ghWorkflowFile: '',
      pollCron: '',
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    };
    const [appStore, testflight] = await Promise.all([checkForUpdate(draft), checkForTestFlightUpdate(draft)]);
    return { ...appStore, testflight };
  });

  server.post<DashboardWatchDispatchValidationRoute>('/v1/dashboard/watches/validate-dispatch-draft', {
    schema: getRouteContract('POST', '/v1/dashboard/watches/validate-dispatch-draft'),
    attachValidation: true,
    preHandler: [canManageWatches, limitDispatchPreview],
  }, async (request, reply) => {
    if (validationFailed(request, reply, 'each dispatch target needs a valid repository and workflow')) return;
    const rawTargets = request.body.targets;
    if (rawTargets.length === 0 || rawTargets.length > 10) {
      sendError(request, reply, 400, 'provide between 1 and 10 dispatch targets');
      return;
    }
    const parsed = normalizedDispatchTargets(rawTargets);
    if (!parsed || parsed.length !== rawTargets.length) {
      sendError(request, reply, 400, 'each dispatch target needs a valid repository and workflow');
      return;
    }
    const results = await Promise.all(parsed.map((target) => validateDispatchTarget(target)));
    return { results, ok: results.every((result) => result.ok) };
  });

  server.get<DashboardWatchPreviewRoute>('/v1/dashboard/watches/:id/preview-dispatch', {
    schema: getRouteContract('GET', '/v1/dashboard/watches/:id/preview-dispatch'),
    preHandler: [canManageWatches, limitDispatchPreview],
  }, async (request, reply) => {
    const watch = visibleWatch(request, reply);
    if (!watch) return;
    const [appStore, testflight] = await Promise.all([checkForUpdate(watch), checkForTestFlightUpdate(watch)]);
    return { ...appStore, testflight };
  });

  server.get<DashboardWatchSourcePreviewRoute>('/v1/dashboard/watches/:id/preview-dispatch/:source', {
    schema: getRouteContract('GET', '/v1/dashboard/watches/:id/preview-dispatch/:source'),
    attachValidation: true,
    preHandler: [canManageWatches, limitDispatchPreview],
  }, async (request, reply) => {
    if (validationFailed(request, reply, 'source must be app-store or testflight')) return;
    const watch = visibleWatch(request, reply);
    if (!watch) return;
    if (request.params.source === 'app-store') return { source: 'appStore', result: await checkForUpdate(watch) };
    return { source: 'testflight', result: await checkForTestFlightUpdate(watch) };
  });

  server.post<DashboardWatchTriggerRoute>('/v1/dashboard/watches/:id/trigger-dispatch', {
    schema: getRouteContract('POST', '/v1/dashboard/watches/:id/trigger-dispatch'),
    preHandler: canManageWatches,
  }, async (request, reply) => {
    if (!visibleWatch(request, reply)) return;
    const result = await triggerTickNow(request.params.id);
    reply.code(result.ok ? 202 : 409);
    return result;
  });
};
