export type AppStorePlatform = 'ios' | 'tvos' | 'visionos';

export function appStorePlatformForDownloader(platform: AppStorePlatform): 'iphone' | 'appletv' | 'visionos' {
  if (platform === 'tvos') return 'appletv';
  if (platform === 'visionos') return 'visionos';
  return 'iphone';
}

export function appStorePlatformLabel(platform: AppStorePlatform): string {
  if (platform === 'tvos') return 'tvOS';
  if (platform === 'visionos') return 'visionOS';
  return 'iOS';
}
