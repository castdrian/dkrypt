import { expect, test } from 'bun:test';
import { buildTestServer } from '#testServer.js';
import { getRouteContracts, JobTimelineResponse } from '#contracts.js';
import { Value } from '@sinclair/typebox/value';
import {
  dashboardJobDiagnosticResponseSchema,
  dashboardJobExportEntrySchema,
  dashboardJobHistoryPageSchema,
} from '#dashboardJobContracts.js';

test('every registered versioned route has an explicit TypeBox contract', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as { paths?: Record<string, Record<string, unknown>> };
    const routes = Object.entries(document.paths ?? {}).flatMap(([path, methods]) =>
      Object.keys(methods)
        .filter((method) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
        .map((method) => `${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ':$1')}`),
    ).filter((route) => route.includes('/v1/'));
    const contracts = getRouteContracts();
    const hiddenRoutes = [
      ['GET', '/v1/dashboard/jobs/:id/resolution-notice'],
      ['POST', '/v1/dashboard/jobs/:id/resolution-notice'],
      ['GET', '/v1/dashboard/artifacts/:id/contents'],
    ] as const;
    expect(routes.length + hiddenRoutes.length).toBe(contracts.size);
    for (const route of routes) expect(contracts.has(route)).toBe(true);
    for (const [method, url] of hiddenRoutes) {
      expect(contracts.has(`${method} ${url}`)).toBe(true);
      expect(server.hasRoute({ method, url })).toBe(true);
    }
  } finally {
    await server.close();
  }
});

test('every versioned route is represented in generated OpenAPI', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as { paths?: Record<string, Record<string, unknown>> };
    const paths = Object.entries(document.paths ?? {}).filter(([path]) => path.startsWith('/v1/'));
    expect(paths.length).toBeGreaterThan(100);
    for (const [, methods] of paths) {
      expect(Object.keys(methods).length).toBeGreaterThan(0);
      for (const [method, operation] of Object.entries(methods)) {
        const value = operation as { responses?: Record<string, unknown>; requestBody?: { content?: Record<string, { schema?: unknown }> } };
        expect(Object.keys(value.responses ?? {}).length).toBeGreaterThan(0);
        if (method !== 'get' && method !== 'delete' && value.requestBody) {
          const schema = value.requestBody?.content?.['application/json']?.schema;
          expect(schema).toBeDefined();
        }
      }
    }
  } finally {
    await server.close();
  }
});

test('retired project, app-watch, and GitHub browsing endpoints are absent from dashboard OpenAPI', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as { paths?: Record<string, unknown> };
    for (const path of [
      '/v1/dashboard/github/rate-limit',
      '/v1/dashboard/github/repos',
      '/v1/dashboard/github/workflows',
      '/v1/dashboard/projects',
      '/v1/dashboard/projects/members',
      '/v1/dashboard/projects/{id}',
      '/v1/dashboard/watches',
      '/v1/dashboard/watches/calendar',
    ]) expect(document.paths?.[path]).toBeUndefined();
  } finally {
    await server.close();
  }
});

test('idempotency header contracts match their endpoint validators', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as {
      paths?: Record<string, Record<string, { parameters?: Array<{ in?: string; name?: string; schema?: { pattern?: string } }> }>>;
    };
    const assertions: Array<[string, string, string]> = [
      ['/v1/decrypt', 'get', '^[A-Za-z0-9._:-]+$'],
      ['/v1/decrypts', 'post', '^[A-Za-z0-9._:-]+$'],
      ['/v1/testflight/decrypt', 'post', '^[A-Za-z0-9._:-]+$'],
      ['/v1/billing/checkout', 'post', '^[A-Za-z0-9._~-]+$'],
      ['/v1/billing/cancel', 'post', '^[A-Za-z0-9._~-]+$'],
    ];
    for (const [path, method, pattern] of assertions) {
      const parameters = document.paths?.[path]?.[method]?.parameters ?? [];
      const keyHeader = parameters.find((parameter) => parameter.in === 'header' && parameter.name === 'idempotency-key');
      expect(keyHeader).toBeDefined();
      expect(keyHeader?.schema?.pattern).toBe(pattern);
    }
  } finally {
    await server.close();
  }
});

