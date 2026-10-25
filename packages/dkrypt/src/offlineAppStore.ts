import { accessSync, constants, existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { config } from '#config.js';
import { createAppleAccountAuthenticationOperation } from '#offlineAppStoreAuthOperation.js';
import { clearAppleAccountSessionSnapshot, markAppleAccountAuthenticated, markAppleAccountAuthenticationError, readAppleAccountSecrets, readAppleAccountSessionSnapshot, saveAppleAccountSessionSnapshot, getAppleAccountVaultStatus } from '#appleAccountVault.js';
import type { AppleAccountSecrets, AppleAccountVaultStatus } from '#appleAccountVault.js';
import type { FairPlayVerificationResult } from '#util/ipaFairPlay.js';
import type { ExtractedIpaMetadata } from '#util/ipaMetadata.js';
import { compareVersions } from '#util/version.js';
import { getIpaFairPlayLicenseSelector } from '#util/ipaFairPlay.js';
import { inspectIpaInIsolatedProcess } from '#jobs/ipaInspection.js';
import { appendJobTimelineEvent, type Job, type JobExecutionStage } from '#jobs/types.js';
import { throwIfAborted } from '#util/abort.js';
import { invokeFairPlayDecryptor } from '#offlineAppStoreDecryptor.js';
import { createOfflineAppStoreAuthenticationRepository } from '#store/offlineAppStoreAuthenticationRepository.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';
import { scopedLogger } from '#logger.js';
import { sanitizeAppStoreDownloadDiagnostic } from '#offlineAppStoreDiagnostic.js';
import { runAppStoreDownloaderRequest, type AppStoreDownloaderResponse } from '#offlineAppStoreDownloader.js';
import { emitJobsChanged } from '#events.js';
import { saveAppleAccountFairPlayCredentialForSelector } from '#appleAccountVault.js';

const log = scopedLogger('appstore-offline');
let offlineAppStoreDispatchNotifier = () => {};

export interface OfflineAppStoreReadiness {
  enabled: boolean;
  ready: boolean;
  downloaderAvailable: boolean;
  decryptorAvailable: boolean;
  fairPlayAuthorized: boolean;
  vault: AppleAccountVaultStatus;
  blockers: string[];
}

export interface OfflineAppStoreResult {
  outputPath: string;
  warnings: string[];
  verification: FairPlayVerificationResult;
  metadata: ExtractedIpaMetadata;
}

export interface OfflineAppStoreProcessor {
  readiness(job?: Pick<Job, 'testflight'>): OfflineAppStoreReadiness;
  run(job: Job, signal?: AbortSignal, setStage?: (stage: JobExecutionStage) => void): Promise<OfflineAppStoreResult>;
}

const APPLE_AUTHENTICATION_FAILURE_CODES = [
  'two_factor_required',
  'verification_code_rejected',
  'invalid_credentials',
  'device_verification_required',
  'rate_limited',
  'apple_store_unavailable',
  'account_disabled',
  'apple_request_timed_out',
  'apple_network_unavailable',
  'apple_request_failed',
  'action_signature_rejected',
  'action_signing_failed',
  'apple_response_invalid',
  'apple_client_setup_failed',
  'storefront_lookup_failed',
  'provider_session_storage_failed',
  'apple_sign_in_rejected',
  'authentication_failed',
] as const;

type AppleAuthenticationFailureCode = typeof APPLE_AUTHENTICATION_FAILURE_CODES[number];
const appleAuthenticationFailureCodeSet = new Set<string>(APPLE_AUTHENTICATION_FAILURE_CODES);

export interface OfflineAppStoreDependencies {
  enabled: boolean;
  fairPlayAuthorized: boolean;
  downloaderPath: string;
  decryptorPath: string;
  stagingDirectory: string;
  getSecrets(): AppleAccountSecrets | undefined;
  getVaultStatus(): AppleAccountVaultStatus;
  runDownload(job: Job, secrets: AppleAccountSecrets, outputPath: string, signal?: AbortSignal): Promise<void>;
  runDecrypt(job: Job, secrets: AppleAccountSecrets, inputPath: string, outputPath: string, signal?: AbortSignal, credential?: string): Promise<void>;
  getLicenseSelector(inputPath: string): string;
  retrieveCredentialForIpa?(job: Job, inputPath: string, signal?: AbortSignal): Promise<Buffer>;
  saveCredentialForSelector?(selector: string, credential: string): void;
  inspect(path: string, signal?: AbortSignal, onChildProcess?: (child: ChildProcess | undefined) => void): Promise<{ verification: FairPlayVerificationResult; metadata: ExtractedIpaMetadata }>;
}

export class OfflineAppStoreUnavailableError extends Error {
  constructor(message = 'server-side App Store decryption is not configured') {
    super(message);
    this.name = 'OfflineAppStoreUnavailableError';
  }
}

export class OfflineAppStoreAuthenticationError extends Error {
  constructor(readonly code: AppleAuthenticationFailureCode) {
    super(code === 'two_factor_required' ? 'Apple Account verification is required' : 'Apple Account authentication failed');
    this.name = 'OfflineAppStoreAuthenticationError';
  }
}

export class OfflineAppStoreListingUnavailableError extends Error {
  readonly retryable = false;
  readonly fallbackToDevice = false;

  constructor() {
    super('This app is not available in the signed-in Apple Account storefront');
    this.name = 'OfflineAppStoreListingUnavailableError';
  }
}

export function unavailableAppStoreListingError(response: Pick<AppStoreDownloaderResponse, 'stage' | 'code'>): OfflineAppStoreListingUnavailableError | undefined {
  if (response.stage !== 'app_lookup' || response.code !== 'app_not_found') return undefined;
  return new OfflineAppStoreListingUnavailableError();
}

function statusBlockers(input: {
  enabled: boolean;
  downloaderAvailable: boolean;
  decryptorAvailable: boolean;
  fairPlayAuthorized: boolean;
  vault: AppleAccountVaultStatus;
}): string[] {
  const blockers: string[] = [];
  if (!input.enabled) blockers.push('offline decryption is disabled');
  if (!input.fairPlayAuthorized) blockers.push('FairPlay decryptor use has not been approved');
  if (!input.downloaderAvailable) blockers.push('App Store downloader is missing');
  if (!input.decryptorAvailable) blockers.push('FairPlay decryptor is missing');
  if (!input.vault.encryptionReady) blockers.push('external credential encryption key is not configured');
  if (input.vault.authenticationError === 'encryption_key_mismatch') blockers.push('stored account data cannot be decrypted with the configured key');
  if (!input.vault.accountConfigured) blockers.push('Apple Account credentials are not configured');
  if (input.vault.authenticationError && input.vault.authenticationError !== 'encryption_key_mismatch') blockers.push('Apple Account session needs verification');
  if (!input.vault.authenticatedAt) blockers.push('Apple Account session has not been verified');
  if (!input.vault.credentialConfigured) blockers.push('device-derived FairPlay credential is not configured');
  return blockers;
}

function verifyOfflinePackageIdentity(job: Job, metadata: ExtractedIpaMetadata): void {
  const actualBundleId = metadata.infoPlist.CFBundleIdentifier;
  if (actualBundleId !== job.bundleId) {
    throw new Error(`downloaded IPA bundle identifier ${String(actualBundleId ?? 'missing')} does not match requested ${job.bundleId}`);
  }
  const expectedVersion = job.versionLabel?.match(/^v?(\d+(?:\.\d+)*)$/i)?.[1];
  if (!expectedVersion) return;
  const actualVersion = metadata.summary.shortVersion;
  if (!actualVersion || compareVersions(actualVersion, expectedVersion) !== 0) {
    throw new Error(`downloaded IPA version ${actualVersion ?? 'missing'} does not match requested ${expectedVersion}`);
  }
}

export function createOfflineAppStoreProcessor(dependencies: OfflineAppStoreDependencies): OfflineAppStoreProcessor {
  const isExecutable = (filePath: string): boolean => {
    try {
      accessSync(filePath, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const readiness = (job?: Pick<Job, 'testflight'>): OfflineAppStoreReadiness => {
    const vault = dependencies.getVaultStatus();
    const downloaderAvailable = isExecutable(dependencies.downloaderPath);
    const decryptorAvailable = isExecutable(dependencies.decryptorPath);
    const blockers = statusBlockers({ enabled: dependencies.enabled, fairPlayAuthorized: dependencies.fairPlayAuthorized, downloaderAvailable, decryptorAvailable, vault });
    if (job?.testflight) blockers.push('TestFlight stays on the device workflow');
    return {
      enabled: dependencies.enabled,
      ready: blockers.length === 0 && !job?.testflight,
      downloaderAvailable,
      decryptorAvailable,
      fairPlayAuthorized: dependencies.fairPlayAuthorized,
      vault,
      blockers,
    };
  };

  return {
    readiness,
    async run(job, signal, setStage) {
      if (job.testflight) throw new OfflineAppStoreUnavailableError('TestFlight stays on the device workflow');
      const currentReadiness = readiness(job);
      if (!currentReadiness.ready) throw new OfflineAppStoreUnavailableError(currentReadiness.blockers.join('; '));
      const secrets = dependencies.getSecrets();
      if (!secrets || (!secrets.fairPlayCredential && !Object.keys(secrets.fairPlayCredentials ?? {}).length)) {
        throw new OfflineAppStoreUnavailableError('device-derived FairPlay credential is not configured');
      }
      throwIfAborted(signal);
      await mkdir(dependencies.stagingDirectory, { recursive: true, mode: 0o700 });
      const encryptedPath = path.join(dependencies.stagingDirectory, `${job.id}.offline-encrypted.ipa`);
      const outputPath = path.join(dependencies.stagingDirectory, `${job.id}.offline-decrypted.ipa`);
      await rm(encryptedPath, { force: true });
      await rm(outputPath, { force: true });
      try {
        await dependencies.runDownload(job, secrets, encryptedPath, signal);
        throwIfAborted(signal);
        const downloaded = await stat(encryptedPath);
        if (!downloaded.isFile() || downloaded.size <= 0 || downloaded.size > config.artifactMaxBytes) {
          throw new Error('App Store download has an invalid size');
        }
        setStage?.('offline_decrypting');
        const selector = dependencies.getLicenseSelector(encryptedPath);
        let credential = secrets.fairPlayCredentials?.[selector] ?? secrets.fairPlayCredential;
        let retrievedCredential: Buffer | undefined;
        let retrievedForThisJob = false;
        if (!credential && dependencies.retrieveCredentialForIpa) {
          job.progress = 'Retrieving the matching FairPlay key from the paired iPad';
          appendJobTimelineEvent(job, 'Retrieving the matching FairPlay key from the paired iPad', 'running');
          emitJobsChanged();
          retrievedCredential = await dependencies.retrieveCredentialForIpa(job, encryptedPath, signal);
          credential = retrievedCredential.toString('base64');
          retrievedForThisJob = true;
        }
        try {
          await dependencies.runDecrypt(job, secrets, encryptedPath, outputPath, signal, credential);
        } catch (error) {
          if (!isFairPlaySelectorMismatch(error) || !dependencies.retrieveCredentialForIpa || retrievedForThisJob) throw error;
          job.progress = 'Retrieving the matching FairPlay key from the paired iPad';
          appendJobTimelineEvent(job, 'Retrieving the matching FairPlay key from the paired iPad', 'running');
          emitJobsChanged();
          retrievedCredential = await dependencies.retrieveCredentialForIpa(job, encryptedPath, signal);
          credential = retrievedCredential.toString('base64');
          retrievedForThisJob = true;
          await rm(outputPath, { force: true });
          await dependencies.runDecrypt(job, secrets, encryptedPath, outputPath, signal, credential);
          job.progress = 'Decrypting the App Store package on the server';
          appendJobTimelineEvent(job, 'The matching FairPlay key decrypted the downloaded package', 'done');
          emitJobsChanged();
        } finally {
          retrievedCredential?.fill(0);
        }
        if (credential && !secrets.fairPlayCredentials?.[selector]) {
          dependencies.saveCredentialForSelector?.(selector, credential);
        }
        throwIfAborted(signal);
        const inspection = await dependencies.inspect(outputPath, signal, (child) => { job.childProcess = child; });
        job.childProcess = undefined;
        const { verification, metadata } = inspection;
        verifyOfflinePackageIdentity(job, metadata);
        if (verification.primaryEncrypted || (verification.encryptedPaths.length > 0 && !verification.extensionOnly)) {
          throw new Error(`FairPlay verification found encrypted executable paths: ${verification.encryptedPaths.join(', ')}`);
        }
        if (verification.extensionOnly) {
          job.warnings = [`Some embedded extensions remained encrypted: ${verification.encryptedPaths.join(', ')}`];
        }
        const output = await stat(outputPath);
        if (!output.isFile() || output.size <= 0 || output.size > config.artifactMaxBytes) throw new Error('decrypted IPA has an invalid size');
        await rm(encryptedPath, { force: true });
        return { outputPath, warnings: job.warnings ?? [], verification, metadata };
      } catch (error) {
        job.childProcess = undefined;
        await Promise.all([rm(encryptedPath, { force: true }), rm(outputPath, { force: true })]);
        throw error;
      }
    },
  };
}

function isFairPlaySelectorMismatch(error: unknown): boolean {
  return error instanceof Error && error.message.includes('credential does not decode this SINF priv record');
}

const defaultStagingDirectory = path.join(config.artifactDir, '.staging');
const SESSION_FILE_LIMIT_BYTES = 10 * 1024 * 1024;
const SESSION_FILE_COUNT_LIMIT = 1000;
const SESSION_WORKSPACE_ROOT = existsSync('/dev/shm') ? '/dev/shm' : tmpdir();
let sessionOperation = Promise.resolve();

interface SessionFileEntry {
  path: string;
  data: string;
}

async function collectSessionFiles(root: string, relative = ''): Promise<SessionFileEntry[]> {
  const entries: SessionFileEntry[] = [];
  for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const itemPath = path.join(relative, item.name);
    const absolutePath = path.join(root, itemPath);
    if (item.isSymbolicLink()) throw new Error('App Store provider session contains an unsupported link');
    if (item.isDirectory()) {
      entries.push(...await collectSessionFiles(root, itemPath));
      continue;
    }
    if (!item.isFile()) continue;
    const contents = await readFile(absolutePath);
    if (contents.length > SESSION_FILE_LIMIT_BYTES) throw new Error('App Store provider session file is too large');
    entries.push({ path: itemPath.split(path.sep).join('/'), data: contents.toString('base64') });
    if (entries.length > SESSION_FILE_COUNT_LIMIT) throw new Error('App Store provider session contains too many files');
  }
  return entries;
}

function parseSessionSnapshot(snapshot: Buffer): SessionFileEntry[] {
  const parsed = JSON.parse(snapshot.toString('utf8')) as { version?: unknown; files?: unknown };
  if (parsed.version !== 1 || !Array.isArray(parsed.files) || parsed.files.length > SESSION_FILE_COUNT_LIMIT) {
    throw new Error('stored App Store provider session is invalid');
  }
  return parsed.files.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof (entry as SessionFileEntry).path !== 'string' || typeof (entry as SessionFileEntry).data !== 'string') {
      throw new Error('stored App Store provider session is invalid');
    }
    const file = entry as SessionFileEntry;
    const normalized = path.posix.normalize(file.path);
    if (!file.path || normalized === '.' || normalized !== file.path || normalized.startsWith('../') || normalized.startsWith('/') || file.path.includes('\\')) {
      throw new Error('stored App Store provider session path is invalid');
    }
    return file;
  });
}

