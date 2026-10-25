export interface OfflineAttemptBudgetInput {
  now: number;
  deadlineAt?: number;
  maximumAttemptMs: number;
  fallbackReserveMs: number;
}

export function computeOfflineAttemptBudgetMs(input: OfflineAttemptBudgetInput): number {
  const maximumAttemptMs = Math.max(0, input.maximumAttemptMs);
  if (input.deadlineAt === undefined) return maximumAttemptMs;
  const availableBeforeDeadline = Math.max(0, input.deadlineAt - input.now - Math.max(0, input.fallbackReserveMs));
  return Math.min(maximumAttemptMs, availableBeforeDeadline);
}

export class OfflineAppStoreAttemptTimeoutError extends Error {
  constructor(message = 'server-side App Store attempt timed out; handing the job to a device') {
    super(message);
    this.name = 'OfflineAppStoreAttemptTimeoutError';
  }
}

export async function runWithOfflineAttemptTimeout<T>(
  operation: (signal: AbortSignal, reportActivity: () => void) => Promise<T>,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  onTimeout: () => void,
  cleanupTimeoutMs: number,
  onForceStop: () => void,
  stallTimeoutMs?: number,
): Promise<T> {
  if (parentSignal?.aborted) throw parentSignal.reason instanceof Error ? parentSignal.reason : new Error('operation aborted');
  if (timeoutMs <= 0) {
    onTimeout();
    throw new OfflineAppStoreAttemptTimeoutError();
  }

  const controller = new AbortController();
  const forwardParentAbort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', forwardParentAbort, { once: true });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let cleanupHandle: ReturnType<typeof setTimeout> | undefined;
  let stallHandle: ReturnType<typeof setTimeout> | undefined;
  let operationPromise: Promise<{ ok: true; value: T } | { ok: false; error: unknown }> | undefined;
  let stalled = false;
  let settled = false;
  const clearStallHandle = () => {
    if (stallHandle) clearTimeout(stallHandle);
    stallHandle = undefined;
  };
  const armStallHandle = () => {
    clearStallHandle();
    if (stallTimeoutMs === undefined || stallTimeoutMs <= 0 || settled) return;
    stallHandle = setTimeout(() => {
      stalled = true;
      resolveStall();
    }, stallTimeoutMs);
  };
  let resolveStall!: () => void;
  const stallPromise = new Promise<{ stalled: true }>((resolve) => {
    resolveStall = () => resolve({ stalled: true });
  });

  const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });

  try {
    operationPromise = Promise.resolve()
      .then(() => operation(controller.signal, armStallHandle))
      .then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
      .finally(() => { settled = true; clearStallHandle(); });
    armStallHandle();
    const outcome = await Promise.race([operationPromise, timeoutPromise, stallPromise]);
    if (!('timedOut' in outcome) && !('stalled' in outcome)) {
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    }

    const timeoutError = new OfflineAppStoreAttemptTimeoutError(stalled
      ? 'server-side App Store worker stopped making progress; handing the job to a device'
      : undefined);
    controller.abort(timeoutError);
    onTimeout();
    const stopped = await Promise.race([
      operationPromise.then(() => true),
      new Promise<false>((resolve) => {
        cleanupHandle = setTimeout(() => resolve(false), Math.max(0, cleanupTimeoutMs));
      }),
    ]);
    if (!stopped) {
      onForceStop();
      await operationPromise;
    }
    throw timeoutError;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (cleanupHandle) clearTimeout(cleanupHandle);
    clearStallHandle();
    parentSignal?.removeEventListener('abort', forwardParentAbort);
  }
}

export type OfflineCircuitState = 'closed' | 'open' | 'half_open';

export interface OfflineCircuitStatus {
  state: OfflineCircuitState;
  consecutiveFailures: number;
  nextProbeAt?: number;
}

export class OfflineAppStoreCircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt?: number;
  private probeInProgress = false;

  constructor(private readonly failureThreshold = 3, private readonly cooldownMs = 300_000) {
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) throw new RangeError('offline circuit failure threshold must be positive');
    if (!Number.isInteger(cooldownMs) || cooldownMs < 1) throw new RangeError('offline circuit cooldown must be positive');
  }

  getStatus(now = Date.now()): OfflineCircuitStatus {
    if (this.openedAt === undefined) return { state: 'closed', consecutiveFailures: this.consecutiveFailures };
    const nextProbeAt = this.openedAt + this.cooldownMs;
    return { state: now < nextProbeAt ? 'open' : 'half_open', consecutiveFailures: this.consecutiveFailures, nextProbeAt };
  }

  canStartAttempt(now = Date.now()): boolean {
    const status = this.getStatus(now);
    return status.state === 'closed' || (status.state === 'half_open' && !this.probeInProgress);
  }

  beginAttempt(now = Date.now()): boolean {
    if (!this.canStartAttempt(now)) return false;
    if (this.getStatus(now).state === 'half_open') this.probeInProgress = true;
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = undefined;
    this.probeInProgress = false;
  }

  recordFailure(now = Date.now()): void {
    if (this.probeInProgress) {
      this.consecutiveFailures = Math.max(this.failureThreshold, this.consecutiveFailures);
      this.openedAt = now;
      this.probeInProgress = false;
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) this.openedAt = now;
  }

  reset(): void {
    this.recordSuccess();
  }
}
