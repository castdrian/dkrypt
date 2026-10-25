import { describe, expect, it } from 'bun:test';
import { shouldRecordOfflineDeviceHandoff, shouldRecordQueueWait } from '#jobs/metrics.js';

describe('job metrics', () => {
  it('only records queue wait for the first attempt', () => {
    expect(shouldRecordQueueWait({})).toBeTrue();
    expect(shouldRecordQueueWait({ retryCount: 0 })).toBeTrue();
    expect(shouldRecordQueueWait({ retryCount: 1 })).toBeFalse();
  });

  it('records offline-to-device timing only for the first device fallback attempt', () => {
    const fallbackJob = { attempt: 2, offlineAttemptedAt: 100, offlineFailureReason: 'provider unavailable' };

    expect(shouldRecordOfflineDeviceHandoff(fallbackJob)).toBeTrue();
    expect(shouldRecordOfflineDeviceHandoff({ ...fallbackJob, attempt: 3 })).toBeFalse();
    expect(shouldRecordOfflineDeviceHandoff({ ...fallbackJob, offlineFailureReason: undefined })).toBeFalse();
  });
});