async function restoreSessionWorkspace(root: string): Promise<void> {
  const snapshot = readAppleAccountSessionSnapshot();
  if (!snapshot) return;
  let hadLegacyProviderFiles = false;
  try {
    for (const entry of parseSessionSnapshot(snapshot)) {
      if (entry.path === '.ipatool' || entry.path.startsWith('.ipatool/')) {
        hadLegacyProviderFiles = true;
        continue;
      }
      const destination = path.resolve(root, ...entry.path.split('/'));
      if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) throw new Error('stored App Store provider session path is invalid');
      const contents = Buffer.from(entry.data, 'base64');
      if (contents.toString('base64') !== entry.data || contents.length > SESSION_FILE_LIMIT_BYTES) throw new Error('stored App Store provider session file is invalid');
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, contents, { mode: 0o600 });
      contents.fill(0);
    }
  } finally {
    snapshot.fill(0);
  }
  if (hadLegacyProviderFiles) {
    clearAppleAccountSessionSnapshot();
    markAppleAccountAuthenticationError('provider_migration_required');
  }
}

async function saveSessionWorkspace(root: string): Promise<void> {
  const files = await collectSessionFiles(root);
  if (files.length > SESSION_FILE_COUNT_LIMIT) throw new Error('App Store provider session contains too many files');
  const snapshot = Buffer.from(JSON.stringify({ version: 1, files }));
  try {
    saveAppleAccountSessionSnapshot(snapshot);
  } finally {
    snapshot.fill(0);
  }
}

