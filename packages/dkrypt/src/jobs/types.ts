import type { ChildProcess } from 'node:child_process';
import type { DeviceTransport } from '#apiCommonContracts.js';
import type { TFBuild } from '#testflight.js';
import type { IpaMetadata } from '#store/state.js';
import type { TraceContext } from '#telemetry.js';
import type { JobFailureClass } from '#util/failureCategory.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export type JobSource = 'manual' | 'scheduler';

export type JobExecutionStage = 'preparing' | 'installing' | 'decrypting' | 'offline_download' | 'offline_decrypting' | 'finalizing';
export type JobExecutionPath = 'appstore_offline' | 'device' | 'device_fallback';

export type { JobFailureClass } from '#util/failureCategory.js';

export interface TestFlightJobSource {
  appId: number;
  build: TFBuild;
}

export interface JobTimelineEvent {
  at: number;
  label: string;
  status: JobStatus;
}

export interface Job {
  id: string;
  correlationId?: string;
  parentCorrelationId?: string;
  traceContext?: TraceContext;
  projectId?: string;
  bundleId: string;
  externalVersionId?: string;
  testflight?: TestFlightJobSource;
  versionLabel?: string;
  minimumOsVersion?: string;
  source: JobSource;
  queuedBy?: string;
  billingOwnerId?: string;
  apiKeyId?: string;
  preferredDeviceId?: string;
  priority: number;
  status: JobStatus;
  executionStage?: JobExecutionStage;
  executionPath?: JobExecutionPath;
  offlineAttemptedAt?: number;
  offlineDeviceFallbackStartedAt?: number;
  offlineFailureReason?: string;
  progress: string;
  timeline?: JobTimelineEvent[];
  warnings?: string[];
  error?: string;
  queueReason?: string;
  lastQueueReason?: string;
  retryCount?: number;
  attempt?: number;
  deadlineAt?: number;
  schedulerDeadlineAt?: number;
  deadlineExceeded?: boolean;
  shutdownRecoveryPending?: boolean;
  shutdownRecoveryAt?: number;
  failureClass?: JobFailureClass;
  cancelledBy?: string;
  childProcess?: ChildProcess;
  artifactId?: string;
  cacheHit?: boolean;
  filePath?: string;
  fileSizeBytes?: number;
  sha256?: string;
  deviceId?: string;
  transport?: DeviceTransport;
  ipaMetadata?: IpaMetadata;
  ipaInfoPlist?: Record<string, unknown>;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  downloadedAt?: number;
  waiters: Array<(job: Job) => void>;
}

export function appendJobTimelineEvent(job: Job, label: string, status: JobStatus, at = Date.now()): void {
  const events = job.timeline ?? (job.timeline = []);
  if (events.at(-1)?.label === label) return;
  events.push({ at, label, status });
  if (events.length > 80) events.splice(0, events.length - 80);
}
