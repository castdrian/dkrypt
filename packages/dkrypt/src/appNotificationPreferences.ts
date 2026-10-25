import type { UserPrefs } from '#store/state.js';

export interface JobNotificationChannels {
  push: boolean;
  email: boolean;
}

export function resolveJobNotificationChannels(
  preferences: UserPrefs,
  bundleId: string,
  outcome: 'success' | 'failure',
): JobNotificationChannels {
  const appPreferences = preferences.appNotificationPreferences?.find((preference) =>
    preference.bundleId.toLowerCase() === bundleId.toLowerCase(),
  );
  const pushKey = outcome === 'success' ? 'pushOnSuccess' : 'pushOnFailure';
  const emailKey = outcome === 'success' ? 'emailOnSuccess' : 'emailOnFailure';
  return {
    push: appPreferences?.[pushKey] ?? preferences[pushKey] ?? true,
    email: appPreferences?.[emailKey] ?? preferences[emailKey] ?? false,
  };
}
