import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { PermissionFlag } from '#permissions.js';
import { setSessionCookie } from '#session.js';
import type { Response } from '#http.js';
import { createDashboardIncidentRoutes } from '#routes/dashboardIncidentRoutes.js';
import { openIncident, updateOperationalIncident } from '#store/incidentRepository.js';
import { randomUUID } from 'node:crypto';

function sessionCookie(permissions: bigint): string {
  let value = '';
  const response = { setHeader: (_name: string, cookie: string) => { value = cookie; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions });
  return value.split(';', 1)[0]!;
}

test('incident timeline merges authorized jobs, device history, and deployment outcomes across dkrypt', async () => {
  const now = Date.now();
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardIncidentRoutes({
    getEffectiveDevices: () => [{ id: 'device-1', name: 'Test iPad' } as never],
    getDeviceActivityPage: () => ({ entries: [{ id: 'health-1', ts: now - 3000, deviceId: 'device-1', kind: 'health', message: 'Agent recovered' }], total: 1 }),
    getAllJobHistory: () => [{
      id: 'job-1',
      projectId: 'project-a',
      bundleId: 'com.example.app',
      status: 'done',
      source: 'manual',
      createdAt: now - 5000,
      finishedAt: now - 1000,
      timeline: [{ at: now - 4000, label: 'Started', status: 'running' }, { at: now - 1000, label: 'Finished', status: 'done' }],
    }] as never,
    getActiveJobs: () => [],
    getRecentLogs: () => ({ logs: [{ id: 'deploy-log', ts: now - 500, level: 'info', scope: 'deployment', message: 'Deployment health passed', meta: { deploymentId: 'deploy-1', projectId: 'project-a' } }], total: 1 }),
    listNotifications: () => ({ notifications: [{ id: 'deploy-ready', userId: 'incident-user', title: 'Deployment is live', message: 'Build abc is serving traffic.', severity: 'success', createdAt: now - 250, deploymentId: 'deploy-1' }], unread: 0 }),
  }));

  try {
    const response = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/incidents?since=${now - 10000}`,
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt | PermissionFlag.viewDevices | PermissionFlag.viewLogs) },
    });
    const denied = await server.inject({ method: 'GET', url: '/v1/dashboard/incidents', headers: { cookie: sessionCookie(0n) } });
    const defaultProject = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/incidents?since=${now - 10000}`,
      headers: { cookie: sessionCookie(PermissionFlag.viewDevices) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().events.map((event: { kind: string }) => event.kind)).toEqual(['deployment', 'deployment', 'job', 'device', 'job']);
    expect(response.json().events.some((event: { jobId?: string }) => event.jobId === 'job-1')).toBe(true);
    expect(response.json().events.some((event: { deviceId?: string }) => event.deviceId)).toBe(true);
    expect(defaultProject.statusCode).toBe(200);
    expect(defaultProject.json().events.some((event: { kind: string }) => event.kind === 'device')).toBe(true);
    expect(denied.statusCode).toBe(403);
  } finally {
    await server.close();
  }
});

