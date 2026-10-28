import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { config } from '#config.js';
import { artifactDownloadName, artifactFileAvailable, getArtifactById, type ArtifactRecord } from '#artifacts.js';
import { scopedLogger } from '#logger.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';
import { validatePublicWebhookEndpoint } from '#util/webhookEndpoint.js';

const log = scopedLogger('artifact-delivery');
const maximumAttempts = 8;
const retryBaseMs = 30_000;
const deliveryLeaseMs = 5 * 60_000;
const encryptionSuffix = ':cloud-delivery';

interface EncryptedSecret {
  iv: string;
  tag: string;
  ciphertext: string;
}

export type CloudDestination = {
  id: string;
  ownerId: string;
  provider: 'webdav' | 's3';
  enabled: boolean;
  endpoint: string;
  prefix: string;
  username?: string;
  password?: EncryptedSecret;
  accessKey?: string;
  secretKey?: EncryptedSecret;
  region?: string;
  bucket?: string;
  updatedAt: number;
};

export type CloudDestinationInput =
  | { provider: 'webdav'; endpoint: string; prefix?: string; username: string; password?: string; enabled: boolean }
  | { provider: 's3'; endpoint: string; prefix?: string; accessKey?: string; secretKey?: string; region: string; bucket: string; enabled: boolean };

export type CloudDestinationSummary = Omit<CloudDestination, 'password' | 'secretKey' | 'accessKey'> & { secretConfigured: boolean; accessKeyHint?: string };

export interface CloudDeliveryRecord {
  id: string;
  ownerId: string;
  jobId: string;
  artifactId: string;
  fileName: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt?: number;
  remotePath?: string;
  error?: string;
}

const database = openStateCollectionDatabase(
  { stateDir: config.stateDir, filename: config.stateDatabaseFile, busyTimeoutMs: config.stateDbBusyTimeoutMs, migrationDryRun: config.stateDbMigrationDryRun },
  ['cloud_delivery_destinations', 'cloud_delivery_jobs'],
);
let retryTimer: ReturnType<typeof setInterval> | undefined;
let retryRunning = false;

function destinationId(ownerId: string): string {
  return `destination:${ownerId.toLowerCase()}`;
}

function readDestination(ownerId: string): CloudDestination | undefined {
  const row = database.query('SELECT payload FROM cloud_delivery_destinations WHERE owner_id = ?').get(ownerId.toLowerCase()) as { payload: string } | null;
  if (!row) return undefined;
  try {
    return JSON.parse(row.payload) as CloudDestination;
  } catch {
    return undefined;
  }
}

function encryptionKeys(): Buffer[] {
  return [config.sessionSigningSecret, config.sessionSigningSecretPrevious].filter(Boolean).map((secret) => createHash('sha256').update(`${secret}${encryptionSuffix}`).digest());
}

function encryptSecret(value: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKeys()[0], iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
}

function decryptSecret(encrypted: EncryptedSecret | undefined): string | undefined {
  if (!encrypted) return undefined;
  for (const key of encryptionKeys()) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      continue;
    }
  }
  return undefined;
}

function safePrefix(value: string | undefined): string {
  const segments = (value ?? '').split('/').map((segment) => segment.trim()).filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..' || /[\\\u0000-\u001f]/.test(segment))) throw new Error('Folder path contains an unsafe segment');
  return segments.join('/');
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodedPath(segments: string[]): string {
  return `/${segments.filter(Boolean).flatMap((segment) => segment.split('/')).map(encodeSegment).join('/')}`;
}

function safeEndpoint(value: string, allowPath: boolean): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Enter a valid HTTPS destination URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) throw new Error('Destination must be HTTPS on the standard port without embedded credentials or query parameters');
  if (!allowPath && url.pathname !== '/') throw new Error('S3-compatible endpoint must be an origin without a path');
  return url;
}

export function getCloudDestination(ownerId: string): CloudDestinationSummary | undefined {
  const destination = readDestination(ownerId);
  if (!destination) return undefined;
  const { password, secretKey, accessKey, ...safe } = destination;
  return { ...safe, ...(accessKey ? { accessKeyHint: `••••${accessKey.slice(-4)}` } : {}), secretConfigured: Boolean(password || secretKey) };
}

