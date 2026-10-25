import { expect, test } from 'bun:test';
import { effectiveQueuePriority, sortQueuedByEffectivePriority } from '#jobs/fairQueue.js';

test('queue priority ages without removing the priority advantage of fresh work', () => {
  expect(effectiveQueuePriority({ priority: 0, createdAt: 0 }, 5 * 60_000)).toBe(0);
  expect(effectiveQueuePriority({ priority: 0, createdAt: 0 }, 10 * 60_000)).toBe(1);
  expect(effectiveQueuePriority({ priority: 5, createdAt: 0 }, 55 * 60_000)).toBe(6);
});

test('older work eventually moves ahead of newer higher-priority work without changing stored priority', () => {
  const older = { id: 'older', priority: 0, createdAt: 0 };
  const newer = { id: 'newer', priority: 5, createdAt: 55 * 60_000 };
  expect(sortQueuedByEffectivePriority([newer, older], 55 * 60_000).map(({ id }) => id)).toEqual(['older', 'newer']);
  expect(older.priority).toBe(0);
  expect(newer.priority).toBe(5);
});

test('queue ordering preserves manual order while effective priorities tie', () => {
  const first = { id: 'first', priority: 1, createdAt: 0 };
  const second = { id: 'second', priority: 0, createdAt: 0 };
  expect(sortQueuedByEffectivePriority([second, first], 30 * 60_000).map(({ id }) => id)).toEqual(['second', 'first']);
});
