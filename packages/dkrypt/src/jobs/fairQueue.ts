export interface QueuePriorityRecord {
  priority: number;
  createdAt: number;
}

export const QUEUE_PRIORITY_AGING_INTERVAL_MS = 5 * 60_000;
const MIN_PRIORITY = -5;
const MAX_PRIORITY = 5;

export function effectiveQueuePriority(job: QueuePriorityRecord, now = Date.now()): number {
  const ageSteps = Math.floor(Math.max(0, now - job.createdAt) / QUEUE_PRIORITY_AGING_INTERVAL_MS);
  const priority = Math.min(MAX_PRIORITY, Math.max(MIN_PRIORITY, job.priority));
  const agingRate = (MAX_PRIORITY + 1 - priority) / (MAX_PRIORITY - MIN_PRIORITY + 1);
  return priority + Math.floor(ageSteps * agingRate);
}

export function sortQueuedByEffectivePriority<T extends QueuePriorityRecord>(jobs: T[], now = Date.now()): T[] {
  return jobs
    .map((job, index) => ({ job, index, score: effectiveQueuePriority(job, now) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ job }) => job);
}