export async function saveCloudDestination(ownerId: string, input: CloudDestinationInput): Promise<ReturnType<typeof getCloudDestination>> {
  const endpoint = safeEndpoint(input.endpoint, input.provider === 'webdav');
  await validatePublicWebhookEndpoint(endpoint.toString());
  const previous = readDestination(ownerId);
  const sameProvider = previous?.provider === input.provider;
  const prefix = safePrefix(input.prefix);
  const now = Date.now();
  let destination: CloudDestination;
  if (input.provider === 'webdav') {
    const password = input.password?.trim() ? encryptSecret(input.password) : sameProvider ? previous?.password : undefined;
    if (!password) throw new Error('Enter the WebDAV password to save this destination');
    const username = input.username.trim();
    if (!username || username.length > 256) throw new Error('Enter a valid WebDAV username');
    destination = { id: destinationId(ownerId), ownerId: ownerId.toLowerCase(), provider: input.provider, enabled: input.enabled, endpoint: endpoint.toString(), prefix, username, password, updatedAt: now };
  } else {
    const secretKey = input.secretKey?.trim() ? encryptSecret(input.secretKey) : sameProvider ? previous?.secretKey : undefined;
    if (!secretKey) throw new Error('Enter the S3 secret key to save this destination');
    const accessKey = input.accessKey?.trim() || (sameProvider ? previous?.accessKey : undefined) || '';
    const bucket = input.bucket.trim();
    const region = input.region.trim();
    if (!accessKey || accessKey.length > 256 || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !/^[a-z0-9-]{1,64}$/.test(region)) throw new Error('Check the S3 access key, bucket name, and region');
    destination = { id: destinationId(ownerId), ownerId: ownerId.toLowerCase(), provider: input.provider, enabled: input.enabled, endpoint: endpoint.toString(), prefix, accessKey, secretKey, region, bucket, updatedAt: now };
  }
  database.query('INSERT INTO cloud_delivery_destinations (id, payload, updated_at, owner_id, provider, enabled) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET id = excluded.id, payload = excluded.payload, updated_at = excluded.updated_at, provider = excluded.provider, enabled = excluded.enabled').run(destination.id, JSON.stringify(destination), now, destination.ownerId, destination.provider, destination.enabled ? 1 : 0);
  return getCloudDestination(ownerId);
}

export function deleteCloudDestination(ownerId: string): boolean {
  return database.query('DELETE FROM cloud_delivery_destinations WHERE owner_id = ?').run(ownerId.toLowerCase()).changes > 0;
}