test('job history, exports, and diagnostics expose structured queue failure details', () => {
  const id = crypto.randomUUID();
  const historyEntry = {
    id,
    bundleId: 'com.example.app',
    status: 'failed',
    source: 'scheduler',
    createdAt: 1,
    finishedAt: 2,
    failureClass: 'queue',
    queueReason: 'Waiting for an enabled device',
    fileAvailable: false,
  };
  const exportEntry = {
    id,
    bundleId: 'com.example.app',
    status: 'failed',
    source: 'scheduler',
    createdAt: 1,
    finishedAt: 2,
    failureClass: 'queue',
    queueReason: 'Waiting for an enabled device',
  };
  const diagnostic = {
    generatedAt: new Date(2).toISOString(),
    correlationId: id,
    job: {
      id,
      bundleId: 'com.example.app',
      status: 'failed',
      source: 'scheduler',
      createdAt: 1,
      queueReason: 'Waiting for an enabled device',
      failureClass: 'queue',
    },
    timeline: [],
  };

  expect(Value.Check(dashboardJobHistoryPageSchema, { history: [historyEntry], total: 1 })).toBe(true);
  expect(Value.Check(dashboardJobExportEntrySchema, exportEntry)).toBe(true);
  expect(Value.Check(dashboardJobDiagnosticResponseSchema, diagnostic)).toBe(true);
  expect(Object.keys(dashboardJobHistoryPageSchema.properties.history.items.properties)).toContain('queueReason');
  expect(Object.keys(dashboardJobExportEntrySchema.properties)).toContain('queueReason');
  expect(Object.keys(dashboardJobDiagnosticResponseSchema.properties.job.properties)).toContain('queueReason');
  expect(Object.keys(JobTimelineResponse.properties)).toContain('queueReason');
  expect(Object.keys(JobTimelineResponse.properties)).toContain('executionStage');
  expect(Value.Check(dashboardJobHistoryPageSchema, {
    history: [{ ...historyEntry, failureClass: 'not-a-job-failure-class' }],
    total: 1,
  })).toBe(false);
});

test('dashboard overview does not expose project identifiers', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as {
      paths?: Record<string, Record<string, { parameters?: Array<{ name?: string; in?: string; schema?: { pattern?: string; minLength?: number; maxLength?: number } }> }>>;
    };
    const projectId = document.paths?.['/v1/dashboard/overview']?.get?.parameters?.find((parameter) => parameter.name === 'projectId' && parameter.in === 'query');
    expect(projectId).toBeUndefined();
  } finally {
    await server.close();
  }
});

