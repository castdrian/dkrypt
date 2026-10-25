import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifySwagger from '@fastify/swagger';
import scalarApiReference from '@scalar/fastify-api-reference';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type Stripe from 'stripe';
import { fastifyRejectGeneratedApiKeyOutsidePublicApi } from '#auth.js';
import { drainBackgroundWork, trackBackgroundWork } from '#backgroundWork.js';
import { config } from '#config.js';
import { withCorrelation } from '#correlation.js';
import { closeJobStore, getArtifactBackedJobs, JobsShuttingDownError, shutdownJobs, startJobSweeper, stopAcceptingJobs, stopJobSweeper } from '#jobs/store.js';
import { startJobWebhookDispatcher, stopJobWebhookDispatcher } from '#jobWebhook.js';
import { startKeyExpiryPoller, stopKeyExpiryPoller } from '#keyExpiryPoller.js';
import { log, startLogFlusher, stopLogFlusher } from '#logger.js';
import { authRoutes } from '#routes/authRoutes.js';
import { dashboardApiKeyRoutes } from '#routes/dashboardApiKeyRoutes.js';
import { dashboardAccountRoutes } from '#routes/dashboardAccountRoutes.js';
import { dashboardBackupRoutes } from '#routes/dashboardBackupRoutes.js';
import { dashboardDeviceRoutes } from '#routes/dashboardDeviceRoutes.js';
import { dashboardDiagnosticsRoutes } from '#routes/dashboardDiagnosticsRoutes.js';
import { dashboardOverviewRoutes } from '#routes/dashboardOverviewRoutes.js';
import { dashboardProjectRoutes } from '#routes/dashboardProjectRoutes.js';
import { dashboardRoleRoutes } from '#routes/dashboardRoleRoutes.js';
import { dashboardSettingsRoutes } from '#routes/dashboardSettingsRoutes.js';
import { dashboardUserRoutes } from '#routes/dashboardUserRoutes.js';
import { dashboardObservabilityRoutes } from '#routes/dashboardObservabilityRoutes.js';
import { dashboardArtifactRoutes } from '#routes/dashboardArtifactRoutes.js';
import { dashboardNotificationRoutes } from '#routes/dashboardNotificationRoutes.js';
import { dashboardJobRoutes } from '#routes/dashboardJobRoutes.js';
import { dashboardJobActionRoutes } from '#routes/dashboardJobActionRoutes.js';
import { dashboardDecryptPreflightRoutes } from '#routes/dashboardDecryptPreflightRoutes.js';
import { dashboardJobAnalyticsRoutes } from '#routes/dashboardJobAnalyticsRoutes.js';
import { dashboardJobHistoryRoutes } from '#routes/dashboardJobHistoryRoutes.js';
import { dashboardReportingRoutes } from '#routes/dashboardReportingRoutes.js';
import { dashboardDiagnosticReportRoutes } from '#routes/dashboardDiagnosticReportRoutes.js';
import { dashboardDiscordRoutes } from '#routes/dashboardDiscordRoutes.js';
import { internalDeploymentRoutes } from '#routes/internalDeploymentRoutes.js';
import { dashboardEventsRoutes } from '#routes/dashboardEventsRoutes.js';
import { dashboardTestFlightRoutes } from '#routes/dashboardTestFlightRoutes.js';
import { dashboardTestFlightBrowseRoutes } from '#routes/dashboardTestFlightBrowseRoutes.js';
import { dashboardAppRoutes } from '#routes/dashboardAppRoutes.js';
import { dashboardQuickSearchRoutes } from '#routes/dashboardQuickSearchRoutes.js';
import { dashboardIncidentRoutes } from '#routes/dashboardIncidentRoutes.js';
import { dashboardCoverageRoutes } from '#routes/dashboardCoverageRoutes.js';
import { dashboardIntegrationRoutes } from '#routes/dashboardIntegrationRoutes.js';
import { dashboardOfflineAppStoreRoutes } from '#routes/dashboardOfflineAppStoreRoutes.js';
import { signedTriggerRoutes } from '#routes/signedTriggerRoutes.js';
import { billingRoutes, billingWebhookRoutes } from '#routes/billing.js';
import type { StripeWebhookHealth } from '#stripeWebhookHealth.js';
import { artifactCatalogRoutes, decryptRoutes, testFlightCatalogRoutes } from '#routes/decrypt.js';
import { healthRoutes } from '#routes/health.js';
import { startBackupScheduler, stopBackupScheduler } from '#backupScheduler.js';
import { closeStateDatabase, disableLegacyAppWatches, startApiKeySweeper, startSessionSweeper, startStateFlusher, stopStateBackgroundServices } from '#store/state.js';
import { refreshUsbDeviceHealth, startDeviceHealthPoller, stopDeviceHealthPoller } from '#deviceHealth.js';
import { renderPublicPage } from '#publicPages.js';
import { startNotificationDigestScheduler } from '#notify.js';
import { closeArtifactDatabase, initializeArtifactStore } from '#artifacts.js';
import { startTestFlightSubscriptionPoller, stopTestFlightSubscriptionPoller } from '#testflightSubscriptions.js';
import { startCryptoBillingPoller, stopCryptoBillingPoller } from '#cryptoBilling.js';
import { closeBillingDatabase, listPlans } from '#billing.js';
import { closeIdentityDatabase } from '#identity.js';
import { closeIdempotencyDatabase } from '#idempotency.js';
import { closeWebhookInboxDatabase } from '#webhookInbox.js';
import { incrementMetric, observeMetric } from '#metrics.js';
import { stopNotificationDigestScheduler } from '#notify.js';
import { closeDashboardConnections } from '#events.js';
import { startSpan, startTelemetry, stopTelemetry, traceContextFromHeader, type SpanHandle } from '#telemetry.js';
import { FixedWindowRateLimiter } from '#util/rateLimit.js';
import { DailyDecryptLimitError } from '#jobs/repository.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';
import { startRustDeviceEventMonitoring } from '#deviceBridgeEvents.js';
import { createPublicOpenApiDocument, isPublicApiKeyRoute } from '#publicApi.js';
import { closeIncidentRepository, reconcileOperationalIncidents } from '#store/incidentRepository.js';
import { closeIntegrationRepository } from '#store/integrationRepository.js';
import { closeOauthLinkReviewRepository } from '#store/oauthLinkReview.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const sharedApiRateLimiter = new FixedWindowRateLimiter(config.apiRateLimitPerMinute, 60_000);
let stopRustDeviceEventMonitoring: (() => Promise<void>) | undefined;
let incidentReconciliationTimer: ReturnType<typeof setInterval> | undefined;
const drainingServers = new WeakSet<FastifyInstance>();

