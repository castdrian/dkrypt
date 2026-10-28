#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const cliArgs = process.argv.slice(2);
let requestedProfile = process.env.DKRYPT_PROFILE;
if (cliArgs[0] === '--profile') {
  requestedProfile = cliArgs[1];
  cliArgs.splice(0, 2);
}
const [command, ...args] = cliArgs;
const configPath = process.env.DKRYPT_CONFIG_PATH ?? path.join(homedir(), '.config', 'dkrypt', 'config.json');

if (command === '--help' || command === '-h' || command === undefined) {
  process.stdout.write('dkrypt login [--profile <name>] [--manual]\ndkrypt logout [--profile <name>]\ndkrypt profile <list|use|delete> [name]\ndkrypt --profile <name> <command>\ndkrypt completion <bash|zsh|fish>\ndkrypt proxy-config <caddy|nginx|traefik> <domain> [--upstream <url>]\ndkrypt mcp <login|logout|stdio> [--url <origin>] [--scope <scopes>]\ndkrypt doctor [--bundle-id <id>] [--channel appstore|testflight] [--json]\ndkrypt tui\ndkrypt decrypt <bundle-id> [--version <version>] [--output <file.ipa>] [--idempotency-key <key>]\ndkrypt status <job-id>\ndkrypt wait <job-id>\ndkrypt follow <job-id>\ndkrypt artifacts [search] [--limit <1-100>] [--cursor <cursor>]\ndkrypt download <artifact-id> <output.ipa>\n');
  process.exit(0);
}

