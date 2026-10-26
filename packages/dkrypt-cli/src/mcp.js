import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const supportedScopes = ['decrypt:plan', 'decrypt:submit', 'jobs:read', 'jobs:control', 'artifacts:read', 'ipa:analyze', 'devices:read'];

export function validateMcpBaseUrl(value) {
  const url = new URL(value);
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || (url.protocol !== 'https:' && !localHost) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Use an HTTPS dkrypt origin; HTTP is allowed only for localhost');
  return url.origin;
}

export function createPkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function validateOAuthMetadata(metadata, baseUrl) {
  const endpointNames = ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint'];
  for (const name of endpointNames) {
    if (typeof metadata?.[name] !== 'string') throw new Error('The dkrypt OAuth metadata is incomplete');
    const endpoint = new URL(metadata[name]);
    if (endpoint.origin !== baseUrl || endpoint.username || endpoint.password || endpoint.hash) throw new Error('The dkrypt OAuth metadata points outside the configured origin');
  }
  const expectedResource = new URL('/v1/mcp', baseUrl).toString();
  if (metadata.resource !== expectedResource) throw new Error('The dkrypt OAuth resource does not match the configured origin');
  return metadata;
}

async function readConfig(configPath) {
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    if (parsed && parsed.profiles && typeof parsed.profiles === 'object' && !Array.isArray(parsed.profiles)) return parsed;
    if (typeof parsed.apiUrl === 'string') return { activeProfile: 'default', profiles: { default: parsed } };
    return { profiles: {}, activeProfile: undefined };
  } catch (error) {
    if (error?.code === 'ENOENT') return { profiles: {}, activeProfile: undefined };
    throw new Error('Saved dkrypt CLI configuration is invalid.');
  }
}

async function writeConfig(configPath, config) {
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(config), { mode: 0o600 });
  await rename(temporary, configPath);
}

function commandOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('--')) continue;
    options[value.slice(2)] = args[index + 1];
    index += 1;
  }
  return options;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', headers: { Accept: 'application/json', ...(options.headers ?? {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error_description ?? payload.message ?? `OAuth request failed with HTTP ${response.status}`);
  return payload;
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const commandArgs = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, commandArgs, { detached: true, stdio: 'ignore' });
  child.on('error', () => process.stderr.write(`Open this URL to continue: ${url}\n`));
  child.unref();
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

async function completeLogin({ configPath, profileName, apiUrl, scopes }) {
  const baseUrl = validateMcpBaseUrl(apiUrl);
  const authorizationMetadata = await requestJson(new URL('/.well-known/oauth-authorization-server', baseUrl));
  const protectedResource = await requestJson(new URL('/.well-known/oauth-protected-resource/mcp', baseUrl));
  const authorizationEndpoint = new URL(authorizationMetadata.authorization_endpoint);
  const tokenEndpoint = new URL(authorizationMetadata.token_endpoint);
  const registrationEndpoint = new URL(authorizationMetadata.registration_endpoint);
  const resource = protectedResource.resource;
  validateOAuthMetadata({ ...authorizationMetadata, resource }, baseUrl);
  if (!Array.isArray(authorizationMetadata.code_challenge_methods_supported) || !authorizationMetadata.code_challenge_methods_supported.includes('S256')) throw new Error('This dkrypt server does not support secure PKCE sign-in');

  const state = randomBytes(32).toString('base64url');
  const pkce = createPkcePair();
  let expectedPath;
  let resolveCallback;
  let rejectCallback;
  const callbackResult = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const callbackServer = createServer((request, response) => {
    const callback = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (callback.pathname !== expectedPath) {
      response.writeHead(404).end();
      return;
    }
    if (callback.searchParams.get('state') !== state) {
      response.writeHead(400).end('The sign-in response did not match this request.');
      return;
    }
    const error = callback.searchParams.get('error');
    const code = callback.searchParams.get('code');
    if (error || !code) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('dkrypt sign-in was canceled. You can close this page.');
      rejectCallback(new Error(error ?? 'OAuth callback did not include an authorization code'));
      callbackServer.close();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end('<!doctype html><meta charset="utf-8"><title>dkrypt connected</title><p>dkrypt is connected. You can close this page and return to your terminal.</p>');
    resolveCallback({ code, returnedState: callback.searchParams.get('state') });
    callbackServer.close();
  });

  const address = await listen(callbackServer);
  if (!address || typeof address === 'string') throw new Error('Could not start the local OAuth callback');
  try {
  const redirectUri = `http://127.0.0.1:${address.port}/callback`;
  expectedPath = '/callback';
  const client = await requestJson(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'dkrypt CLI', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  });
  if (typeof client.client_id !== 'string') throw new Error('dkrypt did not register the CLI OAuth client');

  const authorize = new URL(authorizationEndpoint);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', client.client_id);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('code_challenge', pkce.challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('resource', resource);
  authorize.searchParams.set('scope', scopes.join(' '));
  process.stderr.write('Opening your browser to connect dkrypt.\n');
  openBrowser(authorize.toString());

  const callback = await Promise.race([
    callbackResult,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for browser sign-in')), 5 * 60_000).unref()),
  ]).finally(() => callbackServer.close());
  if (callback.returnedState !== state) throw new Error('OAuth state did not match');
  const token = await requestJson(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code: callback.code, redirect_uri: redirectUri, code_verifier: pkce.verifier }),
  });
  if (typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string') throw new Error('dkrypt returned an incomplete OAuth token response');
  const saved = await readConfig(configPath);
  const prior = saved.profiles[profileName] ?? {};
  saved.profiles[profileName] = {
    ...prior,
    apiUrl: baseUrl,
    mcp: {
      apiUrl: baseUrl,
      resource,
      clientId: client.client_id,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + Number(token.expires_in ?? 3600) * 1000,
      scope: typeof token.scope === 'string' ? token.scope : scopes.join(' '),
    },
  };
  saved.activeProfile = profileName;
  await writeConfig(configPath, saved);
  } finally {
    callbackServer.close();
  }
}

