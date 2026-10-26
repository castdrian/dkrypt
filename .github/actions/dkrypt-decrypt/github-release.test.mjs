import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishVerifiedIpaToGitHubRelease } from './github-release.mjs';

const release = {
  id: 123,
  html_url: 'https://github.com/example/app/releases/tag/v1',
  upload_url: 'https://uploads.github.com/repos/example/app/releases/123/assets{?name,label}',
};

async function withIpa(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dkrypt-release-'));
  const filePath = path.join(directory, 'app.ipa');
  await writeFile(filePath, Buffer.from('verified ipa payload'));
  try {
    await run(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function options(filePath, overrides = {}) {
  const content = Buffer.from('verified ipa payload');
  return {
    token: 'github-test-token',
    repository: 'example/app',
    tag: 'v1',
    assetName: 'com.example.app-1.0.ipa',
    filePath,
    sha256: createHash('sha256').update(content).digest('hex'),
    sizeBytes: content.length,
    ...overrides,
  };
}

test('uploads a verified IPA to an existing GitHub Release without exposing the token', async () => {
  await withIpa(async (filePath) => {
    const calls = [];
    const fetchImpl = async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (url.hostname === 'uploads.github.com') return json({ name: url.searchParams.get('name'), size: 20, browser_download_url: 'https://github.com/example/app/releases/download/v1/app.ipa' }, 201);
      if (url.pathname.endsWith('/releases/tags/v1')) return json(release);
      if (url.pathname.endsWith('/releases/123/assets')) return json([]);
      throw new Error(`unexpected URL ${url}`);
    };
    const result = await publishVerifiedIpaToGitHubRelease(options(filePath), { fetchImpl, log: () => {} });

    assert.deepEqual(result, {
      releaseUrl: release.html_url,
      assetUrl: 'https://github.com/example/app/releases/download/v1/app.ipa',
      assetName: 'com.example.app-1.0.ipa',
      sizeBytes: 20,
    });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer github-test-token');
    assert.equal(calls[2].init.headers['Content-Length'], '20');
    assert.equal(calls[2].init.headers['Content-Type'], 'application/octet-stream');
    assert.equal(calls[2].init.duplex, 'half');
  });
});

test('requires an explicit release creation option and creates drafts when requested', async () => {
  await withIpa(async (filePath) => {
    const calls = [];
    const fetchImpl = async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (url.hostname === 'uploads.github.com') return json({ name: url.searchParams.get('name'), size: 20, browser_download_url: 'https://github.com/example/app/releases/download/v1/app.ipa' }, 201);
      if (url.pathname.endsWith('/releases/tags/v1')) return json({ message: 'Not Found' }, 404);
      if (url.pathname.endsWith('/releases')) return json(release, 201);
      if (url.pathname.endsWith('/releases/123/assets')) return json([]);
      throw new Error(`unexpected URL ${url}`);
    };
    await assert.rejects(publishVerifiedIpaToGitHubRelease(options(filePath), { fetchImpl, log: () => {} }), /create-release to true/);
    assert.equal(calls.length, 1);

    await publishVerifiedIpaToGitHubRelease(options(filePath, { createRelease: true, draft: true, releaseName: 'Build v1', releaseNotes: 'Release notes' }), { fetchImpl, log: () => {} });
    const created = JSON.parse(calls[2].init.body);
    assert.deepEqual(created, { tag_name: 'v1', name: 'Build v1', body: 'Release notes', draft: true });
  });
});

test('checks the tag after an uncertain release creation response before retrying', async () => {
  await withIpa(async (filePath) => {
    const counts = { tagLookups: 0, creations: 0, uploads: 0 };
    const fetchImpl = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'uploads.github.com') {
        counts.uploads += 1;
        return json({ name: url.searchParams.get('name'), size: 20, browser_download_url: 'https://github.com/example/app/releases/download/v1/app.ipa' }, 201);
      }
      if (url.pathname.endsWith('/releases/tags/v1')) {
        counts.tagLookups += 1;
        return counts.tagLookups === 1 ? json({ message: 'Not Found' }, 404) : json(release);
      }
      if (url.pathname.endsWith('/releases')) {
        counts.creations += 1;
        return json({ message: 'temporary failure after accepting request' }, 502);
      }
      if (url.pathname.endsWith('/releases/123/assets')) return json([]);
      throw new Error(`unexpected URL ${url}`);
    };
    await publishVerifiedIpaToGitHubRelease(options(filePath, { createRelease: true }), { fetchImpl, log: () => {} });
    assert.deepEqual(counts, { tagLookups: 2, creations: 1, uploads: 1 });
  });
});

test('refuses duplicate asset names and unsafe release destinations', async () => {
  await withIpa(async (filePath) => {
    let uploads = 0;
    const fetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/releases/tags/v1')) return json(release);
      if (url.pathname.endsWith('/releases/123/assets')) return json([{ name: 'com.example.app-1.0.ipa' }]);
      uploads += 1;
      return json({});
    };
    await assert.rejects(publishVerifiedIpaToGitHubRelease(options(filePath), { fetchImpl, log: () => {} }), /already contains an asset/);
    await assert.rejects(publishVerifiedIpaToGitHubRelease(options(filePath, { assetName: '../leak.ipa' }), { fetchImpl, log: () => {} }), /safe \.ipa filename/);
    await assert.rejects(publishVerifiedIpaToGitHubRelease(options(filePath, { repository: 'other/repo', apiUrl: 'http://github.invalid' }), { fetchImpl, log: () => {} }), /HTTPS API base/);
    assert.equal(uploads, 0);
  });
});

test('refuses to upload a file that no longer matches its verified metadata', async () => {
  await withIpa(async (filePath) => {
    let requests = 0;
    await assert.rejects(publishVerifiedIpaToGitHubRelease(options(filePath, { sha256: '0'.repeat(64) }), {
      fetchImpl: async () => { requests += 1; return json({}); },
      log: () => {},
    }), /changed after its initial integrity verification/);
    assert.equal(requests, 0);
  });
});
