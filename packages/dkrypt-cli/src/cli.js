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
  process.stdout.write('dkrypt login\ndkrypt logout\ndkrypt completion <bash|zsh|fish>\ndkrypt proxy-config <caddy|nginx|traefik> <domain> [--upstream <url>]\ndkrypt decrypt <bundle-id> [--version <version>] [--output <file.ipa>] [--idempotency-key <key>]\ndkrypt status <job-id>\ndkrypt wait <job-id>\ndkrypt follow <job-id>\ndkrypt artifacts [search] [--limit <1-100>] [--cursor <cursor>]\ndkrypt download <artifact-id> <output.ipa>\n');
  process.exit(0);
}

if (command === 'completion') {
  const completions = {
    bash: '_dkrypt() {\n  local cur prev\n  cur="${COMP_WORDS[COMP_CWORD]}"\n  prev="${COMP_WORDS[COMP_CWORD-1]}"\n  case "$prev" in\n    completion) COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ); return ;;\n    --version|--output|--idempotency-key|--limit|--cursor) COMPREPLY=(); return ;;\n    proxy-config) if (( COMP_CWORD <= 2 )); then COMPREPLY=( $(compgen -W "caddy nginx traefik" -- "$cur") ); else COMPREPLY=( $(compgen -W "--upstream" -- "$cur") ); fi; return ;;\n    --upstream) COMPREPLY=(); return ;;\n  esac\n  case "${COMP_WORDS[1]}" in\n    proxy-config) COMPREPLY=( $(compgen -W "--upstream" -- "$cur") ) ;;\n    decrypt) COMPREPLY=( $(compgen -W "--version --output --idempotency-key" -- "$cur") ) ;;\n    artifacts) COMPREPLY=( $(compgen -W "--limit --cursor" -- "$cur") ) ;;\n    *) COMPREPLY=( $(compgen -W "login logout completion proxy-config decrypt status wait follow artifacts download" -- "$cur") ) ;;\n  esac\n}\ncomplete -F _dkrypt dkrypt\n',
    zsh: '_dkrypt() {\n  local context state state_descr line\n  _arguments \\\n    "1:command:(login logout completion proxy-config decrypt status wait follow artifacts download)" \\\n    "*::argument:->args"\n  case "$words[2]" in\n    completion) _values "shell" bash zsh fish ;;\n    proxy-config) _arguments "1:proxy:(caddy nginx traefik)" "--upstream[Upstream origin]:url:" ;;\n    decrypt) _arguments "--version[App version]:version:" "--output[Output IPA]:file:_files" "--idempotency-key[Request key]:key:" ;;\n    artifacts) _arguments "--limit[Page size]:limit:" "--cursor[Page cursor]:cursor:" ;;\n    download) _files -g "*.ipa" ;;\n  esac\n}\ncompdef _dkrypt dkrypt\n',
    fish: 'complete -c dkrypt -f -n "__fish_use_subcommand" -a "login logout completion proxy-config decrypt status wait follow artifacts download"\ncomplete -c dkrypt -f -n "__fish_seen_subcommand_from completion" -a "bash zsh fish"\ncomplete -c dkrypt -f -n "__fish_seen_subcommand_from proxy-config" -a "caddy nginx traefik"\ncomplete -c dkrypt -l version -r -n "__fish_seen_subcommand_from decrypt"\ncomplete -c dkrypt -l output -r -F -n "__fish_seen_subcommand_from decrypt"\ncomplete -c dkrypt -l idempotency-key -r -n "__fish_seen_subcommand_from decrypt"\ncomplete -c dkrypt -l limit -r -n "__fish_seen_subcommand_from artifacts"\ncomplete -c dkrypt -l cursor -r -n "__fish_seen_subcommand_from artifacts"\ncomplete -c dkrypt -l upstream -r -n "__fish_seen_subcommand_from proxy-config"\n',
  };
  if (!args[0] || !(args[0] in completions)) throw new Error('Choose bash, zsh, or fish');
  process.stdout.write(completions[args[0]]);
  process.exit(0);
}