function sendServiceDraining(reply: FastifyReply, requestId: string): void {
  reply.code(503).send({ error: 'service is shutting down', code: 'service_draining', message: 'dkrypt is shutting down; retry shortly', requestId, retryable: true });
}

async function waitForShutdownOperation(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completed = operation.then(() => true, () => false);
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const result = await Promise.race([completed, timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}

function shouldRateLimitApiRequest(url: string): boolean {
  const path = url.split('?', 1)[0];
  return path.startsWith('/v1/') && ![
    '/v1/health',
    '/v1/status',
    '/v1/metrics',
    '/v1/dashboard/events',
    '/v1/stripe/webhook',
    '/v1/nowpayments/webhook',
  ].includes(path);
}

function normalizeApiErrorPayload(
  request: { url: string; id: string },
  reply: { statusCode: number; getHeader(name: string): unknown },
  payload: unknown,
): unknown {
  if (!request.url.startsWith('/v1/') || reply.statusCode < 400) return payload;
  const contentType = reply.getHeader('content-type');
  if (typeof contentType !== 'string' || !contentType.includes('application/json')) return payload;
  const raw = typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : undefined;
  if (!raw) return payload;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return payload;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return payload;
  const body = parsed as Record<string, unknown>;
  const message = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : 'request failed';
  return JSON.stringify({
    ...body,
    error: typeof body.error === 'string' ? body.error : message,
    code: typeof body.code === 'string' ? body.code : `http_${reply.statusCode}`,
    message,
    requestId: typeof body.requestId === 'string' ? body.requestId : request.id,
    retryable: typeof body.retryable === 'boolean' ? body.retryable : reply.statusCode >= 500 || reply.statusCode === 429 || reply.statusCode === 503,
  });
}

function rejectCsrfMutation(reply: FastifyReply, requestId: string, message: string): void {
  reply.code(403).send({ error: message, code: 'csrf_origin_rejected', message, requestId, retryable: false });
}

export async function buildServer(options: {
  includePublicRoutes?: boolean;
  stripeClient?: () => Stripe;
  stripeWebhookHealth?: () => Promise<StripeWebhookHealth>;
} = {}): Promise<FastifyInstance> {
  const server = Fastify({ bodyLimit: 5 * 1024 * 1024, trustProxy: 'loopback' }).withTypeProvider<TypeBoxTypeProvider>();

  server.setNotFoundHandler((request, reply) => reply.code(404).send({ error: 'not found', code: 'not_found', message: 'not found', requestId: request.id, retryable: false }));
  server.setErrorHandler((error, request, reply) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (error instanceof JobsShuttingDownError) {
      log.warn('job submission rejected during graceful shutdown', { requestId: request.id });
      sendServiceDraining(reply, request.id);
      return;
    }
    if (error instanceof DailyDecryptLimitError) {
      reply.header('Retry-After', String(Math.max(1, Math.ceil((error.nextAvailableAt - Date.now()) / 1000))));
      reply.code(429).send({ error: error.message, code: error.code, message: error.message, requestId: request.id, retryable: true, remediation: { nextAvailableAt: error.nextAvailableAt } });
      return;
    }
    const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500;
    const status = statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    log.error('unhandled request error', { requestId: request.id, method: request.method, path: request.url, error: normalized.message });
    reply.code(status).send(createHttpErrorEnvelope(request.id, status, normalized.message));
  });

  await server.register(fastifySwagger, {
    mode: 'dynamic',
    openapi: {
      openapi: '3.1.0',
      info: { title: 'dkrypt API', version: '1.0.0', description: 'Typed internal API for dkrypt dashboard and operations.' },
      servers: [{ url: '/' }],
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearerAuth: [] }],
    },
  });

  server.addHook('onRequest', (request, reply, done) => {
    (request as unknown as { metricsStartedAt: number }).metricsStartedAt = performance.now();
    const supplied = request.headers['x-request-id'];
    const requestId = typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
    (request as unknown as { id: string }).id = requestId;
    reply.header('X-Request-ID', requestId);
    if (isPublicApiKeyRoute(request.method, request.url)) reply.header('X-Dkrypt-API-Version', '1');
    const traceparent = typeof request.headers.traceparent === 'string' ? request.headers.traceparent : undefined;
    const trace = startSpan('http.request', { 'http.method': request.method, 'http.request_id': requestId }, traceparent ? traceContextFromHeader(traceparent) : undefined);
    (request as unknown as { traceSpan: SpanHandle }).traceSpan = trace;
    reply.header('traceparent', trace.context.traceparent);
    withCorrelation({ correlationId: requestId, traceId: trace.context.traceId, traceContext: trace.context }, () => {
      const method = request.method.toUpperCase();
      const isMutation = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
      if (drainingServers.has(server) && isMutation) {
        log.warn('mutation rejected during graceful shutdown', { requestId });
        sendServiceDraining(reply, requestId);
        return;
      }
      const isWebhook = request.url.startsWith('/v1/stripe/webhook') || request.url.startsWith('/v1/nowpayments/webhook');
      const hasCookie = typeof request.headers.cookie === 'string' && request.headers.cookie.length > 0;
      if (isMutation && !isWebhook && hasCookie) {
        const fetchSite = request.headers['sec-fetch-site'];
        const origin = request.headers.origin;
        if (typeof fetchSite !== 'string' && typeof origin !== 'string') {
          rejectCsrfMutation(reply, requestId, 'request origin and fetch metadata are missing');
          return;
        }
        if (typeof fetchSite === 'string' && fetchSite.toLowerCase() !== 'same-origin') {
          rejectCsrfMutation(reply, requestId, 'request fetch site is not same-origin');
          return;
        }
        if (typeof origin === 'string') {
          try {
            const requestedUrl = new URL(origin);
            const requestedOrigin = requestedUrl.origin;
            const configuredOrigin = new URL(config.publicBaseUrl).origin;
            if (requestedOrigin !== configuredOrigin) {
              const sameHostThroughProxy = typeof fetchSite === 'string'
                && fetchSite.toLowerCase() === 'same-origin'
                && requestedUrl.host === new URL(`${requestedUrl.protocol}//${request.host}`).host;
              if (!sameHostThroughProxy && requestedOrigin !== new URL(`${request.protocol}://${request.host}`).origin) {
                rejectCsrfMutation(reply, requestId, 'request origin is not allowed');
                return;
              }
            }
          } catch {
            rejectCsrfMutation(reply, requestId, 'request origin is not allowed');
            return;
          }
        }
      }
      if (shouldRateLimitApiRequest(request.url)) {
        const credential = request.headers.authorization ?? request.headers.cookie ?? request.ip ?? 'unknown';
        const subject = createHash('sha256').update(credential).digest('hex');
        const decision = sharedApiRateLimiter.consume(subject);
        reply.header('X-RateLimit-Limit', String(decision.limit));
        reply.header('X-RateLimit-Remaining', String(decision.remaining));
        reply.header('X-RateLimit-Reset', String(Math.ceil(decision.resetAt / 1000)));
        if (!decision.allowed) {
          reply.header('Retry-After', String(decision.retryAfterSeconds));
          reply.code(429).send({ error: 'too many requests', code: 'rate_limited', message: 'too many requests', requestId, retryable: true });
          return;
        }
      }
      done();
    });
  });

  server.addHook('onResponse', (request, reply, done) => {
    incrementMetric('http_requests_total', { method: request.method, path: request.routeOptions.url ?? request.url.split('?')[0], status: reply.statusCode });
    const startedAt = (request as unknown as { metricsStartedAt?: number }).metricsStartedAt;
    if (startedAt !== undefined) observeMetric('http_request_duration_ms', performance.now() - startedAt);
    const trace = (request as unknown as { traceSpan?: SpanHandle }).traceSpan;
    trace?.setAttributes({ 'http.route': request.routeOptions.url ?? request.url.split('?')[0], 'http.status_code': reply.statusCode });
    trace?.end(reply.statusCode >= 500 ? new Error(`HTTP ${reply.statusCode}`) : undefined);
    done();
  });

  server.addHook('preValidation', fastifyRejectGeneratedApiKeyOutsidePublicApi);

  server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    if (request.url.startsWith('/v1/stripe/webhook') || request.url.startsWith('/v1/nowpayments/webhook')) return done(null, body);
    try {
      done(null, body.length === 0 ? {} : JSON.parse(body.toString('utf8')));
    } catch (error) {
      done(error as Error);
    }
  });

  if (options.includePublicRoutes !== false) {
    await server.register(fastifyStatic, { root: path.join(publicDir, 'assets'), prefix: '/assets/', maxAge: '1y', immutable: true });
    await server.register(scalarApiReference, {
      routePrefix: '/reference',
      configuration: { url: '/openapi.json', theme: 'moon' },
    });
  }

  server.addHook('onSend', (request, reply, payload, done) => {
    let normalizedPayload = normalizeApiErrorPayload(request, reply, payload);
    if (!request.url.startsWith('/assets/') && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=()');
    const isScalarReferenceDocument = request.url.split('?', 1)[0] === '/reference/';
    if (isScalarReferenceDocument) {
      const nonce = randomBytes(18).toString('base64url');
      const html = typeof normalizedPayload === 'string'
        ? normalizedPayload
        : Buffer.isBuffer(normalizedPayload)
          ? normalizedPayload.toString('utf8')
          : undefined;
      if (html) {
        normalizedPayload = html
          .replace(/<script\b/gi, `<script nonce="${nonce}"`)
          .replace('</head>', `<meta property="csp-nonce" content="${nonce}" />\n  </head>`);
      }
      reply.header('Content-Security-Policy', `default-src 'self'; base-uri 'self'; frame-ancestors 'self'; object-src 'none'; img-src 'self' data: https:; style-src 'self'; style-src-elem 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; script-src 'self' 'nonce-${nonce}'; connect-src 'self'; font-src 'self' data:`);
    } else {
      reply.header('Content-Security-Policy', "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data: https:; style-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:");
    }
    if (config.publicBaseUrl.startsWith('https://')) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    done(null, normalizedPayload);
  });

  server.get('/openapi.json', (_request, reply) => reply.send(createPublicOpenApiDocument(server.swagger())));

  if (options.includePublicRoutes !== false) {
    const ogImageVersion = createHash('sha256').update(readFileSync(path.join(publicDir, 'og-image.png'))).digest('hex').slice(0, 10);
    const indexHtml = readFileSync(path.join(publicDir, 'index.html'), 'utf8')
      .replaceAll('__PUBLIC_BASE_URL__', config.publicBaseUrl)
      .replaceAll('__OG_IMAGE_VERSION__', ogImageVersion);

    for (const route of ['/', '/pricing', '/terms', '/privacy', '/refund-policy', '/contact', '/status']) {
      server.get(route, (request, reply) => reply.type('text/html').send(renderPublicPage(indexHtml, request.url)));
    }

    server.get('/pricing/catalog.json', (_request, reply) => reply.header('Cache-Control', 'no-store').send({ plans: listPlans().map(({ id, name, description, amount, currency, api, priority, dailyDecryptLimit, apiRatePerMinute }) => ({ id, name, description, amount, currency, api, priority, dailyDecryptLimit, apiRatePerMinute })) }));

    server.get('/favicon.svg', (_request, reply) => reply.header('Cache-Control', 'public, max-age=86400').type('image/svg+xml').sendFile('favicon.svg', publicDir));
    server.get('/favicon.png', (_request, reply) => reply.header('Cache-Control', 'public, max-age=86400').type('image/png').sendFile('favicon.png', publicDir));
    server.get('/og-image.png', (_request, reply) => reply.header('Cache-Control', 'public, max-age=86400').type('image/png').sendFile('og-image.png', publicDir));
    server.get('/manifest.webmanifest', (_request, reply) =>
      reply.header('Cache-Control', 'public, max-age=86400').type('application/manifest+json').sendFile('manifest.webmanifest', publicDir),
    );
    server.get('/.well-known/apple-developer-merchantid-domain-association', (_request, reply) =>
      reply.type('text/plain').sendFile('.well-known/apple-developer-merchantid-domain-association', publicDir),
    );
    server.get('/sw.js', (_request, reply) => reply.type('application/javascript').sendFile('sw.js', publicDir));
  }

  await server.register(billingWebhookRoutes, { stripeClient: options.stripeClient });
  await server.register(healthRoutes);
  await server.register(internalDeploymentRoutes);
  await server.register(decryptRoutes);
  await server.register(artifactCatalogRoutes);
  await server.register(testFlightCatalogRoutes);
  await server.register(authRoutes);
  await server.register(dashboardApiKeyRoutes);
  await server.register(dashboardAccountRoutes);
  await server.register(dashboardBackupRoutes);
  await server.register(dashboardDeviceRoutes);
  await server.register(dashboardDiagnosticsRoutes);
  await server.register(dashboardOverviewRoutes);
  await server.register(dashboardProjectRoutes);
  await server.register(dashboardRoleRoutes);
  await server.register(dashboardSettingsRoutes);
  await server.register(dashboardUserRoutes);
  await server.register(dashboardObservabilityRoutes);
  await server.register(dashboardArtifactRoutes);
  await server.register(dashboardNotificationRoutes);
  await server.register(dashboardJobRoutes);
  await server.register(dashboardJobActionRoutes);
  await server.register(dashboardDecryptPreflightRoutes);
  await server.register(dashboardJobAnalyticsRoutes);
  await server.register(dashboardJobHistoryRoutes);
  await server.register(dashboardReportingRoutes);
  await server.register(dashboardDiagnosticReportRoutes);
  await server.register(dashboardTestFlightRoutes);
  await server.register(dashboardTestFlightBrowseRoutes);
  await server.register(dashboardAppRoutes);
  await server.register(dashboardQuickSearchRoutes);
  await server.register(dashboardIncidentRoutes);
  await server.register(dashboardCoverageRoutes);
  await server.register(dashboardIntegrationRoutes);
  await server.register(dashboardOfflineAppStoreRoutes);
  await server.register(signedTriggerRoutes);
  await server.register(dashboardDiscordRoutes);
  await server.register(dashboardEventsRoutes);
  await server.register(billingRoutes, { stripeClient: options.stripeClient, stripeWebhookHealth: options.stripeWebhookHealth });
  return server;
}

