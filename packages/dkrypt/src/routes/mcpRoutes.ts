import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { createMcpHandler, fromJsonSchema, McpServer, ResourceTemplate, type AuthInfo, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';
import { artifactDownloadName, getArtifactById, artifactFileAvailable, listArtifacts } from '#artifacts.js';
import { config, isDiscordOauthEnabled, isGithubOauthEnabled } from '#config.js';
import { resolveDecryptTarget, resolveLatestTestFlightTarget } from '#decryptTarget.js';
import { getJob, getActiveJobs, enqueueDecryptJob, waitForJob, cancelJob, pauseQueuedJob, resumePausedJob } from '#jobs/store.js';
import { analyzeIpaInIsolatedProcess } from '#jobs/ipaInspection.js';
import { fastifyRequireSession, getFastifySession } from '#session.js';
import { getDevice, getJobHistoryPage, getUserEffectivePermissions, listDevices, recordAudit, DEFAULT_PROJECT_ID } from '#store/state.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';
import { PermissionFlag, hasPermission } from '#permissions.js';
import { lookupAppMetadata } from '#appStoreMetadata.js';
import type { TFBuild } from '#testflight.js';
import { getMaintenanceStatus } from '#maintenance.js';

const RESOURCE = `${config.publicBaseUrl.replace(/\/$/, '')}/v1/mcp`;
const RESOURCE_METADATA = `${config.publicBaseUrl.replace(/\/$/, '')}/.well-known/oauth-protected-resource/mcp`;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const APPROVAL_TTL_MS = 10 * 60 * 1000;
const DOWNLOAD_LINK_TTL_MS = 5 * 60 * 1000;
const OAUTH_RATE_LIMIT_MS = 60_000;
const supportedScopes = ['decrypt:plan', 'decrypt:submit', 'jobs:read', 'jobs:control', 'artifacts:read', 'ipa:analyze', 'devices:read'] as const;
type SupportedScope = typeof supportedScopes[number];

interface McpClientRecord {
  id: string;
  type: 'client';
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}

interface AuthorizationCodeRecord {
  id: string;
  type: 'authorization_code';
  clientId: string;
  clientName: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: SupportedScope[];
  state?: string;
  expiresAt: number;
}

interface AccessTokenRecord {
  id: string;
  type: 'access_token';
  clientId: string;
  clientName: string;
  userId: string;
  resource: string;
  scopes: SupportedScope[];
  createdAt: number;
  expiresAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

interface RefreshTokenRecord {
  id: string;
  type: 'refresh_token';
  accessTokenId: string;
  clientId: string;
  userId: string;
  expiresAt: number;
}

interface DecryptPlanRecord {
  id: string;
  type: 'decrypt_plan';
  userId: string;
  clientId: string;
  bundleId: string;
  versionLabel: string;
  channel: 'appstore' | 'testflight';
  externalVersionId?: string;
  testflight?: { appId: number; build: TFBuild };
  minimumOsVersion?: string;
  status: 'pending' | 'approved' | 'rejected' | 'submitted';
  createdAt: number;
  expiresAt: number;
  jobId?: string;
}

const database = openStateCollectionDatabase({ stateDir: config.stateDir, filename: config.stateDatabaseFile, busyTimeoutMs: config.stateDbBusyTimeoutMs }, ['mcp_records']);

export function closeMcpDatabase(): void {
  database.close();
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function recordId(type: string, value: string): string {
  return `${type}:${value}`;
}

function readRecord<T>(id: string): T | undefined {
  const row = database.query('SELECT payload FROM mcp_records WHERE id = ?').get(id) as { payload: string } | null;
  if (!row) return undefined;
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return undefined;
  }
}

function listRecords<T>(type: string): T[] {
  const rows = database.query("SELECT payload FROM mcp_records WHERE json_extract(payload, '$.type') = ? ORDER BY updated_at DESC").all(type) as Array<{ payload: string }>;
  return rows.flatMap(({ payload }) => {
    try {
      return [JSON.parse(payload) as T];
    } catch {
      return [];
    }
  });
}

function writeRecord<T extends { id: string }>(value: T): void {
  database.query('INSERT INTO mcp_records (id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at').run(value.id, JSON.stringify(value), Date.now());
}

function deleteRecord(id: string): void {
  database.query('DELETE FROM mcp_records WHERE id = ?').run(id);
}

const oauthAttempts = new Map<string, { count: number; resetAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of oauthAttempts) if (value.resetAt <= now) oauthAttempts.delete(key);
}, OAUTH_RATE_LIMIT_MS).unref();

function oauthRateLimit(maximum: number) {
  return (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void => {
    const now = Date.now();
    const key = `${request.ip ?? 'unknown'}:${request.routeOptions.url ?? request.url.split('?', 1)[0]}`;
    const prior = oauthAttempts.get(key);
    const current = !prior || prior.resetAt <= now ? { count: 0, resetAt: now + OAUTH_RATE_LIMIT_MS } : prior;
    current.count += 1;
    oauthAttempts.set(key, current);
    if (current.count > maximum) {
      reply.header('Retry-After', String(Math.max(1, Math.ceil((current.resetAt - now) / 1000)))).code(429).send({ error: 'too_many_requests', error_description: 'Too many authorization requests. Try again shortly.' });
      return;
    }
    done();
  };
}

function revokeAccess(record: AccessTokenRecord): void {
  writeRecord({ ...record, revokedAt: Date.now() });
  for (const refresh of listRecords<RefreshTokenRecord>('refresh_token')) {
    if (refresh.accessTokenId === record.id) deleteRecord(refresh.id);
  }
}

function supportedScope(value: string): value is SupportedScope {
  return supportedScopes.includes(value as SupportedScope);
}

function userCanUseScope(userId: string, scope: SupportedScope): boolean {
  const permissions = getUserEffectivePermissions(userId);
  return scope === 'devices:read'
    ? hasPermission(permissions, PermissionFlag.viewDevices)
    : hasPermission(permissions, PermissionFlag.requestDecrypt);
}

function userCanUseAllScopes(userId: string, scopes: readonly SupportedScope[]): boolean {
  return scopes.every((scope) => userCanUseScope(userId, scope));
}

function validRedirectUri(value: string): boolean {
  try {
    const uri = new URL(value);
    if (uri.username || uri.password || uri.hash) return false;
    if (uri.protocol === 'https:') return true;
    if (uri.protocol !== 'http:') return false;
    return ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname) && Boolean(uri.port);
  } catch {
    return false;
  }
}

