import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { config, cryptoBillingEnabled, isValidStripeSecretKeyRotation, nowpaymentsConfigured, stripeEnabled, stripeEnvironment } from '#config.js';
import { getRustDeviceBridgeStatus } from '#idevice.js';
import { getNowPaymentsProviderStatus } from '#nowpayments.js';
import { getStateDatabaseStatus, verifyLatestDatabaseBackup } from '#store/state.js';
import { getDiskUsage } from '#util/diskUsage.js';
import { isValidCredentialRotation } from '#util/secretRotation.js';

export interface DoctorCheck {
  id: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

function rotationCheck(id: string, current: string, previous: string, minimumLength: number): DoctorCheck {
  const valid = !previous || isValidCredentialRotation(current, previous, minimumLength);
  return {
    id,
    status: valid ? 'ok' : 'error',
    detail: valid ? (previous ? 'Current and previous credentials are ready for rotation' : 'No overlapping previous credential is configured') : 'Current and previous credentials must both meet the minimum length and be different',
  };
}

function readNumericLimit(path: string): number | undefined {
  try {
    const value = readFileSync(path, 'utf8').trim();
    if (!/^\d+$/.test(value) || value === String(Number.MAX_SAFE_INTEGER)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function checkFilePermissions(id: string, targetPath: string, description: string): DoctorCheck {
  try {
    const mode = statSync(targetPath).mode & 0o777;
    const exposedBits = mode & 0o077;
    return {
      id,
      status: exposedBits === 0 ? 'ok' : 'warn',
      detail: exposedBits === 0 ? `${description} is restricted to its owner` : `${description} grants access to group or other users; review its filesystem permissions`,
    };
  } catch {
    return { id, status: 'warn', detail: `${description} permissions could not be checked` };
  }
}

export function assessRuntimeCapacity(input: { cpuCount: number; memoryLimitBytes: number; availableMemoryBytes: number; temporaryFreeBytes: number; offlineWorkers: number; offlineWorkerMemoryMb: number }): DoctorCheck {
  const requiredCpu = Math.max(2, input.offlineWorkers + 1);
  const requiredMemoryMb = input.offlineWorkerMemoryMb * input.offlineWorkers + 2048;
  const requiredTemporaryBytes = Math.max(2, input.offlineWorkers * 2) * 1024 ** 3;
  const issues = [
    input.cpuCount < requiredCpu ? `${requiredCpu} CPU cores recommended` : undefined,
    input.memoryLimitBytes < requiredMemoryMb * 1024 ** 2 ? `${Math.ceil(requiredMemoryMb / 1024)} GiB memory recommended; increase the container limit or lower APPSTORE_OFFLINE_WORKER_MEMORY_MB` : undefined,
    input.temporaryFreeBytes < requiredTemporaryBytes ? `${Math.ceil(requiredTemporaryBytes / 1024 ** 3)} GiB free temporary storage recommended under OUTPUT_DIR` : undefined,
    input.availableMemoryBytes < 512 * 1024 ** 2 ? 'less than 512 MiB of host memory is currently free' : undefined,
  ].filter((issue): issue is string => issue !== undefined);
  return {
    id: 'worker-capacity',
    status: issues.length ? 'warn' : 'ok',
    detail: `${input.cpuCount} effective CPU core(s), ${Math.round(input.memoryLimitBytes / 1024 ** 3)} GiB memory limit, ${Math.round(input.availableMemoryBytes / 1024 ** 2)} MiB host memory free, ${Math.round(input.temporaryFreeBytes / 1024 ** 3)} GiB temporary storage free. Recommended for ${input.offlineWorkers} offline worker(s): ${requiredCpu} CPU core(s), ${Math.ceil(requiredMemoryMb / 1024)} GiB RAM, and ${Math.ceil(requiredTemporaryBytes / 1024 ** 3)} GiB free temporary storage${issues.length ? `; ${issues.join('; ')}` : ''}`,
  };
}

function runtimeCapacityCheck(): DoctorCheck {
  const hostCpuCount = cpus().length;
  const hostMemory = totalmem();
  const availableMemory = freemem();
  const memoryLimit = readNumericLimit('/sys/fs/cgroup/memory.max');
  let cpuLimit = readNumericLimit('/sys/fs/cgroup/cpu.max');
  if (cpuLimit === undefined) {
    try {
      const [quota, period] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/).map(Number);
      if (Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0) cpuLimit = Math.max(1, Math.floor(quota / period));
    } catch {}
  }
  const effectiveCpu = cpuLimit ?? hostCpuCount;
  const effectiveMemory = Math.min(hostMemory, memoryLimit ?? hostMemory);
  const temporaryStorage = getDiskUsage(config.outputDir);
  return assessRuntimeCapacity({
    cpuCount: effectiveCpu,
    memoryLimitBytes: effectiveMemory,
    availableMemoryBytes: availableMemory,
    temporaryFreeBytes: temporaryStorage?.freeBytes ?? 0,
    offlineWorkers: config.appStoreOfflineMaxWorkers,
    offlineWorkerMemoryMb: config.appStoreOfflineWorkerMemoryMb,
  });
}

export async function runConfigurationDoctor(): Promise<{ ok: boolean; checkedAt: string; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  const secretStatus = config.sessionSigningSecret.length >= 32 ? 'ok' : 'error';
  checks.push({ id: 'session-secret', status: secretStatus, detail: secretStatus === 'ok' ? 'Session signing secret has sufficient entropy' : 'Session signing secret must be at least 32 characters' });
  checks.push(rotationCheck('session-secret-rotation', config.sessionSigningSecret, config.sessionSigningSecretPrevious, 32));
  const backupManifestKey = config.backupManifestSecret || config.sessionSigningSecret;
  const invalidBackupManifestPrevious = config.backupManifestSecretPrevious.some((secret) => secret.length < 32 || secret === backupManifestKey);
  checks.push({ id: 'backup-manifest-secret', status: config.backupManifestSecret.length >= 32 ? 'ok' : 'warn', detail: config.backupManifestSecret.length >= 32 ? 'Backup manifest encryption uses a stable dedicated key' : 'Backup manifest encryption falls back to the session key; configure BACKUP_MANIFEST_SECRET to keep it valid through session rotation' });
  checks.push({ id: 'backup-manifest-rotation', status: invalidBackupManifestPrevious ? 'error' : 'ok', detail: invalidBackupManifestPrevious ? 'Previous backup manifest keys must be unique and at least 32 characters' : 'Previous backup manifest keys are valid' });
  checks.push(rotationCheck('admin-password-rotation', config.adminPassword, config.adminPasswordPrevious, 12));
  checks.push({ id: 'admin-password', status: config.adminPassword.length >= 12 ? 'ok' : 'warn', detail: config.adminPassword.length >= 12 ? 'Administrator password meets the minimum length' : 'Administrator password should be at least 12 characters' });
  try {
    const baseUrl = new URL(config.publicBaseUrl);
    checks.push({ id: 'public-url', status: baseUrl.protocol === 'https:' ? 'ok' : 'warn', detail: baseUrl.protocol === 'https:' ? 'Public URL uses HTTPS' : 'Public URL does not use HTTPS' });
  } catch {
    checks.push({ id: 'public-url', status: 'error', detail: 'Public URL is not a valid absolute URL' });
  }
  const timingSettings = [config.jobMaxWaitSeconds, config.jobMaxRetries, config.jobProcessGraceSeconds, config.jobRetentionMinutes, config.stateDbBusyTimeoutMs];
  checks.push({ id: 'runtime-limits', status: timingSettings.every((value) => Number.isInteger(value) && value > 0) ? 'ok' : 'error', detail: timingSettings.every((value) => Number.isInteger(value) && value > 0) ? 'Runtime limits are valid' : 'Runtime limits must be positive integers' });
  try {
    const database = getStateDatabaseStatus();
    checks.push({ id: 'database', status: database.integrity === 'ok' ? 'ok' : 'error', detail: `SQLite schema ${database.schemaVersion} is intact` });
  } catch (error) {
    checks.push({ id: 'database', status: 'error', detail: error instanceof Error ? error.message : String(error) });
  }
  try {
    accessSync(config.stateDir, constants.R_OK | constants.W_OK);
    checks.push({ id: 'state', status: 'ok', detail: 'State volume is readable and writable' });
    checks.push(checkFilePermissions('state-permissions', config.stateDir, 'State directory'));
  } catch {
    checks.push({ id: 'state', status: 'error', detail: 'State volume is not readable and writable' });
  }
  const disk = getDiskUsage(config.artifactDir);
  checks.push({ id: 'artifacts', status: disk ? disk.usedPercent >= 0.95 ? 'error' : disk.usedPercent >= 0.85 ? 'warn' : 'ok' : 'error', detail: disk ? `${Math.round(disk.usedPercent * 100)}% used with ${disk.freeBytes} bytes free` : 'Artifact storage is unavailable' });
  checks.push(runtimeCapacityCheck());
  const backup = verifyLatestDatabaseBackup();
  checks.push({ id: 'backup-restore-drill', status: backup.ok ? 'ok' : backup.detail.startsWith('No verified') ? 'warn' : 'error', detail: backup.detail });
  if (config.deviceBridgeSecret.length < 32) checks.push({ id: 'device-bridge', status: 'error', detail: 'Rust device bridge secret is missing or too short' });
  else if (!existsSync(config.deviceBridgeSocket)) checks.push({ id: 'device-bridge', status: 'warn', detail: 'Rust device bridge socket is not available yet' });
  else {
    try {
      const bridge = await getRustDeviceBridgeStatus();
      checks.push({ id: 'device-bridge', status: bridge.state === 'ready' ? 'ok' : 'warn', detail: `Rust bridge is ${bridge.state} with ${bridge.deviceCount} discovered device(s)` });
    } catch (error) {
      checks.push({ id: 'device-bridge', status: 'error', detail: error instanceof Error ? error.message : String(error) });
    }
  }
  checks.push(rotationCheck('device-bridge-rotation', config.deviceBridgeSecret, config.deviceBridgeSecretPrevious, 32));
  const stripeRotationValid = !config.stripeSecretKeyPrevious || isValidStripeSecretKeyRotation(config.stripeSecretKey, config.stripeSecretKeyPrevious);
  checks.push({ id: 'stripe-secret-key-rotation', status: stripeRotationValid ? 'ok' : 'error', detail: stripeRotationValid ? config.stripeSecretKeyPrevious ? 'Stripe API key rotation is ready in the same mode' : 'No previous Stripe API key is configured' : 'Current and previous Stripe API keys must be different, valid-length keys in the same mode' });
  checks.push(rotationCheck('stripe-webhook-rotation', config.stripeWebhookSecret, config.stripeWebhookSecretPrevious, 16));
  checks.push(rotationCheck('crypto-api-key-rotation', config.nowpaymentsApiKey, config.nowpaymentsApiKeyPrevious, 16));
  checks.push(rotationCheck('crypto-webhook-rotation', config.nowpaymentsIpnSecret, config.nowpaymentsIpnSecretPrevious, 16));
  checks.push(rotationCheck('outbound-webhook-rotation', config.outboundWebhookSecret, config.outboundWebhookSecretPrevious, 16));
  checks.push(rotationCheck('github-oauth-secret-rotation', config.githubOauthClientSecret, config.githubOauthClientSecretPrevious, 16));
  checks.push(rotationCheck('discord-oauth-secret-rotation', config.discordOauthClientSecret, config.discordOauthClientSecretPrevious, 16));
  checks.push(rotationCheck('smtp-secret-rotation', config.smtpPass, config.smtpPassPrevious, 1));
  checks.push({ id: 'pairing-store', status: existsSync(config.devicePairingStore) ? 'ok' : 'warn', detail: existsSync(config.devicePairingStore) ? 'Device pairing store exists' : 'Device pairing store will be created on first bridge start' });
  if (existsSync(config.devicePairingStore)) checks.push(checkFilePermissions('pairing-store-permissions', config.devicePairingStore, 'Device pairing store'));
  checks.push({ id: 'security-posture', status: config.publicBaseUrl.startsWith('https://') && checks.some((check) => check.id === 'backup-restore-drill' && check.status === 'ok') ? 'ok' : 'warn', detail: config.publicBaseUrl.startsWith('https://') ? 'Secure public origin is configured; backup and credential checks are listed above' : 'Use HTTPS for the public origin and keep verified backups current' });
  const otelSignals = [
    config.otelExporterOtlpEndpoint || config.otelExporterOtlpTracesEndpoint ? 'traces' : undefined,
    config.otelExporterOtlpEndpoint || config.otelExporterOtlpMetricsEndpoint ? 'metrics' : undefined,
  ].filter((signal): signal is string => !!signal);
  checks.push({ id: 'otel', status: otelSignals.length ? 'ok' : 'warn', detail: otelSignals.length ? `OTLP ${otelSignals.join(' and ')} configured for ${config.otelServiceName}` : 'OTLP export is disabled; Prometheus metrics remain available' });
  checks.push({ id: 'stripe', status: stripeEnabled ? 'ok' : 'warn', detail: stripeEnabled ? `Stripe is configured in ${stripeEnvironment} mode` : 'Stripe billing is missing runtime configuration' });
  if (cryptoBillingEnabled || nowpaymentsConfigured) {
    const crypto = await getNowPaymentsProviderStatus();
    checks.push({ id: 'crypto', status: crypto.ready ? 'ok' : crypto.enabled ? 'error' : 'warn', detail: crypto.ready ? 'NOWPayments crypto billing is ready' : crypto.issues.join(', ') || 'Crypto billing is disabled' });
  } else checks.push({ id: 'crypto', status: 'warn', detail: 'Crypto billing is disabled' });
  return { ok: checks.every((check) => check.status !== 'error'), checkedAt: new Date().toISOString(), checks };
}
