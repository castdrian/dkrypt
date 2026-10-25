import { expect, test } from 'bun:test';
import { createMockApiHandler } from './mock-api.js';

test('mock API is deterministic, idempotent, and clearly marks synthetic artifacts', async () => {
  const handle = createMockApiHandler();
  const headers = { authorization: 'Bearer mock-dkrypt-key', 'idempotency-key': 'stable-job' };
  const first = await handle(new Request('http://127.0.0.1/v1/decrypts', { method: 'POST', headers, body: JSON.stringify({ bundleId: 'com.example.app' }) }));
  const repeated = await handle(new Request('http://127.0.0.1/v1/decrypts', { method: 'POST', headers, body: JSON.stringify({ bundleId: 'com.example.app' }) }));
  expect(first.status).toBe(202);
  expect(await first.json()).toMatchObject({ id: 'mock-job-0001', status: 'queued', synthetic: true });
  expect(await repeated.json()).toMatchObject({ id: 'mock-job-0001' });

  await handle(new Request('http://127.0.0.1/v1/jobs/mock-job-0001', { headers: { authorization: 'Bearer mock-dkrypt-key' } }));
  const done = await handle(new Request('http://127.0.0.1/v1/jobs/mock-job-0001', { headers: { authorization: 'Bearer mock-dkrypt-key' } }));
  expect(await done.json()).toMatchObject({ status: 'done', synthetic: true });

  const artifacts = await handle(new Request('http://127.0.0.1/v1/artifacts', { headers: { authorization: 'Bearer mock-dkrypt-key' } }));
  expect(await artifacts.json()).toMatchObject({ synthetic: true, artifacts: [{ id: 'mock-artifact-mock-job-0001', synthetic: true }] });
  const file = await handle(new Request('http://127.0.0.1/v1/artifacts/mock-artifact-mock-job-0001/file', { headers: { authorization: 'Bearer mock-dkrypt-key' } }));
  expect(file.headers.get('x-dkrypt-sandbox')).toBe('true');
  expect(await file.text()).toContain('This is not an IPA');
});

test('mock API supports a deterministic failure scenario and refuses external access', async () => {
  const handle = createMockApiHandler();
  const failed = await handle(new Request('http://127.0.0.1/v1/decrypts', { method: 'POST', headers: { authorization: 'Bearer mock-dkrypt-key', 'x-dkrypt-mock-scenario': 'failure' }, body: JSON.stringify({ bundleId: 'com.example.failure' }) }));
  const job = await failed.json() as { id: string };
  await handle(new Request(`http://127.0.0.1/v1/jobs/${job.id}`, { headers: { authorization: 'Bearer mock-dkrypt-key' } }));
  const terminal = await handle(new Request(`http://127.0.0.1/v1/jobs/${job.id}`, { headers: { authorization: 'Bearer mock-dkrypt-key' } }));
  expect(await terminal.json()).toMatchObject({ status: 'failed', synthetic: true });

  const unauthorized = await handle(new Request('http://127.0.0.1/v1/artifacts'));
  expect(unauthorized.status).toBe(401);
});