function validResource(value: string): boolean {
  try {
    const candidate = new URL(value);
    return candidate.href.replace(/\/$/, '') === RESOURCE.replace(/\/$/, '');
  } catch {
    return false;
  }
}

function jsonSchema<T>(properties: Record<string, unknown>, required: string[] = []): StandardSchemaWithJSON<T, T> {
  return fromJsonSchema<T>({ type: 'object', properties, required, additionalProperties: false } as never);
}

function registerMcpTool<T>(server: McpServer, name: string, configuration: { title: string; description: string; inputSchema: StandardSchemaWithJSON<T, T> }, handler: (args: T) => Promise<unknown>): void {
  server.registerTool(name, configuration as never, handler as never);
}

function textResult(value: unknown) {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text' as const, text }], structuredContent: value as Record<string, unknown> };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function currentUser(authInfo: AuthInfo | undefined): string {
  const userId = authInfo?.extra?.userId;
  if (typeof userId !== 'string') throw new Error('MCP authorization is missing a user identity');
  return userId;
}

function requireScope(authInfo: AuthInfo | undefined, scope: SupportedScope): string {
  if (!authInfo?.scopes.includes(scope)) throw new Error(`Reconnect the agent and allow the ${scope} permission`);
  const userId = currentUser(authInfo);
  if (!userCanUseScope(userId, scope)) throw new Error(`Your dkrypt access no longer allows ${scope}`);
  return userId;
}

function ownedJob(userId: string, id: string) {
  const job = getJob(id);
  if (!job || (job.billingOwnerId ?? job.queuedBy)?.toLowerCase() !== userId.toLowerCase()) return undefined;
  return job;
}

function jobMetadata(job: NonNullable<ReturnType<typeof getJob>>) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    bundleId: job.bundleId,
    version: job.versionLabel,
    channel: job.testflight ? 'testflight' : 'appstore',
    attempt: job.attempt,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    deadlineAt: job.deadlineAt,
    warningCount: job.warnings?.length ?? 0,
    warnings: job.warnings,
    error: job.error,
    artifactId: job.artifactId,
    sha256: job.sha256,
    sizeBytes: job.fileSizeBytes,
    timeline: job.timeline,
  };
}

function signedDownloadUrl(userId: string, artifactId: string): string {
  const expiresAt = Date.now() + DOWNLOAD_LINK_TTL_MS;
  const subject = createHmac('sha256', config.sessionSigningSecret).update(userId).digest('base64url');
  const payload = `${subject}\n${artifactId}\n${expiresAt}`;
  const signature = createHmac('sha256', config.sessionSigningSecret).update(payload).digest('base64url');
  const url = new URL(`/mcp/artifacts/${encodeURIComponent(artifactId)}/download`, config.publicBaseUrl);
  url.searchParams.set('subject', subject);
  url.searchParams.set('expires', String(expiresAt));
  url.searchParams.set('signature', signature);
  return url.toString();
}

function verifySignedDownload(subject: string, artifactId: string, expiresAtText: string, signature: string): boolean {
  const expiresAt = Number(expiresAtText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + DOWNLOAD_LINK_TTL_MS + 60_000) return false;
  const expected = createHmac('sha256', config.sessionSigningSecret).update(`${subject}\n${artifactId}\n${expiresAt}`).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, 'base64url');
  } catch {
    return false;
  }
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function artifactMetadata(userId: string, artifactId: string) {
  const artifact = getArtifactById(artifactId);
  if (!artifact || !artifact.projectIds.includes(DEFAULT_PROJECT_ID) || !artifactFileAvailable(artifact)) return undefined;
  return {
    id: artifact.id,
    bundleId: artifact.bundleId,
    channel: artifact.channel,
    version: artifact.versionLabel,
    build: artifact.buildNumber,
    sizeBytes: artifact.fileSizeBytes,
    sha256: artifact.sha256,
    createdAt: artifact.createdAt,
    downloadUrl: signedDownloadUrl(userId, artifact.id),
  };
}

