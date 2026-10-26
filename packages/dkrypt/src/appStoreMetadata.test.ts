import { describe, expect, test } from 'bun:test';

const { lookupAppMetadata, lookupAppMetadataByTrackId, searchApps } = await import(`${new URL('./appStoreMetadata.ts', import.meta.url).href}?storefront-test`);

const originalFetch = globalThis.fetch;

function mockFetch(requests: URL[]): void {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    requests.push(url);
    const result = {
      version: '340.0',
      bundleId: 'com.hammerandchisel.discord',
      trackId: 985746746,
      trackName: 'Discord',
      sellerName: 'Discord Inc.',
      artworkUrl100: 'https://example.com/discord.png',
      price: 0,
      minimumOsVersion: '16.0',
    };
    const body = { resultCount: 1, results: [result] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

async function runCurrentVersionLookupInIsolatedProcess(): Promise<{ url: string; version: string; minimumOsVersion?: string }> {
  const script = [
    "import { mkdtempSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import path from 'node:path';",
    "process.env.API_KEY = 'test';",
    "process.env.SESSION_SIGNING_SECRET = 'test';",
    "process.env.ADMIN_PASSWORD = 'test';",
    "process.env.STATE_DIR = mkdtempSync(path.join(tmpdir(), 'dkrypt-storefront-current-'));",
    "globalThis.fetch = async (input) => {",
    "  globalThis.requestUrl = String(input);",
    "  return new Response(JSON.stringify({ resultCount: 1, results: [{ version: '340.0', bundleId: 'com.hammerandchisel.discord', trackId: 985746746, minimumOsVersion: '16.0' }] }), { status: 200 });",
    "};",
    "const { lookupCurrentVersion } = await import('./src/appStoreMetadata.ts');",
    "const result = await lookupCurrentVersion('com.hammerandchisel.discord');",
    "console.log(JSON.stringify({ url: globalThis.requestUrl, version: result.version, minimumOsVersion: result.minimumOsVersion }));",
  ].join('\n');
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`isolated lookup failed: ${stderr}`);
  return JSON.parse(stdout) as { url: string; version: string };
}

async function runStorefrontVersionLookupInIsolatedProcess(): Promise<string> {
  const script = [
    "import { mkdtempSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import path from 'node:path';",
    "process.env.API_KEY = 'test';",
    "process.env.SESSION_SIGNING_SECRET = 'test';",
    "process.env.ADMIN_PASSWORD = 'test';",
    "process.env.STATE_DIR = mkdtempSync(path.join(tmpdir(), 'dkrypt-storefront-'));",
    "process.env.APPSTORE_OFFLINE_VAULT_KEY = Buffer.alloc(32, 1).toString('base64url');",
    "const vault = await import('./src/appleAccountVault.ts');",
    "vault.saveAppleAccountCredentials('admin@example.com', 'password');",
    "vault.saveAppleAccountStorefrontCountry('DE');",
    "globalThis.fetch = async (input) => { globalThis.requestUrl = String(input); return new Response(JSON.stringify({ resultCount: 1, results: [{ version: '1.0', bundleId: 'org.mozilla.ios.Klar', trackId: 1073435754 }] }), { status: 200 }); };",
    "const { lookupCurrentVersion } = await import('./src/appStoreMetadata.ts');",
    "await lookupCurrentVersion('org.mozilla.ios.Klar');",
    "console.log(globalThis.requestUrl);",
  ].join('\n');
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`storefront lookup failed: ${stderr}`);
  return stdout.trim();
}

async function runUnresolvedStorefrontLookupInIsolatedProcess(): Promise<{ error: string; fetched: boolean }> {
  const script = [
    "import { mkdtempSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import path from 'node:path';",
    "process.env.API_KEY = 'test';",
    "process.env.SESSION_SIGNING_SECRET = 'test';",
    "process.env.ADMIN_PASSWORD = 'test';",
    "process.env.STATE_DIR = mkdtempSync(path.join(tmpdir(), 'dkrypt-storefront-unknown-'));",
    "process.env.APPSTORE_OFFLINE_VAULT_KEY = Buffer.alloc(32, 1).toString('base64url');",
    "const vault = await import('./src/appleAccountVault.ts');",
    "vault.saveAppleAccountCredentials('admin@example.com', 'password');",
    "globalThis.fetched = false;",
    "globalThis.fetch = async () => { globalThis.fetched = true; return new Response(JSON.stringify({ resultCount: 0, results: [] }), { status: 200 }); };",
    "const { lookupCurrentVersion } = await import('./src/appStoreMetadata.ts');",
    "let error = '';",
    "try { await lookupCurrentVersion('org.mozilla.ios.Klar'); } catch (failure) { error = failure.message; }",
    "console.log(JSON.stringify({ error, fetched: globalThis.fetched }));",
  ].join('\n');
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`unknown storefront lookup failed: ${stderr}`);
  return JSON.parse(stdout) as { error: string; fetched: boolean };
}

