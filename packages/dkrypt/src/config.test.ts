import { describe, expect, test } from 'bun:test';

async function loadDefaultRetention(): Promise<{ jobRetentionMinutes: number; nowpaymentsSupportedAssets: string[]; nowpaymentsDefaultAsset: string; nowpaymentsOutcomeCurrency: string; appStoreOfflineDecryptEnabled: boolean; appStoreOfflineFairPlayAuthorized: boolean; appStoreOfflineAuthenticationTimeoutSeconds: number; appStoreOfflineMaxWorkers: number; appStoreOfflineAttemptTimeoutSeconds: number; appStoreOfflineStallTimeoutSeconds: number; appStoreOfflineFallbackReserveSeconds: number; appStoreOfflineCircuitFailureThreshold: number; appStoreOfflineCircuitCooldownSeconds: number }> {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      "const { config } = await import('./src/config.ts'); console.log(JSON.stringify({ jobRetentionMinutes: config.jobRetentionMinutes, nowpaymentsSupportedAssets: config.nowpaymentsSupportedAssets, nowpaymentsDefaultAsset: config.nowpaymentsDefaultAsset, nowpaymentsOutcomeCurrency: config.nowpaymentsOutcomeCurrency, appStoreOfflineDecryptEnabled: config.appStoreOfflineDecryptEnabled, appStoreOfflineFairPlayAuthorized: config.appStoreOfflineFairPlayAuthorized, appStoreOfflineAuthenticationTimeoutSeconds: config.appStoreOfflineAuthenticationTimeoutSeconds, appStoreOfflineMaxWorkers: config.appStoreOfflineMaxWorkers, appStoreOfflineAttemptTimeoutSeconds: config.appStoreOfflineAttemptTimeoutSeconds, appStoreOfflineStallTimeoutSeconds: config.appStoreOfflineStallTimeoutSeconds, appStoreOfflineFallbackReserveSeconds: config.appStoreOfflineFallbackReserveSeconds, appStoreOfflineCircuitFailureThreshold: config.appStoreOfflineCircuitFailureThreshold, appStoreOfflineCircuitCooldownSeconds: config.appStoreOfflineCircuitCooldownSeconds }));",
    ],
    {
      cwd: process.cwd(),
      env: {
        API_KEY: 'config-test-api-key',
        SESSION_SIGNING_SECRET: 'config-test-session-signing-secret',
        ADMIN_PASSWORD: 'config-test-admin-password',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`config defaults lookup failed: ${stderr}`);
  return JSON.parse(stdout) as { jobRetentionMinutes: number; nowpaymentsSupportedAssets: string[]; nowpaymentsDefaultAsset: string; nowpaymentsOutcomeCurrency: string; appStoreOfflineDecryptEnabled: boolean; appStoreOfflineFairPlayAuthorized: boolean; appStoreOfflineAuthenticationTimeoutSeconds: number; appStoreOfflineMaxWorkers: number; appStoreOfflineAttemptTimeoutSeconds: number; appStoreOfflineStallTimeoutSeconds: number; appStoreOfflineFallbackReserveSeconds: number; appStoreOfflineCircuitFailureThreshold: number; appStoreOfflineCircuitCooldownSeconds: number };
}

