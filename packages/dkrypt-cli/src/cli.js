#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

const [command, ...args] = process.argv.slice(2);
const baseUrl = process.env.DKRYPT_API_URL;
const apiKey = process.env.DKRYPT_API_KEY;

if (command === '--help' || command === '-h' || command === undefined) {
  process.stdout.write('dkrypt decrypt <bundle-id> [--version <version>] [--project <id>]\ndkrypt status <job-id>\ndkrypt wait <job-id>\ndkrypt artifacts [search]\ndkrypt download <artifact-id> <output.ipa>\n');
  process.exit(0);
}

if (!baseUrl || !apiKey) throw new Error('Set DKRYPT_API_URL and DKRYPT_API_KEY in the environment');
const origin = new URL(baseUrl).origin;

function buildUrl(path) {
  const url = new URL(path, baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('dkrypt requests must use the configured origin');
  return url;
}

async function send(path, options = {}) {
  const response = await fetch(buildUrl(path), {
    ...options,
    redirect: 'error',
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers ?? {}) },
  });
  if (!response.ok && response.status !== 202) {
    const payload = await response.json().catch(() => undefined);
    throw new Error(payload?.message ?? payload?.error ?? `dkrypt request failed with HTTP ${response.status}`);
  }
  return response;
}

async function printJson(response) {
  process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
}

function optionValue(name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

if (command === 'decrypt') {
  const bundleId = args[0];
  if (!bundleId || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId)) throw new Error('Provide a valid app bundle ID');
  const body = { bundleId, ...(optionValue('--version') ? { version: optionValue('--version') } : {}), ...(optionValue('--project') ? { projectId: optionValue('--project') } : {}) };
  const response = await send('/v1/decrypts', { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/zip')) {
    const output = optionValue('--output') ?? `${bundleId}.ipa`;
    await pipeline(Readable.fromWeb(response.body), createWriteStream(output));
    process.stdout.write(`Saved decrypted IPA to ${output}\n`);
  } else await printJson(response);
} else if (command === 'status') {
  if (!args[0]) throw new Error('Provide a job ID');
  await printJson(await send(`/v1/jobs/${encodeURIComponent(args[0])}`));
} else if (command === 'wait') {
  if (!args[0]) throw new Error('Provide a job ID');
  let response;
  do {
    response = await send(`/v1/jobs/${encodeURIComponent(args[0])}/wait?timeoutSeconds=25`);
  } while (response.status === 202);
  await printJson(response);
} else if (command === 'artifacts') {
  const params = new URLSearchParams({ limit: '100' });
  if (args[0]) params.set('q', args[0]);
  await printJson(await send(`/v1/artifacts?${params}`));
} else if (command === 'download') {
  const [artifactId, output] = args;
  if (!artifactId || !output) throw new Error('Use: dkrypt download <artifact-id> <output.ipa>');
  const response = await send(`/v1/artifacts/${encodeURIComponent(artifactId)}/file`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(output));
  process.stdout.write(`Saved IPA to ${output}\n`);
} else {
  throw new Error(`Unknown command: ${command}`);
}
