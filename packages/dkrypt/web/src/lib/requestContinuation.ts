import type { PublicRequestCheckResult } from '#lib/api';

const REQUEST_CONTINUATION_KEY = 'dkrypt.request-continuation';
const REQUEST_CONTINUATION_TTL_MS = 20 * 60_000;
const CHECKOUT_DECRYPT_CONTINUATION_KEY = 'dkrypt.checkout-decrypt-continuation';
const CHECKOUT_DECRYPT_CONTINUATION_TTL_MS = 4 * 60 * 60_000;

export interface SignupRequestContinuation extends PublicRequestCheckResult {
  expiresAt: number;
}

export interface CheckoutDecryptContinuation {
  bundleId: string;
  trackName: string;
  channel: 'appstore' | 'testflight';
  platform?: 'ios' | 'tvos' | 'visionos';
  externalVersionId?: string;
  versionLabel: string;
  minimumOsVersion?: string;
  testflight?: {
    appId: number;
    build: {
      id: number;
      bundleId: string;
      cfBundleShortVersion: string;
      cfBundleVersion: string;
      whatsNew?: string;
      releaseDate?: string;
      expiration?: string;
      fileSize?: number;
    };
  };
  expiresAt: number;
}

export function saveSignupRequestContinuation(request: PublicRequestCheckResult): void {
  const continuation: SignupRequestContinuation = { ...request, expiresAt: Date.now() + REQUEST_CONTINUATION_TTL_MS };
  localStorage.setItem(REQUEST_CONTINUATION_KEY, JSON.stringify(continuation));
}

export function takeSignupRequestContinuation(): SignupRequestContinuation | undefined {
  const saved = localStorage.getItem(REQUEST_CONTINUATION_KEY);
  localStorage.removeItem(REQUEST_CONTINUATION_KEY);
  if (!saved) return undefined;
  try {
    const value = JSON.parse(saved) as Partial<SignupRequestContinuation>;
    if (value.expiresAt === undefined || value.expiresAt <= Date.now()) return undefined;
    if (typeof value.bundleId !== 'string' || typeof value.displayName !== 'string') return undefined;
    if (value.channel !== 'appstore' && value.channel !== 'testflight') return undefined;
    if (typeof value.requestable !== 'boolean' || typeof value.nextStep !== 'string') return undefined;
    return value as SignupRequestContinuation;
  } catch {
    return undefined;
  }
}

export function saveCheckoutDecryptContinuation(request: Omit<CheckoutDecryptContinuation, 'expiresAt'>): void {
  const continuation: CheckoutDecryptContinuation = { ...request, expiresAt: Date.now() + CHECKOUT_DECRYPT_CONTINUATION_TTL_MS };
  localStorage.setItem(CHECKOUT_DECRYPT_CONTINUATION_KEY, JSON.stringify(continuation));
}

export function takeCheckoutDecryptContinuation(): CheckoutDecryptContinuation | undefined {
  const saved = localStorage.getItem(CHECKOUT_DECRYPT_CONTINUATION_KEY);
  localStorage.removeItem(CHECKOUT_DECRYPT_CONTINUATION_KEY);
  if (!saved) return undefined;
  try {
    const value = JSON.parse(saved) as Partial<CheckoutDecryptContinuation>;
    if (!Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= Date.now()) return undefined;
    if (typeof value.bundleId !== 'string' || typeof value.trackName !== 'string' || typeof value.versionLabel !== 'string') return undefined;
    if (value.channel !== 'appstore' && value.channel !== 'testflight') return undefined;
    if (value.platform !== undefined && value.platform !== 'ios' && value.platform !== 'tvos' && value.platform !== 'visionos') return undefined;
    if (value.externalVersionId !== undefined && typeof value.externalVersionId !== 'string') return undefined;
    if (value.minimumOsVersion !== undefined && typeof value.minimumOsVersion !== 'string') return undefined;
    if (value.channel === 'testflight') {
      const appId = value.testflight?.appId;
      const build = value.testflight?.build;
      if (!Number.isSafeInteger(appId) || !build || !Number.isSafeInteger(build.id) || typeof build.bundleId !== 'string' || typeof build.cfBundleShortVersion !== 'string' || typeof build.cfBundleVersion !== 'string') return undefined;
    }
    return value as CheckoutDecryptContinuation;
  } catch {
    return undefined;
  }
}

export function hasCheckoutDecryptContinuation(): boolean {
  const saved = localStorage.getItem(CHECKOUT_DECRYPT_CONTINUATION_KEY);
  if (!saved) return false;
  try {
    const value = JSON.parse(saved) as Partial<CheckoutDecryptContinuation>;
    return Number.isSafeInteger(value.expiresAt) && (value.expiresAt as number) > Date.now();
  } catch {
    return false;
  }
}