async function runAbortableVersionLookupInIsolatedProcess(): Promise<string> {
  const script = [
    "import { mkdtempSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import path from 'node:path';",
    "process.env.API_KEY = 'test';",
    "process.env.SESSION_SIGNING_SECRET = 'test';",
    "process.env.ADMIN_PASSWORD = 'test';",
    "process.env.STATE_DIR = mkdtempSync(path.join(tmpdir(), 'dkrypt-storefront-abort-'));",
    'globalThis.fetch = async (_input, init) => {',
    '  if (!init?.signal) return new Response(JSON.stringify({ resultCount: 1, results: [{ version: "340.0", bundleId: "com.hammerandchisel.discord", trackId: 985746746 }] }), { status: 200 });',
    '  return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));',
    '};',
    "const { lookupCurrentVersion } = await import('./src/appStoreMetadata.ts');",
    'const controller = new AbortController();',
    'const lookup = lookupCurrentVersion("com.hammerandchisel.discord", controller.signal);',
    'controller.abort(new Error("job deadline exceeded"));',
    'try { await lookup; console.log("resolved"); } catch (error) { console.log(error.message); }',
  ].join('\n');
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`isolated abortable lookup failed: ${stderr}`);
  return stdout.trim();
}

describe('iTunes storefront selection', () => {
  test('uses the US storefront for current version lookup', async () => {
    const result = await runCurrentVersionLookupInIsolatedProcess();
    expect(new URL(result.url).searchParams.get('country')).toBe('US');
    expect(result.version).toBe('340.0');
    expect(result.minimumOsVersion).toBe('16.0');
  });

  test('uses the authenticated Apple Account storefront for default metadata lookup', async () => {
    const result = await runStorefrontVersionLookupInIsolatedProcess();
    expect(new URL(result).searchParams.get('country')).toBe('DE');
    expect(new URL(result).searchParams.get('lang')).toBe('en_us');
  });

  test('does not guess a storefront when a configured Apple Account has no verified region', async () => {
    await expect(runUnresolvedStorefrontLookupInIsolatedProcess()).resolves.toEqual({
      error: 'configured Apple Account storefront could not be determined',
      fetched: false,
    });
  });

  test('uses the US storefront for metadata and search', async () => {
    const requests: URL[] = [];
    mockFetch(requests);

    try {
      await lookupAppMetadata('com.hammerandchisel.discord');
      const results = await searchApps('Discord');
      expect(requests).toHaveLength(2);
      expect(requests.every((url) => url.searchParams.get('country') === 'US')).toBe(true);
      expect(requests.every((url) => url.searchParams.get('lang') === 'en_us')).toBe(true);
      expect(results[0]?.minimumOsVersion).toBe('16.0');
    } finally {
      restoreFetch();
    }
  });

  test('resolves an App Store URL track ID through the software lookup', async () => {
    const requests: URL[] = [];
    mockFetch(requests);
    try {
      const metadata = await lookupAppMetadataByTrackId(985746746);
      expect(metadata.bundleId).toBe('com.hammerandchisel.discord');
      expect(requests[0]?.pathname).toBe('/lookup');
      expect(requests[0]?.searchParams.get('id')).toBe('985746746');
      expect(requests[0]?.searchParams.get('entity')).toBe('software');
      expect(requests[0]?.searchParams.get('lang')).toBe('en_us');
      expect(() => lookupAppMetadataByTrackId(-1)).toThrow();
    } finally {
      restoreFetch();
    }
  });

  test('looks up a verified app title in a requested storefront', async () => {
    const requests: URL[] = [];
    mockFetch(requests);
    try {
      await lookupAppMetadataByTrackId(1510944943, 'AU');
      expect(requests[0]?.searchParams.get('country')).toBe('AU');
      expect(requests[0]?.searchParams.get('lang')).toBe('en_us');
      expect(() => lookupAppMetadataByTrackId(1510944943, 'AUS')).toThrow();
    } finally {
      restoreFetch();
    }
  });

  test('cancels the current version lookup when the job deadline expires', async () => {
    await expect(runAbortableVersionLookupInIsolatedProcess()).resolves.toBe('job deadline exceeded');
  });
});