async function startBackgroundServices(): Promise<void> {
  const retiredWatches = disableLegacyAppWatches();
  if (retiredWatches > 0) log.info('disabled legacy scheduled app watches', { count: retiredWatches });
  startTelemetry();
  stopRustDeviceEventMonitoring = startRustDeviceEventMonitoring({
    onUsbDeviceHealthRefresh: (udid) => {
      void trackBackgroundWork('device-health-usb-event', () => refreshUsbDeviceHealth(udid))
        .catch((error: unknown) => log.warn('device health refresh after USB event failed', { error: String(error) }));
    },
  });
  await initializeArtifactStore(getArtifactBackedJobs());
  startJobSweeper();
  startStateFlusher();
  startLogFlusher();
  startApiKeySweeper();
  startSessionSweeper();
  startBackupScheduler();
  startDeviceHealthPoller();
  startKeyExpiryPoller();
  startTestFlightSubscriptionPoller();
  startCryptoBillingPoller();
  startJobWebhookDispatcher();
  startNotificationDigestScheduler();
  incidentReconciliationTimer = setInterval(() => {
    try {
      reconcileOperationalIncidents();
    } catch (error) {
      log.warn('incident reconciliation failed', { error: String(error) });
    }
  }, 60_000);
  incidentReconciliationTimer.unref();
}