if (command === 'completion') {
  const completions = {
    bash: '_dkrypt() {\n  local cur prev\n  cur="${COMP_WORDS[COMP_CWORD]}"\n  prev="${COMP_WORDS[COMP_CWORD-1]}"\n  case "$prev" in\n    completion) COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ); return ;;\n    profile) COMPREPLY=( $(compgen -W "list use delete" -- "$cur") ); return ;;\n    mcp) COMPREPLY=( $(compgen -W "login logout stdio" -- "$cur") ); return ;;\n    --profile) COMPREPLY=(); return ;;\n    --version|--output|--idempotency-key|--limit|--cursor|--url|--scope|--bundle-id) COMPREPLY=(); return ;;\n    --channel) COMPREPLY=( $(compgen -W "appstore testflight" -- "$cur") ); return ;;\n    proxy-config) if (( COMP_CWORD <= 2 )); then COMPREPLY=( $(compgen -W "caddy nginx traefik" -- "$cur") ); else COMPREPLY=( $(compgen -W "--upstream" -- "$cur") ); fi; return ;;\n    --upstream) COMPREPLY=(); return ;;\n  esac\n  case "${COMP_WORDS[1]}" in\n    proxy-config) COMPREPLY=( $(compgen -W "--upstream" -- "$cur") ) ;;\n    doctor) COMPREPLY=( $(compgen -W "--bundle-id --channel --json" -- "$cur") ) ;;\n    decrypt) COMPREPLY=( $(compgen -W "--version --output --idempotency-key" -- "$cur") ) ;;\n    artifacts) COMPREPLY=( $(compgen -W "--limit --cursor" -- "$cur") ) ;;\n    *) COMPREPLY=( $(compgen -W "login logout profile completion proxy-config mcp doctor tui decrypt status wait follow artifacts download" -- "$cur") ) ;;\n  esac\n}\ncomplete -F _dkrypt dkrypt\n',
    zsh: '_dkrypt() {\n  local context state state_descr line\n  _arguments \\\n    "1:command:(login logout profile completion proxy-config mcp doctor tui decrypt status wait follow artifacts download)" \\\n    "*::argument:->args"\n  case "$words[2]" in\n    completion) _values "shell" bash zsh fish ;;\n    profile) _values "action" list use delete ;;\n    proxy-config) _arguments "1:proxy:(caddy nginx traefik)" "--upstream[Upstream origin]:url:" ;;\n    doctor) _arguments "--bundle-id[Bundle ID]:bundle:" "--channel[Release channel]:channel:(appstore testflight)" "--json[Machine-readable output]" ;;\n    decrypt) _arguments "--version[App version]:version:" "--output[Output IPA]:file:_files" "--idempotency-key[Request key]:key:" ;;\n    artifacts) _arguments "--limit[Page size]:limit:" "--cursor[Page cursor]:cursor:" ;;\n    download) _files -g "*.ipa" ;;\n  esac\n}\ncompdef _dkrypt dkrypt\n',
    fish: 'complete -c dkrypt -f -n "__fish_use_subcommand" -a "login logout profile completion proxy-config mcp doctor tui decrypt status wait follow artifacts download"\ncomplete -c dkrypt -f -n "__fish_seen_subcommand_from completion" -a "bash zsh fish"\ncomplete -c dkrypt -f -n "__fish_seen_subcommand_from profile" -a "list use delete"\ncomplete -c dkrypt -f -n "__fish_seen_subcommand_from proxy-config" -a "caddy nginx traefik"\ncomplete -c dkrypt -f -n "__fish_seen_subcommand_from doctor" -l bundle-id -r\ncomplete -c dkrypt -f -n "__fish_seen_subcommand_from doctor" -l channel -r -a "appstore testflight"\ncomplete -c dkrypt -l profile -r\ncomplete -c dkrypt -l version -r -n "__fish_seen_subcommand_from decrypt"\ncomplete -c dkrypt -l output -r -F -n "__fish_seen_subcommand_from decrypt"\ncomplete -c dkrypt -l idempotency-key -r -n "__fish_seen_subcommand_from decrypt"\ncomplete -c dkrypt -l limit -r -n "__fish_seen_subcommand_from artifacts"\ncomplete -c dkrypt -l cursor -r -n "__fish_seen_subcommand_from artifacts"\ncomplete -c dkrypt -l upstream -r -n "__fish_seen_subcommand_from proxy-config"\n',
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
    if (value && typeof value.profiles === 'object' && value.profiles !== null && !Array.isArray(value.profiles)) {
      const profiles = Object.fromEntries(Object.entries(value.profiles).filter(([name, profile]) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(name) && profile && typeof profile.apiUrl === 'string' && (typeof profile.apiKey === 'string' || (profile.mcp && typeof profile.mcp.accessToken === 'string'))));
      const activeProfile = typeof value.activeProfile === 'string' && profiles[value.activeProfile] ? value.activeProfile : Object.keys(profiles)[0];
      return { profiles, activeProfile };
    }
    if (typeof value.apiUrl === 'string' && typeof value.apiKey === 'string') return { activeProfile: 'default', profiles: { default: { apiUrl: value.apiUrl, apiKey: value.apiKey } } };
    throw new Error();
  } catch (error) {
    if (error?.code === 'ENOENT') return { profiles: {}, activeProfile: undefined };
    throw new Error('Saved dkrypt CLI sign-in is invalid. Run dkrypt logout, then dkrypt login.');
  }
}

async function writeSavedConfig(config) {
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temporaryPath = configPath + '.' + process.pid + '.tmp';
  await writeFile(temporaryPath, JSON.stringify(config), { mode: 0o600 });
  await rename(temporaryPath, configPath);
}

function selectedProfileName(saved) {
  return optionValue('--profile') ?? requestedProfile ?? saved.activeProfile ?? 'default';
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
  const profileName = optionValue('--profile') ?? requestedProfile ?? saved.activeProfile ?? 'default';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(profileName)) throw new Error('Profile names must be 1 to 48 letters, numbers, hyphens, or underscores');
  const existingProfile = saved.profiles[profileName];
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let apiUrl;
  try {
    const enteredUrl = await prompt.question(`dkrypt URL${existingProfile?.apiUrl ? ' (' + existingProfile.apiUrl + ')' : ''}: `);
    apiUrl = validateApiUrl(enteredUrl.trim() || existingProfile?.apiUrl || 'https://ipa.dylib.dev');
  } finally {
    prompt.close();
  }
  let apiKey;
  if (args.includes('--manual')) {
    apiKey = await readHiddenInput('API key (input hidden): ');
    if (apiKey.length < 8) throw new Error('Enter a valid API key');
  } else {
    apiKey = await authorizeCliProfile(apiUrl);
  }
  saved.profiles[profileName] = { ...existingProfile, apiUrl, apiKey };
  saved.activeProfile = profileName;
  await writeSavedConfig(saved);
  process.stdout.write(`Signed in to profile "${profileName}". The local configuration is readable only by your account.\n`);
}

