import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import { commandWithResourceLimits } from '#jobs/resourceLimits.js';
import { terminateChildProcess } from '#jobs/process.js';

const MAX_DOWNLOADER_OUTPUT_BYTES = 8192;

export interface AppStoreDownloaderResponse {
  ok: boolean;
  authenticated?: boolean;
  free_license_claimed?: boolean;
  storefront_country?: string;
  stage?: string;
  code?: string;
  diagnostic?: string;
  network_reachable?: boolean;
  network_latency_ms?: number;
  network_endpoint?: string;
  network_redirected?: boolean;
  network_range_supported?: boolean;
  network_rate_limited?: boolean;
  network_retry_after_seconds?: number;
}

export interface AppStoreDownloaderRequestOptions {
  commandPath: string;
  commandArgs?: string[];
  homeDirectory: string;
  cacheDirectory: string;
  memoryMb: number;
  cpuSeconds: number;
  request: Record<string, unknown>;
  signal?: AbortSignal;
  childStarted?: (child: ChildProcess) => void;
  onActivity?: () => void;
}

function childInput(child: ChildProcess): Writable {
  if (!child.stdin) throw new Error('App Store downloader input channel is unavailable');
  child.stdin.on('error', () => {});
  return child.stdin;
}

function appendTail(current: string, chunk: Buffer | string): string {
  return `${current}${chunk.toString()}`.slice(-MAX_DOWNLOADER_OUTPUT_BYTES);
}

function parseResponse(output: string): AppStoreDownloaderResponse {
  let response: unknown;
  try {
    response = JSON.parse(output.trim());
  } catch {
    throw new Error('App Store downloader returned an invalid response');
  }
  if (!response || typeof response !== 'object' || typeof (response as AppStoreDownloaderResponse).ok !== 'boolean') {
    throw new Error('App Store downloader returned an invalid response');
  }
  const parsed = response as AppStoreDownloaderResponse;
  if (parsed.free_license_claimed !== undefined && typeof parsed.free_license_claimed !== 'boolean') {
    throw new Error('App Store downloader returned an invalid response');
  }
  if (parsed.storefront_country !== undefined && (typeof parsed.storefront_country !== 'string' || !/^[A-Z]{2}$/.test(parsed.storefront_country))) {
    throw new Error('App Store downloader returned an invalid response');
  }
  return parsed;
}

export async function runAppStoreDownloaderRequest(options: AppStoreDownloaderRequestOptions): Promise<{
  response: AppStoreDownloaderResponse;
  diagnostic: string;
}> {
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error ? options.signal.reason : new Error('App Store operation was cancelled');
  }
  const limited = commandWithResourceLimits(
    options.commandPath,
    options.commandArgs ?? [],
    options.memoryMb,
    options.cpuSeconds,
  );
  const child = spawn(limited.command, limited.args, {
    cwd: options.homeDirectory,
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: options.homeDirectory,
      XDG_CONFIG_HOME: `${options.homeDirectory}/config`,
      XDG_STATE_HOME: `${options.homeDirectory}/state`,
      XDG_DATA_HOME: `${options.homeDirectory}/data`,
      DKRYPT_APPSTORE_CACHE_DIR: options.cacheDirectory,
      LANG: 'C.UTF-8',
      ...(process.platform === 'linux' ? { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent' } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  options.childStarted?.(child);
  const input = childInput(child);
  const payload = Buffer.from(JSON.stringify(options.request));
  let stdout = '';
  let stderr = '';
  let closed = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

  const abort = () => {
    if (closed) return;
    terminateChildProcess(child, 'SIGTERM');
    forceKillTimer = setTimeout(() => {
      if (!closed) terminateChildProcess(child, 'SIGKILL');
    }, 5_000);
    forceKillTimer.unref?.();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  child.stdout?.on('data', (chunk) => { stdout = appendTail(stdout, chunk); options.onActivity?.(); });
  child.stderr?.on('data', (chunk) => { stderr = appendTail(stderr, chunk); options.onActivity?.(); });

  const result = await new Promise<{ code: number | null }>((resolve, reject) => {
    child.once('error', (error) => {
      closed = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener('abort', abort);
      payload.fill(0);
      reject(error);
    });
    child.once('close', (code) => {
      closed = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener('abort', abort);
      payload.fill(0);
      resolve({ code });
    });
    input.end(payload, () => payload.fill(0));
  });

  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error ? options.signal.reason : new Error('App Store operation was cancelled');
  }
  if (result.code === null) throw new Error('App Store downloader exited without a status');
  const response = parseResponse(stdout);
  if (result.code !== 0 && response.ok) {
    throw new Error(`App Store downloader exited with status ${result.code}`);
  }
  return { response, diagnostic: `${stdout}\n${stderr}`.trim() };
}
