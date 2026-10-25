import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

const apiUrl = process.env.DKRYPT_API_URL ?? '';
const apiKey = process.env.DKRYPT_API_KEY ?? '';
const bundleId = process.env.DKRYPT_BUNDLE_ID ?? '';
const timeoutSeconds = Number(process.env.DKRYPT_TIMEOUT_SECONDS ?? '1800');

function validateOrigin(value) {
  const url = new URL(value);
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol !== 'https:' && !localHost) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('dkrypt API URL must be an HTTPS origin; HTTP is allowed only for localhost');
  return url.origin;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  if (!response.ok && response.status !== 202) {
    const payload = await response.json().catch(() => undefined);
    throw new Error(payload?.message ?? `dkrypt request failed with HTTP ${response.status}`);
  }
  return response;
}

async function output(name, value) {
  if (/[\r\n]/.test(value)) throw new Error(`dkrypt returned an invalid ${name}`);
  await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  if (!apiKey || apiKey.length < 8) throw new Error('Provide a valid dkrypt API key');
  if (!/^[A-Za-z0-9.-]{3,200}$/.test(bundleId)) throw new Error('Provide a valid app bundle ID');
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) throw new Error('Timeout must be between 1 and 86400 seconds');
  const origin = validateOrigin(apiUrl);
  const body = { bundleId, ...(process.env.DKRYPT_VERSION ? { version: process.env.DKRYPT_VERSION } : {}) };
  const submission = await request(`${origin}/v1/decrypts`, {
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID() },
    body: JSON.stringify(body),
  });
  let job = await submission.json();
  const deadline = Date.now() + timeoutSeconds * 1000;
  let delay = 2_000;
  while (job.status !== 'done' && job.status !== 'failed') {
    if (Date.now() >= deadline) throw new Error(`dkrypt job ${job.id} did not finish within the configured timeout`);
    await wait(delay);
    const status = await request(`${origin}/v1/jobs/${encodeURIComponent(job.id)}`);
    job = await status.json();
    delay = Math.min(10_000, Math.round(delay * 1.35));
  }
  await output('job-id', String(job.id));
  if (job.status === 'failed') throw new Error(`dkrypt job ${job.id} failed: ${String(job.error ?? 'unknown failure').slice(0, 500)}`);
  if (!job.artifactId) throw new Error(`dkrypt job ${job.id} completed without an artifact`);
  const fileUrl = new URL(job.artifactUrl ?? `/v1/artifacts/${encodeURIComponent(job.artifactId)}/file`, origin);
  if (fileUrl.origin !== origin) throw new Error('dkrypt returned an artifact URL outside its configured origin');
  const fileResponse = await request(fileUrl);
  const outputPath = process.env.DKRYPT_OUTPUT || `${bundleId}.ipa`;
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.partial`;
  try {
    await pipeline(Readable.fromWeb(fileResponse.body), createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  await output('artifact-id', String(job.artifactId));
  process.stdout.write(`Downloaded dkrypt artifact to ${outputPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
