import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyReply } from 'fastify';
import { config } from '#config.js';
import { log } from '#logger.js';
import { openStateDatabase } from '#store/sqlite.js';

const SIGNAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEVICE_SIGNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const REPUTATION_TTL_MS = 12 * 60 * 60 * 1000;
const SIGNUP_ADDRESS_HOURLY_LIMIT = 3;
const SIGNUP_ADDRESS_MONTHLY_LIMIT = 10;
const SIGNUP_NETWORK_MONTHLY_LIMIT = 25;
const HIGH_RISK_SIGNUP_ADDRESS_HOURLY_LIMIT = 1;
const HIGH_RISK_SIGNUP_ADDRESS_MONTHLY_LIMIT = 3;
const HIGH_RISK_SIGNUP_NETWORK_MONTHLY_LIMIT = 8;
const SIGNUP_DEVICE_WEEKLY_LIMIT = 6;
const SIGNUP_EMAIL_MONTHLY_LIMIT = 1;
const SIGNUP_CHALLENGE_COOKIE = 'dk_signup_challenge';
const ABUSE_BROWSER_COOKIE = 'dk_abuse_device';
const ABUSE_TURNSTILE_COOKIE = 'dk_abuse_turnstile';
const abuseSignalSigningKey = config.abuseSignalSecret || createHmac('sha256', config.sessionSigningSecret).update('dkrypt-abuse-signals-v1').digest('hex');
const database = openStateDatabase({ stateDir: config.stateDir, filename: config.stateDatabaseFile, busyTimeoutMs: config.stateDbBusyTimeoutMs }).db;
const pendingIpReputation = new Map<string, Promise<IpReputation | undefined>>();
let cleanupTimer: ReturnType<typeof setInterval> | undefined;

export interface SignupAdmission {
  allowed: boolean;
  reason?: 'email' | 'account' | 'network' | 'device';
  nextAvailableAt?: number;
}

export interface RequestAbuseContext {
  networkHash?: string;
  addressHash?: string;
  browserHash?: string;
  turnstileHash?: string;
  networkDecryptLimit?: number;
  addressDecryptLimit?: number;
}

export interface SignupAbuseSignals {
  browserHash?: string;
  turnstileHash?: string;
}

interface SignupAbuseContext extends SignupAbuseSignals {
  networkHash?: string;
  addressHash?: string;
}

export interface IpReputation {
  vpn: boolean;
  proxy: boolean;
  tor: boolean;
  relay: boolean;
  hosting: boolean;
  residentialProxy: boolean;
  anonymous: boolean;
  abuser?: boolean;
}

interface TurnstileResult {
  success?: boolean;
  hostname?: string;
  action?: string;
  metadata?: { ephemeral_id?: string };
}

function hmac(purpose: string, value: string): string {
  return createHmac('sha256', abuseSignalSigningKey).update(`${purpose}:${value}`).digest('hex');
}

function cleanupAbuseRecords(now = Date.now()): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.query('DELETE FROM abuse_signup_events WHERE expires_at <= ?').run(now);
    database.query('UPDATE abuse_signup_events SET browser_hash = NULL, browser_expires_at = NULL WHERE browser_hash IS NOT NULL AND browser_expires_at <= ?').run(now);
    database.query('UPDATE abuse_signup_events SET turnstile_hash = NULL, turnstile_expires_at = NULL WHERE turnstile_hash IS NOT NULL AND turnstile_expires_at <= ?').run(now);
    database.query('DELETE FROM abuse_signup_challenges WHERE expires_at <= ?').run(now);
    database.query('DELETE FROM abuse_ip_reputation WHERE expires_at <= ?').run(now);
    database.query('DELETE FROM free_decrypt_abuse_quota WHERE completed_at IS NOT NULL AND completed_at <= ?').run(now - SIGNAL_RETENTION_MS);
    database.query('UPDATE free_decrypt_abuse_quota SET browser_hash = NULL, browser_expires_at = NULL WHERE browser_hash IS NOT NULL AND browser_expires_at <= ?').run(now);
    database.query('UPDATE free_decrypt_abuse_quota SET turnstile_hash = NULL, turnstile_expires_at = NULL WHERE turnstile_hash IS NOT NULL AND turnstile_expires_at <= ?').run(now);
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

