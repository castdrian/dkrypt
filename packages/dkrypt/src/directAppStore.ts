import { execCommand, type DeviceClient } from '#idevice.js';

export const APP_STORE_HELPER = '/var/jb/usr/libexec/autoinstall-appstore';

interface DirectStoreProbe {
  countryCode: string;
  biometric?: string;
}

export interface DirectAppStoreRequest {
  bundleId: string;
  adamId: string;
  versionId?: string;
  operationId: string;
  verifiedPrice: number;
}

function parseResponse(stdout: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new Error('App Store helper returned an invalid response'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('App Store helper returned an invalid response');
  return value as Record<string, unknown>;
}

export class AppStorePurchaseError extends Error {
  readonly retryable = false;
  constructor(message: string) { super(message); this.name = 'AppStorePurchaseError'; }
}

export function storeFailureMessage(result: Record<string, unknown>): string {
  const details = result.details && typeof result.details === 'object' ? result.details as Record<string, unknown> : undefined;
  const dialog = typeof details?.dialogId === 'string' ? details.dialogId : undefined;
  const chain = Array.isArray(details?.chain) ? details.chain.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    return typeof record.domain === 'string' && typeof record.code === 'number' ? [`${record.domain} ${record.code}`] : [];
  }) : [];
  const message = typeof result.error === 'string' ? result.error : 'App Store purchase failed';
  const context = [...(dialog ? [dialog] : []), ...chain].join('; ');
  return context ? `${message} (${context})` : message;
}

export async function probeDirectAppStore(conn: DeviceClient, signal?: AbortSignal): Promise<DirectStoreProbe | undefined> {
  const result = await execCommand(conn, `if [ -x ${APP_STORE_HELPER} ]; then ${APP_STORE_HELPER} probe; else exit 127; fi`, 15_000, signal);
  if (result.code === 127) return undefined;
  const response = parseResponse(result.stdout);
  if (result.code !== 0 || response.ok !== true) throw new Error(storeFailureMessage(response));
  if (response.protocol !== 1) return undefined;
  if (response.supported === false) return undefined;
  if (response.supported !== true || typeof response.countryCode !== 'string' || !/^[A-Z]{2,3}$/.test(response.countryCode)) {
    throw new Error('could not verify the signed-in App Store storefront through the device helper');
  }
  return { countryCode: response.countryCode, biometric: typeof response.biometric === 'string' ? response.biometric : undefined };
}

export async function submitDirectAppStore(
  conn: DeviceClient,
  request: DirectAppStoreRequest,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  // Base64 contains no shell metacharacters. Requests contain app metadata, never credentials.
  const payload = Buffer.from(JSON.stringify(request)).toString('base64');
  try {
    const result = await execCommand(conn, `${APP_STORE_HELPER} install '${payload}'`, 110_000, signal);
    const response = parseResponse(result.stdout);
    if (result.code !== 0 || response.ok !== true) throw new AppStorePurchaseError(storeFailureMessage(response));
    if (response.state !== 'purchased') throw new AppStorePurchaseError('App Store helper returned an uncertain purchase result; inspect the device before retrying');
    return response;
  } catch (error) {
    if (error instanceof AppStorePurchaseError) throw error;
    throw new AppStorePurchaseError('App Store purchase outcome is unknown after the device connection failed; inspect the device before retrying');
  }
}

export async function readDirectAppStoreOperation(conn: DeviceClient, request: DirectAppStoreRequest, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
  const payload = Buffer.from(JSON.stringify(request)).toString('base64');
  const result = await execCommand(conn, `${APP_STORE_HELPER} operation '${payload}'`, 10_000, signal);
  const response = parseResponse(result.stdout);
  if (result.code !== 0 || response.ok !== true) throw new AppStorePurchaseError(storeFailureMessage(response));
  if (response.found === false) return undefined;
  if (response.found !== true || response.state !== 'purchased') throw new AppStorePurchaseError('App Store purchase outcome is unknown; inspect the device before retrying');
  return response;
}
