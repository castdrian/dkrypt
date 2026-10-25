import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unavailableAppStoreListingError } from '#offlineAppStore.js';
import { runAppStoreDownloaderRequest } from '#offlineAppStoreDownloader.js';

const secret = 'account-password-never-in-args';

test('App Store credentials travel over stdin and are absent from downloader arguments', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dkrypt-appstore-process-'));
  const script = 'let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (part) => input += part); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ ok: true, request: JSON.parse(input), args: process.argv.slice(1) })))';
  try {
    const result = await runAppStoreDownloaderRequest({
      commandPath: process.execPath,
      commandArgs: ['-e', script],
      homeDirectory: root,
      cacheDirectory: path.join(root, 'cache'),
      memoryMb: 512,
      cpuSeconds: 20,
      request: { operation: 'authenticate', apple_id: 'person@example.test', password: secret },
    });

    expect(result.response).toMatchObject({
      ok: true,
      request: { operation: 'authenticate', password: secret },
    });
    const response = result.response as typeof result.response & { args: string[] };
    expect(JSON.stringify(response.args)).not.toContain(secret);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('App Store downloader reports malformed responses instead of treating them as successful', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dkrypt-appstore-process-'));
  try {
    await expect(runAppStoreDownloaderRequest({
      commandPath: process.execPath,
      commandArgs: ['-e', 'process.stdout.write("not-json")'],
      homeDirectory: root,
      cacheDirectory: path.join(root, 'cache'),
      memoryMb: 512,
      cpuSeconds: 20,
      request: { operation: 'status' },
    })).rejects.toThrow('invalid response');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('App Store downloader rejects a successful response paired with a failing process status', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dkrypt-appstore-process-'));
  try {
    await expect(runAppStoreDownloaderRequest({
      commandPath: process.execPath,
      commandArgs: ['-e', 'process.stdout.write(JSON.stringify({ ok: true })); process.exitCode = 1'],
      homeDirectory: root,
      cacheDirectory: path.join(root, 'cache'),
      memoryMb: 512,
      cpuSeconds: 20,
      request: { operation: 'status' },
    })).rejects.toThrow('exited with status 1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an app lookup miss from the downloader becomes a non-retryable storefront error', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dkrypt-appstore-process-'));
  try {
    const result = await runAppStoreDownloaderRequest({
      commandPath: process.execPath,
      commandArgs: ['-e', 'process.stdout.write(JSON.stringify({ ok: false, stage: "app_lookup", code: "app_not_found" }))'],
      homeDirectory: root,
      cacheDirectory: path.join(root, 'cache'),
      memoryMb: 512,
      cpuSeconds: 20,
      request: { operation: 'download' },
    });
    const error = unavailableAppStoreListingError(result.response);

    expect(error).toMatchObject({
      name: 'OfflineAppStoreListingUnavailableError',
      message: 'This app is not available in the signed-in Apple Account storefront',
      retryable: false,
      fallbackToDevice: false,
    });
    expect(unavailableAppStoreListingError({ stage: 'download_info', code: 'app_not_found' })).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
