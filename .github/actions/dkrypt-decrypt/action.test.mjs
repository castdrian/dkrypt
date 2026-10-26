import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAction } from './action.mjs';
import { downloadVerifiedArtifact } from './action-lib.mjs';

const bytes = Buffer.from('verified ipa bytes');
const sha256 = createHash('sha256').update(bytes).digest('hex');

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), 'dkrypt-github-action-'));
}

function actionConfig(directory, overrides = {}) {
  return {
    apiUrl: 'https://dkrypt.example',
    apiKey: 'test-api-key',
    githubOutput: path.join(directory, 'github-output'),
    output: path.join(directory, 'download.ipa'),
    maxAttempts: 3,
    retryBaseMs: 0,
    retryMaxMs: 0,
    requestTimeoutMs: 5_000,
    downloadTimeoutSeconds: 5,
    ...overrides,
  };
}

async function outputsAt(file) {
  const contents = await readFile(file, 'utf8');
  return Object.fromEntries(contents.trim().split('\n').map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

function apiResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('submits the latest TestFlight decrypt, waits for completion, and verifies the downloaded IPA', async () => {
  const directory = await temporaryDirectory();
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === '/v1/decrypts') {
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), { bundleId: 'com.example.app', channel: 'testflight' });
      assert.equal(init.headers.Authorization, 'Bearer test-api-key');
      return apiResponse({ id: 'job-1', status: 'running', bundleId: 'com.example.app', channel: 'testflight', progress: 'queued' }, 202);
    }
    if (url.pathname === '/v1/jobs/job-1/wait') {
      assert.equal(url.searchParams.get('timeoutSeconds'), '25');
      return apiResponse({
        id: 'job-1',
        status: 'done',
        bundleId: 'com.example.app',
        channel: 'testflight',
        resolvedVersion: '352.0_118977',
        testflight: { buildNumber: '118977' },
        artifactId: 'artifact-1',
        artifactUrl: '/v1/artifacts/artifact-1/file',
        sizeBytes: bytes.length,
        sha256,
        cacheHit: false,
      });
    }
    if (url.pathname === '/v1/artifacts/artifact-1/file') return new Response(bytes);
    throw new Error(`unexpected URL ${url}`);
  };
  const logs = [];

  try {
    const result = await runAction(actionConfig(directory, {
      bundleId: 'com.example.app',
      channel: 'testflight',
      timeoutSeconds: 60,
    }), { fetchImpl, sleep: async () => {}, log: (message) => logs.push(message), idempotencyKey: 'stable-testflight-key' });
    const outputs = await outputsAt(path.join(directory, 'github-output'));

    assert.equal(await readFile(result.path, 'utf8'), bytes.toString());
    assert.equal(outputs['job-id'], 'job-1');
    assert.equal(outputs['artifact-id'], 'artifact-1');
    assert.equal(outputs.version, '352.0_118977');
    assert.equal(outputs.build, '118977');
    assert.equal(outputs.channel, 'testflight');
    assert.equal(outputs.is_testflight, 'true');
    assert.equal(outputs.cache_hit, 'false');
    assert.equal(outputs.sha256, sha256);
    assert.equal(outputs.size_bytes, String(bytes.length));
    assert.equal(outputs.path, result.path);
    assert.equal((await readFile(path.join(directory, 'github-output'), 'utf8')).split('\n').filter((line) => line.startsWith('job-id=')).length, 1);
    assert.equal(calls[0].init.headers['Idempotency-Key'], 'stable-testflight-key');
    assert.ok(logs.some((message) => message.includes('dkrypt job job-1: running')));
    assert.ok(logs.some((message) => message.includes('dkrypt job job-1: done')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('retries a transient submission response with the same idempotency key', async () => {
  const directory = await temporaryDirectory();
  let submissions = 0;
  let firstIdempotencyKey;
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/decrypts') {
      submissions += 1;
      firstIdempotencyKey ??= init.headers['Idempotency-Key'];
      assert.equal(init.headers['Idempotency-Key'], firstIdempotencyKey);
      if (submissions === 1) return apiResponse({ message: 'try again' }, 503);
      return apiResponse({
        id: 'job-2',
        status: 'done',
        bundleId: 'com.example.app',
        channel: 'appstore',
        resolvedVersion: '350.0',
        artifactId: 'artifact-2',
        artifactUrl: '/v1/artifacts/artifact-2/file',
        sizeBytes: bytes.length,
        sha256,
        cacheHit: true,
      }, 200);
    }
    if (url.pathname === '/v1/artifacts/artifact-2') return apiResponse({
      id: 'artifact-2',
      bundleId: 'com.example.app',
      channel: 'appstore',
      versionLabel: '350.0',
      buildNumber: '106011',
      sizeBytes: bytes.length,
      sha256,
      fileUrl: '/v1/artifacts/artifact-2/file',
    });
    if (url.pathname === '/v1/artifacts/artifact-2/file') return new Response(bytes);
    throw new Error(`unexpected URL ${url}`);
  };

  try {
    const logs = [];
    const result = await runAction(actionConfig(directory, { bundleId: 'com.example.app' }), { fetchImpl, sleep: async () => {}, log: (message) => logs.push(message) });
    const outputs = await outputsAt(path.join(directory, 'github-output'));
    assert.equal(submissions, 2);
    assert.equal(outputs.version, '350.0');
    assert.equal(outputs.build, '106011');
    assert.equal(outputs.channel, 'appstore');
    assert.equal(outputs.cache_hit, 'true');
    assert.equal(result.sha256, sha256);
    assert.ok(logs.some((message) => message.includes('cache hit')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('downloads the newest cached artifact for a channel with retry and no decrypt submission', async () => {
  const directory = await temporaryDirectory();
  let fileAttempts = 0;
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/artifacts') {
      assert.equal(url.searchParams.get('channel'), 'testflight');
      assert.equal(url.searchParams.get('limit'), '1');
      return apiResponse({ artifacts: [{
        id: 'cached-1',
        bundleId: 'com.example.app',
        channel: 'testflight',
        versionLabel: '352.0_118977',
        buildNumber: '118977',
        sizeBytes: bytes.length,
        sha256,
        fileUrl: '/v1/artifacts/cached-1/file',
      }] });
    }
    if (url.pathname === '/v1/artifacts/cached-1/file') {
      fileAttempts += 1;
      if (fileAttempts === 1) return apiResponse({ message: 'try again' }, 503);
      return new Response(bytes);
    }
    throw new Error(`unexpected URL ${url}`);
  };

  try {
    const result = await runAction(actionConfig(directory, { latestCachedChannel: 'testflight' }), { fetchImpl, sleep: async () => {}, log: () => {} });
    const outputs = await outputsAt(path.join(directory, 'github-output'));
    assert.equal(outputs['job-id'], '');
    assert.equal(outputs['artifact-id'], 'cached-1');
    assert.equal(outputs.is_testflight, 'true');
    assert.equal(outputs.cache_hit, 'true');
    assert.equal(fileAttempts, 2);
    assert.equal((await readdir(directory)).filter((entry) => entry.endsWith('.partial')).length, 0);
    assert.equal(result.path, path.join(directory, 'download.ipa'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('downloads a specific artifact ID and removes a file whose size does not match', async () => {
  const directory = await temporaryDirectory();
  const output = path.join(directory, 'invalid.ipa');
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/artifacts/cached-2') {
      return apiResponse({
        id: 'cached-2',
        bundleId: 'com.example.app',
        channel: 'appstore',
        versionLabel: '350.0',
        sizeBytes: bytes.length + 1,
        sha256,
        fileUrl: '/v1/artifacts/cached-2/file',
      });
    }
    if (url.pathname === '/v1/artifacts/cached-2/file') return new Response(bytes);
    throw new Error(`unexpected URL ${url}`);
  };

  try {
    await assert.rejects(runAction(actionConfig(directory, { artifactId: 'cached-2', output }), { fetchImpl, log: () => {} }), /integrity check failed/);
    assert.equal((await readdir(directory)).some((entry) => entry.includes('partial')), false);
    await assert.rejects(readFile(output));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects and removes an artifact whose SHA-256 does not match', async () => {
  const directory = await temporaryDirectory();
  const output = path.join(directory, 'invalid-hash.ipa');

  try {
    await assert.rejects(downloadVerifiedArtifact({
      url: '/v1/artifacts/hash-mismatch/file',
      origin: 'https://dkrypt.example',
      apiKey: 'test-api-key',
      outputPath: output,
      expectedSha256: '0'.repeat(64),
      expectedSizeBytes: bytes.length,
      fetchImpl: async () => new Response(bytes),
      log: () => {},
    }), /integrity check failed/);
    assert.equal((await readdir(directory)).some((entry) => entry.includes('partial')), false);
    await assert.rejects(readFile(output));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('applies one overall deadline across stalled download retries', async () => {
  const directory = await temporaryDirectory();
  const output = path.join(directory, 'timed-out.ipa');

  try {
    await assert.rejects(downloadVerifiedArtifact({
      url: '/v1/artifacts/stalled/file',
      origin: 'https://dkrypt.example',
      apiKey: 'test-api-key',
      outputPath: output,
      expectedSha256: sha256,
      expectedSizeBytes: bytes.length,
      fetchImpl: async () => new Response(new ReadableStream({ pull() {} })),
      sleep: async () => {},
      maxAttempts: 4,
      timeoutMs: 30,
      log: () => {},
    }), /timed out|aborted/i);
    assert.equal((await readdir(directory)).some((entry) => entry.includes('.partial')), false);
    await assert.rejects(readFile(output));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