function openVerificationPage(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const commandArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, commandArgs, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', () => {});
    child.unref();
  } catch {}
}

async function authorizeCliProfile(apiUrl) {
  const startUrl = new URL('/v1/cli/device/start', apiUrl);
  const startResponse = await fetch(startUrl, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}' });
  const startPayload = await startResponse.json().catch(() => ({}));
  if (!startResponse.ok) throw new Error(startPayload.message ?? startPayload.error ?? `Could not start dkrypt sign-in (HTTP ${startResponse.status})`);
  const verificationUri = new URL(startPayload.verificationUri);
  if (verificationUri.origin !== apiUrl || verificationUri.pathname !== '/cli/authorize' || typeof startPayload.deviceCode !== 'string' || typeof startPayload.userCode !== 'string') throw new Error('dkrypt returned an invalid sign-in request');
  const expiresAt = Date.now() + Math.max(60, Number(startPayload.expiresIn) || 600) * 1000;
  let interval = Math.max(2, Number(startPayload.interval) || 5);
  process.stdout.write(`\nOpen ${verificationUri.toString()} and confirm code ${startPayload.userCode}.\n`);
  openVerificationPage(verificationUri.toString());
  process.stdout.write('Waiting for approval');
  let lastProgressAt = Date.now();
  while (Date.now() < expiresAt) {
    await wait(interval * 1000);
    const response = await fetch(new URL('/v1/cli/device/token', apiUrl), {
      method: 'POST',
      redirect: 'error',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: startPayload.deviceCode }),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && typeof payload.accessToken === 'string') {
      process.stdout.write('\n');
      return payload.accessToken;
    }
    if (payload.error === 'authorization_pending') {
      if (Date.now() - lastProgressAt >= 15_000) {
        process.stdout.write('.');
        lastProgressAt = Date.now();
      }
      continue;
    }
    if (payload.error === 'slow_down') {
      interval = Math.max(interval + 5, Number(payload.interval) || interval + 5);
      continue;
    }
    process.stdout.write('\n');
    if (payload.error === 'access_denied') throw new Error('CLI sign-in was denied in the browser');
    if (payload.error === 'expired_token') throw new Error('CLI sign-in expired. Run dkrypt login again.');
    throw new Error(payload.message ?? payload.error ?? `Could not finish dkrypt sign-in (HTTP ${response.status})`);
  }
  process.stdout.write('\n');
  throw new Error('CLI sign-in expired. Run dkrypt login again.');
}

if (command === 'login') {
  await login();
  process.exit(0);
}

if (command === 'logout') {
  const saved = await readSavedConfig();
  const profileName = optionValue('--profile') ?? requestedProfile ?? saved.activeProfile ?? 'default';
  delete saved.profiles[profileName];
  const names = Object.keys(saved.profiles);
  if (names.length === 0) await rm(configPath, { force: true });
  else {
    saved.activeProfile = saved.activeProfile === profileName ? names[0] : saved.activeProfile;
    await writeSavedConfig(saved);
  }
  process.stdout.write(`Signed out from profile "${profileName}".\n`);
  process.exit(0);
}