async function loadOfflineWorkerLimit(value: number): Promise<number> {
  const child = Bun.spawn(
    [process.execPath, '-e', "const { config } = await import('./src/config.ts'); console.log(config.appStoreOfflineMaxWorkers);"],
    {
      cwd: process.cwd(),
      env: {
        API_KEY: 'config-test-api-key',
        SESSION_SIGNING_SECRET: 'config-test-session-signing-secret',
        ADMIN_PASSWORD: 'config-test-admin-password',
        APPSTORE_OFFLINE_MAX_WORKERS: String(value),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`offline worker limit lookup failed: ${stderr}`);
  return Number.parseInt(stdout.trim(), 10);
}

async function loadStripeMissingConfiguration(): Promise<string[]> {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      "const { stripeMissingConfiguration } = await import('./src/config.ts'); console.log(JSON.stringify(stripeMissingConfiguration));",
    ],
    {
      cwd: process.cwd(),
      env: {
        API_KEY: 'config-test-api-key',
        SESSION_SIGNING_SECRET: 'config-test-session-signing-secret',
        ADMIN_PASSWORD: 'config-test-admin-password',
        STRIPE_SECRET_KEY: '',
        STRIPE_WEBHOOK_SECRET: '',
        STRIPE_REGULAR_PRICE_ID: '',
        STRIPE_PRIORITY_PRICE_ID: '',
        STRIPE_API_PRICE_ID: '',
        STRIPE_PRIORITY_API_PRICE_ID: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Stripe configuration lookup failed: ${stderr}`);
  return JSON.parse(stdout) as string[];
}

async function loadStripeEnvironment(secretKey: string): Promise<string> {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      "const { stripeEnvironment } = await import('./src/config.ts'); console.log(stripeEnvironment);",
    ],
    {
      cwd: process.cwd(),
      env: {
        API_KEY: 'config-test-api-key',
        SESSION_SIGNING_SECRET: 'config-test-session-signing-secret',
        ADMIN_PASSWORD: 'config-test-admin-password',
        STRIPE_SECRET_KEY: secretKey,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Stripe environment lookup failed: ${stderr}`);
  return stdout.trim();
}

async function loadInvalidCanaryConfiguration(): Promise<string> {
  const child = Bun.spawn(
    [process.execPath, '-e', "await import('./src/config.ts');"],
    {
      cwd: process.cwd(),
      env: {
        API_KEY: 'config-test-api-key',
        SESSION_SIGNING_SECRET: 'config-test-session-signing-secret',
        ADMIN_PASSWORD: 'config-test-admin-password',
        BILLING_CATALOG_ROLLOUT: 'canary',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (exitCode === 0) throw new Error('billing canary configuration unexpectedly succeeded');
  return stderr;
}

describe('config defaults', () => {
  test('keeps completed job history for 24 hours by default', async () => {
    await expect(loadDefaultRetention()).resolves.toEqual({
      jobRetentionMinutes: 1440,
      nowpaymentsSupportedAssets: ['USDC', 'USDT'],
      nowpaymentsDefaultAsset: 'USDC',
      nowpaymentsOutcomeCurrency: 'USDC',
      appStoreOfflineDecryptEnabled: true,
      appStoreOfflineFairPlayAuthorized: true,
      appStoreOfflineAuthenticationTimeoutSeconds: 300,
      appStoreOfflineMaxWorkers: 1,
      appStoreOfflineAttemptTimeoutSeconds: 900,
      appStoreOfflineStallTimeoutSeconds: 300,
      appStoreOfflineFallbackReserveSeconds: 180,
      appStoreOfflineCircuitFailureThreshold: 3,
      appStoreOfflineCircuitCooldownSeconds: 300,
    });
  });

  test('bounds offline App Store worker concurrency', async () => {
    await expect(loadOfflineWorkerLimit(32)).resolves.toBe(4);
    await expect(loadOfflineWorkerLimit(-3)).resolves.toBe(1);
  });

  test('reports every missing Stripe runtime prerequisite', async () => {
    await expect(loadStripeMissingConfiguration()).resolves.toEqual([
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_REGULAR_PRICE_ID',
      'STRIPE_PRIORITY_PRICE_ID',
      'STRIPE_API_PRICE_ID',
      'STRIPE_PRIORITY_API_PRICE_ID',
    ]);
  });

  test('recognizes restricted live Stripe keys as live mode', async () => {
    await expect(loadStripeEnvironment('rk_live_config-test-key')).resolves.toBe('live');
  });

  test('requires at least one account before enabling the catalog canary', async () => {
    await expect(loadInvalidCanaryConfiguration()).resolves.toContain('BILLING_CATALOG_CANARY_USER_IDS is required');
  });
});
