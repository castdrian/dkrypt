import { expect, test } from 'bun:test';
import type { Response } from '#http.js';
import { PermissionFlag } from '#permissions.js';
import { setSessionCookie } from '#session.js';
import { buildTestServer } from '#testServer.js';

function createSessionCookie(userId: string, permissions: bigint): string {
  let cookieHeader = '';
  const response = { setHeader: (_name: string, value: string) => { cookieHeader = value; } } as unknown as Response;
  setSessionCookie(response, { sub: userId, permissions });
  return cookieHeader.split(';', 1)[0]!;
}

test('worker status and drain controls require device management permission', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  const viewerCookie = createSessionCookie('root', 0n);
  const managerCookie = createSessionCookie('root', PermissionFlag.manageDevices);

  try {
    const denied = await server.inject({ method: 'GET', url: '/v1/dashboard/workers', headers: { cookie: viewerCookie } });
    expect(denied.statusCode).toBe(403);

    const status = await server.inject({ method: 'GET', url: '/v1/dashboard/workers', headers: { cookie: managerCookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      currentWorkerId: expect.any(String),
      configurationConsistent: true,
      workers: expect.arrayContaining([expect.objectContaining({ state: 'active', configuration: expect.any(Object) })]),
      capacity: expect.objectContaining({ queuedJobs: expect.any(Number), runningJobs: expect.any(Number) }),
    });

    const workerId = status.json().currentWorkerId as string;
    const drained = await server.inject({
      method: 'POST',
      url: `/v1/dashboard/workers/${encodeURIComponent(workerId)}/drain`,
      headers: { cookie: managerCookie },
      payload: { draining: true },
    });
    expect(drained.statusCode).toBe(200);
    expect(drained.json().workers).toContainEqual(expect.objectContaining({ workerId, state: 'drained' }));

    const resumed = await server.inject({
      method: 'POST',
      url: `/v1/dashboard/workers/${encodeURIComponent(workerId)}/drain`,
      headers: { cookie: managerCookie },
      payload: { draining: false },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().workers).toContainEqual(expect.objectContaining({ workerId, state: 'active' }));
  } finally {
    await server.close();
  }
});
