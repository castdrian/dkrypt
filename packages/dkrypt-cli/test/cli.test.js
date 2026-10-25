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
