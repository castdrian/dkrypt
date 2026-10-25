import { expect, test } from 'bun:test';
import { resolveJobNotificationChannels } from '#appNotificationPreferences.js';

test('app-specific job notification settings override global preferences only for the matching app and channel', () => {
  const preferences = {
    pushOnSuccess: true,
    pushOnFailure: true,
    emailOnSuccess: false,
    emailOnFailure: false,
    appNotificationPreferences: [
      { bundleId: 'com.example.app', pushOnFailure: false, emailOnFailure: true },
    ],
  };

  expect(resolveJobNotificationChannels(preferences, 'COM.EXAMPLE.APP', 'failure')).toEqual({ push: false, email: true });
  expect(resolveJobNotificationChannels(preferences, 'com.example.app', 'success')).toEqual({ push: true, email: false });
  expect(resolveJobNotificationChannels(preferences, 'com.other.app', 'failure')).toEqual({ push: true, email: false });
});

test('job notification defaults preserve existing push and email behavior', () => {
  expect(resolveJobNotificationChannels({}, 'com.example.app', 'success')).toEqual({ push: true, email: false });
  expect(resolveJobNotificationChannels({}, 'com.example.app', 'failure')).toEqual({ push: true, email: false });
});
