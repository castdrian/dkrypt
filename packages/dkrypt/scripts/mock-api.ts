const jobs = new Map<string, { id: string; bundleId: string; status: 'queued' | 'done'; createdAt: number; projectId?: string }>();
let nextJob = 1;

const port = Number(process.env.DKRYPT_MOCK_PORT ?? 4179);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('DKRYPT_MOCK_PORT must be a valid TCP port');

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('authorization') !== 'Bearer mock-dkrypt-key') return Response.json({ error: 'use the local mock key', code: 'unauthorized' }, { status: 401 });
    if (request.method === 'POST' && url.pathname === '/v1/decrypts') {
      const body = await request.json() as { bundleId?: string; projectId?: string };
      if (!body.bundleId) return Response.json({ error: 'bundleId is required' }, { status: 400 });
      const id = `mock-job-${nextJob++}`;
      const job = { id, bundleId: body.bundleId, status: 'queued' as const, createdAt: Date.now(), projectId: body.projectId };
      jobs.set(id, job);
      return Response.json({ id, correlationId: id, bundleId: job.bundleId, projectId: job.projectId, status: job.status, progress: 'Mock job accepted; no Apple request was made', source: 'manual', channel: 'appstore', priority: 0, createdAt: new Date(job.createdAt).toISOString(), statusUrl: `/v1/jobs/${id}` }, { status: 202 });
    }
    if (request.method === 'POST' && url.pathname === '/v1/jobs/status') {
      const body = await request.json() as { ids?: string[] };
      return Response.json({ jobs: (body.ids ?? []).map((id) => ({ id, state: jobs.has(id) ? 'found' : 'not_found', job: jobs.has(id) ? publicJob(jobs.get(id)!) : undefined })) });
    }
    const waitMatch = /^\/v1\/jobs\/([^/]+)(?:\/(wait))?$/.exec(url.pathname);
    if (request.method === 'GET' && waitMatch) {
      const job = jobs.get(decodeURIComponent(waitMatch[1]!));
      if (!job) return Response.json({ error: 'job not found', code: 'not_found' }, { status: 404 });
      if (waitMatch[2] && job.status === 'queued') await Bun.sleep(Math.min(1_000, Math.max(0, 1_001 - (Date.now() - job.createdAt))));
      if (Date.now() - job.createdAt > 1_000) job.status = 'done';
      return Response.json(publicJob(job), { status: job.status === 'queued' ? 202 : 200 });
    }
    if (request.method === 'GET' && url.pathname === '/v1/artifacts') return Response.json({ artifacts: [], total: 0, totalBytes: 0, maxBytes: 0 });
    return Response.json({ error: 'route is not part of the local mock', code: 'not_found' }, { status: 404 });
  },
});

process.on('SIGINT', () => server.stop(true));
process.on('SIGTERM', () => server.stop(true));
console.log(`Local dkrypt mock API listening on http://127.0.0.1:${port}`);
console.log('Mock key: mock-dkrypt-key');
console.log('This server is local-only and never contacts Apple or a payment provider.');

function publicJob(job: { id: string; bundleId: string; status: 'queued' | 'done'; createdAt: number; projectId?: string }) {
  return { id: job.id, correlationId: job.id, bundleId: job.bundleId, projectId: job.projectId, status: job.status, progress: job.status === 'done' ? 'Mock decrypt complete; no IPA was downloaded' : 'Mock job queued', source: 'manual', channel: 'appstore', priority: 0, createdAt: new Date(job.createdAt).toISOString(), startedAt: new Date(job.createdAt).toISOString(), finishedAt: job.status === 'done' ? new Date(job.createdAt + 1_001).toISOString() : undefined, statusUrl: `/v1/jobs/${job.id}` };
}