test('core operational responses publish their required fields', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as {
      paths?: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown>; items?: { properties?: Record<string, unknown> } } }> }> }>>;
    };
    const assertions: Array<[string, string, string[]]> = [
      ['/v1/health', 'get', ['ok', 'serviceReady', 'deployment', 'database', 'bridge', 'device']],
      ['/v1/status', 'get', ['status', 'checkedAt', 'deployment', 'components']],
      ['/v1/billing', 'get', ['enabled', 'provider', 'plans', 'providers', 'entitlement']],
      ['/v1/dashboard/overview', 'get', ['devices', 'deviceStatus', 'activeJobs']],
      ['/v1/dashboard/jobs', 'get', ['history', 'total', 'nextCursor']],
      ['/v1/dashboard/artifacts', 'get', ['artifacts', 'total', 'totalBytes', 'maxBytes']],
      ['/v1/dashboard/artifacts/bulk-pin', 'post', ['ok', 'pinned', 'changedIds', 'artifacts']],
      ['/v1/dashboard/artifacts/bulk-archive', 'post', ['ok', 'archived', 'changedIds', 'artifacts']],
      ['/v1/dashboard/devices', 'get', ['devices']],
      ['/v1/dashboard/testflight/catalog', 'get', ['apps', 'refreshing']],
      ['/v1/dashboard/search', 'get', ['results']],
      ['/v1/dashboard/testflight/subscriptions', 'get', ['subscriptions', 'total', 'nextCursor']],
      ['/v1/dashboard/decrypt/preflight', 'post', ['bundleId', 'testflight', 'queueLength', 'canQueue', 'devices']],
      ['/v1/dashboard/versions/{bundleId}', 'get', ['versions']],
      ['/v1/dashboard/devices/{id}/inventory', 'get', ['deviceId', 'bundles']],
      ['/v1/dashboard/devices/{id}/dark-mode', 'put', ['reachable', 'checkedAt']],
      ['/v1/dashboard/devices/{id}/bridge-action', 'post', ['result']],
      ['/v1/dashboard/jobs/bulk-preview', 'post', ['requested', 'eligible', 'projectedQueueAdds', 'items']],
      ['/v1/dashboard/jobs/stats/{bundleId}', 'get', ['bundleId', 'totalRuns', 'successRate', 'failureBreakdown']],
      ['/v1/dashboard/jobs/diff', 'get', ['a', 'b', 'sizeDeltaBytes', 'plistDiff']],
      ['/v1/dashboard/insights', 'get', ['totalRuns', 'topApps', 'trend', 'byDevice', 'anomalies']],
      ['/v1/dashboard/failure-patterns', 'get', ['patterns']],
      ['/v1/dashboard/storage-forecast', 'get', ['freeBytes', 'bytesPerDay', 'daysRemaining', 'sampleCount']],
      ['/v1/dashboard/apps/metadata', 'get', ['entries']],
      ['/v1/dashboard/apps/cache', 'get', ['entries', 'icons']],
      ['/v1/dashboard/settings/artifact-storage', 'get', ['count', 'usedBytes', 'maxBytes']],
      ['/v1/dashboard/settings/job-history-retention/preview', 'get', ['retentionDays', 'currentEntries', 'retained', 'removed', 'agePruned', 'capacityPruned', 'afterNextWrite', 'maxEntries', 'artifacts']],
      ['/v1/dashboard/artifacts/retention-preview', 'get', ['targetMaxBytes', 'currentBytes', 'retainedBytes', 'evictedCount', 'evictionExamples']],
      ['/v1/auth/session', 'get', ['loggedIn', 'identities', 'linkedProviders', 'publicBaseUrl', 'deployment', 'mfa']],
      ['/v1/auth/mfa/verify', 'post', ['ok', 'expiresAt']],
      ['/v1/auth/reauthenticate', 'post', ['ok', 'expiresAt']],
      ['/v1/auth/passkeys', 'get', ['passkeys']],
      ['/v1/auth/passkeys/options', 'post', ['challenge']],
      ['/v1/auth/passkeys/reauth/options', 'post', ['challenge']],
      ['/v1/auth/profile', 'patch', ['username', 'displayName', 'linkedProviders']],
      ['/v1/auth/connections/{provider}', 'delete', ['identities', 'linkedProviders']],
      ['/v1/billing/provider-status', 'get', ['stripe', 'crypto']],
      ['/v1/billing/webhooks/inbox', 'get', ['inbox', 'total', 'nextCursor']],
      ['/v1/dashboard/doctor', 'get', ['ok', 'checkedAt', 'deployment', 'checks']],
      ['/v1/dashboard/synthetic', 'get', ['ok', 'checkedAt', 'probes']],
      ['/v1/dashboard/notifications', 'get', ['notifications', 'unread', 'total', 'nextCursor']],
      ['/v1/dashboard/devices/discover', 'get', ['devices', 'scannedNetworks', 'warnings']],
      ['/v1/dashboard/jobs/slo', 'get', ['targetMs', 'historicalP95Ms', 'jobs']],
      ['/v1/decrypts', 'post', ['id', 'bundleId', 'channel', 'status', 'statusUrl', 'selector', 'resolvedVersion', 'artifact']],
      ['/v1/artifacts', 'get', ['artifacts', 'total', 'totalBytes', 'maxBytes', 'nextCursor']],
      ['/v1/artifacts/{id}', 'get', ['id', 'bundleId', 'channel', 'sizeBytes', 'sha256', 'fileUrl']],
      ['/v1/jobs/{id}', 'get', ['id', 'bundleId', 'channel', 'status', 'statusUrl']],
      ['/v1/testflight/{appId}/trains', 'get', ['trains']],
      ['/v1/testflight/{appId}/builds', 'get', ['builds']],
      ['/v1/dashboard/testflight/{appId}/trains', 'get', ['trains']],
      ['/v1/dashboard/testflight/{appId}/builds', 'get', ['builds']],
      ['/v1/billing/checkout', 'post', ['url']],
      ['/v1/billing/cancel', 'post', ['success', 'status', 'provider']],
      ['/v1/dashboard/settings', 'get', ['notifyFormat', 'notifySuccessMode', 'maintenanceMode']],
      ['/v1/dashboard/users', 'get', ['users']],
      ['/v1/dashboard/audit-log', 'get', ['entries', 'total', 'nextCursor']],
      ['/v1/dashboard/roles', 'get', ['roles']],
      ['/v1/dashboard/keys/all', 'get', ['keys', 'total', 'nextCursor']],
      ['/v1/dashboard/backup/schedule', 'get', ['enabled', 'cron', 'retentionCount']],
      ['/v1/dashboard/backup/history', 'get', ['id', 'createdAt', 'filename', 'trigger']],
    ];
    for (const [path, method, fields] of assertions) {
      const schema = document.paths?.[path]?.[method]?.responses?.['200']?.content?.['application/json']?.schema;
      expect(schema).toBeDefined();
      const properties = schema?.properties ?? schema?.items?.properties ?? {};
      for (const field of fields) expect(Object.keys(properties)).toContain(field);
    }
    const billingStatus = document.paths?.['/v1/billing/provider-status']?.get?.responses?.['200']?.content?.['application/json']?.schema;
    const stripeProperties = (billingStatus?.properties?.stripe as { properties?: Record<string, { properties?: Record<string, unknown> }> } | undefined)?.properties;
    const webhookProperties = stripeProperties?.webhook?.properties;
    for (const field of ['state', 'endpointUrl', 'requiredEvents', 'missingEvents', 'checkedAt']) expect(Object.keys(webhookProperties ?? {})).toContain(field);
    const healthDevice = document.paths?.['/v1/health']?.get?.responses?.['200']?.content?.['application/json']?.schema?.properties?.device as { properties?: Record<string, unknown> } | undefined;
    for (const field of ['transportState', 'capabilities', 'recoveryState', 'subsystems', 'bridgeHeartbeats']) expect(Object.keys(healthDevice?.properties ?? {})).toContain(field);
    const healthHeartbeats = healthDevice?.properties?.bridgeHeartbeats as { properties?: Record<string, unknown> } | undefined;
    expect(Object.keys(healthHeartbeats?.properties ?? {})).toEqual(expect.arrayContaining(['springboard', 'testflight', 'appstore']));
  } finally {
    await server.close();
  }
});

