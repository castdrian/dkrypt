import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { createDecryptRoutes } from '#routes/decrypt.js';
import { createApiKey, revokeApiKey } from '#store/state.js';
import type { Job } from '#jobs/types.js';

test('API-key job event streams replay the current snapshot and resume after the last event', async () => {
  const job: Job = {
    id: 'job-events-1',
    bundleId: 'com.example.app',
    source: 'manual',
    priority: 0,
    status: 'done',
    progress: 'Complete',
    createdAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    timeline: [{ at: 1_700_000_000_000, label: 'Queued', status: 'queued' }],
    waiters: [],
  };
  const apiKey = createApiKey(`event stream ${crypto.randomUUID()}`, 'root');
  const server = Fastify();
  await server.register(createDecryptRoutes({ getJob: () => job } as never));

  try {
    const headers = { authorization: `Bearer ${apiKey.key}` };
    const first = await server.inject({ method: 'GET', url: `/v1/jobs/${job.id}/events`, headers });
    const body = first.body;
    const id = /^id: ([A-Za-z0-9_-]{43})$/m.exec(body)?.[1];
    const data = /^data: (.+)$/m.exec(body)?.[1];

    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toStartWith('text/event-stream');
    expect(id).toBeDefined();
    expect(JSON.parse(data ?? '{}')).toMatchObject({ job: { id: job.id, status: 'done' }, events: job.timeline });

    const resumed = await server.inject({
      method: 'GET',
      url: `/v1/jobs/${job.id}/events`,
      headers: { ...headers, 'last-event-id': id! },
    });

    expect(resumed.statusCode).toBe(200);
    expect(resumed.body).not.toContain('event: snapshot');
  } finally {
    revokeApiKey(apiKey.id, 'root', true);
    await server.close();
  }
});
