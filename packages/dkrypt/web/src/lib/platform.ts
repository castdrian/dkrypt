export type AppStorePlatform = 'ios' | 'tvos' | 'visionos';

export function appStorePlatformLabel(platform: AppStorePlatform): string {
  if (platform === 'tvos') return 'tvOS';
  if (platform === 'visionos') return 'visionOS';
  return 'iOS';
}