test('dashboard job contracts describe history and transport fields', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as {
      paths?: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, { items?: { properties?: Record<string, unknown> }; properties?: Record<string, unknown> }> } }> }> }>>;
    };
    const historySchema = document.paths?.['/v1/dashboard/jobs']?.get?.responses?.['200']?.content?.['application/json']?.schema;
    const historyFields = historySchema?.properties?.history?.items?.properties ?? {};
    for (const field of ['id', 'bundleId', 'status', 'createdAt', 'deviceId', 'transport', 'requester', 'fileAvailable']) {
      expect(Object.keys(historyFields)).toContain(field);
    }
    const overviewSchema = document.paths?.['/v1/dashboard/overview']?.get?.responses?.['200']?.content?.['application/json']?.schema;
    const activeJobFields = overviewSchema?.properties?.activeJobs?.items?.properties ?? {};
    for (const field of ['id', 'bundleId', 'status', 'deviceId', 'preferredDeviceId', 'transport', 'attempt', 'deadlineAt', 'warnings']) {
      expect(Object.keys(activeJobFields)).toContain(field);
    }
    const activeQueueFields = (activeJobFields.queue as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    for (const field of ['position', 'total', 'predictedStartMs', 'predictedCompletionMs']) {
      expect(Object.keys(activeQueueFields)).toContain(field);
    }
    for (const [path, fields] of [
      ['/v1/dashboard/jobs/{id}/status', ['attempt', 'deadlineAt', 'deviceId', 'preferredDeviceId', 'transport', 'warnings']],
    ['/v1/dashboard/jobs/{id}/timeline', ['deviceId', 'transport', 'queueReason']],
    ] as const) {
      const schema = document.paths?.[path]?.get?.responses?.['200']?.content?.['application/json']?.schema;
      for (const field of fields) expect(Object.keys(schema?.properties ?? {})).toContain(field);
    }
    const jobStatusSchema = document.paths?.['/v1/dashboard/jobs/{id}/status']?.get?.responses?.['200']?.content?.['application/json']?.schema;
    const jobQueueFields = jobStatusSchema?.properties?.queue?.properties ?? {};
    for (const field of ['position', 'total', 'predictedStartMs', 'predictedCompletionMs']) {
      expect(Object.keys(jobQueueFields)).toContain(field);
    }
    const timelineSchema = document.paths?.['/v1/dashboard/jobs/{id}/timeline']?.get?.responses?.['200']?.content?.['application/json']?.schema;
    const eventSchema = timelineSchema?.properties?.events as { items?: { properties?: Record<string, unknown> } } | undefined;
    for (const field of ['at', 'label', 'status']) expect(Object.keys(eventSchema?.items?.properties ?? {})).toContain(field);
  } finally {
    await server.close();
  }
});

test('public and dashboard job responses document queue failure classification', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as {
      paths?: Record<string, Record<string, {
        responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }>;
      }>>;
    };
    const paths = ['/v1/jobs/{id}', '/v1/dashboard/jobs/{id}/status'];
    for (const path of paths) {
      const property = document.paths?.[path]?.get?.responses?.['200']?.content?.['application/json']?.schema?.properties?.failureClass as {
        anyOf?: Array<{ enum?: string[] }>;
      } | undefined;
      expect(property?.anyOf?.flatMap((variant) => variant.enum ?? [])).toContain('queue');
    }
  } finally {
    await server.close();
  }
});

test('dashboard overview publishes typed nested dashboard records', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    type Schema = { properties?: Record<string, Schema>; items?: Schema; pattern?: string; minLength?: number; maxLength?: number };
    const document = server.swagger() as {
      paths?: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: Schema }> }> }>>;
    };
    const properties = document.paths?.['/v1/dashboard/overview']?.get?.responses?.['200']?.content?.['application/json']?.schema?.properties ?? {};
    const settings = Object.keys(properties.settings?.properties ?? {});
    expect(settings).toEqual(expect.arrayContaining(['notifyFormat', 'notifyWebhookUrl', 'maintenanceMode', 'jobHistoryRetentionDays']));

    expect(properties).not.toHaveProperty('watches');
    expect(properties).not.toHaveProperty('schedulerRunHistory');

    const device = properties.devices?.items?.properties ?? {};
    expect(Object.keys(device)).toEqual(expect.arrayContaining(['id', 'transportState', 'transportCapabilities', 'setupRequired', 'recoveryState']));
    expect(device.bridgeHeartbeats).toBeDefined();
    expect(Object.keys(device.bridgeHeartbeats?.properties?.springboard?.properties ?? {})).toEqual(expect.arrayContaining(['at', 'bridgeVersion', 'channel', 'process']));
    expect(device).not.toHaveProperty('keyPath');

    expect(Object.keys(properties.maintenance?.properties ?? {})).toEqual(expect.arrayContaining(['active', 'manual', 'auto', 'reason']));
    expect(Object.keys(properties.disk?.properties ?? {})).toEqual(expect.arrayContaining(['totalBytes', 'freeBytes', 'usedBytes', 'usedPercent']));
  } finally {
    await server.close();
  }
});

