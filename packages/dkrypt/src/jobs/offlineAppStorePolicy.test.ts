import { expect, test } from 'bun:test';
import { computeOfflineAttemptBudgetMs, OfflineAppStoreAttemptTimeoutError, OfflineAppStoreCircuitBreaker, runWithOfflineAttemptTimeout } from '#jobs/offlineAppStorePolicy.js';

test('offline App Store attempt leaves the configured device-fallback reserve', () => {
  expect(computeOfflineAttemptBudgetMs({ now: 1_000, deadlineAt: 121_000, maximumAttemptMs: 90_000, fallbackReserveMs: 30_000 })).toBe(90_000);
  expect(computeOfflineAttemptBudgetMs({ now: 1_000, deadlineAt: 91_000, maximumAttemptMs: 90_000, fallbackReserveMs: 30_000 })).toBe(60_000);
  expect(computeOfflineAttemptBudgetMs({ now: 1_000, deadlineAt: 25_000, maximumAttemptMs: 90_000, fallbackReserveMs: 30_000 })).toBe(0);
  expect(computeOfflineAttemptBudgetMs({ now: 1_000, deadlineAt: undefined, maximumAttemptMs: 90_000, fallbackReserveMs: 30_000 })).toBe(90_000);
});

test('offline App Store timeout aborts and returns a fallback-specific error', async () => {
  let timedOut = false;
  await expect(runWithOfflineAttemptTimeout(
    (signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    undefined,
    5,
    () => { timedOut = true; },
    50,
    () => {},
  )).rejects.toBeInstanceOf(OfflineAppStoreAttemptTimeoutError);
  expect(timedOut).toBeTrue();
});

test('offline fallback waits for the timed-out worker to stop', async () => {
  let operationStopped = false;
  await expect(runWithOfflineAttemptTimeout(
    (signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        setTimeout(() => {
          operationStopped = true;
          reject(signal.reason);
        }, 5);
      }, { once: true });
    }),
    undefined,
    1,
    () => {},
    50,
    () => {},
  )).rejects.toBeInstanceOf(OfflineAppStoreAttemptTimeoutError);
  expect(operationStopped).toBeTrue();
});

test('offline fallback force-stops an operation that ignores its abort signal', async () => {
  let releaseOperation: (() => void) | undefined;
  let forceStopped = false;
  await expect(runWithOfflineAttemptTimeout(
    () => new Promise<void>((_resolve, reject) => {
      releaseOperation = () => reject(new Error('process stopped'));
    }),
    undefined,
    1,
    () => {},
    1,
    () => {
      forceStopped = true;
      releaseOperation?.();
    },
  )).rejects.toBeInstanceOf(OfflineAppStoreAttemptTimeoutError);
  expect(forceStopped).toBeTrue();
});

test('offline App Store circuit breaker allows a single probe after cooldown', () => {
  const circuit = new OfflineAppStoreCircuitBreaker(3, 1_000);
  circuit.recordFailure(100);
  circuit.recordFailure(200);
  expect(circuit.canStartAttempt(300)).toBeTrue();
  circuit.recordFailure(400);
  expect(circuit.getStatus(999)).toMatchObject({ state: 'open', consecutiveFailures: 3, nextProbeAt: 1_400 });
  expect(circuit.canStartAttempt(1_399)).toBeFalse();
  expect(circuit.canStartAttempt(1_400)).toBeTrue();
  expect(circuit.beginAttempt(1_400)).toBeTrue();
  expect(circuit.canStartAttempt(1_400)).toBeFalse();
  circuit.recordFailure(1_500);
  expect(circuit.getStatus(1_500)).toMatchObject({ state: 'open', consecutiveFailures: 3, nextProbeAt: 2_500 });
  expect(circuit.canStartAttempt(2_500)).toBeTrue();
  expect(circuit.beginAttempt(2_500)).toBeTrue();
  circuit.recordSuccess();
  expect(circuit.getStatus(2_500)).toMatchObject({ state: 'closed', consecutiveFailures: 0 });
});
