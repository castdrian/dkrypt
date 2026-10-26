import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.js');

test('CLI prints shell completions without requiring API credentials', async () => {
  const child = spawn(process.execPath, [cliPath, 'completion', 'fish'], { env: { ...process.env, DKRYPT_CONFIG_PATH: '/tmp/dkrypt-cli-missing-config' } });
  const result = await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /complete -c dkrypt/);
  assert.match(result.stdout, /follow/);
  assert.match(result.stdout, /cursor/);
});

test('CLI generates proxy examples before API authentication is configured', async () => {
  const child = spawn(process.execPath, [cliPath, 'proxy-config', 'nginx', 'ipa.example.com', '--upstream', 'http://127.0.0.1:8080'], { env: { ...process.env, DKRYPT_CONFIG_PATH: '/tmp/dkrypt-cli-missing-config' } });
  const result = await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /server_name ipa\.example\.com/);
  assert.match(result.stdout, /proxy_buffering off/);
  assert.match(result.stdout, /proxy_read_timeout 3600s/);
});

test('CLI rejects unsafe reverse-proxy values', async () => {
  const child = spawn(process.execPath, [cliPath, 'proxy-config', 'caddy', 'example.com; malicious'], { env: { ...process.env, DKRYPT_CONFIG_PATH: '/tmp/dkrypt-cli-missing-config' } });
  const result = await new Promise((resolve) => {
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stderr }));
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fully qualified domain name/);
});

test('CLI logout removes saved credentials without requiring API credentials', async () => {
  const configPath = '/tmp/dkrypt-cli-config-' + process.pid + '.json';
  await writeFile(configPath, JSON.stringify({ apiUrl: 'https://ipa.dylib.dev', apiKey: 'secret-test-key' }), { mode: 0o600 });
  const child = spawn(process.execPath, [cliPath, 'logout'], { env: { ...process.env, DKRYPT_CONFIG_PATH: configPath } });
  const result = await new Promise((resolve) => {
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stderr }));
  });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(configPath));
});

test('CLI profiles list names without revealing credentials and switch the active profile', async () => {
  const configPath = '/tmp/dkrypt-cli-profiles-' + process.pid + '.json';
  const config = {
    activeProfile: 'home',
    profiles: {
      home: { apiUrl: 'https://home.example', apiKey: 'home-secret-key' },
      work: { apiUrl: 'https://work.example', apiKey: 'work-secret-key' },
    },
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const listed = spawn(process.execPath, [cliPath, 'profile', 'list'], { env: { ...process.env, DKRYPT_CONFIG_PATH: configPath } });
  const listResult = await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    listed.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    listed.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    listed.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.match(listResult.stdout, /home \(active\)/);
  assert.match(listResult.stdout, /work/);
  assert.doesNotMatch(listResult.stdout, /secret/);
  const switched = spawn(process.execPath, [cliPath, 'profile', 'use', 'work'], { env: { ...process.env, DKRYPT_CONFIG_PATH: configPath } });
  const switchResult = await new Promise((resolve) => {
    let stderr = '';
    switched.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    switched.on('close', (status) => resolve({ status, stderr }));
  });
  assert.equal(switchResult.status, 0, switchResult.stderr);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).activeProfile, 'work');
});

test('CLI one-off profile selection uses only that profile for API calls', async () => {
  const configPath = '/tmp/dkrypt-cli-selected-profile-' + process.pid + '.json';
  await writeFile(configPath, JSON.stringify({
    activeProfile: 'home',
    profiles: {
      home: { apiUrl: 'https://home.example', apiKey: 'home-secret-key' },
      lab: { apiUrl: 'http://127.0.0.1:0', apiKey: 'lab-secret-key' },
    },
  }), { mode: 0o600 });
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: 'job-lab', status: 'queued' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.profiles.lab.apiUrl = `http://127.0.0.1:${address.port}`;
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const child = spawn(process.execPath, [cliPath, '--profile', 'lab', 'status', 'job-lab'], { env: { ...process.env, DKRYPT_CONFIG_PATH: configPath } });
    const result = await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /job-lab/);
    assert.deepEqual(requests, [{ url: '/v1/jobs/job-lab', authorization: 'Bearer lab-secret-key' }]);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('CLI status sends the API key to the scoped job endpoint', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: 'job-1', status: 'done' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    const child = spawn(process.execPath, [cliPath, 'status', 'job-1'], {
      env: { ...process.env, DKRYPT_API_URL: `http://127.0.0.1:${address.port}`, DKRYPT_API_KEY: 'test-key' },
    });
    const result = await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"status": "done"/);
    assert.deepEqual(requests, [{ url: '/v1/jobs/job-1', authorization: 'Bearer test-key' }]);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('CLI doctor verifies API key and IPA library access only through public routes', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ artifacts: [], total: 0 }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    const child = spawn(process.execPath, [cliPath, 'doctor', '--json'], {
      env: { ...process.env, DKRYPT_API_URL: `http://127.0.0.1:${address.port}`, DKRYPT_API_KEY: 'test-key' },
    });
    const result = await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"name": "API key and IPA library",\n\s+"status": "ok"/);
    assert.deepEqual(requests, [
      { url: '/v1/artifacts?limit=1', authorization: 'Bearer test-key' },
    ]);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('CLI follow reconnects to the resumable event stream', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, lastEventId: request.headers['last-event-id'] });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const status = requests.length === 1 ? 'running' : 'done';
    const id = `event-${requests.length}`;
    response.end(`retry: 0\n\nid: ${id}\nevent: snapshot\ndata: ${JSON.stringify({ job: { id: 'job-1', status, progress: status } })}\n\n`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    const child = spawn(process.execPath, [cliPath, 'follow', 'job-1'], {
      env: { ...process.env, DKRYPT_API_URL: `http://127.0.0.1:${address.port}`, DKRYPT_API_KEY: 'test-key' },
    });
    const result = await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"status": "done"/);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, '/v1/jobs/job-1/events?timeoutSeconds=25');
    assert.equal(requests[1].lastEventId, 'event-1');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('CLI decrypt retries idempotently after a rate limit and sends no project scope', async () => {
  const requests = [];
  let attempts = 0;
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, authorization: request.headers.authorization, key: request.headers['idempotency-key'], body: JSON.parse(body) });
      attempts += 1;
      if (attempts === 1) {
        response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        response.end(JSON.stringify({ code: 'rate_limited', message: 'try again' }));
        return;
      }
      response.writeHead(202, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'job-2', status: 'queued' }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    const child = spawn(process.execPath, [cliPath, 'decrypt', 'com.example.app', '--version', '3.2', '--idempotency-key', 'stable-request'], {
      env: { ...process.env, DKRYPT_API_URL: `http://127.0.0.1:${address.port}`, DKRYPT_API_KEY: 'test-key' },
    });
    const result = await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"status": "queued"/);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.url), ['/v1/decrypts', '/v1/decrypts']);
    assert.deepEqual(requests.map((request) => request.key), ['stable-request', 'stable-request']);
    assert.deepEqual(requests[1].body, { bundleId: 'com.example.app', version: '3.2' });
  } finally {
    server.close();
    await once(server, 'close');
  }
});