test('device route contracts describe subsystem history and query bounds', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as {
      paths?: Record<string, Record<string, {
        parameters?: Array<{ name?: string; in?: string; schema?: { minimum?: number; maximum?: number } }>;
        responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, { items?: { properties?: Record<string, unknown> } }> } }> }>;
      }>>;
    };
    const history = document.paths?.['/v1/dashboard/devices/{id}/battery-history']?.get;
    const hours = history?.parameters?.find((parameter) => parameter.name === 'hours' && parameter.in === 'query');
    expect(hours?.schema?.minimum).toBe(1);
    expect(hours?.schema?.maximum).toBe(168);
    const bucketFields = history?.responses?.['200']?.content?.['application/json']?.schema?.properties?.buckets?.items?.properties ?? {};
    expect(Object.keys(bucketFields)).toEqual(expect.arrayContaining(['hourStart', 'batteryPercent']));

    const activity = document.paths?.['/v1/dashboard/devices/{id}/activity']?.get?.responses?.['200']?.content?.['application/json']?.schema;
    const activityFields = activity?.properties?.activity?.items?.properties ?? {};
    expect(Object.keys(activityFields)).toEqual(expect.arrayContaining(['id', 'ts', 'deviceId', 'kind', 'message']));
  } finally {
    await server.close();
  }
});

test('device operation contracts publish typed health, inventory, bridge, and recovery responses', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    type Schema = { properties?: Record<string, Schema>; items?: Schema; type?: string; minimum?: number; maximum?: number };
    const document = server.swagger() as {
      paths?: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: Schema }> }> }>>;
    };
    const paths = document.paths ?? {};
    const health = paths['/v1/dashboard/devices/{id}/health']?.get?.responses?.['200']?.content?.['application/json']?.schema?.properties ?? {};
    expect(health.checkedAt).toMatchObject({ type: 'number' });
    expect(health.bridgeHeartbeats?.properties?.springboard).toBeDefined();

    const preflight = paths['/v1/dashboard/devices/{id}/preflight']?.get?.responses?.['200']?.content?.['application/json']?.schema?.properties ?? {};
    expect(Object.keys(preflight)).toEqual(expect.arrayContaining(['device', 'health', 'bridge', 'checks', 'ready']));
    expect(preflight.checks?.items?.properties?.label).toMatchObject({ type: 'string' });
    expect(preflight.checks?.items?.properties?.ok).toMatchObject({ type: 'boolean' });

    const inventory = paths['/v1/dashboard/devices/{id}/inventory']?.get?.responses?.['200']?.content?.['application/json']?.schema?.properties ?? {};
    expect(inventory.bundles?.items).toMatchObject({ type: 'string' });

    const recovery = paths['/v1/dashboard/devices/{id}/recover']?.post?.responses?.['200']?.content?.['application/json']?.schema?.properties ?? {};
    expect(recovery.ok).toMatchObject({ enum: [true], type: 'boolean' });
  } finally {
    await server.close();
  }
});

test('observability contracts publish typed log and audit entry fields', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as {
      paths?: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, { items?: { properties?: Record<string, unknown> } }> } }> }> }>>;
    };
    const logSchema = document.paths?.['/v1/dashboard/logs']?.get?.responses?.['200']?.content?.['application/json']?.schema;
    const logFields = logSchema?.properties?.logs?.items?.properties ?? {};
    expect(Object.keys(logFields)).toEqual(expect.arrayContaining(['id', 'ts', 'level', 'scope', 'message', 'meta']));

    const auditSchema = document.paths?.['/v1/dashboard/audit-log']?.get?.responses?.['200']?.content?.['application/json']?.schema;
    const auditFields = auditSchema?.properties?.entries?.items?.properties ?? {};
    expect(Object.keys(auditFields)).toEqual(expect.arrayContaining(['id', 'ts', 'actor', 'action', 'target', 'detail']));
  } finally {
    await server.close();
  }
});