export function registerShutdownHandlers(
  server: FastifyInstance,
  options: { jobDrainTimeoutMs?: number; serverCloseTimeoutMs?: number; processExit?: (code: number) => void } = {},
): { shutdown: (signal: string) => Promise<void> } {
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    log.info('graceful shutdown started', { signal });
    const shutdownDeadline = setTimeout(() => {
      log.error('graceful shutdown is still pending near the container stop deadline', { signal });
    }, 140_000);
    drainingServers.add(server);
    stopAcceptingJobs();
    stopBackupScheduler();
    void trackBackgroundWork('telemetry-shutdown', stopTelemetry)
      .catch((error: unknown) => log.warn('telemetry shutdown failed', { error: String(error) }));
    stopDeviceHealthPoller();
    stopTestFlightSubscriptionPoller();
    stopCryptoBillingPoller();
    stopKeyExpiryPoller();
    stopJobSweeper();
    stopStateBackgroundServices();
    if (incidentReconciliationTimer) clearInterval(incidentReconciliationTimer);
    incidentReconciliationTimer = undefined;
    void trackBackgroundWork('notification-digest-shutdown', stopNotificationDigestScheduler)
      .catch((error: unknown) => log.warn('notification digest shutdown failed', { error: String(error) }));

    shutdownPromise = (async () => {
      const rustEventShutdown = (async () => {
        await stopRustDeviceEventMonitoring?.();
        stopRustDeviceEventMonitoring = undefined;
      })().catch((error: unknown) => {
        log.warn('Rust device event monitor shutdown failed', { error: String(error) });
        throw error;
      });
      const [jobShutdown, backgroundShutdown, rustEventDrained] = await Promise.all([
        shutdownJobs(options.jobDrainTimeoutMs),
        drainBackgroundWork(15_000),
        waitForShutdownOperation(rustEventShutdown, 15_000),
      ]);
      const finalBackgroundShutdown = await drainBackgroundWork(1_000);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      closeDashboardConnections();
      const serverClose = server.close().catch((error: unknown) => {
        log.warn('HTTP server close failed', { error: String(error) });
        throw error;
      });
      const serverDrained = await waitForShutdownOperation(serverClose, options.serverCloseTimeoutMs ?? 10_000);
      if (!serverDrained) {
        log.warn('HTTP connections remain after the shutdown grace period');
        server.server.closeAllConnections();
      }
      const finishShutdown = async () => {
        closeJobStore();
        closeBillingDatabase();
        closeIdentityDatabase();
        closeIdempotencyDatabase();
        closeWebhookInboxDatabase();
        closeArtifactDatabase();
        closeIncidentRepository();
        closeIntegrationRepository();
        closeOauthLinkReviewRepository();
        closeStateDatabase();
        log.info('graceful shutdown completed', { signal });
        stopLogFlusher();
        clearTimeout(shutdownDeadline);
      };
      if (jobShutdown.drained && backgroundShutdown.drained && finalBackgroundShutdown.drained && rustEventDrained && serverDrained) {
        await Promise.all([
          jobShutdown.completion,
          backgroundShutdown.completion,
          finalBackgroundShutdown.completion,
        ]);
        stopJobWebhookDispatcher();
        const pendingNotificationWork = await drainBackgroundWork(1_000);
        if (pendingNotificationWork.drained) {
          await pendingNotificationWork.completion;
          await finishShutdown();
          return;
        }
        log.warn('notification work remains after its shutdown grace period; closing durable state and exiting', { pending: pendingNotificationWork.pending });
      } else {
        log.warn('work remains after the shutdown grace period; closing durable state and exiting', {
          signal,
          jobRunnersDrained: jobShutdown.drained,
          rustEventMonitorDrained: rustEventDrained,
          httpServerDrained: serverDrained,
          backgroundWork: [...new Set([...backgroundShutdown.pending, ...finalBackgroundShutdown.pending])],
        });
        stopJobWebhookDispatcher();
        const pendingNotificationWork = await drainBackgroundWork(1_000);
        if (!pendingNotificationWork.drained) {
          log.warn('notification work remains; terminating after durable state is closed', { pending: pendingNotificationWork.pending });
        }
      }
      await finishShutdown();
      if (options.processExit) options.processExit(0);
      else process.exit(0);
    })().catch((error: unknown) => {
      clearTimeout(shutdownDeadline);
      log.error('graceful shutdown failed', { signal, error: String(error) });
      throw error;
    });
    return shutdownPromise;
  };

  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  return { shutdown };
}

async function start(): Promise<void> {
  const server = await buildServer();
  await startBackgroundServices();
  await server.listen({ port: config.port, host: config.bindHost });
  log.info(`dkrypt listening on ${config.bindHost}:${config.port}`);
  registerShutdownHandlers(server);
}

if (import.meta.main) void start();
