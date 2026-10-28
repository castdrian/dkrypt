import { describe, expect, test } from 'bun:test';
import { normalizeVersionSelector, resolveDecryptTarget, resolveLatestTestFlightTarget, VERSION_SELECTOR_RE } from './decryptTarget.js';

describe('decrypt version selectors', () => {
  test('accepts stable and TestFlight tag shapes', () => {
    for (const selector of ['240', '234.2', 'v240', '240_109440', 'v234.2_109440']) {
      expect(VERSION_SELECTOR_RE.test(selector)).toBe(true);
      expect(normalizeVersionSelector(selector)).toBe(selector.replace(/^v/i, ''));
    }
  });

  test('rejects non-tag input and treats blank as latest', () => {
    expect(normalizeVersionSelector('')).toBeUndefined();
    expect(normalizeVersionSelector(undefined)).toBeUndefined();
    for (const selector of ['latest', '240-beta', '240_']) {
      expect(() => normalizeVersionSelector(selector)).toThrow(/version/);
    }
    expect(() => normalizeVersionSelector('release-240')).toThrow(/version/);
  });
});

describe('latest TestFlight target resolution', () => {
  test('selects the newest unexpired build for the highest available train', async () => {
    const buildLookups: string[] = [];
    const result = await resolveLatestTestFlightTarget('com.example.app', {
      lookupAppMetadata: async (bundleId) => ({ bundleId, trackId: 123, trackName: 'Example', sellerName: 'Seller', artworkUrl: '', version: '1.0' }),
      listTrains: async () => [
        { trainVersion: '3.0', buildCount: 2 },
        { trainVersion: '2.9', buildCount: 1 },
      ],
      listBuilds: async (_appId, trainVersion) => {
        buildLookups.push(trainVersion);
        if (trainVersion === '3.0') return [
          { id: 3001, cfBundleShortVersion: '3.0', cfBundleVersion: '118976', bundleId: 'com.example.other' },
          { id: 3002, cfBundleShortVersion: '3.0', cfBundleVersion: '118975', bundleId: 'com.example.app', expiration: '2020-01-01T00:00:00Z' },
          { id: 3003, cfBundleShortVersion: '3.0', cfBundleVersion: '118977', bundleId: 'com.example.app' },
        ];
        return [{ id: 2901, cfBundleShortVersion: '2.9', cfBundleVersion: '118999', bundleId: 'com.example.app' }];
      },
    });

    expect(result).toMatchObject({
      bundleId: 'com.example.app',
      selector: '3.0_118977',
      channel: 'testflight',
      testflight: { appId: 123, build: { id: 3003 } },
      versionLabel: '3.0_118977',
    });
    expect(buildLookups).toEqual(['3.0']);
  });

  test('falls back to an older train when its newest build is expired', async () => {
    const result = await resolveLatestTestFlightTarget('com.example.app', {
      lookupAppMetadata: async (bundleId) => ({ bundleId, trackId: 123, trackName: 'Example', sellerName: 'Seller', artworkUrl: '', version: '1.0' }),
      listTrains: async () => [{ trainVersion: '3.0', buildCount: 1 }, { trainVersion: '2.9', buildCount: 1 }],
      listBuilds: async (_appId, trainVersion) => trainVersion === '3.0'
        ? [{ id: 3001, cfBundleShortVersion: '3.0', cfBundleVersion: '1', bundleId: 'com.example.app', expiration: '2020-01-01T00:00:00Z' }]
        : [{ id: 2901, cfBundleShortVersion: '2.9', cfBundleVersion: '8', bundleId: 'com.example.app' }],
    });

    expect(result.versionLabel).toBe('2.9_8');
  });

  test('fails when no unexpired TestFlight build matches the bundle ID', async () => {
    await expect(resolveLatestTestFlightTarget('com.example.app', {
      lookupAppMetadata: async (bundleId) => ({ bundleId, trackId: 123, trackName: 'Example', sellerName: 'Seller', artworkUrl: '', version: '1.0' }),
      listTrains: async () => [{ trainVersion: '3.0', buildCount: 1 }],
      listBuilds: async () => [{ id: 3001, cfBundleShortVersion: '3.0', cfBundleVersion: '1', bundleId: 'com.example.other' }],
    })).rejects.toThrow('no available TestFlight build');
  });
});

describe('platform App Store target resolution', () => {
  test.each([
    ['tvos', 'tvOS', 'com.example.tv', '2.4', 'tv-version-24', '17.0'],
    ['visionos', 'visionOS', 'com.example.spatial', '1.3', 'vision-version-13', '2.0'],
  ] as const)('resolves the current %s release without using iOS version records', async (platform, label, bundleId, version, externalVersionId, minimumOsVersion) => {
    const calls: unknown[][] = [];
    const target = await resolveDecryptTarget(bundleId, undefined, platform, {
      lookupAppMetadata: async () => { throw new Error('iOS metadata lookup must not run'); },
      listTrains: async () => { throw new Error('TestFlight lookup must not run'); },
      listBuilds: async () => { throw new Error('TestFlight lookup must not run'); },
      listAppVersions: async () => { throw new Error('iOS version lookup must not run'); },
      lookupCurrentPlatformVersion: async (requestedBundleId, requestedPlatform) => {
        calls.push([requestedBundleId, requestedPlatform]);
        return { bundleId: requestedBundleId, trackId: 42, version, externalVersionId, minimumOsVersion };
      },
    });

    expect(target).toMatchObject({
      bundleId,
      platform,
      channel: 'appstore',
      externalVersionId,
      versionLabel: version,
      minimumOsVersion,
    });
    expect(target.artifactKey).toContain(platform);
    expect(calls).toEqual([[bundleId, platform]]);
    expect(label).toBe(platform === 'tvos' ? 'tvOS' : 'visionOS');
  });

  test('rejects stale platform releases and TestFlight selectors for non-iOS platforms', async () => {
    const services = {
      lookupAppMetadata: async () => { throw new Error('iOS metadata lookup must not run'); },
      listTrains: async () => { throw new Error('TestFlight lookup must not run'); },
      listBuilds: async () => { throw new Error('TestFlight lookup must not run'); },
      listAppVersions: async () => [],
      lookupCurrentPlatformVersion: async (bundleId: string) => ({ bundleId, trackId: 42, version: '4.0', externalVersionId: 'platform-version-40' }),
    };

    await expect(resolveDecryptTarget('com.example.tv', '3.9', 'tvos', services)).rejects.toThrow('Only the latest tvOS release is supported');
    await expect(resolveDecryptTarget('com.example.spatial', '4.0_12', 'visionos', services)).rejects.toThrow('TestFlight builds are available only for iOS');
  });
});
