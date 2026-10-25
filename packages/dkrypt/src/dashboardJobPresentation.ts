import { getAuthProfile } from '#identity.js';
import { jobFileAvailable } from '#jobs/http.js';
import { getJob } from '#jobs/store.js';
import { artifactFileAvailable, getArtifactById, getArtifactBySourceJobId, getArtifactForJob } from '#artifacts.js';
import { type JobHistoryEntry } from '#store/state.js';

export function dashboardHistoryEntry(entry: JobHistoryEntry) {
  const { projectId: _projectId, ...visibleEntry } = entry;
  const job = getJob(entry.id);
  const artifact =
    (entry.artifactId ? getArtifactById(entry.artifactId) : undefined) ??
    (job ? getArtifactForJob(job) : undefined) ??
    getArtifactBySourceJobId(entry.id);
  const fileAvailable = artifact ? artifactFileAvailable(artifact) : jobFileAvailable(job);
  return {
    ...visibleEntry,
    requester: dashboardJobRequester(entry),
    downloadUrl: artifact && fileAvailable ? `/v1/dashboard/artifacts/${encodeURIComponent(artifact.id)}/file` : undefined,
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