test('device and TestFlight mutation contracts publish their success status', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as {
      paths?: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }> }>>;
    };
    const assertions: Array<[string, string, string, string[]]> = [
      ['/v1/dashboard/testflight/subscriptions', 'post', '201', ['subscription']],
      ['/v1/dashboard/testflight/subscriptions/{id}/approve', 'post', '202', ['subscription']],
      ['/v1/dashboard/testflight/subscriptions/{id}/deny', 'post', '200', ['subscription']],
      ['/v1/dashboard/testflight/subscriptions/{id}/sync', 'post', '202', ['subscription']],
      ['/v1/dashboard/testflight/subscriptions/{id}/unsubscribe', 'post', '202', ['subscription']],
      ['/v1/dashboard/devices/setup', 'post', '201', ['device', 'setup']],
      ['/v1/dashboard/devices', 'post', '201', ['id', 'name', 'enabled', 'transport']],
      ['/v1/dashboard/devices/{id}', 'patch', '200', ['id', 'name', 'enabled', 'transport']],
      ['/v1/dashboard/devices/{id}/recover', 'post', '200', ['ok']],
      ['/v1/auth/login', 'post', '200', ['ok']],
      ['/v1/auth/logout', 'post', '200', ['ok']],
      ['/v1/auth/logout-everywhere', 'post', '200', ['ok']],
      ['/v1/auth/sessions/{id}', 'delete', '200', ['ok']],
      ['/v1/auth/sessions/revoke-others', 'post', '200', ['ok', 'revoked']],
      ['/v1/auth/passkeys/register', 'post', '201', ['passkey']],
      ['/v1/auth/passkeys/{id}', 'delete', '200', ['ok']],
      ['/v1/auth/passkeys/verify', 'post', '200', ['ok', 'expiresAt']],
      ['/v1/auth/passkeys/reauth/verify', 'post', '200', ['ok', 'expiresAt']],
      ['/v1/auth/privacy/delete', 'post', '200', ['ok']],
      ['/v1/dashboard/notifications/read', 'post', '200', ['ok', 'marked']],
      ['/v1/dashboard/jobs/{id}/cancel', 'post', '200', ['ok']],
      ['/v1/dashboard/jobs/{id}/prioritize', 'post', '200', ['ok']],
      ['/v1/dashboard/jobs/{id}/retry', 'post', '202', ['id', 'bundleId', 'status', 'statusUrl']],
      ['/v1/dashboard/jobs/reorder', 'post', '200', ['ok']],
    ];
    for (const [path, method, status, fields] of assertions) {
      const schema = document.paths?.[path]?.[method]?.responses?.[status]?.content?.['application/json']?.schema;
      expect(schema).toBeDefined();
      for (const field of fields) expect(Object.keys(schema?.properties ?? {})).toContain(field);
    }
    const duplicateSubscriptionConflict = document.paths?.['/v1/dashboard/testflight/subscriptions']?.post?.responses?.['409']?.content?.['application/json']?.schema;
    expect(Object.keys(duplicateSubscriptionConflict?.properties ?? {})).toEqual(expect.arrayContaining(['alreadySubscribed', 'subscription']));
  } finally {
    await server.close();
  }
});

test('dashboard job action contracts describe diagnostic payloads and error statuses', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as {
      paths?: Record<string, Record<string, {
        responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }>;
      }>>;
    };
    const diagnostic = document.paths?.['/v1/dashboard/jobs/{id}/diagnostic']?.get?.responses?.['200']?.content?.['application/json']?.schema;
    const diagnosticJob = diagnostic?.properties?.job as { properties?: Record<string, unknown> } | undefined;
    const diagnosticTimeline = diagnostic?.properties?.timeline as { items?: { properties?: Record<string, unknown> } } | undefined;

    expect(Object.keys(diagnosticJob?.properties ?? {})).toEqual(expect.arrayContaining(['id', 'bundleId', 'source', 'status', 'createdAt', 'transport', 'ipaMetadata']));
    expect(Object.keys(diagnosticTimeline?.items?.properties ?? {})).toEqual(expect.arrayContaining(['at', 'label', 'status']));
    for (const path of ['/v1/dashboard/jobs/{id}/cancel', '/v1/dashboard/jobs/{id}/prioritize', '/v1/dashboard/jobs/reorder', '/v1/dashboard/jobs/{id}/retry', '/v1/dashboard/jobs/{id}/diagnostic']) {
      const method = path.endsWith('/diagnostic') ? 'get' : 'post';
      expect(document.paths?.[path]?.[method]?.responses?.['400']).toBeDefined();
      expect(document.paths?.[path]?.[method]?.responses?.['429']).toBeDefined();
    }
  } finally {
    await server.close();
  }
});