async function refreshTokens(configPath, profileName, profile) {
  const mcp = profile.mcp;
  if (!mcp || typeof mcp.refreshToken !== 'string') throw new Error('Run dkrypt mcp login to connect an agent');
  if (mcp.expiresAt > Date.now() + 60_000) return mcp;
  const baseUrl = validateMcpBaseUrl(mcp.apiUrl);
  const metadata = await requestJson(new URL('/.well-known/oauth-authorization-server', baseUrl));
  validateOAuthMetadata({ ...metadata, resource: mcp.resource }, baseUrl);
  const token = await requestJson(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: mcp.clientId, refresh_token: mcp.refreshToken }),
  });
  const updated = { ...mcp, accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + Number(token.expires_in ?? 3600) * 1000, scope: token.scope ?? mcp.scope };
  const saved = await readConfig(configPath);
  saved.profiles[profileName] = { ...saved.profiles[profileName], mcp: updated };
  await writeConfig(configPath, saved);
  return updated;
}

async function loginCommand(args, options) {
  const parsed = commandOptions(args);
  const configPath = options.configPath ?? path.join(homedir(), '.config', 'dkrypt', 'config.json');
  const saved = await readConfig(configPath);
  const profileName = options.profileName ?? parsed.profile ?? saved.activeProfile ?? 'default';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(profileName)) throw new Error('Invalid profile name');
  const prior = saved.profiles[profileName];
  const apiUrl = parsed.url ?? prior?.apiUrl ?? 'https://ipa.dylib.dev';
  const scopesText = parsed.scope ?? supportedScopes.join(' ');
  const scopes = [...new Set(scopesText.split(/[ ,]+/).filter((scope) => supportedScopes.includes(scope)))];
  if (scopes.length === 0) throw new Error('Choose at least one supported MCP scope');
  await completeLogin({ configPath, profileName, apiUrl, scopes });
  process.stdout.write(`Connected profile "${profileName}" to dkrypt with OAuth.\n`);
}

async function logoutCommand(options) {
  const configPath = options.configPath ?? path.join(homedir(), '.config', 'dkrypt', 'config.json');
  const saved = await readConfig(configPath);
  const profileName = options.profileName ?? saved.activeProfile ?? 'default';
  const profile = saved.profiles[profileName];
  if (!profile?.mcp) throw new Error(`Profile "${profileName}" has no MCP connection`);
  const mcp = profile.mcp;
  const baseUrl = validateMcpBaseUrl(mcp.apiUrl);
  const metadata = await requestJson(new URL('/.well-known/oauth-authorization-server', baseUrl));
  validateOAuthMetadata({ ...metadata, resource: mcp.resource }, baseUrl);
  await fetch(metadata.revocation_endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: mcp.clientId, token: mcp.refreshToken }),
  });
  const { mcp: ignored, ...remaining } = profile;
  saved.profiles[profileName] = remaining;
  await writeConfig(configPath, saved);
  process.stdout.write(`Disconnected MCP access for profile "${profileName}".\n`);
}

