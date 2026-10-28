import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { DashboardDoctorRoute, DashboardSyntheticRoute } from '#dashboardDiagnosticsContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { getDeploymentMetadata } from '#deployment.js';
import { runConfigurationDoctor } from '#doctor.js';
import { PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession } from '#session.js';
import { getRouteContract } from '#contracts.js';
import { runSyntheticProbes } from '#synthetic.js';
import { getCompatibilityMatrix } from '#compatibility.js';
import { config, appleOauthEnabled, discordOauthEnabled, githubOauthEnabled } from '#config.js';

const canManageDevices = fastifyRequirePermission(PermissionFlag.manageDevices);

export const dashboardDiagnosticsRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get<DashboardDoctorRoute>('/v1/dashboard/doctor', {
    schema: getRouteContract('GET', '/v1/dashboard/doctor'),
    preHandler: canManageDevices,
  }, async () => ({ ...await runConfigurationDoctor(), deployment: getDeploymentMetadata() }));

  server.get<DashboardSyntheticRoute>('/v1/dashboard/synthetic', {
    schema: getRouteContract('GET', '/v1/dashboard/synthetic'),
    preHandler: canManageDevices,
  }, async () => runSyntheticProbes());

  server.get('/v1/dashboard/browser-check', {
    schema: { hide: true },
    preHandler: canManageDevices,
  }, (request) => {
    let expectedOrigin: string | null = null;
    try {
      expectedOrigin = new URL(config.publicBaseUrl).origin;
    } catch {}
    const callbackBase = expectedOrigin ?? '';
    return {
      cookieSessionValid: true,
      expectedOrigin,
      observedOrigin: `${request.protocol}://${request.host}`,
      forwardedHeadersPresent: Boolean(request.headers['x-forwarded-host'] || request.headers['x-forwarded-proto']),
      oauthCallbacks: {
        github: githubOauthEnabled ? `${callbackBase}/v1/auth/github/callback` : 'Not configured',
        discord: discordOauthEnabled ? `${callbackBase}/v1/auth/discord/callback` : 'Not configured',
        apple: appleOauthEnabled ? `${callbackBase}/v1/auth/apple/callback` : 'Not configured',
      },
    };
  });

  server.get('/v1/dashboard/compatibility', {
    schema: { hide: true, response: { 200: Type.Object({ policy: Type.Object({ sqliteSchema: Type.Number(), rustBridge: Type.String(), autoinstallMinimum: Type.String(), autoinstallMajor: Type.Number() }), rows: Type.Array(Type.Object({ component: Type.String(), observed: Type.String(), supported: Type.String(), state: Type.Union([Type.Literal('supported'), Type.Literal('unsupported'), Type.Literal('unknown')]), detail: Type.Optional(Type.String()) })) }) } },
    preHandler: fastifyRequirePermission(PermissionFlag.administrator),
  }, async () => getCompatibilityMatrix());
};
