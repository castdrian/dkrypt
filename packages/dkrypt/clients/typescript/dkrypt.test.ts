import { expect, test } from 'bun:test';
import { DkryptClient } from './dkrypt.js';

test('TypeScript client authenticates JSON calls and preserves request headers', async () => {
  let receivedHeaders: Headers | undefined;
  const fetchImpl = (async (_input: unknown, init: RequestInit | undefined) => {
    receivedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ id: 'job-1' }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new DkryptClient('https://ipa.dylib.dev', { apiKey: 'dk_test_key', fetchImpl });

  const result = await client.request<{ id: string }>({ path: '/v1/jobs/job-1', headers: { 'X-Request-Id': 'request-1' } });

  expect(result).toEqual({ id: 'job-1' });
  expect(receivedHeaders?.get('Authorization')).toBe('Bearer dk_test_key');
  expect(receivedHeaders?.get('X-Request-Id')).toBe('request-1');
});

test('TypeScript client preserves the previous fetch-injection constructor', async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response(JSON.stringify({ id: 'job-1' }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new DkryptClient('https://ipa.dylib.dev', fetchImpl);

  await client.request({ path: '/v1/jobs/job-1' });

  expect(called).toBe(true);
});

test('TypeScript client downloads IPA files with API-key authentication', async () => {
  let receivedHeaders: Headers | undefined;
  let receivedMethod = '';
  const fetchImpl = (async (_input: unknown, init: RequestInit | undefined) => {
    receivedHeaders = new Headers(init?.headers);
    receivedMethod = init?.method ?? 'GET';
    return new Response(new Uint8Array([73, 80, 65]), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new DkryptClient('https://ipa.dylib.dev', { apiKey: 'dk_test_key', fetchImpl });

  const result = await client.download('/v1/artifacts/artifact-1/file');

  expect([...new Uint8Array(result)]).toEqual([73, 80, 65]);
  expect(receivedMethod).toBe('GET');
  expect(receivedHeaders?.get('Authorization')).toBe('Bearer dk_test_key');
  expect(receivedHeaders?.get('Accept')).toBe('application/octet-stream');
});

test('TypeScript convenience helpers submit idempotent decrypts and resume a job event stream', async () => {
  const requests: Array<{ url: string; headers: Headers; body?: string }> = [];
  let eventCount = 0;
  const fetchImpl = (async (input: unknown, init: RequestInit | undefined) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : undefined;
    requests.push({ url, headers, body });
    if (url.endsWith('/v1/decrypts')) return new Response(JSON.stringify({ id: 'job/1', status: 'queued' }), { status: 202 });
    eventCount += 1;
    const status = eventCount === 1 ? 'running' : 'done';
    const eventId = `snapshot-${eventCount}`;
    const snapshot = { job: { id: 'job/1', status, progress: status }, events: [] };
    return new Response(`retry: 0\n\nid: ${eventId}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  const client = new DkryptClient('https://ipa.dylib.dev', { apiKey: 'dk_test_key', fetchImpl });

  const job = await client.decrypt('com.example.app', { idempotencyKey: 'request-1' });
  const updates = [];
  for await (const update of client.followJob(job.id)) updates.push(update.status);

  expect(job).toMatchObject({ id: 'job/1', status: 'queued' });
  expect(updates).toEqual(['running', 'done']);
  expect(requests[0]).toMatchObject({ url: 'https://ipa.dylib.dev/v1/decrypts', body: JSON.stringify({ bundleId: 'com.example.app' }) });
  expect(requests[0]?.headers.get('Idempotency-Key')).toBe('request-1');
  expect(requests[1]?.url).toBe('https://ipa.dylib.dev/v1/jobs/job%2F1/events');
  expect(requests[2]?.headers.get('Last-Event-ID')).toBe('snapshot-1');
});

test('TypeScript client follows every artifact page and rejects cursor loops', async () => {
  const requests: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    requests.push(url);
    const page = url.includes('cursor=next')
      ? { artifacts: [{ id: 'artifact-2', bundleId: 'com.example.two' }] }
      : { artifacts: [{ id: 'artifact-1', bundleId: 'com.example.one' }], nextCursor: 'next' };
    return new Response(JSON.stringify(page), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new DkryptClient('https://ipa.dylib.dev', { fetchImpl });

  await expect(client.listAllArtifacts({ q: 'example', limit: 20 })).resolves.toMatchObject([
    { id: 'artifact-1' },
    { id: 'artifact-2' },
  ]);
  expect(requests).toEqual([
    'https://ipa.dylib.dev/v1/artifacts?q=example&limit=20',
    'https://ipa.dylib.dev/v1/artifacts?q=example&limit=20&cursor=next',
  ]);

  const loopingClient = new DkryptClient('https://ipa.dylib.dev', { fetchImpl: (async () => new Response(JSON.stringify({ artifacts: [], nextCursor: 'repeat' }), { status: 200 })) as unknown as typeof fetch });
  await expect(loopingClient.listAllArtifacts()).rejects.toThrow('repeated cursor');
});

test('TypeScript client never sends an API key to a different origin', async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response(new Uint8Array([73, 80, 65]), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new DkryptClient('https://ipa.dylib.dev', { apiKey: 'dk_test_key', fetchImpl });

  await expect(client.download('https://attacker.example/file')).rejects.toThrow('configured origin');

  expect(called).toBe(false);
});

test('TypeScript client allows plain HTTP only for localhost', async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response(JSON.stringify({ id: 'job-1' }), { status: 200 });
  }) as unknown as typeof fetch;
  const remote = new DkryptClient('http://dkrypt.example', { apiKey: 'dk_test_key', fetchImpl });
  await expect(remote.request({ path: '/v1/jobs/job-1' })).rejects.toThrow('HTTPS');
  expect(called).toBe(false);

  const local = new DkryptClient('http://localhost:3000', { apiKey: 'dk_test_key', fetchImpl });
  await expect(local.request({ path: '/v1/jobs/job-1' })).resolves.toEqual({ id: 'job-1' });
  expect(called).toBe(true);
});

test('TypeScript client returns the HTTP error for non-object error JSON', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify('upstream error'), { status: 502 })) as unknown as typeof fetch;
  const client = new DkryptClient('https://ipa.dylib.dev', { apiKey: 'dk_test_key', fetchImpl, retry: { baseDelayMs: 0 } });

  await expect(client.request({ path: '/v1/jobs/job-1' })).rejects.toThrow('HTTP 502');
});

test('TypeScript client retries a transient read and respects Retry-After', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return calls === 1
      ? new Response(JSON.stringify({ message: 'try again' }), { status: 503, headers: { 'Retry-After': '0' } })
      : new Response(JSON.stringify({ id: 'job-1' }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new DkryptClient('https://ipa.dylib.dev', { fetchImpl, retry: { baseDelayMs: 0 } });

  await expect(client.request({ path: '/v1/jobs/job-1' })).resolves.toEqual({ id: 'job-1' });
  expect(calls).toBe(2);
});

test('TypeScript client never retries a write without an idempotency key', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ message: 'unavailable' }), { status: 503 });
  }) as unknown as typeof fetch;
  const client = new DkryptClient('https://ipa.dylib.dev', { fetchImpl, retry: { baseDelayMs: 0 } });

  await expect(client.request({ path: '/v1/example', method: 'POST', body: '{}' })).rejects.toThrow('unavailable');
  expect(calls).toBe(1);
});
