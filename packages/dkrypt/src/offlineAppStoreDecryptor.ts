import { spawn } from 'node:child_process';
import type { Job } from '#jobs/types.js';
import { commandWithResourceLimits } from '#jobs/resourceLimits.js';
import { terminateChildProcess } from '#jobs/process.js';

const MAX_DECRYPTOR_STDERR_CHARACTERS = 8192;
const DEFAULT_DIAGNOSTIC_LIMIT = 1000;

export interface FairPlayDecryptorInvocation {
  commandPath: string;
  commandArgs: string[];
  memoryMb: number;
  cpuSeconds: number;
  job: Job;
  signal?: AbortSignal;
  sensitiveValues?: string[];
  diagnosticLimit?: number;
  onActivity?: () => void;
}

function appendTail(current: string, chunk: Buffer | string): string {
  return `${current}${chunk.toString()}`.slice(-MAX_DECRYPTOR_STDERR_CHARACTERS);
}

function sanitizeDiagnostic(stderr: string, sensitiveValues: string[], limit: number): string {
  let safe = stderr
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  for (const value of [...sensitiveValues].filter(Boolean).sort((left, right) => right.length - left.length)) {
    safe = safe.split(value).join('[redacted]');
  }
  safe = safe.replace(/\/(?:[^/\s:'"]+\/)*[^/\s:'"]+/g, '[path]');
  const lines = safe.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(-2).join(' | ').slice(-limit);
}

export async function invokeFairPlayDecryptor(options: FairPlayDecryptorInvocation): Promise<void> {
  const limited = commandWithResourceLimits(options.commandPath, options.commandArgs, options.memoryMb, options.cpuSeconds);
  const child = spawn(limited.command, limited.args, {
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32',
  });
  options.job.childProcess = child;

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
  child.stderr?.on('data', (chunk) => { stderr = appendTail(stderr, chunk); options.onActivity?.(); });

  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', (error) => {
        closed = true;
        const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
        reject(new Error(`FairPlay decryptor could not start (${code})`));
      });
      child.once('close', (code, signal) => {
        closed = true;
        resolve({ code, signal });
      });
    });

    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error('offline decryption was cancelled');
    }
    if (result.code !== 0) {
      const status = result.code === null ? `signal ${result.signal ?? 'unknown'}` : `exit ${result.code}`;
      const diagnostic = sanitizeDiagnostic(stderr, options.sensitiveValues ?? [], options.diagnosticLimit ?? DEFAULT_DIAGNOSTIC_LIMIT);
      throw new Error(`FairPlay decryption failed (${status})${diagnostic ? `: ${diagnostic}` : ''}`);
    }
  } finally {
    closed = true;
    if (forceKillTimer) clearTimeout(forceKillTimer);
    options.signal?.removeEventListener('abort', abort);
    if (options.job.childProcess === child) options.job.childProcess = undefined;
  }
}
