import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { dashboardDiagnosticsRoutes } from '#routes/dashboardDiagnosticsRoutes.js';
import { PermissionFlag } from '#permissions.js';
import { setSessionCookie } from '#session.js';
import type { Response } from '#http.js';

function cookie(permissions: bigint): string {
  let value = '';
  const response = { setHeader: (_name: string, header: string) => { value = header; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions });
  return value.split(';', 1)[0]!;
}

test('self-hosting browser check requires device management and exposes no credential material', async () => {
  const server = Fastify({ trustProxy: 'loopback' }).withTypeProvider<TypeBoxTypeProvider>();
  await server.register(dashboardDiagnosticsRoutes);
  try {
    const denied = await server.inject({ method: 'GET', url: '/v1/dashboard/browser-check', headers: { cookie: cookie(PermissionFlag.viewDevices), host: 'ipa.example.test' } });
    const allowed = await server.inject({ method: 'GET', url: '/v1/dashboard/browser-check', headers: { cookie: cookie(PermissionFlag.manageDevices), host: 'ipa.example.test' } });
    expect(denied.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ cookieSessionValid: true, observedOrigin: 'http://ipa.example.test', oauthCallbacks: { github: expect.any(String), discord: expect.any(String), apple: 'Not configured' } });
    expect(allowed.body).not.toMatch(/sessionSigningSecret|clientSecret|set-cookie|authorization/i);
  } finally {
    await server.close();
  }
});