test('device discovery and setup contracts describe bridge results in detail', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as {
      paths?: Record<string, Record<string, {
        responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
      }>>;
    };
    const responseSchema = (path: string, method: string, status: string): unknown =>
      document.paths?.[path]?.[method]?.responses?.[status]?.content?.['application/json']?.schema;
    const properties = (schema: unknown): Record<string, unknown> =>
      (schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    const discovery = properties(responseSchema('/v1/dashboard/devices/discover', 'get', '200'));
    const discoveredDeviceItems = (discovery.devices as { items?: unknown } | undefined)?.items;
    expect(Object.keys(properties(discoveredDeviceItems))).toEqual(expect.arrayContaining([
      'discoveryId', 'name', 'transport', 'host', 'port', 'user', 'udid', 'source',
    ]));

    const setup = properties(responseSchema('/v1/dashboard/devices/setup', 'post', '201'));
    const setupDetails = properties(setup.setup);
    expect(Object.keys(setupDetails)).toEqual(expect.arrayContaining(['info', 'steps', 'ready']));
    const setupStepItems = (setupDetails.steps as { items?: unknown } | undefined)?.items;
    expect(Object.keys(properties(setupStepItems))).toEqual(expect.arrayContaining(['id', 'label', 'status', 'detail']));
  } finally {
    await server.close();
  }
});

test('TestFlight build contracts use the trainVersion query parameter', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as { paths?: Record<string, Record<string, { parameters?: Array<{ name?: string; required?: boolean }> }>> };
    for (const path of ['/v1/testflight/{appId}/builds', '/v1/dashboard/testflight/{appId}/builds']) {
      const parameters = document.paths?.[path]?.get?.parameters ?? [];
      const trainVersion = parameters.find((parameter) => parameter.name === 'trainVersion');
      expect(trainVersion?.required).toBe(true);
      expect(parameters.some((parameter) => parameter.name === 'train')).toBe(false);
    }
  } finally {
    await server.close();
  }
});

test('administrative, notification, and diagnostic contracts publish structured responses', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as {
      paths?: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }> }>>;
    };
    const assertions: Array<[string, string, string, string[]]> = [
      ['/v1/dashboard/logs', 'get', '200', ['logs', 'total', 'nextCursor']],
      ['/v1/dashboard/doctor', 'get', '200', ['ok', 'checkedAt', 'deployment', 'checks']],
      ['/v1/dashboard/synthetic', 'get', '200', ['ok', 'checkedAt', 'probes']],
      ['/v1/dashboard/webhooks', 'get', '200', ['deliveries']],
      ['/v1/dashboard/jobs/{id}/diagnostic', 'get', '200', ['generatedAt', 'correlationId', 'job', 'timeline']],
      ['/v1/dashboard/support-bundle', 'get', '200', ['generatedAt', 'deployment', 'database', 'latestBackup', 'devices', 'jobs']],
      ['/v1/dashboard/discord/status', 'get', '200', ['botEnabled', 'guilds']],
      ['/v1/dashboard/discord/perks', 'get', '200', ['perks']],
      ['/v1/dashboard/discord/perks', 'post', '201', ['id', 'guildId', 'discordRoleId', 'appRoleId']],
      ['/v1/dashboard/backup/export', 'get', '200', ['backupVersion', 'allowedUsers', 'devices', 'billing', 'identities']],
      ['/v1/dashboard/keys/bulk-revoke', 'post', '200', ['revoked']],
      ['/v1/dashboard/keys/bulk-extend-expiry', 'post', '200', ['extended']],
      ['/v1/dashboard/keys/bulk-set-daily-limit', 'post', '200', ['updated']],
      ['/v1/dashboard/keys/bulk-approve', 'post', '200', ['approved']],
      ['/v1/dashboard/keys/{id}/priority', 'patch', '200', ['ok', 'priority']],
      ['/v1/dashboard/keys/{id}/max-concurrent', 'patch', '200', ['ok', 'maxConcurrent']],
      ['/v1/dashboard/keys/{id}/allow-testflight', 'patch', '200', ['ok', 'allowTestFlight']],
      ['/v1/dashboard/me/prefs', 'get', '200', ['theme', 'density', 'preferPrimaryDevice']],
      ['/v1/dashboard/push/public-key', 'get', '200', ['publicKey']],
      ['/v1/dashboard/testflight/diagnostics', 'get', '200', ['bridge']],
      ['/v1/stripe/webhook', 'post', '200', ['received', 'duplicate']],
      ['/v1/nowpayments/webhook', 'post', '200', ['received', 'duplicate']],
    ];
    for (const [path, method, status, fields] of assertions) {
      const schema = document.paths?.[path]?.[method]?.responses?.[status]?.content?.['application/json']?.schema;
      expect(schema).toBeDefined();
      for (const field of fields) expect(Object.keys(schema?.properties ?? {})).toContain(field);
    }
    const backupFields = Object.keys(document.paths?.['/v1/dashboard/backup/export']?.get?.responses?.['200']?.content?.['application/json']?.schema?.properties ?? {});
    expect(backupFields).not.toContain('projects');
    expect(backupFields).not.toContain('artifactProjectLinks');
    const jobsSchema = document.paths?.['/v1/dashboard/support-bundle']?.get?.responses?.['200']?.content?.['application/json']?.schema?.properties?.jobs as {
      items?: { additionalProperties?: boolean; properties?: Record<string, unknown> };
    } | undefined;
    const timelineSchema = jobsSchema?.items?.properties?.timeline as { items?: { additionalProperties?: boolean } } | undefined;
    expect(jobsSchema?.items?.additionalProperties).toBe(false);
    expect(timelineSchema?.items?.additionalProperties).toBe(false);
  } finally {
    await server.close();
  }
});

