export interface BillingCheckoutRecovery {
  planId: string;
  provider: 'stripe' | 'crypto';
  preserveResultId?: string;
  resumeRequest: boolean;
  savedAt: number;
}

const RECOVERY_KEY = 'dkrypt.billing-checkout-recovery';
const RECOVERY_TTL_MS = 24 * 60 * 60_000;

export function saveBillingCheckoutRecovery(intent: Omit<BillingCheckoutRecovery, 'savedAt'>): void {
  localStorage.setItem(RECOVERY_KEY, JSON.stringify({ ...intent, savedAt: Date.now() } satisfies BillingCheckoutRecovery));
}

export function readBillingCheckoutRecovery(): BillingCheckoutRecovery | undefined {
  const raw = localStorage.getItem(RECOVERY_KEY);
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<BillingCheckoutRecovery>;
    if (typeof value.planId !== 'string' || (value.provider !== 'stripe' && value.provider !== 'crypto')) return undefined;
    if (!Number.isSafeInteger(value.savedAt) || Date.now() - (value.savedAt as number) > RECOVERY_TTL_MS) return undefined;
    return {
      planId: value.planId,
      provider: value.provider,
      preserveResultId: typeof value.preserveResultId === 'string' ? value.preserveResultId : undefined,
      resumeRequest: value.resumeRequest === true,
      savedAt: value.savedAt as number,
    };
  } catch {
    return undefined;
  }
}

export function clearBillingCheckoutRecovery(): void {
  localStorage.removeItem(RECOVERY_KEY);
}
