import { getAuthProfile } from '#identity.js';
import { jobFileAvailable } from '#jobs/http.js';
import { getJob } from '#jobs/store.js';
import { artifactFileAvailable, getArtifactById, getArtifactBySourceJobId, getArtifactForJob } from '#artifacts.js';
import { type JobHistoryEntry } from '#store/state.js';

export function redactMemberJobHistoryEntry(entry: JobHistoryEntry) {
  return {
    ...entry,
    deviceId: undefined,
    transport: undefined,
    artifactId: undefined,
    sha256: undefined,
    executionPath: undefined,
    offlineAttemptedAt: undefined,
    offlineAttemptDurationMs: undefined,
    offlineDeviceFallbackStartedAt: undefined,
    deviceFallbackDurationMs: undefined,
    offlineFailureReason: undefined,
    queueReason: undefined,
    failureClass: undefined,
    deadlineAt: undefined,
  };
}

export function dashboardHistoryEntry(entry: JobHistoryEntry, memberView = false) {
  const { projectId: _projectId, ...visibleEntry } = entry;
  const job = getJob(entry.id);
  const artifact =
    (entry.artifactId ? getArtifactById(entry.artifactId) : undefined) ??
    (job ? getArtifactForJob(job) : undefined) ??
    getArtifactBySourceJobId(entry.id);
  const fileAvailable = entry.freeTierResult ? jobFileAvailable(job) : artifact ? artifactFileAvailable(artifact) : jobFileAvailable(job);
  const downloadUrl = entry.freeTierResult && fileAvailable
    ? `/v1/dashboard/jobs/${encodeURIComponent(entry.id)}/file`
    : artifact && fileAvailable
      ? `/v1/dashboard/artifacts/${encodeURIComponent(artifact.id)}/file`
      : undefined;
  return {
    ...visibleEntry,
    ...(memberView ? redactMemberJobHistoryEntry(visibleEntry) : {}),
    requester: dashboardJobRequester(entry),
    downloadUrl,
    fileAvailable,
  };
}

function dashboardJobRequester(entry: JobHistoryEntry) {
  if (entry.source === 'scheduler') return { displayName: 'System', avatarUrl: '/favicon.svg' };
  if (!entry.queuedBy) return { displayName: 'Unknown' };
  const profile = getAuthProfile(entry.queuedBy);
  return {
    username: profile?.username ?? entry.queuedBy,
    displayName: profile?.displayName ?? entry.queuedBy,
    avatarUrl: profile?.avatarUrl,
  };
}
