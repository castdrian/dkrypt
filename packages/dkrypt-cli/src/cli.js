#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const [command, ...args] = process.argv.slice(2);
const configPath = process.env.DKRYPT_CONFIG_PATH ?? path.join(homedir(), '.config', 'dkrypt', 'config.json');

if (command === '--help' || command === '-h' || command === undefined) {
  process.stdout.write('dkrypt login\ndkrypt logout\ndkrypt completion <bash|zsh|fish>\ndkrypt decrypt <bundle-id> [--version <version>] [--output <file.ipa>] [--idempotency-key <key>]\ndkrypt status <job-id>\ndkrypt wait <job-id>\ndkrypt follow <job-id>\ndkrypt artifacts [search] [--limit <1-100>] [--cursor <cursor>]\ndkrypt download <artifact-id> <output.ipa>\n');
  process.exit(0);
}

if (command === 'completion') {
  const completions = {
    bash: 'complete -W "login logout completion decrypt status wait follow artifacts download" dkrypt\n',
    zsh: '_dkrypt() { _arguments "1:command:(login logout completion decrypt status wait follow artifacts download)"; }\ncompdef _dkrypt dkrypt\n',
    fish: 'complete -c dkrypt -f -a "login logout completion decrypt status wait follow artifacts download"\n',
  };
  if (!args[0] || !(args[0] in completions)) throw new Error('Choose bash, zsh, or fish');
  process.stdout.write(completions[args[0]]);
  process.exit(0);
}

async function readSavedConfig() {
  try {
    const value = JSON.parse(await readFile(configPath, 'utf8'));
    if (typeof value.apiUrl !== 'string' || typeof value.apiKey !== 'string') throw new Error();
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error('Saved dkrypt CLI sign-in is invalid. Run dkrypt logout, then dkrypt login.');
  }
}

function validateApiUrl(value) {
  const url = new URL(value);
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || (url.protocol !== 'https:' && !localHost) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS dkrypt URL; HTTP is allowed only for localhost');
  }
  return url.origin;
}

function readHiddenInput(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') throw new Error('dkrypt login needs an interactive terminal so the API key can be entered without echoing');
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.off('data', handleInput);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value.trim());
    };
    const handleInput = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') return finish(new Error('Login cancelled'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ' && character <= '~') value += character;
      }
    };
    process.stdin.on('data', handleInput);
  });
}

async function login() {
  if (!process.stdin.isTTY) throw new Error('dkrypt login needs an interactive terminal');
  const saved = await readSavedConfig();
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let apiUrl;
  try {
    const enteredUrl = await prompt.question('dkrypt URL' + (saved.apiUrl ? ' (' + saved.apiUrl + ')' : '') + ': ');
    apiUrl = validateApiUrl(enteredUrl.trim() || saved.apiUrl || 'https://ipa.dylib.dev');
  } finally {
    prompt.close();
  }
  const apiKey = await readHiddenInput('API key (input hidden): ');
  if (apiKey.length < 8) throw new Error('Enter a valid API key');
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temporaryPath = configPath + '.' + process.pid + '.tmp';
  await writeFile(temporaryPath, JSON.stringify({ apiUrl, apiKey }), { mode: 0o600 });
  await rename(temporaryPath, configPath);
  process.stdout.write('Signed in. The local configuration is readable only by your account.\n');
}

if (command === 'login') {
  await login();
  process.exit(0);
}

if (command === 'logout') {
  await rm(configPath, { force: true });
  process.stdout.write('Signed out from the saved dkrypt CLI configuration.\n');
  process.exit(0);
}

const savedConfig = process.env.DKRYPT_API_URL && process.env.DKRYPT_API_KEY ? {} : await readSavedConfig();
const baseUrl = process.env.DKRYPT_API_URL ?? savedConfig.apiUrl;
const apiKey = process.env.DKRYPT_API_KEY ?? savedConfig.apiKey;
if (!baseUrl || !apiKey) throw new Error('Set DKRYPT_API_URL and DKRYPT_API_KEY in the environment, or run dkrypt login');
validateApiUrl(baseUrl);
const origin = new URL(baseUrl).origin;

function buildUrl(path) {
  const url = new URL(path, baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('dkrypt requests must use the configured origin');
  return url;
}

async function send(path, options = {}) {
  const headers = { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers ?? {}) };
  const canRetry = options.method === undefined || options.method === 'GET' || Boolean(headers['Idempotency-Key']);
  let response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(buildUrl(path), { ...options, redirect: 'error', headers });
    } catch (error) {
      if (!canRetry || attempt >= 2) throw error;
      await wait(250 * (2 ** attempt));
      continue;
    }
    if (response.ok || response.status === 202) return response;
    if (canRetry && attempt < 2 && [429, 502, 503, 504].includes(response.status)) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : 250 * (2 ** attempt));
      continue;
    }
    const payload = await response.json().catch(() => undefined);
    throw new Error(payload?.message ?? payload?.error ?? `dkrypt request failed with HTTP ${response.status}`);
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function downloadToFile(response, output) {
  const temporary = `${output}.${process.pid}.${randomUUID()}.partial`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
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
  const version = optionValue('--version');
  const body = { bundleId, ...(version ? { version } : {}) };
  const idempotencyKey = optionValue('--idempotency-key') ?? randomUUID();
  const response = await send('/v1/decrypts', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body) });
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/zip')) {
    const output = optionValue('--output') ?? `${bundleId}.ipa`;
    await downloadToFile(response, output);
    process.stdout.write(`Saved decrypted IPA to ${output}\n`);
  } else await printJson(response);
} else if (command === 'status') {
  if (!args[0]) throw new Error('Provide a job ID');
  await printJson(await send(`/v1/jobs/${encodeURIComponent(args[0])}`));
} else if (command === 'wait' || command === 'follow') {
  if (!args[0]) throw new Error('Provide a job ID');
  let response;
  const followStartedAt = Date.now();
  let lastFollowSignature;
  do {
    response = await send(`/v1/jobs/${encodeURIComponent(args[0])}/wait?timeoutSeconds=25`);
    if (response.status === 202 && command === 'follow') {
      const job = await response.json().catch(() => undefined);
      const state = typeof job?.status === 'string' ? job.status : 'still running';
      const progress = typeof job?.progress === 'string' ? job.progress : '';
      const signature = state + ':' + progress;
      if (signature !== lastFollowSignature) {
        const elapsed = Math.floor((Date.now() - followStartedAt) / 1000);
        process.stderr.write('[' + elapsed + 's] Job ' + args[0] + ': ' + state + (progress ? ' · ' + progress : '') + '\n');
        lastFollowSignature = signature;
      }
    }
  } while (response.status === 202);
  await printJson(response);
} else if (command === 'artifacts') {
  const limitText = optionValue('--limit') ?? '100';
  if (!/^\d+$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > 100) throw new Error('--limit must be between 1 and 100');
  const params = new URLSearchParams({ limit: limitText });
  const search = args.find((value, index) => index === 0 && !value.startsWith('--'));
  if (search) params.set('q', search);
  if (optionValue('--cursor')) params.set('cursor', optionValue('--cursor'));
  await printJson(await send(`/v1/artifacts?${params}`));
} else if (command === 'download') {
  const [artifactId, output] = args;
  if (!artifactId || !output) throw new Error('Use: dkrypt download <artifact-id> <output.ipa>');
  const response = await send(`/v1/artifacts/${encodeURIComponent(artifactId)}/file`);
  await downloadToFile(response, output);
  process.stdout.write(`Saved IPA to ${output}\n`);
} else {
  throw new Error(`Unknown command: ${command}`);
}
