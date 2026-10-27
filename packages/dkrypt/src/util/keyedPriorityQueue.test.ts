import { expect, test } from 'bun:test';
import { adaptiveTimeout, recordAdaptiveDuration } from '#util/adaptiveTimeout.js';
import { DeviceOperationPreemptedError, DeviceOperationQueueFullError, KeyedPriorityQueue } from '#util/keyedPriorityQueue.js';
import { SingleFlight } from '#util/singleFlight.js';

test('device queue runs foreground work before waiting background work', async () => {
  const queue = new KeyedPriorityQueue();
  const order: string[] = [];
  let releaseCurrent: (() => void) | undefined;
  const current = queue.run('device-a', 'normal', () => new Promise<void>((resolve) => { releaseCurrent = resolve; }));
  await Promise.resolve();
  const background = queue.run('device-a', 'background', async () => { order.push('background'); });
  const foreground = queue.run('device-a', 'foreground', async () => { order.push('foreground'); });
  releaseCurrent?.();
  await Promise.all([current, background, foreground]);
  expect(order).toEqual(['foreground', 'background']);
});

test('device queue aborts active background work before starting foreground work', async () => {
  const queue = new KeyedPriorityQueue();
  const order: string[] = [];
  let reportStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { reportStarted = resolve; });
  const background = queue.run('device-a', 'background', (signal) => new Promise<void>((_, reject) => {
    order.push('background-started');
    reportStarted?.();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  await started;
  const foreground = queue.run('device-a', 'foreground', async () => {
    order.push('foreground-started');
  });

  await expect(background).rejects.toBeInstanceOf(DeviceOperationPreemptedError);
  await foreground;
  expect(order).toEqual(['background-started', 'foreground-started']);
});

test('device queue holds its active slot until preempted background work settles', async () => {
  const queue = new KeyedPriorityQueue();
  let reportStarted: (() => void) | undefined;
  let finish: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { reportStarted = resolve; });
  const background = queue.run('device-a', 'background', (signal) => new Promise<void>((resolve) => {
    reportStarted?.();
    finish = resolve;
    signal.addEventListener('abort', () => {
      setTimeout(() => {
        finish?.();
      }, 10);
    }, { once: true });
  }));
  await started;
  let foregroundStarted = false;
  const foreground = queue.run('device-a', 'foreground', async () => {
    foregroundStarted = true;
  });
  await Promise.resolve();
  expect(foregroundStarted).toBe(false);
  await expect(background).rejects.toBeInstanceOf(DeviceOperationPreemptedError);
  await foreground;
  expect(foregroundStarted).toBe(true);
});

test('device queue isolates devices and removes cancelled queued work', async () => {
  const queue = new KeyedPriorityQueue();
  let releaseCurrent: (() => void) | undefined;
  const current = queue.run('device-a', 'normal', () => new Promise<void>((resolve) => { releaseCurrent = resolve; }));
  await Promise.resolve();
  const controller = new AbortController();
  const cancelled = queue.run('device-a', 'background', async () => 'cancelled', controller.signal);
  await expect(queue.run('device-b', 'foreground', async () => 'independent')).resolves.toBe('independent');
  controller.abort(new Error('cancelled by test'));
  await expect(cancelled).rejects.toThrow('cancelled by test');
  releaseCurrent?.();
  await current;
});

test('device queue bounds accumulated background work', async () => {
  const queue = new KeyedPriorityQueue(1);
  let releaseCurrent: (() => void) | undefined;
  const current = queue.run('device-a', 'normal', () => new Promise<void>((resolve) => { releaseCurrent = resolve; }));
  await Promise.resolve();
  const queued = queue.run('device-a', 'background', async () => undefined);
  await expect(queue.run('device-a', 'background', async () => undefined)).rejects.toBeInstanceOf(DeviceOperationQueueFullError);
  releaseCurrent?.();
  await Promise.all([current, queued]);
});

test('single-flight shares an in-flight lookup and clears it after completion', async () => {
  const flight = new SingleFlight<string, number>();
  let calls = 0;
  let finish: ((value: number) => void) | undefined;
  const first = flight.run('same request', () => {
    calls += 1;
    return new Promise<number>((resolve) => { finish = resolve; });
  });
  const second = flight.run('same request', async () => {
    calls += 1;
    return 2;
  });
  await Promise.resolve();
  finish?.(1);
  await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
  expect(calls).toBe(1);
  await expect(flight.run('same request', async () => 3)).resolves.toBe(3);
});

test('adaptive bridge timeout grows from recent slow completions and stays bounded', () => {
  const key = `device:${crypto.randomUUID()}`;
  recordAdaptiveDuration(key, 80, 1);
  recordAdaptiveDuration(key, 120, 2);
  recordAdaptiveDuration(key, 300, 3);
  expect(adaptiveTimeout(key, 100, 4)).toBe(300);
  recordAdaptiveDuration(key, 10_000, 5);
  expect(adaptiveTimeout(key, 100, 6)).toBe(300);
});