test('member incident timelines include only their own job history', async () => {
  const now = Date.now();
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardIncidentRoutes({
    getEffectiveDevices: () => [],
    getDeviceActivityPage: () => ({ entries: [], total: 0 }),
    getAllJobHistory: () => [
      { id: 'member-job', bundleId: 'com.example.member', queuedBy: 'root', status: 'done', source: 'manual', createdAt: now - 100, finishedAt: now - 50, timeline: [{ at: now - 50, label: 'Finished', status: 'done' }] },
      { id: 'other-job', bundleId: 'com.example.other', queuedBy: 'another-user', status: 'done', source: 'manual', createdAt: now - 100, finishedAt: now - 50, timeline: [{ at: now - 50, label: 'Finished', status: 'done' }] },
    ] as never,
    getActiveJobs: () => [
      { id: 'member-active', bundleId: 'com.example.active', billingOwnerId: 'root', status: 'running', source: 'manual', createdAt: now - 100, timeline: [{ at: now - 20, label: 'Started', status: 'running' }] },
      { id: 'other-active', bundleId: 'com.example.active', billingOwnerId: 'another-user', status: 'running', source: 'manual', createdAt: now - 100, timeline: [{ at: now - 20, label: 'Started', status: 'running' }] },
    ] as never,
    getRecentLogs: () => ({ logs: [], total: 0 }),
    listNotifications: () => ({ notifications: [], unread: 0 }),
  }));

  try {
    const response = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/incidents?since=${now - 1000}`,
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().events.map((event: { jobId: string }) => event.jobId).filter(Boolean).sort()).toEqual(['member-active', 'member-job']);
  } finally {
    await server.close();
  }
});

test('Action Center separates view and management permissions and includes the shared workspace', async () => {
  const incident = openIncident({ projectId: 'default', sourceKey: `job:${randomUUID()}`, sourceId: randomUUID(), kind: 'job', title: 'Decrypt failed', detail: 'com.example.app' });
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardIncidentRoutes({
  }));
  try {
    const url = '/v1/dashboard/action-center';
    const denied = await server.inject({ method: 'GET', url, headers: { cookie: sessionCookie(PermissionFlag.viewLogs) } });
    expect(denied.statusCode).toBe(403);
    const visible = await server.inject({ method: 'GET', url, headers: { cookie: sessionCookie(PermissionFlag.viewIncidents) } });
    expect(visible.statusCode).toBe(200);
    expect(visible.json().incidents.some((entry: { id: string }) => entry.id === incident.id)).toBe(true);
    const globallyVisible = await server.inject({ method: 'GET', url, headers: { cookie: sessionCookie(PermissionFlag.viewIncidents) } });
    expect(globallyVisible.statusCode).toBe(200);
    expect(globallyVisible.json().incidents.some((entry: { id: string }) => entry.id === incident.id)).toBe(true);
    const readonlyChange = await server.inject({ method: 'PATCH', url: `${url}/${incident.id}`, headers: { cookie: sessionCookie(PermissionFlag.viewIncidents) }, payload: { status: 'in_progress' } });
    expect(readonlyChange.statusCode).toBe(403);
    const managed = await server.inject({ method: 'PATCH', url: `${url}/${incident.id}`, headers: { cookie: sessionCookie(PermissionFlag.manageIncidents) }, payload: { status: 'resolved', resolutionNote: 'Verified recovery' } });
    expect(managed.statusCode).toBe(200);
    expect(managed.json().incident.status).toBe('resolved');
  } finally {
    await server.close();
  }
});

test('incident state at a time uses recorded transitions and labels earlier history incomplete', async () => {
  const incident = openIncident({ projectId: 'default', sourceKey: `job:${randomUUID()}`, sourceId: randomUUID(), kind: 'job', title: 'Decrypt failed', detail: 'com.example.app' });
  await Bun.sleep(5);
  updateOperationalIncident(incident.id, 'default', 'operator', { status: 'resolved', resolutionNote: 'Retried successfully' });
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardIncidentRoutes());
  try {
    const base = '/v1/dashboard/incidents/state-at?';
    const headers = { cookie: sessionCookie(PermissionFlag.viewIncidents) };
    const before = await server.inject({ method: 'GET', url: `${base}at=0`, headers });
    const opened = await server.inject({ method: 'GET', url: `${base}at=${incident.createdAt}`, headers });
    const resolved = await server.inject({ method: 'GET', url: `${base}at=${Date.now()}`, headers });
    const denied = await server.inject({ method: 'GET', url: `${base}at=${Date.now()}`, headers: { cookie: sessionCookie(PermissionFlag.viewLogs) } });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ coverage: 'incomplete', incidents: [] });
    expect(opened.json().coverage).toBe('recorded');
    expect(opened.json().incidents.find((entry: { id: string }) => entry.id === incident.id)).toMatchObject({ status: 'open' });
    expect(resolved.json().incidents.find((entry: { id: string }) => entry.id === incident.id)).toMatchObject({ status: 'resolved' });
    expect(denied.statusCode).toBe(403);
  } finally {
    await server.close();
  }
});
