import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.js');

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