test('dashboard diagnostics document their session and permission errors', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as {
      paths?: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }> }>>;
    };
    for (const path of ['/v1/dashboard/doctor', '/v1/dashboard/synthetic']) {
      const responses = document.paths?.[path]?.get?.responses ?? {};
      for (const status of ['401', '403']) {
        const schema = responses[status]?.content?.['application/json']?.schema;
        expect(schema).toBeDefined();
        expect(Object.keys(schema?.properties ?? {})).toEqual(expect.arrayContaining(['code', 'message', 'requestId', 'retryable']));
      }
    }
  } finally {
    await server.close();
  }
});

test('successful route responses never fall back to generic JSON', () => {
  const exportRoutes = new Set(['GET /v1/dashboard/jobs/export', 'GET /v1/dashboard/audit-log/export']);
  for (const [route, schema] of getRouteContracts()) {
    const responses = schema.response as Record<string, { anyOf?: unknown }> | undefined;
    for (const [status, response] of Object.entries(responses ?? {})) {
      if (status === '200' && response.anyOf) expect(exportRoutes.has(route)).toBe(true);
    }
  }
});

test('response declarations preserve earlier request schemas', () => {
  const login = getRouteContracts().get('POST /v1/auth/login');
  const loginBody = login?.body as { properties?: Record<string, unknown> } | undefined;
  expect(loginBody?.properties).toHaveProperty('password');
  expect(login?.response).toHaveProperty('200');

  const decrypt = getRouteContracts().get('GET /v1/decrypt');
  const decryptQuery = decrypt?.querystring as { properties?: Record<string, unknown> } | undefined;
  expect(decryptQuery?.properties).toHaveProperty('bundleId');
  expect(decrypt?.response).toHaveProperty('200');
});

test('bodyless auth actions do not require JSON request bodies', () => {
  for (const path of [
    '/v1/auth/mfa/setup',
    '/v1/auth/passkeys/options',
    '/v1/auth/passkeys/register/options',
    '/v1/auth/passkeys/reauth/options',
    '/v1/auth/refresh',
    '/v1/auth/logout',
    '/v1/auth/logout-everywhere',
    '/v1/auth/sessions/revoke-others',
  ]) {
    expect(getRouteContracts().get(`POST ${path}`)).not.toHaveProperty('body');
  }
});

test('bodyless dashboard notification actions do not require JSON request bodies', () => {
  for (const path of ['/v1/dashboard/push/test', '/v1/dashboard/email/test']) {
    expect(getRouteContracts().get(`POST ${path}`)).not.toHaveProperty('body');
  }
});

test('bodyless API key actions do not require JSON request bodies', () => {
  for (const path of [
    '/v1/dashboard/keys/:id/reveal',
    '/v1/dashboard/keys/:id/approve',
    '/v1/dashboard/keys/:id/deny',
  ]) {
    expect(getRouteContracts().get(`POST ${path}`)).not.toHaveProperty('body');
  }
});

test('TestFlight catalog contracts include the normalized bridge failure envelope', () => {
  for (const route of ['GET /v1/testflight/:appId/trains', 'GET /v1/testflight/:appId/builds']) {
    const responses = getRouteContracts().get(route)?.response as Record<string, { properties?: Record<string, unknown> }> | undefined;
    for (const field of ['error', 'code', 'message', 'requestId', 'retryable']) {
      expect(Object.keys(responses?.['502']?.properties ?? {})).toContain(field);
    }
  }
});

test('streaming and file responses publish their wire formats', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as {
      paths?: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, unknown> }> }>>;
    };
    expect(Object.keys(document.paths?.['/v1/dashboard/events']?.get?.responses?.['200']?.content ?? {})).toEqual(['text/event-stream']);
    expect(Object.keys(document.paths?.['/v1/metrics']?.get?.responses?.['200']?.content ?? {})).toEqual(['text/plain']);
    expect(Object.keys(document.paths?.['/v1/artifacts/{id}/file']?.get?.responses?.['200']?.content ?? {})).toEqual(['application/octet-stream']);
    expect(Object.keys(document.paths?.['/v1/dashboard/backup/history/{id}/download']?.get?.responses?.['200']?.content ?? {})).toEqual(['application/octet-stream']);
  } finally {
    await server.close();
  }
});
