import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '#config.js';
import type { ExtractedIpaMetadata } from '#util/ipaMetadata.js';
import type { FairPlayVerificationResult } from '#util/ipaFairPlay.js';
import type { IpaAnalysisReport, IpaAssetReport } from '#ipaAnalysis.js';
import type { IpaDeviceOptimizationResult } from '#ipaAnalysis.js';
import { terminateChildProcess } from '#jobs/process.js';
import { commandWithResourceLimits } from '#jobs/resourceLimits.js';

export interface IpaInspection {
  metadata: ExtractedIpaMetadata;
  verification: FairPlayVerificationResult;
}

interface IpaInspectionProcessResult {
  metadata: ExtractedIpaMetadata;
  verification: FairPlayVerificationResult;
}

const MAX_INSPECTION_OUTPUT_BYTES = 12 * 1024 * 1024;
const workerPath = fileURLToPath(new URL('./ipaInspectionWorker.ts', import.meta.url));

interface IpaInspectionWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class IpaInspectionCapacityError extends Error {
  readonly retryAfterSeconds = 5;

  constructor() {
    super('IPA analysis is busy; retry shortly');
  }
}

export class IpaInspectionCapacity {
  private active = 0;
  private readonly queue: IpaInspectionWaiter[] = [];

  constructor(private readonly maximumActive: number, private readonly maximumQueued: number) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('IPA inspection was cancelled'));
    if (this.active < this.maximumActive) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }
    if (this.queue.length >= this.maximumQueued) return Promise.reject(new IpaInspectionCapacityError());

    return new Promise((resolve, reject) => {
      const waiter: IpaInspectionWaiter = { resolve, reject, signal };
      waiter.onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(signal?.reason instanceof Error ? signal.reason : new Error('IPA inspection was cancelled'));
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.queue.push(waiter);
      if (signal?.aborted) waiter.onAbort();
    });
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.queue.shift();
      if (waiter) {
        if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
        waiter.resolve(this.createRelease());
      } else {
        this.active -= 1;
      }
    };
  }
}

const ipaAnalysisCapacity = new IpaInspectionCapacity(1, 2);

function workerCommand(ipaPath: string, mode: 'inspect' | 'analysis' | 'asset-preview' | 'optimize', extraArgs: string[] = []): string[] {
  const limited = commandWithResourceLimits(process.execPath, [workerPath, ipaPath, mode, ...extraArgs], config.appStoreOfflineWorkerMemoryMb, config.appStoreOfflineInspectTimeoutSeconds);
  return [limited.command, ...limited.args];
}

function runIpaWorker(
  ipaPath: string,
  mode: 'inspect' | 'analysis' | 'asset-preview' | 'optimize',
  extraArgs: string[] = [],
  signal?: AbortSignal,
  onChildProcess?: (child: ChildProcess | undefined) => void,
): Promise<unknown> {
  const operation = () => runIpaWorkerProcess(ipaPath, mode, extraArgs, signal, onChildProcess);
  return mode === 'inspect' ? operation() : ipaAnalysisCapacity.run(operation, signal);
}

function runIpaWorkerProcess(
  ipaPath: string,
  mode: 'inspect' | 'analysis' | 'asset-preview' | 'optimize',
  extraArgs: string[] = [],
  signal?: AbortSignal,
  onChildProcess?: (child: ChildProcess | undefined) => void,
): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('IPA inspection was cancelled'));

  return new Promise((resolve, reject) => {
    const [command, ...args] = workerCommand(ipaPath, mode, extraArgs);
    const child = spawn(command!, args, {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    onChildProcess?.(child);
    let stdout = Buffer.alloc(0);
    let stderr = '';
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let inspectionTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const clearTimers = () => {
      if (killTimer) clearTimeout(killTimer);
      if (inspectionTimer) clearTimeout(inspectionTimer);
      signal?.removeEventListener('abort', abort);
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      terminateChildProcess(child, 'SIGTERM');
      killTimer = setTimeout(() => terminateChildProcess(child, 'SIGKILL'), config.jobProcessGraceSeconds * 1000);
      killTimer.unref();
    };
    const abort = () => stop(signal?.reason instanceof Error ? signal.reason : new Error('IPA inspection was cancelled'));
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      onChildProcess?.(undefined);
      reject(error);
    };

    signal?.addEventListener('abort', abort, { once: true });
    inspectionTimer = setTimeout(() => stop(new Error('IPA inspection exceeded its time limit')), config.appStoreOfflineInspectTimeoutSeconds * 1000);
    inspectionTimer.unref();
    if (signal?.aborted) abort();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > MAX_INSPECTION_OUTPUT_BYTES) {
        stop(new Error('IPA inspection returned too much data'));
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4096);
    });
    child.once('error', (error) => fail(error));
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimers();
      onChildProcess?.(undefined);
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || `IPA inspection worker exited with code ${String(code)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.toString('utf8')));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export function inspectIpaInIsolatedProcess(
  ipaPath: string,
  signal?: AbortSignal,
  onChildProcess?: (child: ChildProcess | undefined) => void,
): Promise<IpaInspection> {
  return runIpaWorker(ipaPath, 'inspect', [], signal, onChildProcess).then((value) => {
    const result = value as IpaInspectionProcessResult;
    if (!result.metadata?.summary || !result.metadata.infoPlist || !result.verification?.primaryExecutable) throw new Error('IPA inspection worker returned an invalid result');
    return result;
  });
}

export function analyzeIpaInIsolatedProcess(
  ipaPath: string,
  signal?: AbortSignal,
  onChildProcess?: (child: ChildProcess | undefined) => void,
): Promise<IpaAnalysisReport> {
  return runIpaWorker(ipaPath, 'analysis', [], signal, onChildProcess).then((value) => {
    const result = value as IpaAnalysisReport;
    if (!Array.isArray(result.executables) || !Array.isArray(result.assets) || !Array.isArray(result.signing?.profiles)) throw new Error('IPA analysis worker returned an invalid result');
    return result;
  });
}

export function readIpaAssetPreviewInIsolatedProcess(
  ipaPath: string,
  assetPath: string,
  signal?: AbortSignal,
  onChildProcess?: (child: ChildProcess | undefined) => void,
): Promise<{ data: Buffer; mimeType: IpaAssetReport['mimeType'] }> {
  return runIpaWorker(ipaPath, 'asset-preview', [assetPath], signal, onChildProcess).then((value) => {
    const result = value as { data?: unknown; mimeType?: unknown };
    if (typeof result.data !== 'string' || !/^(?:image\/png|image\/jpeg|image\/gif|image\/webp)$/.test(String(result.mimeType))) throw new Error('IPA asset preview worker returned an invalid result');
    return { data: Buffer.from(result.data, 'base64'), mimeType: result.mimeType as IpaAssetReport['mimeType'] };
  });
}

export function optimizeIpaForDeviceInIsolatedProcess(
  ipaPath: string,
  outputPath: string,
  architecture: string,
  signal?: AbortSignal,
): Promise<{ optimization: IpaDeviceOptimizationResult; sha256: string }> {
  return runIpaWorker(ipaPath, 'optimize', [outputPath, architecture], signal).then((value) => {
    const result = value as { optimization?: IpaDeviceOptimizationResult; sha256?: unknown };
    if (!result.optimization || result.optimization.architecture !== architecture || result.optimization.binariesThinned < 1 || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256)) {
      throw new Error('optimized IPA worker returned an invalid result');
    }
    return { optimization: result.optimization, sha256: result.sha256 };
  });
}