if (command === 'profile') {
  const saved = await readSavedConfig();
  const action = args[0];
  if (action === 'list') {
    for (const name of Object.keys(saved.profiles).sort()) process.stdout.write(`${name}${name === saved.activeProfile ? ' (active)' : ''}\n`);
    if (Object.keys(saved.profiles).length === 0) process.stdout.write('No saved profiles. Run dkrypt login --profile <name>.\n');
  } else if (action === 'use') {
    const name = args[1];
    if (!name || !saved.profiles[name]) throw new Error('Choose an existing profile. Run dkrypt profile list.');
    saved.activeProfile = name;
    await writeSavedConfig(saved);
    process.stdout.write(`Using profile "${name}".\n`);
  } else if (action === 'delete') {
    const name = args[1] ?? selectedProfileName(saved);
    if (!saved.profiles[name]) throw new Error(`Profile "${name}" was not found`);
    delete saved.profiles[name];
    const names = Object.keys(saved.profiles);
    if (names.length === 0) await rm(configPath, { force: true });
    else {
      if (saved.activeProfile === name) saved.activeProfile = names[0];
      await writeSavedConfig(saved);
    }
    process.stdout.write(`Deleted profile "${name}".\n`);
  } else throw new Error('Use dkrypt profile list, use <name>, or delete <name>');
  process.exit(0);
}

if (command === 'mcp') {
  const { runMcpCommand } = await import('./mcp.js');
  await runMcpCommand(args, { configPath, profileName: optionValue('--profile') ?? requestedProfile });
  process.exit(0);
}