function makeMcpServer(authInfo?: AuthInfo): McpServer {
  const server = new McpServer({ name: 'dkrypt', version: '1.0.0' }, { capabilities: { tools: {}, resources: { listChanged: false } } });

  registerMcpTool(server, 'plan_decrypt', {
    title: 'Plan a decrypt',
    description: 'Resolve an exact App Store release or TestFlight build and ask the signed-in user to approve it before submission.',
    inputSchema: jsonSchema<{ bundleId: string; channel?: 'appstore' | 'testflight'; version?: string }>({ bundleId: { type: 'string', minLength: 3, maxLength: 200 }, channel: { type: 'string', enum: ['appstore', 'testflight'] }, version: { type: 'string', maxLength: 64 } }, ['bundleId']),
  }, async ({ bundleId, channel, version }) => {
    try {
      const userId = requireScope(authInfo, 'decrypt:plan');
      if (!hasPermission(getUserEffectivePermissions(userId), PermissionFlag.requestDecrypt)) return errorResult('Your account does not have decrypt access');
      const target = channel === 'testflight' && !version
        ? await resolveLatestTestFlightTarget(bundleId)
        : await resolveDecryptTarget(bundleId, version);
      if (channel && target.channel !== channel) throw new Error(`The requested ${channel} release could not be resolved`);
      const id = randomBytes(24).toString('base64url');
      const plan: DecryptPlanRecord = {
        id,
        type: 'decrypt_plan',
        userId,
        clientId: authInfo!.clientId,
        bundleId: target.bundleId,
        versionLabel: target.versionLabel,
        channel: target.channel,
        externalVersionId: target.externalVersionId,
        testflight: target.testflight,
        minimumOsVersion: target.minimumOsVersion,
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + APPROVAL_TTL_MS,
      };
      writeRecord(plan);
      return textResult({ planId: id, bundleId: target.bundleId, version: target.versionLabel, channel: target.channel, approvalUrl: new URL(`/mcp/approval/${encodeURIComponent(id)}`, config.publicBaseUrl).toString(), expiresAt: plan.expiresAt, requiresUserApproval: true });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  registerMcpTool(server, 'submit_approved_decrypt', {
    title: 'Submit an approved decrypt',
    description: 'Submit a decrypt that the signed-in account owner approved in dkrypt.',
    inputSchema: jsonSchema<{ planId: string }>({ planId: { type: 'string', minLength: 20, maxLength: 128 } }, ['planId']),
  }, async ({ planId }) => {
    try {
      const userId = requireScope(authInfo, 'decrypt:submit');
      const plan = readRecord<DecryptPlanRecord>(recordId('decrypt_plan', planId));
      if (!plan || plan.type !== 'decrypt_plan' || plan.userId.toLowerCase() !== userId.toLowerCase() || plan.clientId !== authInfo!.clientId) return errorResult('The decrypt plan was not found for this connected agent');
      if (plan.status === 'submitted' && plan.jobId) {
        const existingJob = ownedJob(userId, plan.jobId);
        return existingJob ? textResult(jobMetadata(existingJob)) : errorResult('The submitted job is no longer available');
      }
      if (plan.status !== 'approved' || plan.expiresAt <= Date.now()) return errorResult('This decrypt has not been approved or its approval expired');
      if (getMaintenanceStatus().active) return errorResult('dkrypt is in maintenance mode; try submitting this approved decrypt after service recovers');
      const job = enqueueDecryptJob(plan.bundleId, 'manual', {
        externalVersionId: plan.externalVersionId,
        testflight: plan.testflight as never,
        versionLabel: plan.versionLabel,
        minimumOsVersion: plan.minimumOsVersion,
        queuedBy: userId,
        billingOwnerId: userId,
      });
      const submitted = { ...plan, status: 'submitted' as const, jobId: job.id };
      writeRecord(submitted);
      return textResult(jobMetadata(job));
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  registerMcpTool(server, 'get_job_status', {
    title: 'Get job status',
    description: 'Read progress and result details for a job submitted by this account.',
    inputSchema: jsonSchema<{ jobId: string }>({ jobId: { type: 'string', minLength: 1, maxLength: 128 } }, ['jobId']),
  }, async ({ jobId }) => {
    try {
      const userId = requireScope(authInfo, 'jobs:read');
      const job = ownedJob(userId, jobId);
      return job ? textResult(jobMetadata(job)) : errorResult('Job not found');
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  registerMcpTool(server, 'list_jobs', {
    title: 'List recent decrypt jobs',
    description: 'List recent decrypt jobs owned by the signed-in account, including jobs submitted from the dashboard or another device.',
    inputSchema: jsonSchema<{ limit?: number }>({ limit: { type: 'integer', minimum: 1, maximum: 50 } }),
  }, async ({ limit }) => {
    try {
      const userId = requireScope(authInfo, 'jobs:read');
      const boundedLimit = Math.max(1, Math.min(50, Math.floor(Number(limit ?? 20))));
      const activeJobs = getActiveJobs()
        .filter((job) => (job.billingOwnerId ?? job.queuedBy)?.toLowerCase() === userId.toLowerCase())
        .map(jobMetadata);
      const history = getJobHistoryPage(0, 50, { queuedBy: userId, projectId: DEFAULT_PROJECT_ID }).entries.map((job) => ({
        id: job.id,
        status: job.status,
        progress: job.status === 'done' ? 'Completed' : job.error ?? 'Failed',
        bundleId: job.bundleId,
        version: job.versionLabel,
        channel: job.testflight ? 'testflight' : 'appstore',
        attempt: job.attempt,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
        warningCount: job.warnings?.length ?? 0,
        warnings: job.warnings,
        error: job.error,
        artifactId: job.artifactId,
        sha256: job.sha256,
        sizeBytes: job.sizeBytes,
        timeline: job.timeline,
      }));
      const jobs = new Map([...history, ...activeJobs].map((job) => [job.id, job]));
      return textResult({ jobs: [...jobs.values()].sort((left, right) => right.createdAt - left.createdAt).slice(0, boundedLimit) });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  registerMcpTool(server, 'wait_for_job', {
    title: 'Wait for job progress',
    description: 'Wait for job activity for up to 30 seconds and return the latest progress snapshot.',
    inputSchema: jsonSchema<{ jobId: string; timeoutSeconds?: number }>({ jobId: { type: 'string', minLength: 1, maxLength: 128 }, timeoutSeconds: { type: 'integer', minimum: 1, maximum: 30 } }, ['jobId']),
  }, async ({ jobId, timeoutSeconds }) => {
    try {
      const userId = requireScope(authInfo, 'jobs:read');
      const job = ownedJob(userId, jobId);
      if (!job) return errorResult('Job not found');
      await waitForJob(job, Math.max(1, Math.min(30, Number(timeoutSeconds ?? 15))) * 1000);
      const latest = ownedJob(userId, jobId);
      return latest ? textResult(jobMetadata(latest)) : errorResult('Job not found');
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  registerMcpTool(server, 'cancel_job', {
    title: 'Cancel a job',
    description: 'Cancel a queued or running decrypt submitted by this account.',
    inputSchema: jsonSchema<{ jobId: string }>({ jobId: { type: 'string', minLength: 1, maxLength: 128 } }, ['jobId']),
  }, async ({ jobId }) => {
    try {
      const userId = requireScope(authInfo, 'jobs:control');
      if (!ownedJob(userId, jobId)) return errorResult('Job not found');
      return textResult({ jobId, cancelled: cancelJob(jobId, userId) });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  registerMcpTool(server, 'pause_job', {
    title: 'Pause a queued job',
    description: 'Pause a queued decrypt submitted by this account.',
    inputSchema: jsonSchema<{ jobId: string }>({ jobId: { type: 'string', minLength: 1, maxLength: 128 } }, ['jobId']),
  }, async ({ jobId }) => {
    try {
      const userId = requireScope(authInfo, 'jobs:control');
      if (!ownedJob(userId, jobId)) return errorResult('Job not found');
      return textResult({ jobId, paused: pauseQueuedJob(jobId, userId) });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  registerMcpTool(server, 'resume_job', {
    title: 'Resume a paused job',
    description: 'Resume a paused decrypt submitted by this account.',
    inputSchema: jsonSchema<{ jobId: string }>({ jobId: { type: 'string', minLength: 1, maxLength: 128 } }, ['jobId']),
  }, async ({ jobId }) => {
    try {
      const userId = requireScope(authInfo, 'jobs:control');
      if (!ownedJob(userId, jobId)) return errorResult('Job not found');
      return textResult({ jobId, resumed: resumePausedJob(jobId, userId) });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  registerMcpTool(server, 'list_artifacts', {
    title: 'List IPA artifacts',
    description: 'List authorized artifact metadata without returning IPA file contents.',
    inputSchema: jsonSchema<{ query?: string; channel?: 'appstore' | 'testflight'; limit?: number }>({ query: { type: 'string', maxLength: 200 }, channel: { type: 'string', enum: ['appstore', 'testflight'] }, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
  }, async ({ query, channel, limit }) => {
    try {
      const userId = requireScope(authInfo, 'artifacts:read');
      const page = listArtifacts({ query: typeof query === 'string' ? query : undefined, channel: channel as 'appstore' | 'testflight' | undefined, limit: Number(limit ?? 50), projectIds: [DEFAULT_PROJECT_ID] });
      return textResult({ total: page.total, artifacts: page.artifacts.map((artifact) => artifactMetadata(userId, artifact.id)).filter(Boolean) });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  registerMcpTool(server, 'get_artifact', {
    title: 'Get IPA artifact metadata',
    description: 'Get metadata and a short-lived authorized download link for an IPA file.',
    inputSchema: jsonSchema<{ artifactId: string }>({ artifactId: { type: 'string', minLength: 1, maxLength: 128 } }, ['artifactId']),
  }, async ({ artifactId }) => {
    try {
      const userId = requireScope(authInfo, 'artifacts:read');
      const artifact = artifactMetadata(userId, artifactId);
      return artifact ? textResult(artifact) : errorResult('Artifact not found');
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  registerMcpTool(server, 'analyze_ipa', {
    title: 'Analyze an IPA',
    description: 'Run dkrypt’s isolated IPA analyzer and return a structured metadata, executable, asset, and signing report.',
    inputSchema: jsonSchema<{ artifactId: string }>({ artifactId: { type: 'string', minLength: 1, maxLength: 128 } }, ['artifactId']),
  }, async ({ artifactId }) => {
    try {
      requireScope(authInfo, 'ipa:analyze');
      const artifact = getArtifactById(artifactId);
      if (!artifact || !artifact.projectIds.includes(DEFAULT_PROJECT_ID) || !artifactFileAvailable(artifact)) return errorResult('Artifact not found');
      const report = await analyzeIpaInIsolatedProcess(artifact.filePath);
      return textResult({ artifactId, report });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  registerMcpTool(server, 'list_devices', {
    title: 'List devices',
    description: 'List device readiness summaries without exposing pairing records, UDIDs, SSH details, or host addresses.',
    inputSchema: jsonSchema<Record<string, never>>({}),
  }, async () => {
    try {
      requireScope(authInfo, 'devices:read');
      return textResult({ devices: listDevices().map((device) => ({ id: device.id, name: device.name, productType: device.productType, osVersion: device.iosVersion, transport: device.transport, enabled: device.enabled, draining: device.draining, primary: device.isPrimary })) });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  server.registerResource('account-overview', 'dkrypt://account/overview', { title: 'dkrypt account overview', mimeType: 'application/json' }, async (uri) => {
    const userId = requireScope(authInfo, 'jobs:read');
    const jobs = getActiveJobs().filter((job) => (job.billingOwnerId ?? job.queuedBy)?.toLowerCase() === userId.toLowerCase());
    const artifactCount = authInfo?.scopes.includes('artifacts:read') && userCanUseScope(userId, 'artifacts:read')
      ? listArtifacts({ projectIds: [DEFAULT_PROJECT_ID], limit: 1 }).total
      : undefined;
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ userId, activeJobs: jobs.map(jobMetadata), artifactCount }) }] };
  });

  server.registerResource('app-metadata', new ResourceTemplate('dkrypt://apps/{bundleId}', { list: undefined }), { title: 'App Store app metadata', mimeType: 'application/json' }, async (uri, variables) => {
    requireScope(authInfo, 'decrypt:plan');
    const metadata = await lookupAppMetadata(String(variables.bundleId));
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(metadata) }] };
  });

  server.registerResource('job-details', new ResourceTemplate('dkrypt://jobs/{jobId}', { list: undefined }), { title: 'Decrypt job', mimeType: 'application/json' }, async (uri, variables) => {
    const userId = requireScope(authInfo, 'jobs:read');
    const job = ownedJob(userId, String(variables.jobId));
    if (!job) throw new Error('Job not found');
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(jobMetadata(job)) }] };
  });

  server.registerResource('artifact-details', new ResourceTemplate('dkrypt://artifacts/{artifactId}', { list: undefined }), { title: 'IPA artifact', mimeType: 'application/json' }, async (uri, variables) => {
    const userId = requireScope(authInfo, 'artifacts:read');
    const metadata = artifactMetadata(userId, String(variables.artifactId));
    if (!metadata) throw new Error('Artifact not found');
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(metadata) }] };
  });

  server.registerResource('device-details', new ResourceTemplate('dkrypt://devices/{deviceId}', { list: undefined }), { title: 'Device readiness', mimeType: 'application/json' }, async (uri, variables) => {
    requireScope(authInfo, 'devices:read');
    const device = getDevice(String(variables.deviceId));
    if (!device) throw new Error('Device not found');
    const metadata = { id: device.id, name: device.name, productType: device.productType, osVersion: device.iosVersion, transport: device.transport, enabled: device.enabled, draining: device.draining, primary: device.isPrimary };
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(metadata) }] };
  });

  return server;
}

const mcpHandler = createMcpHandler(({ authInfo }) => makeMcpServer(authInfo), { responseMode: 'auto', legacy: 'stateless' });

function oauthError(reply: FastifyReply, status: number, code: string, description: string) {
  return reply.code(status).header('Cache-Control', 'no-store').send({ error: code, error_description: description });
}

function htmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function consentPage(input: { clientName: string; scopes: string[]; authorizeUrl: string; errors?: string[] }): string {
  const checkboxes = input.scopes.map((scope) => `<label><input type="checkbox" name="scope" value="${htmlEscape(scope)}" checked> ${htmlEscape(scope)}</label>`).join('');
  const errors = input.errors?.length ? `<p role="alert">${input.errors.map(htmlEscape).join('<br>')}</p>` : '';
  const hiddenFields = [...new URL(input.authorizeUrl).searchParams.entries()].map(([key, value]) => `<input type="hidden" name="${key === 'scope' ? 'requested_scope' : htmlEscape(key)}" value="${htmlEscape(value)}">`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect agent to dkrypt</title><style>body{font:16px system-ui;max-width:38rem;margin:10vh auto;padding:0 1rem;color:#20212a;background:#f7f7fb}main{background:white;border:1px solid #dedee8;border-radius:1rem;padding:1.5rem}h1{font-size:1.4rem}label{display:block;margin:.8rem 0}button{border:0;border-radius:.6rem;background:#7958e8;color:white;padding:.7rem 1rem;font:inherit}p{line-height:1.5}</style><main><h1>Connect ${htmlEscape(input.clientName)} to dkrypt</h1>${errors}<p>Choose what this agent can access. Decrypt requests still require your explicit approval in dkrypt before they enter the queue.</p><form method="post" action="/oauth/authorize">${hiddenFields}${checkboxes}<div><button name="consent" value="approve">Allow selected access</button><button name="consent" value="deny" formnovalidate>Cancel</button></div></form></main></html>`;
}

function authorizeLinkPage(authorizeUrl: string): string {
  const next = encodeURIComponent(authorizeUrl);
  const links = [
    ...(isGithubOauthEnabled() ? [`<a href="/v1/auth/github/login?return_to=${next}">Continue with GitHub</a>`] : []),
    ...(isDiscordOauthEnabled() ? [`<a href="/v1/auth/discord/login?return_to=${next}">Continue with Discord</a>`] : []),
  ];
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to dkrypt</title><style>body{font:16px system-ui;max-width:34rem;margin:12vh auto;padding:0 1rem;color:#20212a}a{display:block;margin:.8rem 0;padding:.8rem;border:1px solid #dedee8;border-radius:.6rem;color:inherit;text-decoration:none}</style><h1>Sign in to dkrypt</h1><p>Sign in to review and approve this agent connection.</p>${links.join('') || '<a href="/">Open dkrypt and sign in, then restart the connection request.</a>'}</html>`;
}

function readFormString(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : Array.isArray(value) && value.length === 1 && typeof value[0] === 'string' ? value[0] : undefined;
}

function readFormScopes(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return [];
  const value = (body as Record<string, unknown>).scope;
  return Array.isArray(value) ? value.filter((scope): scope is string => typeof scope === 'string') : typeof value === 'string' ? [value] : [];
}

function verifyPkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const calculated = createHash('sha256').update(verifier).digest('base64url');
  const left = Buffer.from(calculated);
  const right = Buffer.from(challenge);
  return left.length === right.length && timingSafeEqual(left, right);
}

function createTokenIssue(input: { clientId: string; clientName: string; userId: string; resource: string; scopes: SupportedScope[] }) {
  const now = Date.now();
  const accessToken = randomBytes(32).toString('base64url');
  const refreshToken = randomBytes(32).toString('base64url');
  const accessHash = hash(accessToken);
  const refreshHash = hash(refreshToken);
  const accessId = recordId('access', accessHash);
  const access: AccessTokenRecord = { id: accessId, type: 'access_token', ...input, createdAt: now, expiresAt: now + ACCESS_TOKEN_TTL_MS };
  const refresh: RefreshTokenRecord = { id: recordId('refresh', refreshHash), type: 'refresh_token', accessTokenId: accessId, clientId: input.clientId, userId: input.userId, expiresAt: now + REFRESH_TOKEN_TTL_MS };
  return {
    access,
    refresh,
    response: { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000), scope: input.scopes.join(' ') },
  };
}

function writeTokenIssue(issue: ReturnType<typeof createTokenIssue>): void {
  writeRecord(issue.access);
  writeRecord(issue.refresh);
}

function verifyAccessToken(token: string): { record: AccessTokenRecord; authInfo: AuthInfo } | undefined {
  const record = readRecord<AccessTokenRecord>(recordId('access', hash(token)));
  if (!record || record.type !== 'access_token' || record.revokedAt || record.expiresAt <= Date.now() || record.resource !== RESOURCE) return undefined;
  const client = readRecord<McpClientRecord>(recordId('client', record.clientId));
  if (!client || client.type !== 'client') return undefined;
  const updated = { ...record, lastUsedAt: Date.now() };
  writeRecord(updated);
  return {
    record: updated,
    authInfo: { token, clientId: record.clientId, scopes: record.scopes, expiresAt: Math.floor(record.expiresAt / 1000), resource: new URL(record.resource), extra: { userId: record.userId } },
  };
}

function bearerToken(request: import('fastify').FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  return typeof header === 'string' ? header.match(/^Bearer\s+(.+)$/i)?.[1] : undefined;
}

function oauthResourceMetadata() {
  return {
    resource: RESOURCE,
    authorization_servers: [config.publicBaseUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: supportedScopes,
  };
}

export const mcpRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    const values: Record<string, string | string[]> = {};
    for (const [key, value] of new URLSearchParams(typeof body === 'string' ? body : body.toString())) {
      const prior = values[key];
      values[key] = prior === undefined ? value : Array.isArray(prior) ? [...prior, value] : [prior, value];
    }
    done(null, values);
  });

  server.get('/.well-known/oauth-authorization-server', { schema: { hide: true } }, (_request, reply) => reply.header('Cache-Control', 'public, max-age=300').send({ issuer: config.publicBaseUrl, authorization_endpoint: `${config.publicBaseUrl}/oauth/authorize`, token_endpoint: `${config.publicBaseUrl}/oauth/token`, registration_endpoint: `${config.publicBaseUrl}/oauth/register`, revocation_endpoint: `${config.publicBaseUrl}/oauth/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: supportedScopes }));
  server.get('/.well-known/oauth-protected-resource/mcp', { schema: { hide: true } }, (_request, reply) => reply.header('Cache-Control', 'public, max-age=300').send(oauthResourceMetadata()));

  server.post('/oauth/register', { schema: { hide: true }, onRequest: oauthRateLimit(30) }, (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const name = typeof body?.client_name === 'string' ? body.client_name.trim().slice(0, 100) : '';
    const redirects = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((value): value is string => typeof value === 'string') : [];
    if (!name || redirects.length === 0 || redirects.length > 10 || redirects.some((uri) => !validRedirectUri(uri))) return oauthError(reply, 400, 'invalid_client_metadata', 'Provide a client name and exact HTTPS or loopback redirect URIs.');
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') return oauthError(reply, 400, 'invalid_client_metadata', 'Only public clients without a client secret are supported.');
    const clientId = randomBytes(24).toString('base64url');
    const client: McpClientRecord = { id: recordId('client', clientId), type: 'client', clientId, clientName: name, redirectUris: [...new Set(redirects)], createdAt: Date.now() };
    writeRecord(client);
    return reply.code(201).header('Cache-Control', 'no-store').send({ client_id: clientId, client_name: name, redirect_uris: client.redirectUris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
  });

  server.get('/oauth/authorize', { schema: { hide: true }, onRequest: oauthRateLimit(120) }, (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const clientId = typeof query.client_id === 'string' ? query.client_id : '';
    const redirectUri = typeof query.redirect_uri === 'string' ? query.redirect_uri : '';
    const resource = typeof query.resource === 'string' ? query.resource : '';
    const client = readRecord<McpClientRecord>(recordId('client', clientId));
    if (query.response_type !== 'code' || query.code_challenge_method !== 'S256' || typeof query.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(query.code_challenge) || !validResource(resource) || !client || !client.redirectUris.includes(redirectUri)) return oauthError(reply, 400, 'invalid_request', 'The authorization request is incomplete or invalid.');
    const user = getFastifySession(request);
    const scopes = (typeof query.scope === 'string' ? query.scope.split(/\s+/) : []).filter(supportedScope);
    if (scopes.length === 0) return oauthError(reply, 400, 'invalid_scope', 'Request at least one supported dkrypt permission.');
    const authorizeUrl = new URL(request.url, config.publicBaseUrl).toString();
    if (!user) return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(authorizeLinkPage(authorizeUrl));
    const permissions = scopes.filter((scope) => userCanUseScope(user.sub, scope));
    if (permissions.length === 0) return oauthError(reply, 403, 'insufficient_scope', 'Your dkrypt account cannot grant any of the requested permissions.');
    return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(consentPage({ clientName: client.clientName, scopes: permissions, authorizeUrl }));
  });

  server.post('/oauth/authorize', { schema: { hide: true }, onRequest: oauthRateLimit(30), preHandler: fastifyRequireSession }, (request, reply) => {
    const user = getFastifySession(request)!;
    const body = request.body as Record<string, unknown>;
    const clientId = readFormString(body, 'client_id') ?? '';
    const redirectUri = readFormString(body, 'redirect_uri') ?? '';
    const resource = readFormString(body, 'resource') ?? '';
    const state = readFormString(body, 'state');
    const challenge = readFormString(body, 'code_challenge') ?? '';
    const client = readRecord<McpClientRecord>(recordId('client', clientId));
    if (!client || !client.redirectUris.includes(redirectUri) || !validResource(resource) || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return oauthError(reply, 400, 'invalid_request', 'The authorization request is no longer valid.');
    const requested = (readFormString(body, 'requested_scope') ?? '').split(/\s+/).filter(supportedScope);
    const selected = readFormScopes(body).filter(supportedScope);
    const consent = readFormString(body, 'consent');
    if (consent === 'deny' || selected.length === 0) {
      const denied = new URL(redirectUri);
      denied.searchParams.set('error', 'access_denied');
      if (state) denied.searchParams.set('state', state);
      return reply.redirect(denied.toString());
    }
    const scopes = [...new Set(selected)].filter((scope) => requested.includes(scope));
    if (!userCanUseAllScopes(user.sub, scopes)) return oauthError(reply, 403, 'insufficient_scope', 'Your dkrypt permissions changed; reconnect and choose the permissions you can grant.');
    const code = randomBytes(32).toString('base64url');
    const codeRecord: AuthorizationCodeRecord = { id: recordId('code', hash(code)), type: 'authorization_code', clientId, clientName: client.clientName, userId: user.sub, redirectUri, codeChallenge: challenge, resource, scopes, state, expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS };
    writeRecord(codeRecord);
    recordAudit(user.sub, 'mcp.agent.connect', clientId, `connected ${client.clientName} with scopes ${scopes.join(', ')}`);
    const callback = new URL(redirectUri);
    callback.searchParams.set('code', code);
    if (state) callback.searchParams.set('state', state);
    return reply.redirect(callback.toString());
  });

  server.post('/oauth/token', { schema: { hide: true }, onRequest: oauthRateLimit(60) }, (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const grantType = readFormString(body, 'grant_type');
    const clientId = readFormString(body, 'client_id') ?? '';
    if (grantType === 'authorization_code') {
      const code = readFormString(body, 'code') ?? '';
      const redirectUri = readFormString(body, 'redirect_uri') ?? '';
      const verifier = readFormString(body, 'code_verifier') ?? '';
      const id = recordId('code', hash(code));
      database.exec('BEGIN IMMEDIATE;');
      try {
        const codeRow = database.query('SELECT payload FROM mcp_records WHERE id = ?').get(id) as { payload: string } | null;
        const record = codeRow ? JSON.parse(codeRow.payload) as AuthorizationCodeRecord : undefined;
        database.query('DELETE FROM mcp_records WHERE id = ?').run(id);
        if (!record || record.type !== 'authorization_code' || record.expiresAt <= Date.now() || record.clientId !== clientId || record.redirectUri !== redirectUri || !verifyPkce(verifier, record.codeChallenge)) {
          database.exec('COMMIT;');
          return oauthError(reply, 400, 'invalid_grant', 'The authorization code is invalid, expired, or was issued to another client.');
        }
        const issue = createTokenIssue({ clientId, clientName: record.clientName, userId: record.userId, resource: record.resource, scopes: record.scopes });
        writeTokenIssue(issue);
        database.exec('COMMIT;');
        return reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache').send(issue.response);
      } catch (error) {
        database.exec('ROLLBACK;');
        throw error;
      }
    }
    if (grantType === 'refresh_token') {
      const refreshToken = readFormString(body, 'refresh_token') ?? '';
      const id = recordId('refresh', hash(refreshToken));
      database.exec('BEGIN IMMEDIATE;');
      try {
        const row = database.query('SELECT payload FROM mcp_records WHERE id = ?').get(id) as { payload: string } | null;
        const refresh = row ? JSON.parse(row.payload) as RefreshTokenRecord : undefined;
        const access = refresh ? readRecord<AccessTokenRecord>(refresh.accessTokenId) : undefined;
        const client = readRecord<McpClientRecord>(recordId('client', clientId));
        if (!refresh || refresh.type !== 'refresh_token' || refresh.expiresAt <= Date.now() || refresh.clientId !== clientId || !access || access.revokedAt || access.clientId !== clientId || access.userId !== refresh.userId || !client || client.type !== 'client') {
          database.query('DELETE FROM mcp_records WHERE id = ?').run(id);
          database.exec('COMMIT;');
          return oauthError(reply, 400, 'invalid_grant', 'The refresh token is invalid, expired, or was issued to another client.');
        }
        const issue = createTokenIssue({ clientId, clientName: client.clientName, userId: access.userId, resource: access.resource, scopes: access.scopes });
        database.query('DELETE FROM mcp_records WHERE id = ?').run(access.id);
        database.query('DELETE FROM mcp_records WHERE id = ?').run(id);
        writeTokenIssue(issue);
        database.exec('COMMIT;');
        return reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache').send(issue.response);
      } catch (error) {
        database.exec('ROLLBACK;');
        throw error;
      }
    }
    return oauthError(reply, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
  });

  server.post('/oauth/revoke', { schema: { hide: true } }, (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const token = readFormString(body, 'token') ?? '';
    const clientId = readFormString(body, 'client_id') ?? '';
    const access = readRecord<AccessTokenRecord>(recordId('access', hash(token)));
    const refresh = readRecord<RefreshTokenRecord>(recordId('refresh', hash(token)));
    const record = access ?? (refresh ? readRecord<AccessTokenRecord>(refresh.accessTokenId) : undefined);
    if (record && record.clientId === clientId) {
      revokeAccess(record);
      if (refresh) deleteRecord(refresh.id);
    }
    return reply.code(200).header('Cache-Control', 'no-store').send({});
  });

  server.get('/v1/dashboard/mcp/clients', { schema: { hide: true }, preHandler: fastifyRequireSession }, (request) => {
    const userId = getFastifySession(request)!.sub.toLowerCase();
    const records = listRecords<AccessTokenRecord>('access_token').filter((record) => record.userId.toLowerCase() === userId);
    const byClient = new Map<string, { clientId: string; clientName: string; scopes: Set<string>; connectedAt: number; lastUsedAt?: number; expiresAt: number; active: boolean }>();
    for (const record of records) {
      const current = byClient.get(record.clientId) ?? { clientId: record.clientId, clientName: record.clientName, scopes: new Set<string>(), connectedAt: record.createdAt, lastUsedAt: undefined, expiresAt: record.expiresAt, active: false };
      record.scopes.forEach((scope) => current.scopes.add(scope));
      current.connectedAt = Math.min(current.connectedAt, record.createdAt);
      current.lastUsedAt = Math.max(current.lastUsedAt ?? 0, record.lastUsedAt ?? 0) || undefined;
      current.expiresAt = Math.max(current.expiresAt, record.expiresAt);
      current.active ||= !record.revokedAt && record.expiresAt > Date.now();
      byClient.set(record.clientId, current);
    }
    return { agents: [...byClient.values()].map((agent) => ({ ...agent, scopes: [...agent.scopes].sort() })).sort((a, b) => b.connectedAt - a.connectedAt) };
  });

  server.post('/v1/dashboard/mcp/clients/revoke', { schema: { hide: true }, preHandler: fastifyRequireSession }, (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    const clientId = readFormString(request.body, 'clientId') ?? (typeof request.body === 'object' && request.body !== null && typeof (request.body as Record<string, unknown>).clientId === 'string' ? String((request.body as Record<string, unknown>).clientId) : '');
    if (!clientId) return reply.code(400).send({ error: 'clientId is required' });
    let revoked = 0;
    for (const record of listRecords<AccessTokenRecord>('access_token')) {
      if (record.clientId !== clientId || record.userId.toLowerCase() !== userId.toLowerCase() || record.revokedAt) continue;
      revokeAccess(record);
      revoked += 1;
    }
    recordAudit(userId, 'mcp.agent.revoke', clientId, `revoked ${revoked} agent token(s)`);
    return reply.send({ ok: true, revoked });
  });

  server.get('/mcp/approval/:id', { schema: { hide: true } }, (request, reply) => {
    const params = request.params as { id: string };
    const plan = readRecord<DecryptPlanRecord>(recordId('decrypt_plan', params.id));
    if (!plan || plan.expiresAt <= Date.now()) return reply.code(404).type('text/plain').send('This decrypt approval expired or was not found.');
    const user = getFastifySession(request);
    if (!user) return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(authorizeLinkPage(new URL(request.url, config.publicBaseUrl).toString()));
    if (user.sub.toLowerCase() !== plan.userId.toLowerCase()) return reply.code(403).type('text/plain').send('Sign in as the account that requested this decrypt approval.');
    if (plan.status !== 'pending') return reply.type('text/html; charset=utf-8').send(`<h1>Approval ${htmlEscape(plan.status)}</h1><p>${htmlEscape(plan.bundleId)} · ${htmlEscape(plan.versionLabel)}</p>`);
    return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve decrypt</title><style>body{font:16px system-ui;max-width:36rem;margin:12vh auto;padding:0 1rem;color:#20212a}main{border:1px solid #dedee8;border-radius:1rem;padding:1.5rem}button{border:0;border-radius:.6rem;background:#7958e8;color:white;padding:.7rem 1rem;font:inherit}button[name=decision][value=deny]{background:#666}</style><main><h1>Approve this decrypt?</h1><p><strong>${htmlEscape(plan.bundleId)}</strong></p><p>${htmlEscape(plan.versionLabel)} · ${plan.channel === 'testflight' ? 'TestFlight' : 'App Store'}</p><p>dkrypt will queue this job using your account’s decrypt access.</p><form method="post" action="/mcp/approval/${encodeURIComponent(plan.id)}"><button name="decision" value="approve">Approve and continue</button> <button name="decision" value="deny">Decline</button></form></main></html>`);
  });

  server.post('/mcp/approval/:id', { schema: { hide: true }, preHandler: fastifyRequireSession }, (request, reply) => {
    const params = request.params as { id: string };
    const user = getFastifySession(request)!;
    const plan = readRecord<DecryptPlanRecord>(recordId('decrypt_plan', params.id));
    if (!plan || plan.expiresAt <= Date.now()) return reply.code(404).type('text/plain').send('This decrypt approval expired or was not found.');
    if (user.sub.toLowerCase() !== plan.userId.toLowerCase()) return reply.code(403).type('text/plain').send('This decrypt approval belongs to another account.');
    if (plan.status !== 'pending') return reply.type('text/plain').send(`This decrypt is already ${plan.status}.`);
    const decision = readFormString(request.body, 'decision');
    if (decision !== 'approve' && decision !== 'deny') return reply.code(400).type('text/plain').send('Choose approve or decline.');
    const updated = { ...plan, status: decision === 'approve' ? 'approved' as const : 'rejected' as const };
    writeRecord(updated);
    recordAudit(user.sub, `mcp.decrypt.${decision}`, plan.id, `${plan.bundleId} ${plan.versionLabel}`);
    return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(`<h1>Decrypt ${decision === 'approve' ? 'approved' : 'declined'}</h1><p>${htmlEscape(plan.bundleId)} · ${htmlEscape(plan.versionLabel)}</p><p>You can return to the connected agent.</p>`);
  });

  server.get('/mcp/artifacts/:id/download', { schema: { hide: true } }, async (request, reply) => {
    const params = request.params as { id: string };
    const query = request.query as Record<string, unknown>;
    const user = typeof query.subject === 'string' ? query.subject : '';
    const expires = typeof query.expires === 'string' ? query.expires : '';
    const signature = typeof query.signature === 'string' ? query.signature : '';
    if (!verifySignedDownload(user, params.id, expires, signature)) return reply.code(403).type('text/plain').send('This artifact link expired. Request a new link from the connected agent.');
    const artifact = getArtifactById(params.id);
    if (!artifact || !artifact.projectIds.includes(DEFAULT_PROJECT_ID) || !artifactFileAvailable(artifact)) return reply.code(404).type('text/plain').send('Artifact not found.');
    const { createReadStream } = await import('node:fs');
    return reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer').header('Content-Length', String(artifact.fileSizeBytes)).header('Content-Disposition', `attachment; filename="${artifactDownloadName(artifact).replace(/[\r\n"\\]/g, '_')}"`).type('application/octet-stream').send(createReadStream(artifact.filePath));
  });

  server.route({ method: ['GET', 'POST', 'DELETE'], url: '/v1/mcp', schema: { hide: true }, handler: async (request, reply) => {
    const token = bearerToken(request);
    const verified = token ? verifyAccessToken(token) : undefined;
    if (!verified) return reply.code(401).header('WWW-Authenticate', `Bearer resource_metadata="${RESOURCE_METADATA}"`).header('Cache-Control', 'no-store').send({ error: 'invalid_token', error_description: 'Sign in again to reconnect this agent.' });
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(', '));
    }
    headers.set('content-type', 'application/json');
    const body = request.method === 'POST' ? JSON.stringify(request.body ?? {}) : undefined;
    const webRequest = new Request(new URL(request.url, config.publicBaseUrl).toString(), { method: request.method, headers, body });
    const response = await mcpHandler.fetch(webRequest, { authInfo: verified.authInfo, parsedBody: request.body });
    reply.code(response.status);
    response.headers.forEach((value, key) => reply.header(key, value));
    return response.body ? reply.send(Readable.fromWeb(response.body)) : reply.send();
  } });
};