if (command === 'proxy-config') {
  const format = args[0];
  const domain = args[1]?.toLowerCase();
  const upstreamInput = optionValue('--upstream') ?? 'http://127.0.0.1:8080';
  if (!['caddy', 'nginx', 'traefik'].includes(format)) throw new Error('Choose caddy, nginx, or traefik');
  if (!domain || domain.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) throw new Error('Provide a fully qualified domain name');
  let upstream;
  try {
    upstream = new URL(upstreamInput);
  } catch {
    throw new Error('Provide a valid upstream URL');
  }
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) throw new Error('Upstream must be an HTTP(S) origin without credentials or a path');
  const target = upstream.origin;
  const configs = {
    caddy: `${domain} {\n  reverse_proxy ${target}\n}\n`,
    nginx: `server {\n    listen 443 ssl http2;\n    server_name ${domain};\n    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;\n    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;\n\n    location / {\n        proxy_pass ${target};\n        proxy_http_version 1.1;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_buffering off;\n        proxy_read_timeout 3600s;\n    }\n}\n`,
    traefik: `http:\n  routers:\n    dkrypt:\n      rule: Host(\`${domain}\`)\n      entryPoints:\n        - websecure\n      service: dkrypt\n      tls: {}\n  services:\n    dkrypt:\n      loadBalancer:\n        servers:\n          - url: ${JSON.stringify(target)}\n        responseForwarding:\n          flushInterval: -1\n`,
  };
  process.stdout.write(configs[format]);
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

async function followJob(jobId) {
  let lastEventId;
  let lastSignature;
  let reconnectDelayMs = 250;
  const startedAt = Date.now();
  while (true) {
    const headers = { Accept: 'text/event-stream', ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}) };
    const response = await send(`/v1/jobs/${encodeURIComponent(jobId)}/events?timeoutSeconds=25`, { headers });
    if (!response.body) throw new Error('dkrypt job event stream has no response body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let disconnected = false;
    try {
      while (true) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch {
          disconnected = true;
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: !chunk.done }).replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const parsed = parseEventBlock(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (parsed?.retryMs !== undefined) reconnectDelayMs = parsed.retryMs;
          if (parsed?.event === 'snapshot' && parsed.data) {
            const snapshot = JSON.parse(parsed.data);
            const job = snapshot?.job;
            if (parsed.id) lastEventId = parsed.id;
            if (job && typeof job.status === 'string') {
              const signature = `${job.status}:${job.progress ?? ''}`;
              if (signature !== lastSignature) {
                const elapsed = Math.floor((Date.now() - startedAt) / 1000);
                process.stderr.write(`[${elapsed}s] Job ${jobId}: ${job.status}${job.progress ? ` · ${job.progress}` : ''}\n`);
                lastSignature = signature;
              }
              if (job.status === 'done' || job.status === 'failed') return job;
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
        if (chunk.done) break;
      }
    } finally {
      reader.releaseLock();
    }
    if (disconnected) process.stderr.write(`Job ${jobId}: event stream disconnected; reconnecting\n`);
    await wait(reconnectDelayMs);
  }
}

function parseEventBlock(block) {
  const data = [];
  let id;
  let event;
  let retryMs;
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'id' && !value.includes('\0')) id = value;
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
    if (field === 'retry' && /^\d+$/.test(value)) retryMs = Math.min(30_000, Number(value));
  }
  return data.length || retryMs !== undefined ? { id, event, data: data.length ? data.join('\n') : undefined, retryMs } : undefined;
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
} else if (command === 'wait') {
  if (!args[0]) throw new Error('Provide a job ID');
  await printJson(await send(`/v1/jobs/${encodeURIComponent(args[0])}/wait?timeoutSeconds=25`));
} else if (command === 'follow') {
  if (!args[0]) throw new Error('Provide a job ID');
  process.stdout.write(`${JSON.stringify(await followJob(args[0]), null, 2)}\n`);
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
