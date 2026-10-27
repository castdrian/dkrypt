import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const calls: string[] = [];
const progress: string[] = [];
type InstalledBundle = { path: string; shortVersion: string };

let installedBundles: Array<InstalledBundle | undefined> = [];
let lastInstalledBundle: InstalledBundle | undefined;
let installRequest: Record<string, unknown> | undefined;
let installRequests: Record<string, unknown>[] = [];
let installStatus: Record<string, unknown> = {};
let installStatusAfterRequest: Record<string, unknown> | undefined;
let installStatusSequence: Record<string, unknown>[] = [];
let deviceInstallStatus: Record<string, unknown> | undefined;
let deviceInstallStatusErrors = 0;
let guardedUninstallFails = false;
let foregroundStatuses: boolean[] = [];
let bridgeStatusErrors = 0;
let postInstallStatusErrors = 0;
let postInstallStatusSuccesses = 0;
let foregroundRequests = 0;
let listingPrice = 0;
let listingBundleId = '';
let deviceStorefrontCode = 'USA';
let deviceStorefrontReadError = false;
let currentVersionCountry: string | undefined;
let localizedLookupError = false;
let localizedListingPrice = 0;
let localizedListingBundleId = '';
const originalSetTimeout = globalThis.setTimeout;
const originalDateNow = Date.now;

const idevice = await import('#idevice.js');
const itunes = await import('#appStoreMetadata.js');
const state = await import('#store/state.js');

mock.module('#idevice.js', () => ({
  ...idevice,
  armAppStoreAutoConfirm: async () => calls.push('arm'),
  clearAppStoreAutoConfirm: async () => calls.push('clear'),
  execCommand: async (_conn: object, _command: string) => {
    calls.push('restart');
    return { stdout: '', stderr: '', code: 0 };
  },
  findInstalledAppStoreBundle: async () => {
    lastInstalledBundle = installedBundles.shift();
    return lastInstalledBundle?.path;
  },
  isAppStoreRunning: async () => true,
  readInstalledBundleVersions: async () => ({ shortVersion: lastInstalledBundle?.shortVersion, buildVersion: '106000' }),
  readAppStoreInstallStatus: async () => {
    if (deviceInstallStatusErrors > 0) {
      deviceInstallStatusErrors -= 1;
      throw new Error('device install status file unavailable');
    }
    return deviceInstallStatus;
  },
  sendAppStoreBridgeRequest: async (_conn: object, request: Record<string, unknown>) => {
    if (request.action === 'status') {
      calls.push('status');
      if (installRequest && postInstallStatusSuccesses > 0) postInstallStatusSuccesses -= 1;
      else if (installRequest && postInstallStatusErrors > 0) {
        postInstallStatusErrors -= 1;
        throw new Error('could not publish bridge request: command timed out');
      }
      if (bridgeStatusErrors > 0) {
        bridgeStatusErrors -= 1;
        throw new Error('status request timed out');
      }
      if (installRequest && installStatusSequence.length > 0) installStatus = installStatusSequence.shift()!;
      return { capabilities: ['install', 'status', 'diagnostics', 'foreground_status', 'localized_install_titles', 'storefront', 'protocol_v1', 'authenticated_requests', 'operation_responses', 'heartbeats', 'stale_artifact_cleanup'], foreground: foregroundStatuses.shift() ?? true, install: installStatus };
    }
    if (request.action === 'storefront') {
      calls.push('storefront');
      if (deviceStorefrontReadError) throw new Error('storefront unavailable');
      return { ok: true, countryCode: deviceStorefrontCode };
    }
    installRequest = request;
    installRequests.push(request);
    calls.push('request');
    if (installStatusAfterRequest) installStatus = { operationId: request.operationId, ...installStatusAfterRequest };
    return { ok: true, requested: true, operationId: request.operationId };
  },
  sendSpringBoardBridgeRequest: async () => {
    foregroundRequests += 1;
    return { launchResult: 0 };
  },
  uninstallInstalledApp: async () => {
    calls.push('uninstall');
    return !guardedUninstallFails;
  },
  uninstallInstalledBundle: async () => {
    calls.push('force-uninstall');
    return true;
  },
  withSSH: async (_device: object, fn: (conn: object, signal: AbortSignal) => Promise<void>) => fn({}, new AbortController().signal),
}));