cleanupAbuseRecords();
cleanupTimer = setInterval(() => {
  try {
    cleanupAbuseRecords();
  } catch (error) {
    log.warn('abuse signal cleanup failed', { error: error instanceof Error ? error.message : String(error) });
  }
}, 60 * 60_000);
cleanupTimer.unref();

function normalizedIp(ip: string): { family: number; parts: string[] } | undefined {
  const value = ip.trim().replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
  const normalized = mapped ?? value;
  const family = isIP(normalized);
  if (family === 4) return { family, parts: normalized.split('.') };
  if (family !== 6) return undefined;

  const [leftValue, rightValue = ''] = normalized.toLowerCase().split('::');
  const left = leftValue ? leftValue.split(':') : [];
  const right = rightValue ? rightValue.split(':') : [];
  const parts = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  if (parts.length !== 8) return undefined;
  return { family, parts: parts.map((part) => Number.parseInt(part || '0', 16).toString(16)) };
}

function canonicalIp(ip: string): { full: string; prefix: string } | undefined {
  const address = normalizedIp(ip);
  if (!address) return undefined;
  if (address.family === 4) return { full: `v4:${address.parts.join('.')}`, prefix: `v4:${address.parts.slice(0, 3).join('.')}` };
  const parts = address.parts.map((part) => Number.parseInt(part, 16));
  const full = `v6:${parts.map((part) => part.toString(16).padStart(4, '0')).join(':')}`;
  const prefix = `v6:${parts.slice(0, 3).map((part) => part.toString(16)).join(':')}:${((parts[3] ?? 0) & 0xff00).toString(16)}`;
  return { full, prefix };
}

export function abuseNetworkHash(ip: string | undefined): string | undefined {
  const prefix = ip ? canonicalIp(ip)?.prefix : undefined;
  return prefix ? hmac('network', prefix) : undefined;
}

export function abuseAddressHash(ip: string | undefined): string | undefined {
  const address = ip ? canonicalIp(ip)?.full : undefined;
  return address ? hmac('address', address) : undefined;
}

export function abuseEmailHash(email: string): string {
  return hmac('email', email.trim().toLowerCase());
}

function abuseBrowserHash(id: string | undefined): string | undefined {
  return id ? hmac('browser', id) : undefined;
}

function abuseTurnstileHash(id: string | undefined): string | undefined {
  return id ? hmac('turnstile', id) : undefined;
}

function signCookie(kind: string, payload: string): string {
  return createHmac('sha256', abuseSignalSigningKey).update(`${kind}:${payload}`).digest('hex');
}

function safeEqual(first: string, second: string): boolean {
  const a = Buffer.from(first);
  const b = Buffer.from(second);
  return a.length === b.length && timingSafeEqual(a, b);
}

function appendCookie(reply: FastifyReply, value: string): void {
  const existing = reply.getHeader('Set-Cookie');
  const cookies = existing === undefined ? [] : Array.isArray(existing) ? existing.map(String) : [String(existing)];
  cookies.push(value);
  reply.header('Set-Cookie', cookies);
}