async function pinnedHttpsRequest(url: URL, options: { method: 'PUT' | 'DELETE'; headers: Record<string, string>; filePath?: string; body?: Buffer; contentLength: number }): Promise<void> {
  const validated = await validatePublicWebhookEndpoint(url.toString());
  const addresses = validated.addresses;
  const pinnedAddress = addresses[0];
  const family = isIP(pinnedAddress);
  if (!family) throw new Error('Destination hostname did not resolve to a public address');
  const lookup = ((hostname: string, lookupOptions: { all?: boolean }, callback: (error: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void) => {
    if (hostname.toLowerCase() !== url.hostname.toLowerCase()) return callback(new Error('Destination DNS lookup changed') as NodeJS.ErrnoException, '');
    if (lookupOptions?.all) callback(null, addresses.map((address) => ({ address, family: isIP(address) })));
    else callback(null, pinnedAddress, family);
  }) as NonNullable<RequestOptions['lookup']>;
  await new Promise<void>((resolve, reject) => {
    const request = httpsRequest({
      protocol: 'https:',
      hostname: url.hostname,
      port: 443,
      servername: url.hostname,
      method: options.method,
      path: `${url.pathname}${url.search}`,
      headers: { ...options.headers, 'Content-Length': String(options.contentLength) },
      rejectUnauthorized: true,
      lookup,
    }, (response) => {
      response.resume();
      response.once('end', () => {
        if ((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300) resolve();
        else reject(new Error(`Destination returned HTTP ${response.statusCode ?? 'unknown'}`));
      });
    });
    request.setTimeout(60_000, () => request.destroy(new Error('Destination upload timed out')));
    request.once('error', reject);
    if (options.filePath) {
      const source = createReadStream(options.filePath);
      void pipeline(source, request).catch(reject);
    } else {
      request.end(options.body);
    }
  });
}

function s3Signature(destination: CloudDestination, method: 'PUT' | 'DELETE', uri: string, payloadHash: string, date: Date): { headers: Record<string, string>; url: URL } {
  const secret = decryptSecret(destination.secretKey);
  if (!secret || !destination.accessKey || !destination.region) throw new Error('Saved S3 credentials could not be decrypted');
  const url = new URL(destination.endpoint);
  url.pathname = uri;
  const shortDate = date.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate = `${shortDate}T${date.toISOString().slice(11, 19).replace(/:/g, '')}Z`;
  const scope = `${shortDate}/${destination.region}/s3/aws4_request`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders = `host:${url.host.toLowerCase()}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = [method, uri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash('sha256').update(canonicalRequest).digest('hex')}`;
  const dateKey = createHmac('sha256', `AWS4${secret}`).update(shortDate).digest();
  const regionKey = createHmac('sha256', dateKey).update(destination.region).digest();
  const serviceKey = createHmac('sha256', regionKey).update('s3').digest();
  const signingKey = createHmac('sha256', serviceKey).update('aws4_request').digest();
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    url,
    headers: {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization: `AWS4-HMAC-SHA256 Credential=${destination.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

function remoteObjectPath(destination: CloudDestination, fileName: string): string {
  if (destination.provider === 's3') return encodedPath([destination.bucket ?? '', destination.prefix, fileName]);
  const base = new URL(destination.endpoint);
  const prefix = base.pathname.split('/').filter(Boolean);
  return encodedPath([...prefix, destination.prefix, fileName]);
}

async function transfer(destination: CloudDestination, fileName: string, source: { filePath?: string; body?: Buffer; sha256: string; size: number }, method: 'PUT' | 'DELETE' = 'PUT'): Promise<string> {
  const objectPath = remoteObjectPath(destination, fileName);
  let url: URL;
  let headers: Record<string, string> = {};
  const contentLength = method === 'DELETE' ? 0 : source.size;
  if (destination.provider === 'webdav') {
    url = new URL(destination.endpoint);
    url.pathname = objectPath;
    const password = decryptSecret(destination.password);
    if (!password || !destination.username) throw new Error('Saved WebDAV credentials could not be decrypted');
    headers.Authorization = `Basic ${Buffer.from(`${destination.username}:${password}`).toString('base64')}`;
  } else {
    const payloadHash = method === 'DELETE' ? createHash('sha256').update('').digest('hex') : source.sha256;
    const signed = s3Signature(destination, method, objectPath, payloadHash, new Date());
    url = signed.url;
    headers = signed.headers;
  }
  if (method === 'PUT') {
    headers['Content-Type'] = 'application/octet-stream';
    if (!source.filePath) headers['Content-Length'] = String(source.body?.byteLength ?? 0);
  }
  await pinnedHttpsRequest(url, { method, headers, filePath: method === 'PUT' ? source.filePath : undefined, body: method === 'PUT' ? source.body : undefined, contentLength });
  return objectPath;
}

export async function testCloudDestination(ownerId: string): Promise<{ ok: true; provider: CloudDestination['provider'] }> {
  const destination = readDestination(ownerId);
  if (!destination) throw new Error('Save a destination before testing it');
  const name = `.dkrypt-check-${randomUUID()}.txt`;
  const body = Buffer.from('dkrypt destination check');
  const source = { body, size: body.byteLength, sha256: createHash('sha256').update(body).digest('hex') };
  let uploaded = false;
  try {
    await transfer(destination, name, source);
    uploaded = true;
    await transfer(destination, name, source, 'DELETE');
  } catch (error) {
    if (uploaded) {
      try {
        await transfer(destination, name, source, 'DELETE');
      } catch {
        throw new Error(`The connection worked, but temporary file ${name} may remain in the destination.`);
      }
    }
    throw error;
  }
  return { ok: true, provider: destination.provider };
}

function readDelivery(id: string): CloudDeliveryRecord | undefined {
  const row = database.query('SELECT payload FROM cloud_delivery_jobs WHERE id = ?').get(id) as { payload: string } | null;
  if (!row) return undefined;
  try {
    return JSON.parse(row.payload) as CloudDeliveryRecord;
  } catch {
    return undefined;
  }
}

function persistDelivery(record: CloudDeliveryRecord): void {
  database.query('UPDATE cloud_delivery_jobs SET payload = ?, updated_at = ?, status = ?, next_attempt_at = ? WHERE id = ?').run(JSON.stringify(record), record.updatedAt, record.status, record.nextAttemptAt ?? null, record.id);
}

export function listCloudDeliveries(ownerId: string, limit = 20): CloudDeliveryRecord[] {
  const rows = database.query('SELECT payload FROM cloud_delivery_jobs WHERE owner_id = ? ORDER BY updated_at DESC LIMIT ?').all(ownerId.toLowerCase(), Math.max(1, Math.min(50, limit))) as Array<{ payload: string }>;
  return rows.flatMap(({ payload }) => {
    try {
      return [JSON.parse(payload) as CloudDeliveryRecord];
    } catch {
      return [];
    }
  });
}

async function deliver(record: CloudDeliveryRecord): Promise<void> {
  const now = Date.now();
  const leaseUntil = now + deliveryLeaseMs;
  const claimed = database.query("UPDATE cloud_delivery_jobs SET status = 'pending', updated_at = ?, next_attempt_at = ? WHERE id = ? AND ((status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) OR (status = 'failed' AND next_attempt_at <= ?))")
    .run(now, leaseUntil, record.id, now, now).changes === 1;
  if (!claimed) return;
  record = { ...record, status: 'pending', updatedAt: now, nextAttemptAt: leaseUntil };
  const destination = readDestination(record.ownerId);
  const artifact = getArtifactById(record.artifactId);
  if (!destination?.enabled || !artifact || !artifactFileAvailable(artifact)) {
    const updated = { ...record, status: 'failed' as const, attempts: record.attempts + 1, updatedAt: Date.now(), nextAttemptAt: undefined, error: destination?.enabled ? 'The IPA file is no longer available' : 'Automatic destination is disabled' };
    persistDelivery(updated);
    return;
  }
  const attempt = record.attempts + 1;
  try {
    const fileStats = await stat(artifact.filePath);
    if (fileStats.size !== artifact.fileSizeBytes || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) throw new Error('The IPA file metadata no longer matches the artifact record');
    const remotePath = await transfer(destination, record.fileName, { filePath: artifact.filePath, size: fileStats.size, sha256: artifact.sha256.toLowerCase() });
    persistDelivery({ ...record, status: 'delivered', attempts: attempt, updatedAt: Date.now(), nextAttemptAt: undefined, remotePath, error: undefined });
  } catch (error) {
    const retry = attempt < maximumAttempts ? Date.now() + Math.min(60 * 60_000, retryBaseMs * 2 ** (attempt - 1)) : undefined;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    persistDelivery({ ...record, status: 'failed', attempts: attempt, updatedAt: Date.now(), nextAttemptAt: retry, error: message });
    log.warn('artifact cloud delivery failed', { ownerId: record.ownerId, jobId: record.jobId, artifactId: record.artifactId, attempts: attempt, error: message });
  }
}

export async function deliverCompletedArtifact(ownerId: string, jobId: string, artifact: ArtifactRecord): Promise<void> {
  const destination = readDestination(ownerId);
  if (!destination?.enabled || !artifactFileAvailable(artifact)) return;
  const id = randomUUID();
  const now = Date.now();
  const record: CloudDeliveryRecord = { id, ownerId: ownerId.toLowerCase(), jobId, artifactId: artifact.id, fileName: artifactDownloadName(artifact), status: 'pending', attempts: 0, createdAt: now, updatedAt: now };
  const inserted = database.query('INSERT OR IGNORE INTO cloud_delivery_jobs (id, payload, updated_at, owner_id, job_id, status, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, JSON.stringify(record), now, record.ownerId, jobId, record.status, null);
  if (inserted.changes === 0) {
    const existing = database.query('SELECT id, payload FROM cloud_delivery_jobs WHERE owner_id = ? AND job_id = ?').get(record.ownerId, jobId) as { id: string; payload: string } | null;
    const prior = existing ? JSON.parse(existing.payload) as CloudDeliveryRecord : undefined;
    if (prior?.status === 'delivered') return;
    if (prior) await deliver(prior);
    return;
  }
  await deliver(record);
}

export async function retryCloudDelivery(ownerId: string, id: string): Promise<CloudDeliveryRecord | undefined> {
  const record = readDelivery(id);
  if (!record || record.ownerId !== ownerId.toLowerCase() || record.status !== 'failed') return undefined;
  const retried = { ...record, nextAttemptAt: Date.now(), updatedAt: Date.now() };
  persistDelivery(retried);
  await deliver(retried);
  return readDelivery(id);
}

export async function retryDueCloudDeliveries(): Promise<void> {
  if (retryRunning) return;
  retryRunning = true;
  try {
    const now = Date.now();
    const rows = database.query("SELECT payload FROM cloud_delivery_jobs WHERE (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) OR (status = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?) ORDER BY COALESCE(next_attempt_at, 0) LIMIT 10").all(now, now) as Array<{ payload: string }>;
    for (const row of rows) {
      const record = JSON.parse(row.payload) as CloudDeliveryRecord;
      await deliver(record);
    }
  } finally {
    retryRunning = false;
  }
}

export function startArtifactDeliveryWorker(): void {
  retryTimer ??= setInterval(() => {
    void retryDueCloudDeliveries().catch((error: unknown) => log.warn('artifact delivery retry sweep failed', { error: String(error) }));
  }, 30_000).unref();
}

export function closeArtifactDeliveryDatabase(): void {
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = undefined;
  database.close();
}