async function stdioCommand(options) {
  const configPath = options.configPath ?? path.join(homedir(), '.config', 'dkrypt', 'config.json');
  const saved = await readConfig(configPath);
  const profileName = options.profileName ?? saved.activeProfile ?? 'default';
  const profile = saved.profiles[profileName];
  let mcp = await refreshTokens(configPath, profileName, profile ?? {});
  const [{ Client, StreamableHTTPClientTransport }, { McpServer, ResourceTemplate, fromJsonSchema }, { StdioServerTransport }] = await Promise.all([
    import('@modelcontextprotocol/client'),
    import('@modelcontextprotocol/server'),
    import('@modelcontextprotocol/server/stdio'),
  ]);
  const remote = new Client({ name: 'dkrypt-local-stdio', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${mcp.apiUrl}/v1/mcp`), { authProvider: { token: async () => mcp.accessToken }, onInsufficientScope: 'throw', requestInit: { redirect: 'error' } });
  await remote.connect(transport);
  const local = new McpServer({ name: 'dkrypt', version: '1.0.0' }, { capabilities: { tools: {}, resources: { listChanged: false } } });
  const tools = await remote.listTools();
  for (const tool of tools.tools) {
    const schema = tool.inputSchema ?? { type: 'object', properties: {} };
    local.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: fromJsonSchema(schema) }, async (input) => remote.callTool({ name: tool.name, arguments: input }));
  }
  const resources = await remote.listResources();
  for (const resource of resources.resources) {
    local.registerResource(resource.name, resource.uri, { title: resource.title, description: resource.description, mimeType: resource.mimeType }, async (uri) => remote.readResource({ uri: uri.href }));
  }
  const templates = await remote.listResourceTemplates();
  for (const template of templates.resourceTemplates) {
    local.registerResource(template.name, new ResourceTemplate(template.uriTemplate, { list: undefined }), { title: template.title, description: template.description, mimeType: template.mimeType }, async (uri) => remote.readResource({ uri: uri.href }));
  }
  const refreshTimer = setInterval(async () => {
    try {
      mcp = await refreshTokens(configPath, profileName, { mcp });
    } catch (error) {
      process.stderr.write(`dkrypt MCP token refresh failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }, 40 * 60_000);
  refreshTimer.unref();
  process.stdin.once('end', () => {
    clearInterval(refreshTimer);
    void remote.close();
  });
  await local.connect(new StdioServerTransport());
}

export async function listMcpJobs(configPath, profileName, profile, limit = 20) {
  const mcp = await refreshTokens(configPath, profileName, profile);
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'dkrypt-tui', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${mcp.apiUrl}/v1/mcp`), {
    authProvider: { token: async () => mcp.accessToken },
    onInsufficientScope: 'throw',
    requestInit: { redirect: 'error' },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'list_jobs', arguments: { limit: Math.max(1, Math.min(50, Math.floor(limit))) } });
    if (result.isError) throw new Error(result.content?.map((item) => item.type === 'text' ? item.text : '').filter(Boolean).join('\n') || 'Could not load recent jobs');
    if (result.structuredContent && Array.isArray(result.structuredContent.jobs)) return result.structuredContent.jobs;
    const text = result.content?.find((item) => item.type === 'text')?.text;
    const payload = text ? JSON.parse(text) : undefined;
    if (!Array.isArray(payload?.jobs)) throw new Error('dkrypt returned an invalid recent-jobs response');
    return payload.jobs;
  } finally {
    await client.close();
  }
}

export async function runMcpCommand(args, options = {}) {
  const [action, ...rest] = args;
  if (action === 'login') return loginCommand(rest, options);
  if (action === 'logout') return logoutCommand(options);
  if (action === 'stdio') return stdioCommand(options);
  throw new Error('Use dkrypt mcp login [--url <origin>] [--scope <scopes>], dkrypt mcp logout, or dkrypt mcp stdio');
}