function cookieFlags(maxAgeSeconds: number): string {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${config.publicBaseUrl.startsWith('https://') ? '; Secure' : ''}`;
}

function clearCookie(reply: FastifyReply, name: string): void {
  appendCookie(reply, `${name}=; ${cookieFlags(0)}`);
}

export function isSignupChallengeConfigured(): boolean {
  return Boolean(config.turnstileSiteKey && config.turnstileSecretKey);
}

export function signupChallengeSiteKey(): string | undefined {
  return isSignupChallengeConfigured() ? config.turnstileSiteKey : undefined;
}

export function blockedEmailDomain(email: string | undefined): boolean {
  if (!email) return true;
  const domain = email.trim().toLowerCase().split('@').at(-1);
  if (!domain || !domain.includes('.')) return true;
  return config.abuseBlockedEmailDomains.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
}

function signupLimits(addressHash: string, now: number): { addressHourly: number; addressMonthly: number; networkMonthly: number } {
  const reputation = cachedIpReputation(addressHash, now);
  const highRisk = isHighRiskNetwork(reputation);
  return highRisk
    ? { addressHourly: HIGH_RISK_SIGNUP_ADDRESS_HOURLY_LIMIT, addressMonthly: HIGH_RISK_SIGNUP_ADDRESS_MONTHLY_LIMIT, networkMonthly: HIGH_RISK_SIGNUP_NETWORK_MONTHLY_LIMIT }
    : { addressHourly: SIGNUP_ADDRESS_HOURLY_LIMIT, addressMonthly: SIGNUP_ADDRESS_MONTHLY_LIMIT, networkMonthly: SIGNUP_NETWORK_MONTHLY_LIMIT };
}

function checkSignupAdmission(email: string, context: SignupAbuseContext, now: number): SignupAdmission {
  if (blockedEmailDomain(email)) return { allowed: false, reason: 'email' };
  if (!context.networkHash || !context.addressHash) return { allowed: false, reason: 'network', nextAvailableAt: now + CHALLENGE_TTL_MS };
  const emailHash = abuseEmailHash(email);
  const emailEvents = database.query('SELECT created_at FROM abuse_signup_events WHERE email_hash = ? AND created_at > ? ORDER BY created_at ASC').all(emailHash, now - SIGNAL_RETENTION_MS) as Array<{ created_at: number }>;
  if (emailEvents.length >= SIGNUP_EMAIL_MONTHLY_LIMIT) return { allowed: false, reason: 'account', nextAvailableAt: emailEvents[0]!.created_at + SIGNAL_RETENTION_MS };
  const limits = signupLimits(context.addressHash, now);

  const addressHourly = database.query('SELECT created_at FROM abuse_signup_events WHERE address_hash = ? AND created_at > ? ORDER BY created_at ASC').all(context.addressHash, now - 60 * 60 * 1000) as Array<{ created_at: number }>;
  if (addressHourly.length >= limits.addressHourly) return { allowed: false, reason: 'network', nextAvailableAt: addressHourly[0]!.created_at + 60 * 60 * 1000 };

  const addressMonthly = database.query('SELECT created_at FROM abuse_signup_events WHERE address_hash = ? AND created_at > ? ORDER BY created_at ASC').all(context.addressHash, now - SIGNAL_RETENTION_MS) as Array<{ created_at: number }>;
  if (addressMonthly.length >= limits.addressMonthly) return { allowed: false, reason: 'network', nextAvailableAt: addressMonthly[0]!.created_at + SIGNAL_RETENTION_MS };

  const networkMonthly = database.query('SELECT created_at FROM abuse_signup_events WHERE network_hash = ? AND created_at > ? ORDER BY created_at ASC').all(context.networkHash, now - SIGNAL_RETENTION_MS) as Array<{ created_at: number }>;
  if (networkMonthly.length >= limits.networkMonthly) return { allowed: false, reason: 'network', nextAvailableAt: networkMonthly[0]!.created_at + SIGNAL_RETENTION_MS };

  for (const [column, value] of [['browser_hash', context.browserHash], ['turnstile_hash', context.turnstileHash]] as const) {
    if (!value) continue;
    const events = database.query(`SELECT created_at FROM abuse_signup_events WHERE ${column} = ? AND created_at > ? ORDER BY created_at ASC`).all(value, now - DEVICE_SIGNAL_RETENTION_MS) as Array<{ created_at: number }>;
    if (events.length >= SIGNUP_DEVICE_WEEKLY_LIMIT) return { allowed: false, reason: 'device', nextAvailableAt: events[0]!.created_at + DEVICE_SIGNAL_RETENTION_MS };
  }
  return { allowed: true };
}

function recordSignupAdmission(email: string, context: SignupAbuseContext, now: number): void {
  database.query('INSERT INTO abuse_signup_events (id, network_hash, address_hash, browser_hash, browser_expires_at, turnstile_hash, turnstile_expires_at, email_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    randomUUID(),
    context.networkHash!,
    context.addressHash!,
    context.browserHash ?? null,
    context.browserHash ? now + DEVICE_SIGNAL_RETENTION_MS : null,
    context.turnstileHash ?? null,
    context.turnstileHash ? now + DEVICE_SIGNAL_RETENTION_MS : null,
    abuseEmailHash(email),
    now,
    now + SIGNAL_RETENTION_MS,
  );
}

export function getSignupAbuseSignals(ip: string | undefined, cookieHeader: string | undefined): SignupAbuseContext {
  return {
    networkHash: abuseNetworkHash(ip),
    addressHash: abuseAddressHash(ip),
    browserHash: signedSignalCookie(cookieHeader, ABUSE_BROWSER_COOKIE, 'abuse-browser'),
    turnstileHash: signedSignalCookie(cookieHeader, ABUSE_TURNSTILE_COOKIE, 'abuse-turnstile'),
  };
}

export function assessSignupAdmission(ip: string | undefined, email: string, signals: SignupAbuseSignals, now = Date.now()): SignupAdmission {
  cleanupAbuseRecords(now);
  return checkSignupAdmission(email, { ...signals, networkHash: abuseNetworkHash(ip), addressHash: abuseAddressHash(ip) }, now);
}

export function admitNewOauthAccount(ip: string | undefined, email: string, signals: SignupAbuseSignals, now = Date.now()): SignupAdmission {
  const context: SignupAbuseContext = { ...signals, networkHash: abuseNetworkHash(ip), addressHash: abuseAddressHash(ip) };
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.query('DELETE FROM abuse_signup_events WHERE expires_at <= ?').run(now);
    database.query('UPDATE abuse_signup_events SET browser_hash = NULL, browser_expires_at = NULL WHERE browser_hash IS NOT NULL AND browser_expires_at <= ?').run(now);
    database.query('UPDATE abuse_signup_events SET turnstile_hash = NULL, turnstile_expires_at = NULL WHERE turnstile_hash IS NOT NULL AND turnstile_expires_at <= ?').run(now);
    database.query('DELETE FROM abuse_signup_challenges WHERE expires_at <= ?').run(now);
    const admission = checkSignupAdmission(email, context, now);
    if (admission.allowed) recordSignupAdmission(email, context, now);
    database.exec('COMMIT;');
    return admission;
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

export async function verifySignupChallenge(token: string, ip: string | undefined, cookieHeader: string | undefined, reply: FastifyReply): Promise<void> {
  if (!isSignupChallengeConfigured()) throw new Error('signup verification is unavailable');
  const networkHash = abuseNetworkHash(ip);
  if (!networkHash) throw new Error('signup verification is unavailable');
  const payload = new URLSearchParams({ secret: config.turnstileSecretKey, response: token });
  if (ip) payload.set('remoteip', ip);
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: payload,
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined);
  if (!response?.ok) throw new Error('signup verification is unavailable');
  const result = await response.json().catch(() => undefined) as TurnstileResult | undefined;
  if (!result) throw new Error('signup verification is unavailable');
  const expectedHostname = new URL(config.publicBaseUrl).hostname.toLowerCase();
  if (!result.success || result.action !== 'signup' || result.hostname?.toLowerCase() !== expectedHostname) throw new Error('signup verification failed');

  const now = Date.now();
  const id = randomUUID();
  const browserHash = ensureAbuseBrowserSignal(reply, cookieHeader);
  const turnstileHash = abuseTurnstileHash(result.metadata?.ephemeral_id);
  const expiresAt = now + CHALLENGE_TTL_MS;
  database.query('INSERT INTO abuse_signup_challenges (id, network_hash, browser_hash, turnstile_hash, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, NULL)').run(id, networkHash, browserHash, turnstileHash ?? null, now, expiresAt);
  const payloadValue = `${id}.${expiresAt}`;
  appendCookie(reply, `${SIGNUP_CHALLENGE_COOKIE}=${payloadValue}.${signCookie('signup-challenge', payloadValue)}; ${cookieFlags(Math.ceil(CHALLENGE_TTL_MS / 1000))}`);
  if (turnstileHash) appendSignedSignalCookie(reply, ABUSE_TURNSTILE_COOKIE, 'abuse-turnstile', turnstileHash, now);
}

export function consumeSignupChallenge(cookieHeader: string | undefined, ip: string | undefined, reply: FastifyReply, now = Date.now()): { valid: boolean; browserHash?: string; turnstileHash?: string } {
  const cookie = (cookieHeader ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SIGNUP_CHALLENGE_COOKIE}=`))?.slice(SIGNUP_CHALLENGE_COOKIE.length + 1);
  clearCookie(reply, SIGNUP_CHALLENGE_COOKIE);
  if (!cookie) return { valid: false };
  const [id, rawExpiry, signature] = cookie.split('.');
  const expiresAt = Number(rawExpiry);
  if (!id || !Number.isSafeInteger(expiresAt) || expiresAt <= now || !signature) return { valid: false };
  const payload = `${id}.${expiresAt}`;
  if (!safeEqual(signature, signCookie('signup-challenge', payload))) return { valid: false };
  const networkHash = abuseNetworkHash(ip);
  if (!networkHash) return { valid: false };

  database.exec('BEGIN IMMEDIATE;');
  try {
    const changed = database.query('UPDATE abuse_signup_challenges SET consumed_at = ? WHERE id = ? AND network_hash = ? AND expires_at > ? AND consumed_at IS NULL').run(now, id, networkHash, now).changes;
    if (changed !== 1) {
      database.exec('COMMIT;');
      return { valid: false };
    }
    const row = database.query('SELECT browser_hash, turnstile_hash FROM abuse_signup_challenges WHERE id = ?').get(id) as { browser_hash?: string; turnstile_hash?: string } | null;
    database.exec('COMMIT;');
    return { valid: true, browserHash: row?.browser_hash, turnstileHash: row?.turnstile_hash };
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

function signedSignalCookie(cookieHeader: string | undefined, name: string, kind: string, now = Date.now()): string | undefined {
  const cookie = (cookieHeader ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!cookie) return undefined;
  const [signalHash, rawExpiry, signature] = cookie.split('.');
  const expiresAt = Number(rawExpiry);
  if (!signalHash || !/^[a-f0-9]{64}$/.test(signalHash) || !Number.isSafeInteger(expiresAt) || expiresAt <= now || !signature) return undefined;
  const payload = `${signalHash}.${expiresAt}`;
  return safeEqual(signature, signCookie(kind, payload)) ? signalHash : undefined;
}

function appendSignedSignalCookie(reply: FastifyReply, name: string, kind: string, signalHash: string, now = Date.now()): void {
  const expiresAt = now + DEVICE_SIGNAL_RETENTION_MS;
  const payload = `${signalHash}.${expiresAt}`;
  appendCookie(reply, `${name}=${payload}.${signCookie(kind, payload)}; ${cookieFlags(Math.ceil(DEVICE_SIGNAL_RETENTION_MS / 1000))}`);
}

export function ensureAbuseBrowserSignal(reply: FastifyReply, cookieHeader: string | undefined): string {
  const existing = signedSignalCookie(cookieHeader, ABUSE_BROWSER_COOKIE, 'abuse-browser');
  if (existing) return existing;
  const browserHash = abuseBrowserHash(randomUUID())!;
  appendSignedSignalCookie(reply, ABUSE_BROWSER_COOKIE, 'abuse-browser', browserHash);
  return browserHash;
}

function cachedIpReputation(addressHash: string | undefined, now = Date.now()): IpReputation | undefined {
  if (!addressHash) return undefined;
  const row = database.query('SELECT payload FROM abuse_ip_reputation WHERE address_hash = ? AND expires_at > ?').get(addressHash, now) as { payload: string } | null;
  if (!row) return undefined;
  try {
    const value = JSON.parse(row.payload) as IpReputation;
    return {
      vpn: value.vpn === true,
      proxy: value.proxy === true,
      tor: value.tor === true,
      relay: value.relay === true,
      hosting: value.hosting === true,
      residentialProxy: value.residentialProxy === true,
      anonymous: value.anonymous === true,
      abuser: value.abuser === true,
    };
  } catch {
    return undefined;
  }
}

function ipReputationConfigured(): boolean {
  return Boolean(config.ipApiIsKey || config.ipInfoToken);
}

function isHighRiskNetwork(reputation: IpReputation | undefined): boolean {
  if (!reputation) return ipReputationConfigured();
  return reputation.vpn || reputation.proxy || reputation.tor || reputation.relay || reputation.hosting || reputation.residentialProxy || reputation.anonymous || reputation.abuser === true;
}

function saveIpReputation(addressHash: string, result: IpReputation): IpReputation {
  const now = Date.now();
  database.query('INSERT INTO abuse_ip_reputation (address_hash, payload, checked_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(address_hash) DO UPDATE SET payload = excluded.payload, checked_at = excluded.checked_at, expires_at = excluded.expires_at').run(addressHash, JSON.stringify(result), now, now + REPUTATION_TTL_MS);
  return result;
}

async function fetchIpApiIsReputation(ip: string, addressHash: string): Promise<IpReputation | undefined> {
  const response = await fetch('https://api.ipapi.is', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: ip, key: config.ipApiIsKey }),
    signal: AbortSignal.timeout(2500),
  }).catch(() => undefined);
  if (!response?.ok) {
    log.warn('signup IP reputation lookup unavailable', { provider: 'ipapi.is', status: response?.status });
    return undefined;
  }
  const raw = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  const signals = ['is_vpn', 'is_proxy', 'is_tor', 'is_datacenter', 'is_abuser'];
  if (!raw || !signals.every((field) => Object.hasOwn(raw, field))) {
    log.warn('signup IP reputation lookup returned an unsupported response', { provider: 'ipapi.is', status: response.status });
    return undefined;
  }
  const egressService = raw.egress_service && typeof raw.egress_service === 'object' && !Array.isArray(raw.egress_service)
    ? raw.egress_service as Record<string, unknown>
    : undefined;
  const vpn = Boolean(raw.is_vpn);
  const proxy = raw.is_proxy === true;
  const tor = raw.is_tor === true;
  const relay = egressService?.type === 'private_relay';
  return saveIpReputation(addressHash, {
    vpn,
    proxy,
    tor,
    relay,
    hosting: raw.is_datacenter === true,
    residentialProxy: false,
    anonymous: vpn || proxy || tor || relay,
    abuser: raw.is_abuser === true,
  });
}

