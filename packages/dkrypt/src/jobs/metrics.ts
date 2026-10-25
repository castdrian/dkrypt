import { incrementMetric, observeMetric } from '#metrics.js';
import type { Job } from '#jobs/types.js';

export function shouldRecordQueueWait(job: Pick<Job, 'retryCount'>): boolean {
  return (job.retryCount ?? 0) === 0;
}

export function shouldRecordOfflineDeviceHandoff(job: Pick<Job, 'attempt' | 'offlineAttemptedAt' | 'offlineFailureReason'>): boolean {
  return job.attempt === 2 && job.offlineAttemptedAt !== undefined && Boolean(job.offlineFailureReason);
}

export function recordJobStarted(job: Pick<Job, 'source' | 'createdAt' | 'retryCount'>, startedAt: number): void {
  incrementMetric('jobs_started_total', { source: job.source });
  if (shouldRecordQueueWait(job)) observeMetric('job_queue_wait_ms', Math.max(0, startedAt - job.createdAt), { source: job.source });
}
