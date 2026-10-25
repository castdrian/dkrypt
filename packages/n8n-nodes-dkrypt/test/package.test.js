const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { test } = require('node:test');

test('n8n package exposes only supported dkrypt public API actions', async () => {
  const node = await readFile(require.resolve('../nodes/Dkrypt/Dkrypt.node.js'), 'utf8');
  const packageJson = JSON.parse(await readFile(require.resolve('../package.json'), 'utf8'));
  assert.equal(packageJson.n8n.nodes[0], 'nodes/Dkrypt/Dkrypt.node.js');
  assert.match(node, /\/v1\/decrypts/);
  assert.match(node, /\/v1\/jobs/);
  assert.match(node, /\/v1\/artifacts/);
  assert.doesNotMatch(node, /\/v1\/(?:billing|auth|dashboard|settings)/);
});

test('n8n decrypt action submits an idempotent public API request', async () => {
  const { Dkrypt } = require('../nodes/Dkrypt/Dkrypt.node.js');
  const calls = [];
  const context = {
    getInputData: () => [{ json: {} }],
    getCredentials: async () => ({ baseUrl: 'https://ipa.dylib.dev', apiKey: 'never-read-by-node' }),
    getNodeParameter: (name) => ({ operation: 'decrypt', bundleId: 'com.example.app', version: '4.2', idempotencyKey: 'stable-id' })[name],
    helpers: {
      httpRequestWithAuthentication: async function (name, options) {
        calls.push({ name, options });
        return { id: 'job-1', status: 'queued' };
      },
    },
  };
  const result = await new Dkrypt().execute.call(context);
  assert.deepEqual(calls[0], {
    name: 'dkryptApi',
    options: {
      method: 'POST',
      url: 'https://ipa.dylib.dev/v1/decrypts',
      headers: { Accept: 'application/json', 'Idempotency-Key': 'stable-id' },
      json: true,
      body: { bundleId: 'com.example.app', version: '4.2' },
    },
  });
  assert.deepEqual(result, [[{ json: { id: 'job-1', status: 'queued' }, pairedItem: { item: 0 } }]]);
});