const savedConfig = await readSavedConfig();
const profileName = selectedProfileName(savedConfig);
const profile = savedConfig.profiles[profileName] ?? {};
const baseUrl = process.env.DKRYPT_API_URL ?? profile.apiUrl;
const apiKey = process.env.DKRYPT_API_KEY ?? profile.apiKey;
if (!baseUrl || (!apiKey && !(command === 'tui' && profile.mcp))) throw new Error('Set DKRYPT_API_URL and DKRYPT_API_KEY in the environment, or run dkrypt login');
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
      if (!canRetry || attempt >= 2) {
        const recovery = canRetry ? ' Retry with the same idempotency key if this was a submission.' : '';
        throw new Error(`Network request to dkrypt failed: ${error instanceof Error ? error.message : String(error)}.${recovery}`);
      }
      await wait(250 * (2 ** attempt));
      continue;
    }
    if (response.ok || response.status === 202) return response;
    if (canRetry && attempt < 2 && [429, 500, 502, 503, 504].includes(response.status)) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterSeconds = Number(retryAfterHeader);
      const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : retryAfterHeader ? Math.max(0, Date.parse(retryAfterHeader) - Date.now()) : 0;
      await wait(retryAfterMs > 0 ? Math.min(retryAfterMs, 30_000) : 250 * (2 ** attempt));
      continue;
    }
    const payload = await response.json().catch(() => undefined);
    throw new Error(explainApiError(payload, response));
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function explainApiError(payload, response) {
  const message = payload?.message ?? payload?.error ?? `dkrypt request failed with HTTP ${response.status}`;
  const code = payload?.code;
  const hints = {
    unauthorized: 'Create or rotate the API key, then update the key used by this client.',
    bundle_scope_denied: 'Add this bundle ID to the API key’s allowed bundle IDs.',
    daily_decrypt_limit: 'Wait until the next available allowance slot. Retry-After and remediation.nextAvailableAt show when.',
    idempotency_conflict: 'Reuse the original key with the exact same request, or use a new key for changed details.',
    testflight_lookup_failed: 'Retry when TestFlight lookup is available. Reuse the same idempotency key if submitting again.',
  };
  const hint = hints[code]
    ?? (response.status === 410 ? 'The stored result expired. Submit again with a new idempotency key.'
      : /idempotency/i.test(message) && /no longer retained/i.test(message) ? 'The stored result expired. Submit again with a new idempotency key.'
        : /idempotency/i.test(message) ? 'Reuse the original key with the exact same request, or use a new key for changed request details.'
          : /not scoped to this bundle/i.test(message) ? 'Add this bundle ID to the API key’s allowed bundle IDs.' : undefined)
    ?? (response.status === 401 ? 'Check that the API key is valid and has not been revoked.'
      : response.status === 403 ? 'Check the API key’s bundle ID and TestFlight scopes.'
        : response.status === 404 ? 'Check the bundle, version, job, or artifact ID; finished jobs are retained for a limited time.'
          : response.status === 409 ? 'The request conflicts with the current job or idempotency record. Keep the same key and request for safe retries.'
            : response.status === 429 ? 'Wait for the allowance or rate limit to reset before retrying.'
              : response.status >= 500 ? 'Retry only with the same idempotency key, and keep the request ID for support.'
                : 'Check the request fields and the API error message.');
  const retryAfter = response.headers.get('retry-after');
  const requestId = payload?.requestId ?? response.headers.get('x-request-id');
  return [
    `dkrypt API error${code ? ` (${code})` : ''} · HTTP ${response.status}: ${message}`,
    hint ? `Recovery: ${hint}` : '',
    retryAfter ? `Retry-After: ${retryAfter}` : '',
    requestId ? `Request ID: ${requestId}` : '',
  ].filter(Boolean).join('\n');
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

async function runDoctor() {
  const checks = [];
  const bundleId = optionValue('--bundle-id');
  const channel = optionValue('--channel') ?? 'appstore';
  if (args.includes('--bundle-id') && !bundleId) throw new Error('--bundle-id requires an app bundle ID');
  if (args.includes('--channel') && !optionValue('--channel')) throw new Error('--channel requires appstore or testflight');
  if (!['appstore', 'testflight'].includes(channel)) throw new Error('--channel must be appstore or testflight');
  if (bundleId && !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId)) throw new Error('Provide a valid app bundle ID');
  if (!bundleId && args.includes('--channel')) throw new Error('--channel requires --bundle-id');
  try {
    const artifacts = await send('/v1/artifacts?limit=1').then((response) => response.json());
    const validPage = Array.isArray(artifacts.artifacts) && Number.isSafeInteger(artifacts.total);
    checks.push({ name: 'API key and IPA library', status: validPage ? 'ok' : 'error', detail: validPage ? `API key accepted · ${artifacts.total} artifact(s) visible` : 'The public API returned an invalid artifact page' });
  } catch (error) {
    checks.push({ name: 'API key and IPA library', status: 'error', detail: error instanceof Error ? error.message : String(error) });
  }
  if (bundleId) {
    try {
      const response = await send('/v1/decrypts', {
        method: 'POST',
        body: JSON.stringify({ bundleId, channel, resolveOnly: true }),
      });
      const result = await response.json();
      const validResult = result.resolveOnly === true && typeof result.resolvedVersion === 'string' && result.channel === channel;
      checks.push({
        name: `${channel === 'testflight' ? 'TestFlight' : 'App Store'} release resolution`,
        status: validResult ? 'ok' : 'error',
        detail: validResult ? `Resolved ${result.resolvedVersion}${result.cacheHit ? ' · exact artifact is cached' : ''} · no job submitted and no allowance used` : 'The public API returned an invalid release-resolution response',
      });
    } catch (error) {
      checks.push({ name: `${channel === 'testflight' ? 'TestFlight' : 'App Store'} release resolution`, status: 'error', detail: error instanceof Error ? error.message : String(error) });
    }
  } else {
    checks.push({ name: 'Release resolution', status: 'info', detail: 'Not checked · pass --bundle-id <id> to resolve a release without submitting a decrypt job' });
  }
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify({ checkedAt: new Date().toISOString(), checks }, null, 2)}\n`);
  else for (const check of checks) process.stdout.write(`[${check.status.toUpperCase()}] ${check.name}: ${check.detail}\n`);
  if (checks.some((check) => check.status === 'error')) process.exitCode = 1;
}

async function rememberJob(jobId) {
  if (typeof jobId !== 'string' || !jobId) return;
  const saved = await readSavedConfig();
  const name = selectedProfileName(saved);
  const current = saved.profiles[name] ?? { apiUrl: baseUrl, apiKey };
  saved.profiles[name] = { ...current, recentJobIds: [jobId, ...(current.recentJobIds ?? []).filter((id) => id !== jobId)].slice(0, 20) };
  saved.activeProfile = name;
  await writeSavedConfig(saved);
}

async function runTui() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function' || !process.stdout.isTTY) throw new Error('dkrypt tui needs an interactive terminal');
  const jobIds = Array.isArray(profile.recentJobIds) ? profile.recentJobIds.filter((id) => typeof id === 'string').slice(0, 20) : [];
  if (jobIds.length === 0 && !profile.mcp) throw new Error('No recent jobs are saved yet. Connect with dkrypt mcp login to view jobs submitted from anywhere.');
  let jobs = [];
  let selected = 0;
  let detail = false;
  let refreshing = false;
  let stopped = false;
  const refresh = async () => {
    if (refreshing || stopped) return;
    refreshing = true;
    if (profile.mcp) {
      try {
        const { listMcpJobs } = await import('./mcp.js');
        jobs = await listMcpJobs(configPath, profileName, profile, 20);
      } catch (error) {
        jobs = [{ id: '', status: 'unavailable', bundleId: 'Could not load recent jobs', error: error instanceof Error ? error.message : String(error) }];
      }
    } else {
      jobs = await Promise.all(jobIds.map(async (id) => {
        try {
          const response = await send(`/v1/jobs/${encodeURIComponent(id)}`);
          const value = await response.json();
          return value.job ?? value;
        } catch (error) {
          return { id, status: 'unavailable', error: error instanceof Error ? error.message : String(error) };
        }
      }));
    }
    selected = Math.min(selected, jobs.length - 1);
    render();
    refreshing = false;
  };
  const render = () => {
    process.stdout.write('\u001b[2J\u001b[H');
    process.stdout.write(`dkrypt jobs · ${profileName} · j/k or ↑/↓ select · Enter details · f follow · r refresh · q quit\n\n`);
    if (jobs.length === 0) process.stdout.write('No decrypt jobs yet.\n');
    jobs.forEach((job, index) => {
      const marker = index === selected ? '›' : ' ';
      process.stdout.write(`${marker} ${String(job.status ?? 'unknown').padEnd(12)} ${job.bundleId ?? 'Decrypt job'}${job.versionLabel ? ` · ${job.versionLabel}` : ''}  ${job.id}\n`);
      if (detail && index === selected) process.stdout.write(`  ${job.progress ?? ''}${job.error ? `\n  ${job.error}` : ''}${job.artifactId ? `\n  IPA artifact ${job.artifactId}` : ''}\n`);
    });
    process.stdout.write('\nUpdated ' + new Date().toLocaleTimeString() + '\n');
  };
  const onKeypress = async (value, key = {}) => {
    if (key.ctrl && key.name === 'c' || value === 'q') {
      stopped = true;
      clearInterval(timer);
      process.stdin.off('keypress', onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\u001b[?25h\n');
      return;
    }
    if (value === 'j' || key.name === 'down') selected = Math.min(jobs.length - 1, selected + 1);
    else if (value === 'k' || key.name === 'up') selected = Math.max(0, selected - 1);
    else if (key.name === 'return') detail = !detail;
    else if (value === 'r') await refresh();
    else if (value === 'f' && jobs[selected]?.id) {
      process.stdin.off('keypress', onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      await followJob(jobs[selected].id);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('keypress', onKeypress);
    }
    render();
  };
  const { emitKeypressEvents } = await import('node:readline');
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('\u001b[?25l');
  process.stdin.on('keypress', onKeypress);
  const timer = setInterval(() => void refresh(), 10_000);
  await refresh();
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

if (command === 'doctor') {
  await runDoctor();
} else if (command === 'tui') {
  await runTui();
} else if (command === 'decrypt') {
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
  } else {
    const result = await response.json();
    const jobId = result.job?.id ?? result.jobId ?? result.id;
    if (typeof jobId === 'string') await rememberJob(jobId);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} else if (command === 'status') {
  if (!args[0]) throw new Error('Provide a job ID');
  await rememberJob(args[0]);
  await printJson(await send(`/v1/jobs/${encodeURIComponent(args[0])}`));
} else if (command === 'wait') {
  if (!args[0]) throw new Error('Provide a job ID');
  await rememberJob(args[0]);
  await printJson(await send(`/v1/jobs/${encodeURIComponent(args[0])}/wait?timeoutSeconds=25`));
} else if (command === 'follow') {
  if (!args[0]) throw new Error('Provide a job ID');
  await rememberJob(args[0]);
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
