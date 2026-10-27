import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Response } from '#http.js';
import type { FastifyInstance } from 'fastify';

const sandbox = await mkdtemp(path.join(tmpdir(), 'dkrypt-load-test-'));
const stateDir = path.join(sandbox, 'state');
const artifactDir = path.join(sandbox, 'artifacts');
const outputDir = path.join(sandbox, 'output');
const runId = randomUUID();

Object.assign(process.env, {
  API_KEY: `load-test-api-${runId}`,
  SESSION_SIGNING_SECRET: `load-test-session-${runId}`,
  SESSION_SIGNING_SECRET_PREVIOUS: '',
  BACKUP_MANIFEST_SECRET: `load-test-backup-${runId}`,
  BACKUP_MANIFEST_SECRET_PREVIOUS: '',
  ADMIN_PASSWORD: `load-test-password-${runId}`,
  ADMIN_PASSWORD_PREVIOUS: '',
  PUBLIC_BASE_URL: 'http://127.0.0.1',
  BIND_HOST: '127.0.0.1',
  STATE_DIR: stateDir,
  ARTIFACT_DIR: artifactDir,
  OUTPUT_DIR: outputDir,
  API_RATE_LIMIT_PER_MINUTE: '2000',
  FREE_NETWORK_DECRYPT_LIMIT: '1000',
  FREE_ADDRESS_DECRYPT_LIMIT: '1000',
  JOB_MAX_WAIT_SECONDS: '300',
  DEVICE_BRIDGE_SOCKET: path.join(sandbox, 'device-bridge.sock'),
  DEVICE_BRIDGE_SECRET: `load-test-bridge-${runId}`,
  DEVICE_BRIDGE_SECRET_PREVIOUS: '',
  DEVICE_TRANSPORT: 'rust',
  DEVICE_PAIRING_STORE: path.join(sandbox, 'pairing'),
  DEVICE_SSH_KEY_PATH: path.join(sandbox, 'device-ssh-key'),
  GITHUB_OAUTH_CLIENT_ID: '',
  GITHUB_OAUTH_CLIENT_SECRET: '',
  DISCORD_OAUTH_CLIENT_ID: '',
  DISCORD_OAUTH_CLIENT_SECRET: '',
  DISCORD_BOT_TOKEN: '',
  STRIPE_SECRET_KEY: 'sk_test_load_test',
  STRIPE_WEBHOOK_SECRET: 'whsec_load_test',
  STRIPE_WEBHOOK_SECRET_PREVIOUS: '',
  STRIPE_REGULAR_PRICE_ID: 'price_load_regular',
  STRIPE_PRIORITY_PRICE_ID: 'price_load_priority',
  STRIPE_API_PRICE_ID: 'price_load_api',
  STRIPE_PRIORITY_API_PRICE_ID: 'price_load_priority_api',
  NOWPAYMENTS_API_KEY: '',
  NOWPAYMENTS_IPN_SECRET: '',
  NOWPAYMENTS_IPN_SECRET_PREVIOUS: '',
  NOWPAYMENTS_ENVIRONMENT: 'test',
  OUTBOUND_WEBHOOK_SECRET: '',
  OUTBOUND_WEBHOOK_SECRET_PREVIOUS: '',
  GH_TOKEN: '',
  NOTIFY_WEBHOOK_URL: '',
  SMTP_HOST: '',
  SMTP_USER: '',
  SMTP_PASS: '',
  OTEL_EXPORTER_OTLP_ENDPOINT: '',
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '',
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: '',
});

const { config } = await import('#config.js');
const { artifactKeyForAppStore, closeArtifactDatabase, promoteArtifact } = await import('#artifacts.js');
const { closeBillingDatabase, createBillingAccessCode, redeemBillingAccessCode } = await import('#billing.js');
const { closeIdentityDatabase } = await import('#identity.js');
const { closeIdempotencyDatabase } = await import('#idempotency.js');
const { cancelQueuedJob, closeJobStore } = await import('#jobs/store.js');
const { PermissionFlag } = await import('#permissions.js');
const { buildServer } = await import('#server.js');
const { setSessionCookie } = await import('#session.js');
const { addAllowedUser, closeStateDatabase, createRole } = await import('#store/state.js');
const { closeWebhookInboxDatabase } = await import('#webhookInbox.js');