async function fetchIpInfoReputation(ip: string, addressHash: string): Promise<IpReputation | undefined> {
  const encodedIp = encodeURIComponent(ip);
  const endpoints = [
    `https://api.ipinfo.io/lookup/${encodedIp}/anonymous`,
    `${isIP(ip) === 6 ? 'https://v6.ipinfo.io' : 'https://ipinfo.io'}/${encodedIp}/privacy`,
  ];
  let raw: Record<string, unknown> | undefined;
  let lastStatus: number | undefined;
  for (const endpoint of endpoints) {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${config.ipInfoToken}` },
      signal: AbortSignal.timeout(2500),
    }).catch(() => undefined);
    if (!response) break;
    lastStatus = response.status;
    if (!response.ok) {
      if ([401, 403, 404].includes(response.status)) continue;
      break;
    }
    const parsed = await response.json().catch(() => undefined);
    raw = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    break;
  }
  if (!raw) {
    log.warn('signup IP reputation lookup unavailable', { provider: 'ipinfo', status: lastStatus });
    return undefined;
  }
  const nested = raw.anonymous && typeof raw.anonymous === 'object' ? raw.anonymous as Record<string, unknown> : {};
  const privacy = raw.privacy && typeof raw.privacy === 'object' ? raw.privacy as Record<string, unknown> : {};
  const values = { ...raw, ...privacy, ...nested };
  const result: IpReputation = {
    vpn: values.vpn === true || values.is_vpn === true,
    proxy: values.proxy === true || values.is_proxy === true,
    tor: values.tor === true || values.is_tor === true,
    relay: values.relay === true || values.is_relay === true,
    hosting: values.hosting === true || values.is_hosting === true,
    residentialProxy: values.is_res_proxy === true || values.residential_proxy === true,
    anonymous: values.is_anonymous === true,
    abuser: false,
  };
  return saveIpReputation(addressHash, result);
}

async function fetchIpReputation(ip: string, addressHash: string): Promise<IpReputation | undefined> {
  if (config.ipApiIsKey) {
    const result = await fetchIpApiIsReputation(ip, addressHash);
    if (result || !config.ipInfoToken) return result;
  }
  if (config.ipInfoToken) return fetchIpInfoReputation(ip, addressHash);
  return undefined;
}

export async function refreshIpReputation(ip: string | undefined): Promise<IpReputation | undefined> {
  if (!ipReputationConfigured() || !ip) return undefined;
  const addressHash = abuseAddressHash(ip);
  if (!addressHash) return undefined;
  const cached = cachedIpReputation(addressHash);
  if (cached) return cached;
  const pending = pendingIpReputation.get(addressHash);
  if (pending) return pending;
  const lookup = fetchIpReputation(ip, addressHash);
  pendingIpReputation.set(addressHash, lookup);
  try {
    return await lookup;
  } finally {
    if (pendingIpReputation.get(addressHash) === lookup) pendingIpReputation.delete(addressHash);
  }
}

export function requestAbuseContext(ip: string | undefined, cookieHeader: string | undefined, refreshMissingReputation = false): RequestAbuseContext {
  const networkHash = abuseNetworkHash(ip);
  const addressHash = abuseAddressHash(ip);
  const reputation = cachedIpReputation(addressHash);
  if (refreshMissingReputation && ipReputationConfigured() && !reputation) void refreshIpReputation(ip).catch(() => undefined);
  const anonymousNetwork = isHighRiskNetwork(reputation);
  return {
    networkHash,
    addressHash: abuseAddressHash(ip),
    browserHash: signedSignalCookie(cookieHeader, ABUSE_BROWSER_COOKIE, 'abuse-browser'),
    turnstileHash: signedSignalCookie(cookieHeader, ABUSE_TURNSTILE_COOKIE, 'abuse-turnstile'),
    networkDecryptLimit: anonymousNetwork ? config.freeAnonymousNetworkDecryptLimit : config.freeNetworkDecryptLimit,
    addressDecryptLimit: anonymousNetwork ? config.freeAnonymousAddressDecryptLimit : config.freeAddressDecryptLimit,
  };
}

export function closeAbuseProtectionDatabase(): void {
  if (cleanupTimer) clearInterval(cleanupTimer);
  database.close();
}