mock.module('#appStoreMetadata.js', () => ({
  ...itunes,
  lookupCurrentVersion: async (bundleId: string, _signal?: AbortSignal, country?: string) => {
    listingBundleId = bundleId;
    currentVersionCountry = country;
    return { trackId: 123, version: '338.0' };
  },
  lookupAppMetadataByTrackId: async (_trackId: number, country?: string) => {
    if (country === 'AU' && localizedLookupError) throw new Error('localized listing unavailable');
    return { trackId: 123, bundleId: country === 'AU' && localizedListingBundleId ? localizedListingBundleId : listingBundleId, trackName: country === 'AU' ? 'Localized Example App' : 'Example App', price: country === 'AU' ? localizedListingPrice : listingPrice };
  },
}));

mock.module('#store/state.js', () => ({
  ...state,
  getPrimaryDevice: () => ({ id: 'test-device', transport: 'usb', udid: 'test-device' }),
}));

const { buildAppStoreOperationId, installFromAppStore } = await import('./appStoreInstall.js');

describe('installFromAppStore', () => {
  afterAll(() => {
    globalThis.setTimeout = originalSetTimeout;
    Date.now = originalDateNow;
    mock.restore();
  });

  beforeEach(() => {
    globalThis.setTimeout = ((handler: () => void) => {
      queueMicrotask(handler);
      return 0;
    }) as unknown as typeof setTimeout;
    calls.length = 0;
    progress.length = 0;
    installedBundles = [
      { path: '/apps/Discord.app', shortVersion: '338.0' },
      { path: '/apps/Discord.app', shortVersion: '338.0' },
    ];
    lastInstalledBundle = undefined;
    installRequest = undefined;
    installRequests = [];
    installStatus = {};
    installStatusAfterRequest = undefined;
    installStatusSequence = [];
    deviceInstallStatus = undefined;
    deviceInstallStatusErrors = 0;
    guardedUninstallFails = false;
    foregroundStatuses = [true];
    bridgeStatusErrors = 0;
    postInstallStatusErrors = 0;
    postInstallStatusSuccesses = 0;
    foregroundRequests = 0;
    listingPrice = 0;
    listingBundleId = '';
    deviceStorefrontCode = 'USA';
    deviceStorefrontReadError = false;
    currentVersionCountry = undefined;
    localizedLookupError = false;
    localizedListingPrice = 0;
    localizedListingBundleId = '';
  });

  test('uses a distinct bridge operation id for each job retry', () => {
    const firstAttempt = buildAppStoreOperationId('job-id', 0);
    const retryAttempt = buildAppStoreOperationId('job-id', 1);

    expect(firstAttempt).toBe('job-id');
    expect(retryAttempt).toBe('job-id-retry-1');
    expect(retryAttempt).not.toBe(firstAttempt);
  });

  test('rejects an already cancelled job before contacting the device', async () => {
    const controller = new AbortController();
    controller.abort(new Error('job deadline exceeded'));

    await expect(installFromAppStore('com.hammerandchisel.discord', { signal: controller.signal })).rejects.toThrow('job deadline exceeded');
    expect(calls).toEqual([]);
  });

  test('refuses a paid listing before changing the device', async () => {
    listingPrice = 1.99;
    await expect(installFromAppStore('com.example.app')).rejects.toThrow('requires a verified free US listing');
    expect(calls).toEqual(['status', 'storefront']);
  });

  test('refuses a pinned release without an expected version before contacting the device', async () => {
    await expect(installFromAppStore('com.example.app', { externalVersionId: '123456789' })).rejects.toThrow('without its expected version');
    expect(calls).toEqual([]);
  });

  test('does not continue when the device storefront cannot be identified', async () => {
    deviceStorefrontReadError = true;
    await expect(installFromAppStore('com.example.app')).rejects.toThrow('could not verify the signed-in App Store storefront');
    expect(calls).toEqual(['status', 'storefront']);
    expect(installRequest).toBeUndefined();
  });

  test('uses the signed-in storefront country to resolve the install title', async () => {
    deviceStorefrontCode = 'AUS';
    await installFromAppStore('com.example.app');
    expect(currentVersionCountry).toBe('AU');
    expect(installRequest).toMatchObject({ appName: 'Localized Example App', appNames: ['Localized Example App'], verifiedPrice: 0 });
  });

  test('accepts the asynchronous account storefront country code', async () => {
    deviceStorefrontCode = 'DE';
    await installFromAppStore('com.example.app');
    expect(currentVersionCountry).toBe('DE');
    expect(installRequest).toMatchObject({ appName: 'Example App', appNames: ['Example App'], verifiedPrice: 0 });
  });

  test('rejects a paid or mismatched localized listing before changing the device', async () => {
    deviceStorefrontCode = 'AUS';
    localizedListingPrice = 1.99;
    await expect(installFromAppStore('com.example.app')).rejects.toThrow('requires a verified free AU listing');
    expect(calls).toEqual(['status', 'storefront']);

    localizedListingPrice = 0;
    localizedListingBundleId = 'com.example.other';
    await expect(installFromAppStore('com.example.app')).rejects.toThrow('requires a verified free AU listing');
    expect(calls).toEqual(['status', 'storefront', 'status', 'storefront']);
  });

  test('does not continue when a localized App Store listing cannot be verified', async () => {
    deviceStorefrontCode = 'AUS';
    localizedLookupError = true;
    await expect(installFromAppStore('com.example.app')).rejects.toThrow('could not verify the free AU App Store listing');
    expect(calls).toEqual(['status', 'storefront']);
    expect(installRequest).toBeUndefined();
  });

  test('does not demand human action while App Store authorization remains pending', async () => {
    let now = 0;
    Date.now = () => now;
    globalThis.setTimeout = ((handler: () => void) => {
      now += 5_000;
      queueMicrotask(handler);
      return 0;
    }) as unknown as typeof setTimeout;
    installedBundles = [undefined, undefined, undefined, undefined, undefined];
    installStatusAfterRequest = {
      operationId: 'job-payment-authorization',
      state: 'requires_user_action',
      reason: 'payment_authorization_ui',
    };

    try {
      await expect(installFromAppStore('com.example.app', {
        operationId: 'job-payment-authorization',
        waitTimeoutMs: 20_000,
        onProgress: (message) => progress.push(message),
      })).rejects.toThrow('Autoinstall could not complete the free App Store confirmation');
    } finally {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(progress.some((message) => message.includes('device action'))).toBe(false);
    expect(calls).toEqual(['status', 'storefront', 'restart', 'status', 'arm', 'request', 'status', 'status', 'status', 'status', 'clear']);
  });

  test('waits through a payment sheet until the requested version installs', async () => {
    let now = 0;
    Date.now = () => now;
    globalThis.setTimeout = ((handler: () => void) => {
      now += 5_000;
      queueMicrotask(handler);
      return 0;
    }) as unknown as typeof setTimeout;
    installedBundles = [undefined, undefined, undefined, undefined, undefined, { path: '/apps/Discord.app', shortVersion: '348.0' }];
    installStatusSequence = [
      { operationId: 'job-transient-payment-authorization', state: 'requires_user_action', reason: 'payment_authorization_ui' },
      { operationId: 'job-transient-payment-authorization', state: 'requires_user_action', reason: 'payment_authorization_ui' },
      { operationId: 'job-transient-payment-authorization', state: 'requires_user_action', reason: 'payment_authorization_ui' },
      { operationId: 'job-transient-payment-authorization', state: 'requires_user_action', reason: 'payment_authorization_ui' },
      { operationId: 'job-transient-payment-authorization', state: 'completed' },
    ];

    try {
      await expect(installFromAppStore('com.example.app', {
        expectedVersion: '348.0',
        operationId: 'job-transient-payment-authorization',
      })).resolves.toMatchObject({ shortVersion: '348.0' });
    } finally {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(calls).toEqual(['status', 'storefront', 'restart', 'status', 'arm', 'request', 'status', 'status', 'status', 'status', 'status', 'clear']);
  });

  test('retries after a temporarily unavailable bridge before purchasing', async () => {
    bridgeStatusErrors = 1;
    installedBundles = [undefined, { path: '/apps/Discord.app', shortVersion: '338.0' }];

    await installFromAppStore('com.hammerandchisel.discord');

    expect(calls.filter((call) => call === 'status')).toHaveLength(4);
    expect(foregroundRequests).toBe(2);
    expect(calls).toEqual(['status', 'status', 'storefront', 'restart', 'status', 'arm', 'request', 'status', 'clear']);
  });

  test('keeps waiting when an App Store status poll times out after the purchase starts', async () => {
    postInstallStatusErrors = 1;
    installedBundles = [undefined, { path: '/apps/Discord.app', shortVersion: '338.0' }];

    await expect(installFromAppStore('com.hammerandchisel.discord')).resolves.toMatchObject({ shortVersion: '338.0' });

    expect(calls).toEqual(['status', 'storefront', 'restart', 'status', 'arm', 'request', 'status', 'clear']);
  });

  test('recognizes a completed purchase when bridge status stops responding and permits a retry', async () => {
    let now = 0;
    Date.now = () => now;
    globalThis.setTimeout = ((handler: () => void) => {
      now += 5_000;
      queueMicrotask(handler);
      return 0;
    }) as unknown as typeof setTimeout;
    installedBundles = Array(10).fill(undefined);
    installStatusAfterRequest = { operationId: 'job-bridge-stalled', state: 'authorizing' };
    deviceInstallStatus = { operationId: 'job-bridge-stalled', state: 'completed' };
    postInstallStatusSuccesses = 1;
    postInstallStatusErrors = 100;

    try {
      await expect(installFromAppStore('com.example.app', {
        operationId: 'job-bridge-stalled',
        waitTimeoutMs: 20_000,
      })).rejects.toMatchObject({
        message: 'App Store purchase request completed but com.example.app was not installed within 20s',
        retryable: true,
      });
    } finally {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
    }
    expect(calls).toEqual(['status', 'storefront', 'restart', 'status', 'arm', 'request', 'clear']);
  });

  test('retries a completed free purchase once when no app download follows', async () => {
    let now = 0;
    Date.now = () => now;
    globalThis.setTimeout = ((handler: () => void) => {
      now += 5_000;
      queueMicrotask(handler);
      return 0;
    }) as unknown as typeof setTimeout;
    installedBundles = [...Array(22).fill(undefined), { path: '/apps/Cleaner.app', shortVersion: '338.0' }];
    installStatusAfterRequest = { state: 'completed' };

    try {
      await expect(installFromAppStore('com.example.app', {
        operationId: 'job-purchase-only',
        waitTimeoutMs: 180_000,
        onProgress: (message) => progress.push(message),
      })).resolves.toMatchObject({ shortVersion: '338.0' });
    } finally {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(installRequests).toHaveLength(2);
    expect(installRequests.map((request) => request.operationId)).toEqual(['job-purchase-only', 'job-purchase-only-download-retry-1']);
    expect(calls.filter((call) => call === 'restart')).toHaveLength(2);
    expect(progress).toContain('App Store confirmed the purchase but did not install the app; retrying the download once');
  });

  test('reports an error contained in the App Store purchase response', async () => {
    installedBundles = [undefined, undefined];
    installStatusAfterRequest = { state: 'failed', error: 'purchase authorization declined' };

    await expect(installFromAppStore('com.example.app')).rejects.toThrow('App Store install operation failed: purchase authorization declined');
    expect(installRequests).toHaveLength(1);
  });

  test('uses bridge status when the device install status file cannot be read', async () => {
    let now = 0;
    Date.now = () => now;
    globalThis.setTimeout = ((handler: () => void) => {
      now += 5_000;
      queueMicrotask(handler);
      return 0;
    }) as unknown as typeof setTimeout;
    installedBundles = Array(10).fill(undefined);
    deviceInstallStatusErrors = 100;
    installStatusAfterRequest = { operationId: 'job-file-unavailable', state: 'completed' };

    try {
      await expect(installFromAppStore('com.example.app', {
        operationId: 'job-file-unavailable',
        waitTimeoutMs: 20_000,
      })).rejects.toThrow('App Store purchase request completed but com.example.app was not installed within 20s');
    } finally {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('does not claim confirmation failed when both install status paths stop responding', async () => {
    let now = 0;
    Date.now = () => now;
    globalThis.setTimeout = ((handler: () => void) => {
      now += 5_000;
      queueMicrotask(handler);
      return 0;
    }) as unknown as typeof setTimeout;
    installedBundles = Array(10).fill(undefined);
    deviceInstallStatusErrors = 100;
    installStatusAfterRequest = { operationId: 'job-status-unavailable', state: 'authorizing' };
    postInstallStatusSuccesses = 1;
    postInstallStatusErrors = 100;

    try {
      await expect(installFromAppStore('com.example.app', {
        operationId: 'job-status-unavailable',
        waitTimeoutMs: 20_000,
      })).rejects.toMatchObject({
        message: 'App Store install status could not be verified for com.example.app within 20s; the app was not installed',
        retryable: true,
      });
    } finally {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('continues when the App Store bridge is responsive but inactive', async () => {
    let now = 0;
    Date.now = () => now;
    globalThis.setTimeout = ((handler: () => void) => {
      now += 20_000;
      queueMicrotask(handler);
      return 0;
    }) as unknown as typeof setTimeout;
    foregroundStatuses = [false];
    installedBundles = [undefined, { path: '/apps/Discord.app', shortVersion: '338.0' }];

    try {
      await expect(installFromAppStore('com.hammerandchisel.discord')).resolves.toMatchObject({ bundleId: 'com.hammerandchisel.discord', shortVersion: '338.0' });
    } finally {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(calls).toEqual(['status', 'storefront', 'restart', 'status', 'arm', 'request', 'status', 'clear']);
  });

  test('replaces an installed beta before decrypting a pinned App Store version', async () => {
    await installFromAppStore('com.hammerandchisel.discord', {
      externalVersionId: '123456789',
      expectedVersion: '338.0',
      onProgress: (message) => progress.push(message),
    });

    expect(calls).toEqual(['status', 'storefront', 'uninstall', 'restart', 'status', 'arm', 'request', 'status', 'clear']);
    expect(installRequest).toMatchObject({ action: 'install', adamId: 123, appName: 'Example App', verifiedPrice: 0, contextMode: 'fallback', versionId: 123456789 });
    expect(installRequest).not.toHaveProperty('requestId');
    expect(progress).toContain('removing the installed app before the App Store install');
    expect(progress.at(-1)).toBe('install verified: 338.0 build 106000 in 0s');
  });

  test('normalizes a v-prefixed App Store version before verification', async () => {
    let now = 0;
    Date.now = () => now;
    globalThis.setTimeout = ((handler: () => void) => {
      now += 20_000;
      queueMicrotask(handler);
      return 0;
    }) as unknown as typeof setTimeout;

    try {
      await expect(installFromAppStore('com.hammerandchisel.discord', {
        externalVersionId: '123456789',
        expectedVersion: 'v338.0',
        onProgress: (message) => progress.push(message),
      })).resolves.toMatchObject({ bundleId: 'com.hammerandchisel.discord', shortVersion: '338.0' });
    } finally {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(progress).not.toContain('waiting for App Store version v338.0; version 338.0 is currently installed');
  });

  test('replaces an installed app before decrypting the current App Store version', async () => {
    await installFromAppStore('com.hammerandchisel.discord');

    expect(calls).toEqual(['status', 'storefront', 'uninstall', 'restart', 'status', 'arm', 'request', 'status', 'clear']);
    expect(installRequest).toMatchObject({ action: 'install', adamId: 123, contextMode: 'fallback' });
  });

  test('removes the discovered app bundle when the guarded uninstaller rejects it', async () => {
    guardedUninstallFails = true;

    await installFromAppStore('com.hammerandchisel.discord', { externalVersionId: '123456789', expectedVersion: '338.0' });

    expect(calls).toEqual(['status', 'storefront', 'uninstall', 'force-uninstall', 'restart', 'status', 'arm', 'request', 'status', 'clear']);
  });

  test('waits for the requested version when a stale App Store install lands first', async () => {
    installedBundles = [
      undefined,
      { path: '/apps/Discord.app', shortVersion: '337.0' },
      { path: '/apps/Discord.app', shortVersion: '338.0' },
    ];

    await installFromAppStore('com.hammerandchisel.discord', {
      externalVersionId: '123456789',
      expectedVersion: '338.0',
      onProgress: (message) => progress.push(message),
    });

    expect(calls).toEqual(['status', 'storefront', 'restart', 'status', 'arm', 'request', 'status', 'clear']);
    expect(progress).toContain('waiting for App Store version 338.0; version 337.0 is currently installed');
    expect(progress.at(-1)).toBe('install verified: 338.0 build 106000 in 0s');
  });

  test('does not treat a different installed version as a timed-out pinned release', async () => {
    let now = 0;
    Date.now = () => now;
    globalThis.setTimeout = ((handler: () => void) => {
      now += 5_000;
      queueMicrotask(handler);
      return 0;
    }) as unknown as typeof setTimeout;
    installedBundles = [
      undefined,
      { path: '/apps/Discord.app', shortVersion: '337.0' },
      { path: '/apps/Discord.app', shortVersion: '337.0' },
    ];

    try {
      await expect(installFromAppStore('com.hammerandchisel.discord', {
        externalVersionId: '123456789',
        expectedVersion: '338.0',
        waitTimeoutMs: 10_000,
      })).rejects.toThrow('version 337.0 remained installed');
    } finally {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('stops before contacting the App Store when cancelled', async () => {
    await expect(installFromAppStore('com.hammerandchisel.discord', { isCancelled: () => true })).rejects.toThrow('App Store install cancelled');

    expect(calls).toEqual([]);
  });
});