function createAdministratorCookie(userId: string): string {
  let value = '';
  const response = { setHeader: (_name: string, header: string) => { value = header; } } as unknown as Response;
  setSessionCookie(response, { sub: userId, permissions: PermissionFlag.administrator });
  return value.split(';', 1)[0];
}

function recordDuration(results: Record<string, number>, key: string, startedAt: number): void {
  results[key] = Math.round(performance.now() - startedAt);
  assert.ok(results[key]! < 15_000, `${key} exceeded the 15-second scenario limit`);
}

const results: Record<string, number> = {};
const queuedIds: string[] = [];
const streamControllers: AbortController[] = [];
const ipnSecret = `load-test-ipn-${runId}`;
const sourceDirectory = await mkdtemp(path.join(tmpdir(), 'dkrypt-load-artifact-'));
const stagedArtifactPath = path.join(sourceDirectory, 'load-test.ipa');
let promotedArtifactPath = '';
let server: FastifyInstance | undefined;
let didFail = false;
let failure: unknown;

try {
  config.nowpaymentsIpnSecret = ipnSecret;
  config.nowpaymentsIpnSecretPrevious = '';
  server = await buildServer({ includePublicRoutes: false });
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  const origin = new URL(address).origin;
  config.publicBaseUrl = origin;
  const loadTestRole = createRole({
    name: `Load test ${runId}`,
    color: '#526dff',
    permissions: PermissionFlag.requestDecrypt.toString(),
  }, 'root');
  const sessionHeaders = Array.from({ length: 32 }, (_, index) => {
    const userId = `load-test-user-${index}`;
    addAllowedUser(userId, [loadTestRole.id], 'root');
    return { cookie: createAdministratorCookie(userId) };
  });

  let startedAt = performance.now();
  const sessionStatuses = await Promise.all(Array.from({ length: 32 }, async (_, index) => {
    const headers = sessionHeaders[index % sessionHeaders.length];
    const response = await fetch(`${origin}/v1/dashboard/overview?projectId=default`, { headers });
    await response.arrayBuffer();
    return response.status;
  }));
  assert.ok(sessionStatuses.every((status) => status === 200));
  recordDuration(results, 'authenticatedRequests', startedAt);

  streamControllers.push(...Array.from({ length: 12 }, () => new AbortController()));
  startedAt = performance.now();
  const eventStreams = await Promise.all(streamControllers.map(async (controller, index) => {
    const response = await fetch(`${origin}/v1/dashboard/events`, { headers: sessionHeaders[index], signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body?.getReader();
    assert.ok(reader);
    const firstChunk = await reader.read();
    assert.equal(firstChunk.done, false);
    assert.ok(new TextDecoder().decode(firstChunk.value).includes('event: overview'));
    return reader;
  }));
  recordDuration(results, 'sseClients', startedAt);
  await Promise.all(eventStreams.map((reader) => reader.cancel()));
  streamControllers.forEach((controller) => controller.abort());
  streamControllers.length = 0;

  for (let index = 0; index < 16; index += 1) {
    const created = createBillingAccessCode({ planId: 'standard', durationDays: 1, redeemWithinDays: 1, createdBy: 'root' });
    assert.ok(created);
    const redeemed = redeemBillingAccessCode(created.code, `load-test-user-${index}`);
    assert.ok('accessCode' in redeemed);
  }

  const artifactBytes = Buffer.alloc(256 * 1024, 0x6b);
  await writeFile(stagedArtifactPath, artifactBytes);
  const bundleId = `com.dkrypt.load.${runId.replaceAll('-', '')}`;
  const artifact = await promoteArtifact({
    key: artifactKeyForAppStore(bundleId, runId),
    bundleId,
    channel: 'appstore',
    externalVersionId: runId,
    stagingPath: stagedArtifactPath,
  });
  promotedArtifactPath = artifact.filePath;

  startedAt = performance.now();
  const artifactDownloads = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
    const response = await fetch(`${origin}/v1/dashboard/artifacts/${artifact.id}/file`, { headers: sessionHeaders[index] });
    const body = Buffer.from(await response.arrayBuffer());
    return { status: response.status, bytes: body.byteLength };
  }));
  assert.ok(artifactDownloads.every((download) => download.status === 200 && download.bytes === artifactBytes.byteLength));
  recordDuration(results, 'artifactDownloads', startedAt);

  startedAt = performance.now();
  const queueBurst = await Promise.all(Array.from({ length: 32 }, async (_, index) => {
    const response = await fetch(`${origin}/v1/dashboard/decrypt`, {
      method: 'POST',
      headers: {
        ...sessionHeaders[index],
        origin,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        bundleId: `com.dkrypt.load.${runId.replaceAll('-', '')}.${index}`,
        projectId: 'default',
        versionLabel: `Load-${index}`,
      }),
    });
    return { status: response.status, job: await response.json() as { id?: string; status?: string } };
  }));
  queuedIds.push(...queueBurst.flatMap(({ job }) => job.id ? [job.id] : []));
  assert.ok(queueBurst.every(({ status, job }) => status === 202 && job.status === 'queued' && typeof job.id === 'string'));
  assert.equal(new Set(queueBurst.map(({ job }) => job.id)).size, 32);
  recordDuration(results, 'queueBurst', startedAt);

  const payment = {
    payment_id: `load_payment_${runId}`,
    payment_status: 'waiting',
    order_id: `load_order_${runId}`,
    updated_at: new Date().toISOString(),
  };
  const rawBody = JSON.stringify(payment);
  const canonicalBody = JSON.stringify(Object.fromEntries(Object.entries(payment).sort(([left], [right]) => left.localeCompare(right))));
  const signature = createHmac('sha512', ipnSecret).update(canonicalBody).digest('hex');
  startedAt = performance.now();
  const webhookResults = await Promise.all(Array.from({ length: 24 }, async () => {
    const response = await fetch(`${origin}/v1/nowpayments/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nowpayments-sig': signature },
      body: rawBody,
    });
    return { status: response.status, body: await response.json() as { duplicate?: boolean; received?: boolean } };
  }));
  assert.ok(webhookResults.every((result) => result.status === 200 && result.body.received));
  assert.equal(webhookResults.filter((result) => result.body.duplicate !== true).length, 1);
  recordDuration(results, 'webhookBurst', startedAt);

  console.info(JSON.stringify({ status: 'passed', bind: 'loopback', counts: { sessions: 16, authenticatedRequests: 32, sseClients: 12, artifactDownloads: 16, queuedJobs: 32, webhookDeliveries: 24 }, durationMs: results }, null, 2));
} catch (error) {
  didFail = true;
  failure = error;
} finally {
  streamControllers.forEach((controller) => controller.abort());
  for (const jobId of queuedIds) cancelQueuedJob(jobId, 'synthetic load cleanup');
  if (server) {
    const closing = server.close();
    server.server.closeAllConnections();
    await closing;
  }
  if (promotedArtifactPath) await rm(promotedArtifactPath, { force: true });
  await rm(sourceDirectory, { recursive: true, force: true });
  closeJobStore();
  closeArtifactDatabase();
  closeBillingDatabase();
  closeIdentityDatabase();
  closeIdempotencyDatabase();
  closeWebhookInboxDatabase();
  closeStateDatabase();
  await rm(sandbox, { recursive: true, force: true });
}

if (didFail) {
  console.error(failure);
  process.exit(1);
}

process.exit(0);
