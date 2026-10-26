import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { config } from '#config.js';
import { assessRuntimeCapacity, runConfigurationDoctor, runtimeConfigurationSnapshot } from '#doctor.js';

test('configuration doctor reports runtime security and persistence checks', async () => {
  const result = await runConfigurationDoctor();
  const ids = new Set(result.checks.map((check) => check.id));
  expect(ids.has('database')).toBe(true);
  expect(ids.has('session-secret')).toBe(true);
  expect(ids.has('backup-manifest-secret')).toBe(true);
  expect(ids.has('backup-manifest-rotation')).toBe(true);
  expect(ids.has('public-url')).toBe(true);
  expect(ids.has('runtime-limits')).toBe(true);
  expect(ids.has('device-bridge')).toBe(true);
  expect(ids.has('otel')).toBe(true);
  expect(ids.has('worker-capacity')).toBe(true);
});

test('configuration doctor rejects an outbound rotation with no active signing key', async () => {
  const currentSecret = config.outboundWebhookSecret;
  const previousSecret = config.outboundWebhookSecretPrevious;
  config.outboundWebhookSecret = '';
  config.outboundWebhookSecretPrevious = 'previous_outbound_signing_secret_456';

  try {
    const result = await runConfigurationDoctor();
    expect(result.checks.find((check) => check.id === 'outbound-webhook-rotation')).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('both meet the minimum length'),
    });
  } finally {
    config.outboundWebhookSecret = currentSecret;
    config.outboundWebhookSecretPrevious = previousSecret;
  }
});

test('configuration doctor validates SMTP and OAuth secret rotations', async () => {
  const previous = {
    smtpPass: config.smtpPass,
    smtpPassPrevious: config.smtpPassPrevious,
    nowpaymentsApiKey: config.nowpaymentsApiKey,
    nowpaymentsApiKeyPrevious: config.nowpaymentsApiKeyPrevious,
    githubSecret: config.githubOauthClientSecret,
    githubSecretPrevious: config.githubOauthClientSecretPrevious,
    discordSecret: config.discordOauthClientSecret,
    discordSecretPrevious: config.discordOauthClientSecretPrevious,
  };
  config.smtpPass = '';
  config.smtpPassPrevious = 'previous-smtp-password';
  config.nowpaymentsApiKey = 'current_nowpayments_api_key_123456';
  config.nowpaymentsApiKeyPrevious = 'short';
  config.githubOauthClientSecret = 'current-github-client-secret-123';
  config.githubOauthClientSecretPrevious = 'short';
  config.discordOauthClientSecret = 'current-discord-client-secret-123';
  config.discordOauthClientSecretPrevious = config.discordOauthClientSecret;

  try {
    const result = await runConfigurationDoctor();
    const checks = new Map(result.checks.map((check) => [check.id, check]));

    expect(checks.get('smtp-secret-rotation')).toMatchObject({ status: 'error' });
    expect(checks.get('crypto-api-key-rotation')).toMatchObject({ status: 'error' });
    expect(checks.get('github-oauth-secret-rotation')).toMatchObject({ status: 'error' });
    expect(checks.get('discord-oauth-secret-rotation')).toMatchObject({ status: 'error' });

    config.smtpPass = 'current-smtp-password';
    config.smtpPassPrevious = 'previous-smtp-password';
    config.nowpaymentsApiKeyPrevious = 'previous_nowpayments_api_key_123456';
    config.githubOauthClientSecretPrevious = 'previous-github-client-secret-456';
    config.discordOauthClientSecretPrevious = 'previous-discord-client-secret-456';
    const validResult = await runConfigurationDoctor();
    const validChecks = new Map(validResult.checks.map((check) => [check.id, check]));

    expect(validChecks.get('smtp-secret-rotation')).toMatchObject({ status: 'ok' });
    expect(validChecks.get('crypto-api-key-rotation')).toMatchObject({ status: 'ok' });
    expect(validChecks.get('github-oauth-secret-rotation')).toMatchObject({ status: 'ok' });
    expect(validChecks.get('discord-oauth-secret-rotation')).toMatchObject({ status: 'ok' });
  } finally {
    config.smtpPass = previous.smtpPass;
    config.smtpPassPrevious = previous.smtpPassPrevious;
    config.nowpaymentsApiKey = previous.nowpaymentsApiKey;
    config.nowpaymentsApiKeyPrevious = previous.nowpaymentsApiKeyPrevious;
    config.githubOauthClientSecret = previous.githubSecret;
    config.githubOauthClientSecretPrevious = previous.githubSecretPrevious;
    config.discordOauthClientSecret = previous.discordSecret;
    config.discordOauthClientSecretPrevious = previous.discordSecretPrevious;
  }
});

