import type { PublicRequestCheckResult } from '#lib/api';

const REQUEST_CONTINUATION_KEY = 'dkrypt.request-continuation';
const REQUEST_CONTINUATION_TTL_MS = 20 * 60_000;

export interface SignupRequestContinuation extends PublicRequestCheckResult {
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
