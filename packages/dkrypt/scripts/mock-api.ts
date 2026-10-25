type MockJob = {
  id: string;
  bundleId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  createdAt: string;
  reads: number;
  scenario: 'success' | 'failure';
};

export function createMockApiHandler() {
  const jobs = new Map<string, MockJob>();
  const idempotency = new Map<string, string>();
  let nextJob = 1;

  return async function handleMockApi(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get('authorization') !== 'Bearer mock-dkrypt-key') return mockJson({ code: 'unauthorized', message: 'Use the local mock key.' }, 401);
    if (request.method === 'POST' && url.pathname === '/v1/decrypts') {
      const body = await request.json().catch(() => ({})) as { bundleId?: string };
      if (!body.bundleId || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(body.bundleId)) return mockJson({ code: 'invalid_bundle_id', message: 'Provide a valid bundle ID.' }, 400);
      const requestKey = request.headers.get('idempotency-key');
      const previousJobId = requestKey ? idempotency.get(requestKey) : undefined;
      const previousJob = previousJobId ? jobs.get(previousJobId) : undefined;
      if (previousJob && previousJob.bundleId !== body.bundleId) return mockJson({ code: 'idempotency_conflict', message: 'This idempotency key already belongs to another request.' }, 409);
      if (previousJob) return mockJson(publicJob(previousJob), 202);
      const id = `mock-job-${String(nextJob).padStart(4, '0')}`;
      const job: MockJob = {
        id,
        bundleId: body.bundleId,
        status: 'queued',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, nextJob)).toISOString(),
        reads: 0,
        scenario: request.headers.get('x-dkrypt-mock-scenario') === 'failure' ? 'failure' : 'success',
      };
      nextJob += 1;
      jobs.set(id, job);
      if (requestKey) idempotency.set(requestKey, id);
      return mockJson(publicJob(job), 202);
    }
    if (request.method === 'POST' && url.pathname === '/v1/jobs/status') {
      const body = await request.json().catch(() => ({})) as { ids?: string[] };
      return mockJson({ jobs: (body.ids ?? []).map((id) => {
        const job = jobs.get(id);
        return { id, state: job ? 'found' : 'not_found', ...(job ? { job: publicJob(job) } : {}) };
      }) });
    }
    const eventMatch = /^\/v1\/jobs\/([^/]+)\/events$/.exec(url.pathname);
    if (request.method === 'GET' && eventMatch) {
      const job = jobs.get(decodeURIComponent(eventMatch[1]!));
      if (!job) return mockJson({ code: 'not_found', message: 'Mock job not found.' }, 404);
      advance(job);
      const snapshot = { job: publicJob(job), events: [] };
      const eventId = await snapshotId(snapshot);
      const body = request.headers.get('last-event-id') === eventId ? ': unchanged\n\n' : `id: ${eventId}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Dkrypt-Sandbox': 'true' } });
    }
    const jobMatch = /^\/v1\/jobs\/([^/]+)(?:\/(wait))?$/.exec(url.pathname);
    if (request.method === 'GET' && jobMatch) {
      const job = jobs.get(decodeURIComponent(jobMatch[1]!));
      if (!job) return mockJson({ code: 'not_found', message: 'Mock job not found.' }, 404);
      advance(job);
      return mockJson(publicJob(job), job.status === 'queued' || job.status === 'running' ? 202 : 200);
    }
    if (request.method === 'GET' && url.pathname === '/v1/artifacts') {
      const artifacts = [...jobs.values()].filter((job) => job.status === 'done').map((job) => ({
        id: `mock-artifact-${job.id}`,
        appName: 'Synthetic Sandbox App',
        bundleId: job.bundleId,
        version: '0.0.0-synthetic',
        source: 'sandbox',
        sizeBytes: 41,
        synthetic: true,
        createdAt: job.createdAt,
        downloadUrl: `/v1/artifacts/mock-artifact-${job.id}/file`,
      }));
      return mockJson({ artifacts, total: artifacts.length, totalBytes: artifacts.length * 41, maxBytes: artifacts.length * 41, nextCursor: null, synthetic: true });
    }
    if (request.method === 'GET' && /^\/v1\/artifacts\/[^/]+$/.test(url.pathname)) {
      const artifactId = decodeURIComponent(url.pathname.split('/').at(-1)!);
      const job = [...jobs.values()].find((candidate) => `mock-artifact-${candidate.id}` === artifactId && candidate.status === 'done');
      return job ? mockJson({ id: artifactId, appName: 'Synthetic Sandbox App', bundleId: job.bundleId, version: '0.0.0-synthetic', synthetic: true, createdAt: job.createdAt }) : mockJson({ code: 'not_found', message: 'Mock artifact not found.' }, 404);
    }
    if (request.method === 'GET' && /^\/v1\/artifacts\/[^/]+\/file$/.test(url.pathname)) {
      const artifactId = decodeURIComponent(url.pathname.split('/').at(-2)!);
      const exists = [...jobs.values()].some((job) => `mock-artifact-${job.id}` === artifactId && job.status === 'done');
      if (!exists) return mockJson({ code: 'not_found', message: 'Mock artifact not found.' }, 404);
      return new Response('SYNTHETIC DKRYPT SANDBOX FILE. This is not an IPA and cannot be installed.\n', { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="synthetic-sandbox-file.txt"', 'X-Dkrypt-Sandbox': 'true' } });
    }
    return mockJson({ code: 'not_found', message: 'Route is not part of the local mock API.' }, 404);
  };

  function advance(job: MockJob) {
    if (job.status === 'queued') job.status = 'running';
    else if (job.status === 'running') job.status = job.scenario === 'failure' ? 'failed' : 'done';
    job.reads += 1;
  }
}

function publicJob(job: MockJob) {
  const terminal = job.status === 'done' || job.status === 'failed';
  return {
    id: job.id,
    correlationId: job.id,
    bundleId: job.bundleId,
    status: job.status,
    progress: job.status === 'done' ? 'Synthetic sandbox job completed; no app was downloaded.' : job.status === 'failed' ? 'Synthetic sandbox failure scenario.' : job.status === 'running' ? 'Synthetic sandbox job running.' : 'Synthetic sandbox job queued.',
    source: 'manual',
    channel: 'appstore',
    priority: 0,
    createdAt: job.createdAt,
    ...(job.status !== 'queued' ? { startedAt: job.createdAt } : {}),
    ...(terminal ? { finishedAt: job.createdAt } : {}),
    ...(job.status === 'failed' ? { error: 'Synthetic sandbox failure.' } : {}),
    statusUrl: `/v1/jobs/${job.id}`,
    synthetic: true,
  };
}

async function snapshotId(snapshot: unknown) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(snapshot)));
  return Buffer.from(digest).toString('base64url');
}

function mockJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { 'X-Dkrypt-Sandbox': 'true' } });
}

if (import.meta.main) {
  const port = Number(process.env.DKRYPT_MOCK_PORT ?? 4179);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('DKRYPT_MOCK_PORT must be a valid TCP port');
  const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: createMockApiHandler() });
  process.on('SIGINT', () => server.stop(true));
  process.on('SIGTERM', () => server.stop(true));
  console.log(`Local dkrypt mock API listening on http://127.0.0.1:${port}`);
  console.log('Mock key: mock-dkrypt-key');
  console.log('All jobs, artifacts, and files are synthetic; no IPA is downloaded and no external service is contacted.');
}