test('configuration doctor requires Stripe API key rotation credentials to use the same mode', async () => {
  const currentKey = config.stripeSecretKey;
  const previousKey = config.stripeSecretKeyPrevious;
  config.stripeSecretKey = 'sk_live_current_key_for_rotation_test';
  config.stripeSecretKeyPrevious = 'sk_test_previous_key_for_rotation_test';

  try {
    const mismatched = await runConfigurationDoctor();
    expect(mismatched.checks.find((check) => check.id === 'stripe-secret-key-rotation')).toMatchObject({ status: 'error' });

    config.stripeSecretKeyPrevious = 'sk_live_previous_key_for_rotation_test';
    const matching = await runConfigurationDoctor();
    expect(matching.checks.find((check) => check.id === 'stripe-secret-key-rotation')).toMatchObject({ status: 'ok' });
  } finally {
    config.stripeSecretKey = currentKey;
    config.stripeSecretKeyPrevious = previousKey;
  }
});

test('runtime capacity advice includes concrete memory, CPU, and temporary storage sizing', () => {
  const check = assessRuntimeCapacity({
    cpuCount: 2,
    memoryLimitBytes: 4 * 1024 ** 3,
    availableMemoryBytes: 2 * 1024 ** 3,
    temporaryFreeBytes: 1024 ** 3,
    offlineWorkers: 1,
    offlineWorkerMemoryMb: 8192,
  });

  expect(check.status).toBe('warn');
  expect(check.detail).toContain('10 GiB RAM');
  expect(check.detail).toContain('2 CPU core(s)');
  expect(check.detail).toContain('2 GiB free temporary storage');
  expect(check.detail).toContain('lower APPSTORE_OFFLINE_WORKER_MEMORY_MB');
});

test('runtime capacity advice clears when the deployment meets the configured worker needs', () => {
  const check = assessRuntimeCapacity({
    cpuCount: 2,
    memoryLimitBytes: 10 * 1024 ** 3,
    availableMemoryBytes: 2 * 1024 ** 3,
    temporaryFreeBytes: 2 * 1024 ** 3,
    offlineWorkers: 1,
    offlineWorkerMemoryMb: 8192,
  });

  expect(check.status).toBe('ok');
  expect(check.detail).toContain('Recommended for 1 offline worker(s)');
});

test('runtime configuration fingerprints OTLP endpoint routes without exposing credentials or query values', () => {
  const previous = {
    base: config.otelExporterOtlpEndpoint,
    traces: config.otelExporterOtlpTracesEndpoint,
    metrics: config.otelExporterOtlpMetricsEndpoint,
  };
  config.otelExporterOtlpEndpoint = 'https://user:password@collector.example/v1?token=secret#trace';
  config.otelExporterOtlpTracesEndpoint = 'https://collector.example/v1/traces?token=secret';
  config.otelExporterOtlpMetricsEndpoint = 'https://collector.example/v1/metrics';

  try {
    const snapshot = runtimeConfigurationSnapshot();
    expect(snapshot.otelBaseEndpointFingerprint).toBe(createHash('sha256').update('https://collector.example/v1').digest('hex'));
    expect(snapshot.otelTracesEndpointFingerprint).toBe(createHash('sha256').update('https://collector.example/v1/traces').digest('hex'));
    expect(snapshot.otelMetricsEndpointFingerprint).not.toBe(snapshot.otelTracesEndpointFingerprint);
    expect(JSON.stringify(snapshot)).not.toContain('password');
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  } finally {
    config.otelExporterOtlpEndpoint = previous.base;
    config.otelExporterOtlpTracesEndpoint = previous.traces;
    config.otelExporterOtlpMetricsEndpoint = previous.metrics;
  }
});