async function waitForSessionOperation(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await previous;
    return;
  }
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('App Store session operation was aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    await Promise.race([previous, aborted]);
    throwIfAborted(signal);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function withSessionWorkspace<T>(operation: (homeDirectory: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const previous = sessionOperation;
  let release: () => void = () => {};
  sessionOperation = new Promise<void>((resolve) => { release = resolve; });
  let acquired = false;
  let homeDirectory: string | undefined;
  let result: T | undefined;
  let operationError: unknown;
  try {
    await waitForSessionOperation(previous, signal);
    acquired = true;
    throwIfAborted(signal);
    homeDirectory = await mkdtemp(path.join(SESSION_WORKSPACE_ROOT, 'dkrypt-appstore-session-'));
    await chmod(homeDirectory, 0o700);
    await restoreSessionWorkspace(homeDirectory);
    try {
      result = await operation(homeDirectory);
    } catch (error) {
      operationError = error;
    }
    await saveSessionWorkspace(homeDirectory);
  } catch (error) {
    if (operationError === undefined) operationError = error;
  } finally {
    try {
      if (homeDirectory) await rm(homeDirectory, { recursive: true, force: true });
    } finally {
      if (acquired) release();
      else void previous.then(release);
    }
  }
  if (operationError !== undefined) throw operationError;
  return result as T;
}

async function runDefaultDownload(job: Job, secrets: AppleAccountSecrets, outputPath: string, signal?: AbortSignal): Promise<void> {
  const result = await withSessionWorkspace((homeDirectory) => runAppStoreDownloaderRequest({
    commandPath: config.appStoreOfflineDownloaderBin,
    homeDirectory,
    cacheDirectory: path.join(config.stateDir, 'appstore-offline-cache'),
    memoryMb: config.appStoreOfflineWorkerMemoryMb,
    cpuSeconds: config.jobMaxWaitSeconds,
    request: {
      operation: 'download',
      apple_id: secrets.appleId,
      password: secrets.password,
      bundle_id: job.bundleId,
      external_version_id: job.externalVersionId,
      output_path: outputPath,
      max_bytes: config.artifactMaxBytes,
    },
    signal,
    childStarted: (child) => { job.childProcess = child; },
  }), signal).finally(() => { job.childProcess = undefined; });
  if (!result.response.ok) {
    log.warn('server-side App Store download failed', {
      jobId: job.id,
      bundleId: job.bundleId,
      stage: result.response.stage,
      code: result.response.code,
      diagnostic: sanitizeAppStoreDownloadDiagnostic(result.diagnostic, secrets),
    });
    const unavailableListing = unavailableAppStoreListingError(result.response);
    if (unavailableListing) throw unavailableListing;
    if (result.response.code === 'two_factor_required') {
      clearAppleAccountSessionSnapshot();
      markAppleAccountAuthenticationError('two_factor_required');
      throw new OfflineAppStoreAuthenticationError('two_factor_required');
    }
    if (result.response.code === 'authentication_required' || result.response.code === 'account_mismatch' || result.response.code === 'session_invalid') {
      clearAppleAccountSessionSnapshot();
      markAppleAccountAuthenticationError('authentication_failed');
    }
    throw new Error('App Store download failed');
  }
  markAppleAccountAuthenticated();
}

async function runDefaultDecrypt(job: Job, secrets: AppleAccountSecrets, inputPath: string, outputPath: string, signal?: AbortSignal, credentialValue?: string): Promise<void> {
  const credential = Buffer.from(credentialValue ?? '', 'base64');
  if (credential.length !== 16) {
    credential.fill(0);
    throw new Error('stored FairPlay credential is invalid');
  }
  try {
    await withTemporaryCredentialFile(credential, async (credentialPath) => {
      const decryptArgs = [inputPath, outputPath, '--credential', credentialPath];
      await invokeFairPlayDecryptor({
        commandPath: config.appStoreOfflineDecryptorBin,
        commandArgs: decryptArgs,
        memoryMb: config.appStoreOfflineWorkerMemoryMb,
        cpuSeconds: config.jobMaxWaitSeconds,
        job,
        signal,
        sensitiveValues: [inputPath, outputPath, credentialPath, secrets.appleId ?? '', secrets.password ?? '', secrets.fairPlayCredential ?? '', credentialValue ?? ''],
      });
    });
  } finally {
    credential.fill(0);
  }
}

export async function withTemporaryCredentialFile<T>(credential: Buffer, action: (credentialPath: string) => Promise<T>, memoryDirectory = '/dev/shm'): Promise<T> {
  const directory = await mkdtemp(path.join(memoryDirectory, 'dkrypt-fairplay-'));
  const credentialPath = path.join(directory, 'credential.bin');
  let file: FileHandle | undefined;
  try {
    await chmod(directory, 0o700);
    file = await open(credentialPath, 'wx', 0o600);
    await file.writeFile(credential);
    await file.sync();
    await file.close();
    file = undefined;
    return await action(credentialPath);
  } finally {
    await file?.close().catch(() => {});
    try {
      const existing = await open(credentialPath, 'r+');
      try {
        const info = await existing.stat();
        await existing.write(Buffer.alloc(info.size), 0, info.size, 0);
        await existing.sync();
      } finally {
        await existing.close();
      }
    } catch {}
    await rm(directory, { recursive: true, force: true });
  }
}

export async function authenticateAppleAccount(authCode?: string, signal?: AbortSignal): Promise<void> {
  if (authCode !== undefined && !/^\d{6}$/.test(authCode)) throw new Error('enter the six-digit Apple verification code');
  const secrets = readAppleAccountSecrets();
  if (!secrets) throw new OfflineAppStoreUnavailableError('Apple Account credentials are not configured');
  const result = await withSessionWorkspace(async (homeDirectory) => {
    const login = await runAppStoreDownloaderRequest({
      commandPath: config.appStoreOfflineDownloaderBin,
      homeDirectory,
      cacheDirectory: path.join(config.stateDir, 'appstore-offline-cache'),
      memoryMb: config.appStoreOfflineWorkerMemoryMb,
      cpuSeconds: config.appStoreOfflineAuthenticationTimeoutSeconds,
      request: {
        operation: 'authenticate',
        apple_id: secrets.appleId,
        password: secrets.password,
        verification_code: authCode,
      },
      signal,
    });
    if (!login.response.ok) return login;
    const status = await runAppStoreDownloaderRequest({
      commandPath: config.appStoreOfflineDownloaderBin,
      homeDirectory,
      cacheDirectory: path.join(config.stateDir, 'appstore-offline-cache'),
      memoryMb: config.appStoreOfflineWorkerMemoryMb,
      cpuSeconds: config.appStoreOfflineAuthenticationTimeoutSeconds,
      request: { operation: 'status' },
      signal,
    });
    return status.response.authenticated ? status : { ...status, response: { ok: false, code: 'authentication_failed' } };
  }, signal);
  if (!result.response.ok) {
    const responseCode = result.response.code ?? 'authentication_failed';
    const code = appleAuthenticationFailureCodeSet.has(responseCode)
      ? responseCode as AppleAuthenticationFailureCode
      : 'authentication_failed';
    log.warn('Apple Account authentication failed', { code });
    clearAppleAccountSessionSnapshot();
    markAppleAccountAuthenticationError(code);
    throw new OfflineAppStoreAuthenticationError(code);
  }
  markAppleAccountAuthenticated();
}

const appleAccountAuthenticationOperation = createAppleAccountAuthenticationOperation({
  authenticate: authenticateAppleAccount,
  repository: createOfflineAppStoreAuthenticationRepository(openStateCollectionDatabase({
    stateDir: config.stateDir,
    filename: config.stateDatabaseFile,
    busyTimeoutMs: config.stateDbBusyTimeoutMs,
  }, ['appstore_offline_authentication_operations'])),
  timeoutMs: config.appStoreOfflineAuthenticationTimeoutSeconds * 1000,
  onStatusChanged: () => offlineAppStoreDispatchNotifier(),
});

export const getAppleAccountAuthenticationStatus = appleAccountAuthenticationOperation.status;
export const startAppleAccountAuthentication = appleAccountAuthenticationOperation.start;
export const resetAppleAccountAuthentication = appleAccountAuthenticationOperation.reset;

export function setOfflineAppStoreDispatchNotifier(notifier: () => void): void {
  offlineAppStoreDispatchNotifier = notifier;
}

export function getOfflineAppStoreReadiness(job?: Pick<Job, 'testflight'>): OfflineAppStoreReadiness {
  return defaultProcessor.readiness(job);
}

export const offlineAppStoreProcessor = createOfflineAppStoreProcessor({
  enabled: config.appStoreOfflineDecryptEnabled,
  fairPlayAuthorized: config.appStoreOfflineFairPlayAuthorized,
  downloaderPath: config.appStoreOfflineDownloaderBin,
  decryptorPath: config.appStoreOfflineDecryptorBin,
  stagingDirectory: defaultStagingDirectory,
  getSecrets: readAppleAccountSecrets,
  getVaultStatus: getAppleAccountVaultStatus,
  runDownload: runDefaultDownload,
  runDecrypt: runDefaultDecrypt,
  getLicenseSelector: getIpaFairPlayLicenseSelector,
  retrieveCredentialForIpa: async (job, inputPath, signal) => {
    job.progress = 'Retrieving the matching FairPlay key from the paired iPad';
    appendJobTimelineEvent(job, 'Retrieving the matching FairPlay key from the paired iPad', 'running');
    emitJobsChanged();
    const { retrieveFairPlayCredentialForIpa } = await import('#offlineAppStoreCredential.js');
    return retrieveFairPlayCredentialForIpa(inputPath, signal, job.id);
  },
  saveCredentialForSelector: saveAppleAccountFairPlayCredentialForSelector,
  inspect: (ipaPath, signal, onChildProcess) => inspectIpaInIsolatedProcess(ipaPath, signal, onChildProcess),
});

const defaultProcessor = offlineAppStoreProcessor;
