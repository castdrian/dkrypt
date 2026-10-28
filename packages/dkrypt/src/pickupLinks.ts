import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '#config.js';

export type PickupKind = 'artifact' | 'job';

export const PICKUP_LINK_TTL_MS = 5 * 60_000;
export const EMAIL_PICKUP_LINK_TTL_MS = 24 * 60 * 60_000;

function userFingerprint(userId: string): string {
  return createHmac('sha256', config.sessionSigningSecret).update(userId.toLowerCase()).digest('base64url');
}

export function createPickupUrl(userId: string, kind: PickupKind, id: string, fileName: string, expiresAt: number): string {
  const subject = userFingerprint(userId);
  const signature = createHmac('sha256', config.sessionSigningSecret).update(`${subject}\n${kind}\n${id}\n${fileName}\n${expiresAt}`).digest('base64url');
  const url = new URL(`/pickup/${kind}/${encodeURIComponent(id)}`, config.publicBaseUrl);
  url.searchParams.set('subject', subject);
  url.searchParams.set('name', fileName);
  url.searchParams.set('expires', String(expiresAt));
  url.searchParams.set('signature', signature);
  return url.toString();
}

export function isValidPickupToken(kind: PickupKind, id: string, subject: string, fileName: string, expiresText: string, signature: string): boolean {
  const expiresAt = Number(expiresText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + EMAIL_PICKUP_LINK_TTL_MS + 60_000) return false;
  const expected = createHmac('sha256', config.sessionSigningSecret).update(`${subject}\n${kind}\n${id}\n${fileName}\n${expiresAt}`).digest();
  const supplied = Buffer.from(signature, 'base64url');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
