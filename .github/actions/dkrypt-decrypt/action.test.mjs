import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAction, runBatchAction } from './action.mjs';
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
  const summaryPath = path.join(directory, 'summary');
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
      githubSummary: summaryPath,
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
    const summary = await readFile(summaryPath, 'utf8');
    assert.match(summary, /IPA path/);
    assert.match(summary, new RegExp(result.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(summary, /\| artifact-1 \|/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('publishes only the checksum-verified IPA to a GitHub Release', async () => {
  const directory = await temporaryDirectory();
  let releaseUploads = 0;
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/decrypts') return apiResponse({ id: 'job-release', status: 'running', bundleId: 'com.example.app' }, 202);
    if (url.pathname === '/v1/jobs/job-release/wait') return apiResponse({
      id: 'job-release', status: 'done', bundleId: 'com.example.app', channel: 'appstore', resolvedVersion: '1.0',
      artifactId: 'artifact-release', artifact: { id: 'artifact-release', bundleId: 'com.example.app', channel: 'appstore', versionLabel: '1.0', buildNumber: '42', sizeBytes: bytes.length, sha256, fileUrl: '/v1/artifacts/artifact-release/file' },
    });
    if (url.pathname === '/v1/artifacts/artifact-release/file') return new Response(bytes);
    throw new Error(`unexpected API URL ${url}`);
  };

  try {
    const result = await runAction(actionConfig(directory, {
      bundleId: 'com.example.app',
      publishToRelease: true,
      githubToken: 'contents-token',
      githubRepository: 'example/app',
      releaseTag: 'v1.0',
    }), {
      fetchImpl,
      log: () => {},
      publishRelease: async (options) => {
        releaseUploads += 1;
        assert.equal(await readFile(options.filePath, 'utf8'), bytes.toString());
        assert.equal(options.token, 'contents-token');
        return { releaseUrl: 'https://github.com/example/app/releases/tag/v1.0', assetUrl: 'https://github.com/example/app/releases/download/v1.0/app.ipa' };
      },
    });
    const outputs = await outputsAt(path.join(directory, 'github-output'));
    assert.equal(releaseUploads, 1);
    assert.equal(outputs['release-url'], 'https://github.com/example/app/releases/tag/v1.0');
    assert.equal(outputs['release-asset-url'], 'https://github.com/example/app/releases/download/v1.0/app.ipa');
    assert.equal(result.path, path.join(directory, 'download.ipa'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not publish an IPA that fails integrity verification', async () => {
  const directory = await temporaryDirectory();
  let releaseUploads = 0;
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/decrypts') return apiResponse({ id: 'job-bad-release', status: 'running', bundleId: 'com.example.app' }, 202);
    if (url.pathname === '/v1/jobs/job-bad-release/wait') return apiResponse({
      id: 'job-bad-release', status: 'done', bundleId: 'com.example.app', channel: 'appstore', resolvedVersion: '1.0',
      artifactId: 'artifact-bad-release', artifact: { id: 'artifact-bad-release', bundleId: 'com.example.app', channel: 'appstore', versionLabel: '1.0', buildNumber: '42', sizeBytes: bytes.length, sha256, fileUrl: '/v1/artifacts/artifact-bad-release/file' },
    });
    if (url.pathname === '/v1/artifacts/artifact-bad-release/file') return new Response(Buffer.from('tampered ipa'));
    throw new Error(`unexpected API URL ${url}`);
  };

  try {
    await assert.rejects(runAction(actionConfig(directory, {
      bundleId: 'com.example.app',
      publishToRelease: true,
      githubToken: 'contents-token',
      githubRepository: 'example/app',
      releaseTag: 'v1.0',
    }), {
      fetchImpl,
      maxAttempts: 1,
      log: () => {},
      publishRelease: async () => { releaseUploads += 1; },
    }), /IPA response ended early/);
    assert.equal(releaseUploads, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('adds failed single-app submissions to the workflow summary', async () => {
  const directory = await temporaryDirectory();
  const summaryPath = path.join(directory, 'summary');

  try {
    await assert.rejects(runAction(actionConfig(directory, {
      bundleId: 'com.example.unavailable',
      githubSummary: summaryPath,
    }), {
      fetchImpl: async () => apiResponse({ message: 'release unavailable' }, 404),
      maxAttempts: 1,
      log: () => {},
    }), /release unavailable/);
    const summary = await readFile(summaryPath, 'utf8');
    assert.match(summary, /com\.example\.unavailable/);
    assert.match(summary, /release unavailable/);
    assert.match(summary, /IPA path/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps cached artifact metadata in failed download summaries', async () => {
  const directory = await temporaryDirectory();
  const summaryPath = path.join(directory, 'summary');
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/artifacts') return apiResponse({ artifacts: [{
      id: 'cached-testflight',
      bundleId: 'com.example.testflight',
      channel: 'testflight',
      versionLabel: '352.0_118977',
      buildNumber: '118977',
      sizeBytes: bytes.length,
      sha256,
      fileUrl: '/v1/artifacts/cached-testflight/file',
    }] });
    if (url.pathname === '/v1/artifacts/cached-testflight/file') return apiResponse({ message: 'download unavailable' }, 503);
    throw new Error(`unexpected URL ${url}`);
  };

  try {
    await assert.rejects(runAction(actionConfig(directory, {
      latestCachedChannel: 'testflight',
      githubSummary: summaryPath,
    }), { fetchImpl, maxAttempts: 1, sleep: async () => {}, log: () => {} }), /HTTP 503/);
    const summary = await readFile(summaryPath, 'utf8');
    assert.match(summary, /\| com\.example\.testflight \| 352\.0_118977 \| testflight \| Hit \|/);
    assert.doesNotMatch(summary, /\| appstore \| Miss \|/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('resolves a release without creating a job or downloading an IPA', async () => {
  const directory = await temporaryDirectory();
  const calls = [];
  const summaryPath = path.join(directory, 'summary');
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    assert.equal(url.pathname, '/v1/decrypts');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { bundleId: 'com.example.app', channel: 'testflight', resolveOnly: true });
    assert.equal(init.headers['Idempotency-Key'], undefined);
    return apiResponse({
      resolveOnly: true,
      bundleId: 'com.example.app',
      channel: 'testflight',
      resolvedVersion: '352.0_118977',
      isTestFlight: true,
      build: '118977',
      cacheHit: false,
    });
  };

  try {
    const result = await runAction(actionConfig(directory, {
      bundleId: 'com.example.app',
      channel: 'testflight',
      resolveOnly: true,
      githubSummary: summaryPath,
    }), { fetchImpl, log: () => {} });
    const outputs = await outputsAt(path.join(directory, 'github-output'));
    assert.equal(calls.length, 1);
    assert.equal(result['resolved-version'], '352.0_118977');
    assert.equal(outputs['job-id'], '');
    assert.equal(outputs['artifact-id'], '');
    assert.equal(outputs.version, '352.0_118977');
    assert.equal(outputs.build, '118977');
    assert.equal(outputs.channel, 'testflight');
    assert.equal(outputs.is_testflight, 'true');
    assert.equal(outputs.path, '');
    assert.match(await readFile(summaryPath, 'utf8'), /Resolve only/);
    await assert.rejects(readFile(path.join(directory, 'download.ipa')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('processes bundle-ids independently and writes aggregate results when one app fails', async () => {
  const directory = await temporaryDirectory();
  const summaryPath = path.join(directory, 'summary');
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(init.body);
    calls.push(body.bundleId);
    if (body.bundleId === 'com.example.missing') return apiResponse({ message: 'release not found' }, 404);
    return apiResponse({
      resolveOnly: true,
      bundleId: body.bundleId,
      channel: 'appstore',
      resolvedVersion: body.bundleId === 'com.example.first' ? '350.0|[release](https://example.com) <unsafe>' : '350.0',
      isTestFlight: false,
      cacheHit: false,
    });
  };

  try {
    await assert.rejects(runBatchAction(actionConfig(directory, {
      bundleId: '',
      bundleIds: JSON.stringify(['com.example.first', 'com.example.missing']),
      resolveOnly: 'true',
      githubSummary: summaryPath,
    }), { fetchImpl, log: () => {} }), /1 of 2 dkrypt app operations failed/);
    const outputs = await outputsAt(path.join(directory, 'github-output'));
    const results = JSON.parse(outputs['results-json']);
    assert.deepEqual(calls, ['com.example.first', 'com.example.missing']);
    assert.equal(outputs['success-count'], '1');
    assert.equal(outputs['failure-count'], '1');
    assert.deepEqual(results.map((result) => result.status), ['success', 'failure']);
    assert.match(await readFile(summaryPath, 'utf8'), /com.example.first/);
    assert.match(await readFile(summaryPath, 'utf8'), /com.example.missing/);
    const summary = await readFile(summaryPath, 'utf8');
    assert.match(summary, /IPA path/);
    assert.match(summary, /Size/);
    assert.match(summary, /Resolve only/);
    assert.match(summary, /350\.0&#124;&#91;release&#93;\(https:\/\/example\.com\) &lt;unsafe&gt;/);
    assert.doesNotMatch(summary, /\| \[release\]\(https:\/\/example\.com\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects batch artifact downloads before making any API request', async () => {
  const directory = await temporaryDirectory();
  let requests = 0;

  try {
    await assert.rejects(runBatchAction(actionConfig(directory, {
      bundleId: '',
      bundleIds: JSON.stringify(['com.example.app']),
      latestCachedChannel: 'testflight',
    }), { fetchImpl: async () => { requests += 1; return apiResponse({}); } }), /bundle-ids cannot be combined with artifact download inputs/);
    assert.equal(requests, 0);
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
  const summaryPath = path.join(directory, 'summary');
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
    if (url.pathname === '/v1/artifacts/cached-2/file') return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    throw new Error(`unexpected URL ${url}`);
  };

  try {
    await assert.rejects(runAction(actionConfig(directory, { artifactId: 'cached-2', output, githubSummary: summaryPath }), { fetchImpl, log: () => {} }), /integrity check failed/);
    const summary = await readFile(summaryPath, 'utf8');
    assert.match(summary, /com\.example\.app/);
    assert.match(summary, /350\.0/);
    assert.match(summary, /\| appstore \| Hit \|/);
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
  const keepEventLoopAlive = setTimeout(() => {}, 1_000);

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
    clearTimeout(keepEventLoopAlive);
    await rm(directory, { recursive: true, force: true });
  }
});

test('resumes an interrupted IPA response from the saved byte offset', async () => {
  const directory = await temporaryDirectory();
  const output = path.join(directory, 'resumed.ipa');
  const firstPart = bytes.subarray(0, 6);
  let attempts = 0;
  const fetchImpl = async (_input, init) => {
    attempts += 1;
    if (attempts === 1) {
      assert.equal(init.headers.Range, undefined);
      return new Response(new ReadableStream({
        async pull(controller) {
          if (!this.sent) {
            this.sent = true;
            controller.enqueue(firstPart);
            await new Promise((resolve) => setTimeout(resolve, 5));
            controller.error(new Error('connection dropped'));
          }
        },
      }));
    }
    assert.equal(init.headers.Range, `bytes=${firstPart.length}-`);
    return new Response(bytes.subarray(firstPart.length), {
      status: 206,
      headers: { 'content-range': `bytes ${firstPart.length}-${bytes.length - 1}/${bytes.length}` },
    });
  };

  try {
    const result = await downloadVerifiedArtifact({
      url: '/v1/artifacts/resumed/file',
      origin: 'https://dkrypt.example',
      apiKey: 'test-api-key',
      outputPath: output,
      expectedSha256: sha256,
      expectedSizeBytes: bytes.length,
      fetchImpl,
      sleep: async () => {},
      maxAttempts: 2,
      timeoutMs: 5_000,
      retryBaseMs: 0,
      retryMaxMs: 0,
      log: () => {},
    });
    assert.equal(attempts, 2);
    assert.equal(await readFile(output, 'utf8'), bytes.toString());
    assert.equal(result.sha256, sha256);
    assert.equal((await readdir(directory)).some((entry) => entry.endsWith('.partial')), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('resumes a response that ends cleanly before the expected artifact size', async () => {
  const directory = await temporaryDirectory();
  const output = path.join(directory, 'clean-truncation.ipa');
  const firstPart = bytes.subarray(0, 5);
  let attempts = 0;
  const fetchImpl = async (_input, init) => {
    attempts += 1;
    if (attempts === 1) return new Response(firstPart);
    assert.equal(init.headers.Range, `bytes=${firstPart.length}-`);
    return new Response(bytes.subarray(firstPart.length), {
      status: 206,
      headers: { 'content-range': `bytes ${firstPart.length}-${bytes.length - 1}/${bytes.length}` },
    });
  };

  try {
    const result = await downloadVerifiedArtifact({
      url: '/v1/artifacts/truncated/file',
      origin: 'https://dkrypt.example',
      apiKey: 'test-api-key',
      outputPath: output,
      expectedSha256: sha256,
      expectedSizeBytes: bytes.length,
      fetchImpl,
      sleep: async () => {},
      maxAttempts: 2,
      timeoutMs: 5_000,
      retryBaseMs: 0,
      retryMaxMs: 0,
      log: () => {},
    });
    assert.equal(attempts, 2);
    assert.equal(await readFile(output, 'utf8'), bytes.toString());
    assert.equal(result.sha256, sha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
